#!/usr/bin/env node
// The reuse replay: for each of the last N merged non-release pull requests,
// its cited CI run (the last pull_request run on its head commit), which Nx
// tasks each test job ran and which it replayed, and, for each task that ran,
// the hash inputs its diff touched — resolved by Nx itself at that head commit
// (inputs.mjs) — or, when none did, the runtime inputs that could have moved.
//
//   node spikes/ci-test-speed/replay.mjs [--last 30] [--cache DIR] [--offline]
//        [--json FILE]
//
// It fetches each head as `refs/pull/<n>/head` and checks it out in a scratch
// worktree under the cache directory, borrowing this checkout's node_modules.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { outer } from "./executions.mjs";
import { Cache, REPO } from "./gh.mjs";

const argv = process.argv.slice(2);
const opt = (n, d = null) =>
  argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d;
const last = Number(opt("last", 30));
const cache = new Cache(
  resolve(opt("cache", "target/spike-ci-test-speed/cache")),
  argv.includes("--offline"),
);
const JOBS = ["test-linux", "test-macos", "test-windows"];
const here = process.cwd();
const git = (...a) =>
  execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 }).trim();

// REST rather than `gh pr list`, which spends the GraphQL allowance.
const prs = cache
  .json(
    `/repos/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`,
  )
  .filter((p) => p.merged_at)
  .map((p) => ({
    number: p.number,
    title: p.title,
    headRefName: p.head.ref,
    headRefOid: p.head.sha,
    mergedAt: p.merged_at,
    mergeCommit: { oid: p.merge_commit_sha },
  }))
  .filter((p) => !p.headRefName.startsWith("release-plz-"))
  .sort((a, b) => b.number - a.number)
  .slice(0, last);

function unpack(id) {
  const dir = cache.path(`artifact-${id}`);
  if (!existsSync(dir)) {
    cache.artifact(id);
    mkdirSync(dir, { recursive: true });
    execFileSync("unzip", [
      "-q",
      "-o",
      cache.path(`artifact-${id}.zip`),
      "-d",
      dir,
    ]);
  }
  return dir;
}

const rows = [];
for (const pr of prs) {
  try {
    const runs = cache
      .json(
        `/repos/${REPO}/actions/runs?head_sha=${pr.headRefOid}&event=pull_request&per_page=20`,
      )
      .workflow_runs.filter((r) => r.name === "CI");
    const cited = runs.sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    )[0];
    const row = {
      pr: pr.number,
      title: pr.title,
      head: pr.headRefOid,
      merge: pr.mergeCommit?.oid ?? null,
      run: cited?.id ?? null,
      attempt: cited?.run_attempt ?? null,
      jobs: {},
    };
    rows.push(row);
    if (!cited) continue;
    const jobs = cache.pages(
      `/repos/${REPO}/actions/runs/${cited.id}/attempts/${cited.run_attempt}/jobs`,
      "jobs",
    );
    const arts = cache.pages(
      `/repos/${REPO}/actions/runs/${cited.id}/artifacts`,
      "artifacts",
    );
    let base = null;
    for (const name of JOBS) {
      const job = jobs.find((j) => j.name === name);
      const art = arts
        .filter((a) => a.name === `nx-cache-entries-${name}` && !a.expired)
        .at(-1);
      const entry = {
        job_id: job?.id ?? null,
        conclusion: job?.conclusion ?? null,
        wall_minutes:
          job?.started_at && job?.completed_at
            ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) /
              60000
            : null,
        tasks: null,
      };
      row.jobs[name] = entry;
      if (!art) {
        entry.missing = arts.some((a) => a.name === `nx-cache-entries-${name}`)
          ? "artifact expired"
          : "no executions artifact";
        continue;
      }
      const doc = JSON.parse(
        readFileSync(join(unpack(art.id), "executions.json"), "utf8"),
      );
      base ??= doc.selection?.base_sha ?? doc.base_sha;
      entry.tasks = outer(doc.tasks).map((t) => ({
        task: t.task,
        result: t.result,
        cacheable: t.cacheable,
        minutes: (Date.parse(t.finished_at) - Date.parse(t.started_at)) / 60000,
        started_at: t.started_at,
        finished_at: t.finished_at,
      }));
      entry.nested_records = doc.tasks.length - entry.tasks.length;
    }
    row.base = base;
    if (!base) continue;
    // The files Nx's affected selection compared: the merge base of the run's base and head.
    try {
      git("cat-file", "-e", `${pr.headRefOid}^{commit}`);
    } catch {
      git("fetch", "-q", "origin", `refs/pull/${pr.number}/head`);
    }
    const mb = git("merge-base", base, pr.headRefOid);
    row.changed = git("diff", "--name-only", mb, pr.headRefOid)
      .split("\n")
      .filter(Boolean);
    const all = [
      ...new Set(
        Object.values(row.jobs).flatMap((j) =>
          (j.tasks ?? []).map((t) => t.task),
        ),
      ),
    ];
    const key = `inputs-${pr.headRefOid}.json`;
    const inputs = JSON.parse(
      cache.read(
        key,
        () => {
          const wt = cache.path(`wt-${pr.number}`);
          rmSync(wt, { recursive: true, force: true });
          git("worktree", "add", "-q", "--detach", wt, pr.headRefOid);
          try {
            symlinkSync(join(here, "node_modules"), join(wt, "node_modules"));
            writeFileSync(join(wt, ".spike-tasks.json"), JSON.stringify(all));
            writeFileSync(
              join(wt, ".spike-changed.txt"),
              row.changed.join("\n"),
            );
            return execFileSync(
              "node",
              [
                join(here, "spikes/ci-test-speed/inputs.mjs"),
                ".spike-tasks.json",
                ".spike-changed.txt",
              ],
              {
                cwd: wt,
                encoding: "utf8",
                env: { ...process.env, NX_DAEMON: "false" },
                maxBuffer: 1 << 28,
              },
            );
          } finally {
            git("worktree", "remove", "--force", wt);
          }
        },
        false,
        true,
      ),
    );
    const lsFilesMoved = git(
      "diff",
      "--name-only",
      "--diff-filter=AD",
      mb,
      pr.headRefOid,
    )
      .split("\n")
      .filter(Boolean);
    for (const entry of Object.values(row.jobs))
      for (const t of entry.tasks ?? []) {
        const inp = inputs[t.task];
        t.matched = inp?.files ?? [];
        if (t.result === "executed" && t.cacheable && !t.matched.length) {
          const rt = inp?.runtime ?? [];
          t.cause = rt.includes("git merge-base HEAD origin/main")
            ? "runtime input `git merge-base HEAD origin/main` (moves with every base)"
            : rt.includes("git ls-files") && lsFilesMoved.length
              ? "runtime input `git ls-files` (files added or removed)"
              : inp?.dep_outputs?.length
                ? `an upstream task's outputs (${inp.dep_outputs.join(", ").slice(0, 120)})`
                : "no diff-matched input: entry absent from the remote cache";
        }
      }
  } catch (error) {
    // Offline, or out of quota: the PR is listed as unread rather than guessed.
    if (!cache.offline && !/quota/.test(error.message)) throw error;
    const row = rows.find((r) => r.pr === pr.number);
    const why = String(error.message).slice(0, 160);
    if (row) row.unavailable = why;
    else
      rows.push({ pr: pr.number, title: pr.title, jobs: {}, unavailable: why });
  }
}
const out = opt("json");
if (out) writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
for (const r of rows) {
  const parts = JOBS.map((j) => {
    const e = r.jobs[j];
    if (!e?.tasks) return `${j}: ${e?.missing ?? "no run"}`;
    const ran = e.tasks.filter(
      (t) => t.result === "executed" && t.cacheable,
    ).length;
    const hit = e.tasks.filter((t) => /hit/.test(t.result)).length;
    return `${j} ${e.wall_minutes?.toFixed(1)}m ran ${ran} replayed ${hit} of ${e.tasks.filter((t) => t.cacheable).length} cacheable`;
  });
  console.log(
    `#${r.pr} run ${r.run} files ${r.changed?.length ?? "?"} | ${parts.join(" | ")}`,
  );
}
