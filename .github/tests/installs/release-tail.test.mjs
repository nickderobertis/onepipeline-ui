// The release-tail budgets, as `publish`'s last step reports them.
//
// Everything is the real thing but GitHub. The step's command line and the step
// that installs onevcs before it are read from release.yml and run as Actions
// runs them; onebudgetspec is the workspace's, the figures script is the copy in
// scripts/, and onevcs is the release that install step put on PATH. GitHub is
// the one boundary doubled: onevcs reaches it through `gh`, and `ONEVCS_GH` names
// .github/fixtures/release-tail/gh-replay.mjs, which serves responses recorded
// read-only from this repository's own v0.64.0 release. The one change a
// recording is served with is the one its sidecar names: the `publish` job is
// served in progress, as the step sees itself from inside `publish`. Apart from
// that, the recordings keep no email address: each was replaced with a
// placeholder when saved, as the sidecars that had any say, and no figure reads one.
//
// Every figure is computed here a second time, from the recorded jobs' own
// timestamps and counts, and the read figures from the double's own record of
// what it was asked.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { parse, stringify } from "yaml";

const ROOT = resolve(".");
// The onevcs release this repository adopts for the tail's reads.
export const ONEVCS_ADOPTED = "0.57.6";
const REPOSITORY = "nickderobertis/onepipeline-ui";
const RELEASE = "v0.64.0";
const RELEASE_RUN = 41269844133;
// The job's token, as a workflow spells it, without a literal `${` here.
const JOB_TOKEN = `$${"{{"} github.token }}`;
const FIXTURES = join(ROOT, ".github/fixtures/release-tail", RELEASE);
const DOUBLE = join(ROOT, ".github/fixtures/release-tail/gh-replay.mjs");
const SEVEN = [
  "onepipeline-ui-ci-check-time",
  "onepipeline-ui-cd-job-time",
  "onepipeline-ui-release-cycle-time",
  "onepipeline-ui-ci-job-count",
  "onepipeline-ui-cd-job-count",
  "onepipeline-ui-release-read-requests",
  "onepipeline-ui-pr-read-requests",
];

const release = () =>
  parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"));
const allWorkflows = () =>
  readdirSync(join(ROOT, ".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [
      file,
      parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8")),
    ]);

export function tailStepProblems(document, workflows = []) {
  const problems = [];
  const publish = document?.jobs?.publish;
  if (!publish) return ["release.yml has no publish job"];
  const steps = publish.steps ?? [];
  const last = steps.at(-1);
  const tail = steps.findIndex((s) =>
    /onebudgetspec check budgets\.yaml --label release-tail/.test(s.run ?? ""),
  );
  if (tail < 0) problems.push("publish has no release-tail step");
  else if (tail !== steps.length - 1)
    problems.push("the release-tail step is not publish's last");
  if (
    last?.run?.trim() !==
    "onebudgetspec check budgets.yaml --label release-tail"
  )
    problems.push(`publish's last step runs ${JSON.stringify(last?.run)}`);
  if (last && "continue-on-error" in last)
    problems.push("the release-tail step carries continue-on-error");
  if (last?.if !== "always()")
    problems.push("the release-tail step is not reached on every path");
  if (last?.env?.GITHUB_TOKEN !== JOB_TOKEN)
    problems.push("the release-tail step does not receive the job's token");
  // Nothing reads its outcome: it has no id a later step could name, nothing
  // follows it in its job, no job needs publish, and no workflow follows a run.
  if (last && "id" in last)
    problems.push("the release-tail step has an id something could read");
  for (const [file, workflow] of [["release.yml", document], ...workflows])
    for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
      const needs = [job.needs ?? []].flat();
      if (needs.includes("publish"))
        problems.push(
          `${file} ${id} needs publish, so it reads the tail's outcome`,
        );
    }
  for (const [file, workflow] of workflows)
    if (workflow?.on && "workflow_run" in workflow.on)
      problems.push(`${file} runs on workflow_run, after the release`);
  const permissions = publish.permissions ?? {};
  for (const [scope, granted] of [
    ["actions", ["read", "write"]],
    ["contents", ["read", "write"]],
    ["pull-requests", ["read", "write"]],
  ])
    if (!granted.includes(permissions[scope]))
      problems.push(`publish's token is not granted ${scope}: read`);
  const installs = steps
    .slice(0, -1)
    .map(
      (s) => (s.run ?? "").match(/npm install [^\n]*\bonevcs-cli@(\S+)/)?.[1],
    )
    .filter(Boolean);
  if (installs.length === 0)
    problems.push("no step before publish's last installs the onevcs CLI");
  for (const version of installs)
    if (version !== ONEVCS_ADOPTED)
      problems.push(
        `publish installs onevcs-cli@${version}, not the adopted ${ONEVCS_ADOPTED}`,
      );
  return problems;
}

test("the release-tail step is publish's last, reads GitHub with the job's token, and is read by nothing", () => {
  assert.deepEqual(tailStepProblems(release(), allWorkflows()), []);
});

test("a tail step moved, read, softened or installed at another onevcs is refused", () => {
  const cases = [
    [
      (d) => d.jobs.publish.steps.push({ run: "echo after" }),
      "the release-tail step is not publish's last",
    ],
    [
      (d) => {
        d.jobs.publish.steps.at(-1)["continue-on-error"] = true;
      },
      "the release-tail step carries continue-on-error",
    ],
    [
      (d) => {
        d.jobs.publish.steps.at(-1).id = "tail";
      },
      "the release-tail step has an id something could read",
    ],
    [
      (d) => {
        d.jobs.after = {
          needs: ["publish"],
          "runs-on": "ubuntu-latest",
          steps: [],
        };
      },
      "release.yml after needs publish, so it reads the tail's outcome",
    ],
    [
      (d) => {
        delete d.jobs.publish.steps.at(-1).env;
      },
      "the release-tail step does not receive the job's token",
    ],
    [
      (d) => {
        delete d.jobs.publish.permissions.actions;
      },
      "publish's token is not granted actions: read",
    ],
    [
      (d) => {
        delete d.jobs.publish.permissions["pull-requests"];
      },
      "publish's token is not granted pull-requests: read",
    ],
    [
      (d) => {
        d.jobs.publish.steps.splice(-2, 1);
      },
      "no step before publish's last installs the onevcs CLI",
    ],
    [
      (d) => {
        const step = d.jobs.publish.steps.at(-2);
        step.run = step.run.replace(
          `onevcs-cli@${ONEVCS_ADOPTED}`,
          "onevcs-cli@0.56.3",
        );
      },
      `publish installs onevcs-cli@0.56.3, not the adopted ${ONEVCS_ADOPTED}`,
    ],
  ];
  for (const [mutate, problem] of cases) {
    const document = structuredClone(release());
    mutate(document);
    const problems = tailStepProblems(document, []);
    assert.ok(problems.includes(problem), `${problem}: ${problems}`);
  }
  assert.ok(
    tailStepProblems(release(), [
      ["late.yml", { on: { workflow_run: {} }, jobs: {} }],
    ]).includes("late.yml runs on workflow_run, after the release"),
  );
});

function recordings() {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const sidecar = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
      const text = readFileSync(
        join(FIXTURES, file.replace(/\.json$/, ".http")),
        "utf8",
      );
      const split = text.search(/\r?\n\r?\n/);
      const body = JSON.parse(text.slice(split).trim());
      for (const [id, fields] of Object.entries(
        sidecar.served_with?.jobs ?? {},
      ))
        Object.assign(
          body.jobs.find((job) => String(job.id) === id),
          fields,
        );
      return { ...sidecar, status: Number(text.split(" ")[1]), body };
    });
}
const at = (records, pattern) => {
  const found = records.filter((r) => pattern.test(r.path));
  assert.equal(found.length, 1, `${pattern}: ${found.map((r) => r.path)}`);
  return found[0].body;
};
const ts = (stamp) => Math.floor(Date.parse(stamp) / 1000);

// What the recorded release is, read straight off GitHub's responses.
function recorded() {
  const records = recordings();
  const commits = at(records, /\/compare\//).commits.map((c) => c.sha);
  const changes = at(records, /\/pulls\?state=closed/)
    .filter((pr) => pr.merged_at && commits.includes(pr.merge_commit_sha))
    .map((pr) => ({
      number: pr.number,
      head: pr.head.sha,
      merged: pr.merged_at,
      merge: pr.merge_commit_sha,
    }));
  const jobsOf = (run) =>
    at(records, new RegExp(`/actions/runs/${run}/jobs\\?`)).jobs;
  const prs = changes.map((change) => {
    const runs = at(
      records,
      new RegExp(`head_sha=${change.head}&event=pull_request`),
    )
      .workflow_runs.filter(
        (run) =>
          run.event === "pull_request" &&
          ts(run.created_at) <= ts(change.merged),
      )
      .sort((a, b) => ts(b.created_at) - ts(a.created_at) || b.id - a.id);
    const latest = [];
    for (const run of runs)
      if (!latest.some((kept) => kept.workflow_id === run.workflow_id))
        latest.push(run);
    return {
      ...change,
      runs: latest.map((run) => ({ ...run, jobs: jobsOf(run.id) })),
    };
  });
  const releaseCommit = commits.at(-1);
  const cdRuns = at(records, new RegExp(`head_sha=${releaseCommit}$`))
    .workflow_runs.filter(
      (run) =>
        ["push", "release"].includes(run.event) &&
        run.name !== "CI cache" &&
        run.conclusion !== "skipped",
    )
    .map((run) => ({ ...run, jobs: jobsOf(run.id) }));
  return { records, prs, cdRuns, releaseCommit };
}

// A counted job and its seconds: completed, not skipped, taken by a runner; or
// the job running the tail, timed to `now`.
const counted = (now, runner) => (job) => {
  if (
    job.status === "completed" &&
    job.conclusion !== "skipped" &&
    job.runner_name
  )
    return [Math.max(ts(job.completed_at) - ts(job.started_at), 0)];
  if (
    job.run_id === RELEASE_RUN &&
    job.status === "in_progress" &&
    job.runner_name === runner
  )
    return [Math.max(now - ts(job.started_at), 0)];
  return [];
};

export function expectedFigures(release, now, runner) {
  const prSecs = release.prs.map((pr) =>
    pr.runs.flatMap((run) => run.jobs.flatMap(counted(now, runner))),
  );
  const cdSecs = release.cdRuns.flatMap((run) =>
    run.jobs.flatMap(counted(now, runner)),
  );
  const specs = readFileSync(
    join(ROOT, ".github/release-published-paths"),
    "utf8",
  )
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const cycle = release.prs
    .filter((pr) =>
      execFileSync(
        "git",
        ["diff", "--name-only", `${pr.merge}^1`, pr.merge, "--", ...specs],
        { cwd: ROOT, encoding: "utf8" },
      ).trim(),
    )
    .map((pr) => {
      const ends = pr.runs.flatMap((run) =>
        run.jobs
          .filter((job) => counted(now, runner)(job).length)
          .map((job) => ts(job.completed_at)),
      );
      const first = Math.min(...pr.runs.map((run) => ts(run.created_at)));
      return Math.max(...ends) - first + (now - ts(pr.merged));
    });
  return {
    "onepipeline-ui-ci-check-time": Math.max(...prSecs.flat()),
    "onepipeline-ui-ci-job-count": Math.max(
      ...prSecs.map((secs) => secs.length),
    ),
    "onepipeline-ui-cd-job-time": Math.max(...cdSecs),
    "onepipeline-ui-cd-job-count": cdSecs.length,
    "onepipeline-ui-release-cycle-time": Math.max(...cycle),
  };
}

const scratch = mkdtempSync(
  join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "release-tail-"),
);
after(() => rmSync(scratch, { recursive: true, force: true }));
let path;
let runner;

// `publish`'s own install step, as Actions runs a `run:` step: bash, with the
// runner's RUNNER_TEMP, GITHUB_PATH and GITHUB_WORKSPACE.
before(() => {
  const steps = release().jobs.publish.steps;
  const install = steps.at(-2);
  const temp = join(scratch, "install-temp");
  mkdirSync(temp, { recursive: true });
  const githubPath = join(scratch, "github-path");
  writeFileSync(githubPath, "");
  const ran = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", install.run],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: temp,
        GITHUB_PATH: githubPath,
        GITHUB_WORKSPACE: ROOT,
      },
    },
  );
  assert.equal(ran.status, 0, `${install.name}: ${ran.stderr}`);
  // Each line of GITHUB_PATH is prepended, so the last written comes first.
  const added = readFileSync(githubPath, "utf8").trim().split("\n").reverse();
  path = [...added, process.env.PATH].join(":");
  const version = spawnSync("onevcs", ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: path },
  });
  assert.equal(version.stdout.trim(), `onevcs ${ONEVCS_ADOPTED}`);
  const publish = recordings()
    .find((r) => r.served_with)
    .body.jobs.find((job) => job.name === "publish");
  runner = publish.runner_name;
});

let serial = 0;
// The step's exact command line, from `dir` (the checkout, or a copy of it
// carrying a test budgets.yaml), as it runs in publish: the job's and the
// step's env, the runner's own variables for this release's Release run, and
// the replay double as onevcs's `gh`.
function step(dir, extra = {}) {
  serial += 1;
  const temp = join(scratch, `step-${serial}`);
  const log = join(scratch, `requests-${serial}.jsonl`);
  mkdirSync(temp, { recursive: true });
  writeFileSync(log, "");
  const missingCache = join(temp, "bin");
  mkdirSync(missingCache);
  const gh = join(missingCache, "gh");
  writeFileSync(
    gh,
    '#!/bin/sh\necho "recorded release predates cache report artifacts" >&2\nexit 1\n',
  );
  chmodSync(gh, 0o755);
  const job = release().jobs.publish;
  const last = job.steps.at(-1);
  const {
    GITHUB_EVENT_PATH: _event,
    GITHUB_TOKEN: _token,
    GH_TOKEN: _gh,
    ...inherited
  } = process.env;
  const placeholder = (value) =>
    String(value).replace(JOB_TOKEN, "replayed-token");
  const env = {
    ...inherited,
    PATH: `${missingCache}:${path}`,
    GIT_DIR: execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    GIT_WORK_TREE: ROOT,
    ...Object.fromEntries(
      Object.entries(job.env ?? {}).map(([k, v]) => [k, placeholder(v)]),
    ),
    ...Object.fromEntries(
      Object.entries(last.env ?? {}).map(([k, v]) => [k, placeholder(v)]),
    ),
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ID: String(RELEASE_RUN),
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: RELEASE,
    RUNNER_NAME: runner,
    RUNNER_TEMP: temp,
    ONEVCS_GH: DOUBLE,
    GH_REPLAY_FIXTURES: FIXTURES,
    GH_REPLAY_LOG: log,
    ...extra,
  };
  const started = Math.floor(Date.now() / 1000);
  const ran = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", last.run],
    {
      cwd: dir,
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const ended = Math.floor(Date.now() / 1000);
  const requests = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).request);
  return {
    status: ran.status,
    stdout: ran.stdout,
    stderr: ran.stderr,
    requests,
    started,
    ended,
  };
}

// onebudgetspec's text report: each budget's line, then its indented breakdown.
export function report(text) {
  const out = {};
  let current;
  for (const line of text.split("\n")) {
    const head = line.match(
      /^budget (\S+): actual (\S+) \S+, budget (\S+) \S+, .* — (within|over);/,
    );
    if (head) {
      current = {
        actual: Number(head[2]),
        threshold: Number(head[3]),
        verdict: head[4],
        detail: [],
      };
      out[head[1]] = current;
    } else if (line.startsWith("budget ")) current = undefined;
    else if (current && line.startsWith("  ")) current.detail.push(line.trim());
  }
  return out;
}

// A copy of the checkout's budgets.yaml, thresholds rewritten, beside the real
// scripts its commands run.
function withThresholds(change) {
  serial += 1;
  const dir = join(scratch, `budgets-${serial}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "scripts"));
  for (const file of ["actions-budget-figures.sh", "nx-remote-cache.mjs"])
    copyFileSync(join(ROOT, "scripts", file), join(dir, "scripts", file));
  symlinkSync(join(ROOT, ".github"), join(dir, ".github"), "dir");
  const document = parse(readFileSync(join(ROOT, "budgets.yaml"), "utf8"));
  for (const budget of document.budgets) budget.threshold = change(budget);
  writeFileSync(join(dir, "budgets.yaml"), stringify(document));
  return dir;
}

let real;
const realRun = () => {
  real ??= step(ROOT);
  return real;
};

test("over the recorded release the step reports all seven budgets, each figure the recordings' own", () => {
  const run = realRun();
  const figures = report(run.stdout);
  assert.deepEqual(
    Object.keys(figures).sort(),
    [...SEVEN].sort(),
    run.stdout + run.stderr,
  );
  for (const id of SEVEN)
    assert.ok(figures[id].detail.length > 0, `${id} has no breakdown`);
  // Over its real thresholds the recorded (pre-change) release is over, so the
  // step is red: exit 1, with every figure reported.
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stdout, /onepipeline-ui-nx-cache-use:.*error/);

  const release = recorded();
  const low = expectedFigures(release, run.started, runner);
  const high = expectedFigures(release, run.ended, runner);
  for (const id of Object.keys(low)) {
    assert.ok(
      low[id] <= figures[id].actual && figures[id].actual <= high[id],
      `${id}: reported ${figures[id].actual}, recorded ${low[id]}..${high[id]}`,
    );
  }
  // The publish job was served in progress, so it is timed to the step's now.
  assert.ok(
    figures["onepipeline-ui-cd-job-time"].detail.some((line) =>
      /^Release \/ publish: \d+s$/.test(line),
    ),
  );
});

test("each GitHub read is made once across the seven, and the read figures are the double's own count", () => {
  const run = realRun();
  const figures = report(run.stdout);
  assert.equal(
    new Set(run.requests).size,
    run.requests.length,
    `a read was made twice: ${run.requests}`,
  );
  // Every recording was asked for, and nothing else.
  assert.deepEqual(
    [...run.requests].sort(),
    recordings()
      .map((r) => r.path)
      .sort(),
  );
  const release = recorded();
  const ofPr = (pr) =>
    run.requests.filter(
      (request) =>
        request.includes(`head_sha=${pr.head}&event=pull_request`) ||
        pr.runs.some((r) => request.includes(`/actions/runs/${r.id}/jobs?`)),
    );
  const perPr = release.prs.map(ofPr);
  const own = run.requests.filter((request) => !perPr.flat().includes(request));
  assert.equal(
    figures["onepipeline-ui-release-read-requests"].actual,
    own.length,
  );
  // The release's own reads: releases, comparison, closed pull requests, the
  // runs at the release commit, and one jobs read per CD run there.
  assert.equal(own.length, 4 + release.cdRuns.length);
  assert.equal(
    figures["onepipeline-ui-pr-read-requests"].actual,
    Math.max(...perPr.map((requests) => requests.length)),
  );
});

test("each budget whose threshold lies below its recorded figure turns the step red, naming it", () => {
  const roomy = step(withThresholds(() => 1e12));
  assert.equal(roomy.status, 3, roomy.stdout + roomy.stderr);
  assert.match(roomy.stdout, /onepipeline-ui-nx-cache-use:.*error/);
  const figures = report(roomy.stdout);
  for (const id of SEVEN) assert.equal(figures[id].verdict, "within", id);
  for (const id of SEVEN) {
    const below = step(
      withThresholds((budget) =>
        budget.id === id ? Math.max(figures[id].actual - 1, 0) : 1e12,
      ),
    );
    assert.equal(below.status, 3, `${id}: ${below.stderr}`);
    const verdicts = report(below.stdout);
    assert.equal(verdicts[id].verdict, "over", id);
    for (const other of SEVEN.filter((o) => o !== id))
      assert.equal(verdicts[other].verdict, "within", `${other} beside ${id}`);
  }
});

test("a GitHub that answers an error status turns the step red", () => {
  const failed = step(ROOT, { GH_REPLAY_STATUS: "502" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /error — bash exited with status 1/);
  assert.match(failed.stdout, /GitHub answered 502/);
});

test("every recording is a non-empty response of this repository, named by its sidecar", () => {
  const records = recordings();
  assert.ok(records.length > 0);
  const changed = records.filter((r) => r.served_with);
  assert.equal(changed.length, 1, "exactly one recording is served changed");
  assert.deepEqual(Object.keys(changed[0].served_with.jobs), ["124744287660"]);
  for (const r of records) {
    assert.equal(r.status, 200, r.path);
    assert.ok(r.path.startsWith(`repos/${REPOSITORY}/`), r.path);
    assert.equal(r.fetched_from.repository, REPOSITORY, r.path);
    assert.equal(r.fetched_from.release, RELEASE, r.path);
    if (/\/actions\/runs\/\d+\/jobs/.test(r.path))
      assert.ok(r.fetched_from.run, r.path);
    assert.ok(Object.keys(r.body).length > 0, r.path);
  }
});
