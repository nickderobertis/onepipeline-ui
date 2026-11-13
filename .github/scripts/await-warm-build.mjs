// Holds release-plz's update of the release pull request until ci-cache.yml's
// `warm-linux` job has saved the Rust build for the same push, when that job is
// building it cold. The release pull request's `test-linux` restores that build;
// updated before the save, it restores the previous lock's build and compiles past
// its cap (docs/release-sweep-timing.md, 2026-11-12).
//
//   node .github/scripts/await-warm-build.mjs --sha SHA --until EPOCH_SECONDS [--interval SECONDS] [--repo OWNER/NAME]
//
// Whether the build is cold is the warm job's own decision: its DROP_STEP runs
// only when its restore was not the key's own, and reports `skipped` when it was.
// So an exact restore returns as soon as that step is decided, and a cold one once
// the job has completed.
//
// Reads GH_TOKEN or GITHUB_TOKEN, GITHUB_API_URL and GITHUB_REPOSITORY. Exit 0 when
// there is nothing left to wait for, or with a `::warning::` when the warm job
// failed, GitHub refused the read, or `--until` came first: the wait decides only
// which build the release pull request's first attempt restores, and that pull
// request runs every check whichever it gets. Exit 2 on a usage error.
import { setTimeout as sleep } from "node:timers/promises";

const WORKFLOW = "ci-cache.yml";
const JOB = "warm-linux";
// .github/tests/await-warm-build.test.mjs serves this name from ci-cache.yml.
const DROP_STEP = "Drop a restored build that is not this key's own";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_WAIT_S = 24 * 60 * 60;
const MAX_INTERVAL_S = 60 * 60;

class Usage extends Error {}
// A refusal no wait can change: a missing permission or a renamed workflow.
class Refused extends Error {}

const warning = (message) => console.error(`::warning::${message}`);

function parseArguments(args) {
  const parsed = { interval: "30", repo: process.env.GITHUB_REPOSITORY };
  const names = ["--sha", "--until", "--interval", "--repo"];
  for (let at = 0; at < args.length; at += 2) {
    const [name, value] = [args[at], args[at + 1]];
    if (!names.includes(name)) throw new Usage(`unknown argument: ${name}`);
    if (value === undefined || value === "" || value.startsWith("--"))
      throw new Usage(`${name} needs a value`);
    parsed[name.slice(2)] = value;
  }
  if (!/^[0-9a-f]{40}$/.test(parsed.sha ?? ""))
    throw new Usage("--sha must be a full commit id");
  const until = Number(parsed.until);
  if (
    !Number.isFinite(until) ||
    until <= 0 ||
    until > Date.now() / 1000 + MAX_WAIT_S
  )
    throw new Usage(
      `--until must be a time in epoch seconds, at most ${MAX_WAIT_S} s from now`,
    );
  const interval = Number(parsed.interval);
  if (!Number.isFinite(interval) || interval <= 0 || interval > MAX_INTERVAL_S)
    throw new Usage(
      `--interval must be a positive number of seconds, at most ${MAX_INTERVAL_S}`,
    );
  if (!/^[\w.-]+\/[\w.-]+$/.test(parsed.repo ?? ""))
    throw new Usage(
      "no repository: pass --repo OWNER/NAME or set GITHUB_REPOSITORY",
    );
  return {
    ...parsed,
    until: Math.floor(until * 1000),
    interval: Math.max(1, Math.round(interval * 1000)),
  };
}

function apiBase() {
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Usage(`GITHUB_API_URL is not a URL: ${base}`);
  }
  const loopback =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback)
    throw new Usage("GITHUB_API_URL must use HTTPS or loopback HTTP");
  return base.replace(/\/$/, "");
}

// A read that never outlasts the deadline, whatever GitHub does.
function client(base, until) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  return async (path) => {
    const room = Math.max(
      1,
      Math.floor(Math.min(REQUEST_TIMEOUT_MS, until - Date.now())),
    );
    const answer = await fetch(`${base}/${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(room),
    });
    if (!answer.ok) {
      await answer.arrayBuffer();
      const failure = `${path} answered HTTP ${answer.status}`;
      throw [401, 403, 404].includes(answer.status)
        ? new Refused(failure)
        : new Error(failure);
    }
    return answer.json();
  };
}

// The warm job of the newest ci-cache.yml run for this push, or why there is
// none to read yet.
async function warmJob(request, repo, sha) {
  const query = new URLSearchParams({ head_sha: sha, event: "push" });
  const { workflow_runs: runs } = await request(
    `repos/${repo}/actions/workflows/${WORKFLOW}/runs?${query}`,
  );
  if (!Array.isArray(runs)) throw new Error(`${WORKFLOW}'s runs carry no list`);
  const run = runs
    .filter((candidate) => Number.isSafeInteger(candidate?.id))
    .sort((a, b) => b.id - a.id)[0];
  if (!run) return { pending: `GitHub had not created ${WORKFLOW}'s run` };
  const { jobs } = await request(
    `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
  );
  if (!Array.isArray(jobs))
    throw new Error(`run ${run.id}'s jobs carry no list`);
  const job = jobs.find((candidate) => candidate?.name === JOB);
  if (!job) return { pending: `run ${run.id} had no ${JOB} job yet` };
  if (typeof job.status !== "string" || !Array.isArray(job.steps ?? []))
    throw new Error(`run ${run.id}'s ${JOB} carries no status or step list`);
  const drop = (job.steps ?? []).find((step) => step?.name === DROP_STEP);
  return { job, run: run.id, dropped: drop?.conclusion };
}

async function main(args) {
  const { sha, until, interval, repo } = parseArguments(args);
  const request = client(apiBase(), until);
  const started = Date.now();
  let reason;
  for (;;) {
    try {
      const { job, run, pending, dropped } = await warmJob(request, repo, sha);
      reason = pending ?? `${JOB} was '${job.status}'`;
      const waited = Math.round((Date.now() - started) / 1000);
      if (dropped === "skipped") {
        console.log(
          `${JOB} (run ${run}) restored this key's own build, which the release pull request restores too; waited ${waited} s.`,
        );
        return;
      }
      if (job?.status === "completed") {
        if (job.conclusion === "success")
          console.log(
            `${JOB} (run ${run}) saved this key's build; waited ${waited} s.`,
          );
        else
          warning(
            `${JOB} (run ${run}) ended '${job.conclusion}', so the release pull request's first attempt may compile its Rust build cold. ACTION: read ${JOB} in ${WORKFLOW} run ${run}; once main builds, rerun the release pull request's test-linux if that attempt was cancelled.`,
          );
        return;
      }
    } catch (error) {
      if (error instanceof Refused) {
        warning(
          `GitHub refused the read of ${JOB}: ${error.message}. ACTION: check that release-plz.yml grants its job 'actions: read' and that ${WORKFLOW} still has a ${JOB} job.`,
        );
        return;
      }
      reason = `the last read failed: ${error.message}`;
    }
    if (Date.now() + interval >= until) {
      warning(
        `${JOB} had not saved the build when this job's room to wait ran out (${reason}), so the release pull request's first attempt may compile its Rust build cold. ACTION: if that attempt is cancelled, rerun its test-linux once ${JOB} for ${sha} is green.`,
      );
      return;
    }
    await sleep(interval);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof Usage)) throw error;
  console.error(`await-warm-build: ${error.message}`);
  console.error(
    "usage: node .github/scripts/await-warm-build.mjs --sha SHA --until EPOCH_SECONDS [--interval SECONDS] [--repo OWNER/NAME]",
  );
  process.exit(2);
}
