// release-plz's wait for ci-cache.yml's warm-linux job, through its real
// interfaces: the workflow step's own command and environment, and the script it
// runs, against a local server standing in for GitHub's runs and jobs API. The
// warm job's steps are served under the names ci-cache.yml gives them, so a
// renamed step there is a failing journey here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { interpolate } from "../workflow-graph.mjs";

const execute = promisify(execFile);
const ROOT = resolve(".");
const REPO = "nickderobertis/onepipeline-ui";
const SHA = "4".repeat(40);
const SCRIPT = ".github/scripts/await-warm-build.mjs";
const workflow = (name) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
const steps = workflow("release-plz").jobs["release-plz"].steps;
const step = steps.find(
  (candidate) =>
    candidate.name ===
    "Wait for main's Linux Rust build when it is building cold",
);
// The warm leg's step that runs only when its restore was not the key's own.
const drop = workflow("ci-cache").jobs["warm-linux"].steps.find(
  (candidate) =>
    candidate.if === "steps.rust-cache.outputs.cache-hit != 'true'",
);

// The warm job as the jobs API reports it: running with its drop step decided
// one way or the other or not reached yet, or completed.
const warmJob = (status, dropped, conclusion = null) => ({
  status,
  conclusion,
  steps: [{ name: drop?.name, conclusion: dropped }],
});
const warm = {
  exact: warmJob("in_progress", "skipped"),
  restoring: warmJob("in_progress", null),
  cold: warmJob("in_progress", "success"),
  saved: warmJob("completed", "success", "success"),
  failed: warmJob("completed", "success", "failure"),
};

// GitHub's two reads as the script makes them. Each read of the runs list takes
// the next of `answers`, the last repeated: a warm job above, `none` for no run
// yet, `jobless` for a run without the job yet, `malformed` for a runs body with
// no list, `badjobs` for a jobs body with none, `badjob` for a warm job whose steps
// are no list, `hang` for a read that never answers, or an HTTP status.
async function github(answers) {
  const state = { requests: [], reads: 0, savedAt: undefined };
  let now;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://github.test");
    state.requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization,
    });
    const answer = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === `/repos/${REPO}/actions/workflows/ci-cache.yml/runs`) {
      now = answers[Math.min(state.reads, answers.length - 1)];
      state.reads++;
      if (now === "hang") return;
      if (typeof now === "number")
        return answer(now, { message: `answered ${now}` });
      if (now === "malformed") return answer(200, { runs: "none" });
      const own = url.searchParams.get("head_sha") === SHA && now !== "none";
      return answer(200, {
        workflow_runs: own ? [{ id: 41 }, { id: 42 }] : [],
      });
    }
    if (url.pathname === `/repos/${REPO}/actions/runs/42/jobs`) {
      if (now.status === "completed") state.savedAt ??= Date.now();
      if (now === "badjobs") return answer(200, { jobs: "none" });
      const others = [{ name: "warm-windows", status: "in_progress" }];
      const own =
        now === "badjob"
          ? { status: "in_progress", steps: { [drop.name]: "skipped" } }
          : now;
      return answer(200, {
        jobs:
          now === "jobless"
            ? others
            : [...others, { name: "warm-linux", ...own }],
      });
    }
    return answer(404, { message: `unrecorded ${request.url}` });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    state,
    api: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}

async function settle(promise) {
  try {
    const { stdout, stderr } = await promise;
    return { code: 0, stdout, stderr, endedAt: Date.now() };
  } catch (error) {
    if (error.killed) return { ...error, code: "killed", endedAt: Date.now() };
    if (typeof error.code !== "number") throw error;
    return { ...error, endedAt: Date.now() };
  }
}

// Every journey is bounded: a wait that never sees what it waits for would
// otherwise sit out the step's real 27-minute deadline.
// The child is killed first, so the journey fails rather than waiting on it.
const CHILD_TIMEOUT_MS = 15000;
const journey = (name, body) => test(name, { timeout: 20000 }, body);

const seconds = (from) => String(Math.floor(Date.now() / 1000) + from);

// The script itself, with a short poll so a journey of several reads is quick.
function script(api, args, env = { GITHUB_REPOSITORY: REPO }) {
  return settle(
    execute("node", [SCRIPT, ...args], {
      cwd: ROOT,
      timeout: CHILD_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: api,
        GH_TOKEN: "token",
        ...env,
      },
    }),
  );
}
const polled = (until, interval = "0.1") => [
  "--sha",
  SHA,
  "--until",
  until,
  "--interval",
  interval,
];

// The guard step's own command, run as the runner would, and the `started` it
// writes to $GITHUB_OUTPUT.
async function guardStarted() {
  const guard = steps.find((candidate) => candidate.id === "guard");
  const dir = mkdtempSync(join(tmpdir(), "await-warm-build-guard-"));
  try {
    const output = join(dir, "output");
    const result = await settle(
      execute(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", guard.run],
        {
          timeout: CHILD_TIMEOUT_MS,
          env: {
            PATH: process.env.PATH,
            TOKEN: "a-pat",
            GITHUB_OUTPUT: output,
          },
        },
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    const started = readFileSync(output, "utf8").match(/^started=(\d+)$/m)?.[1];
    assert.ok(started, "the guard writes when the job started");
    assert.ok(Math.abs(Number(started) - Date.now() / 1000) < 10);
    return Number(started);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The step's own command and environment, as the runner would start them.
function workflowStep(host, started) {
  const context = {
    github: { sha: SHA, token: "a-token" },
    steps: { guard: { outputs: { started: String(started) } } },
  };
  const env = Object.fromEntries(
    Object.entries(step.env).map(([name, value]) => [
      name,
      String(interpolate(value, context) ?? ""),
    ]),
  );
  return settle(
    execute(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
      {
        cwd: ROOT,
        timeout: CHILD_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH,
          GITHUB_API_URL: host.api,
          GITHUB_REPOSITORY: REPO,
          ...env,
        },
      },
    ),
  );
}

journey(
  "the step runs on the pushes release-plz updates the release PR on, just before that update",
  () => {
    const at = steps.indexOf(step);
    assert.ok(at > 0, "release-plz.yml has the wait step");
    assert.equal(steps[at + 1].name, "Open or update the release PR");
    assert.equal(step.if, steps[at + 1].if);
    assert.ok(drop, "ci-cache.yml's warm-linux drops an inexact restore");
  },
);

journey(
  "the step's own command returns at once when warm-linux restored its key's own build",
  async () => {
    const host = await github([warm.exact]);
    try {
      const result = await workflowStep(host, await guardStarted());
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        "warm-linux (run 42) restored this key's own build, which the release pull request restores too; waited 0 s.\n",
      );
      assert.equal(result.stderr, "");
      // The newest run for this push, read with the job's own token.
      assert.deepEqual(host.state.requests[0].query, {
        head_sha: SHA,
        event: "push",
      });
      assert.equal(
        host.state.requests[1].path,
        `/repos/${REPO}/actions/runs/42/jobs`,
      );
      for (const request of host.state.requests)
        assert.equal(request.authorization, "Bearer a-token");
    } finally {
      await host.close();
    }
  },
);

journey(
  "the step's own command returns once a cold warm-linux has saved the build",
  async () => {
    const host = await github([warm.saved]);
    try {
      const result = await workflowStep(host, await guardStarted());
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /^warm-linux \(run 42\) saved this key's build/,
      );
      assert.equal(result.stderr, "");
    } finally {
      await host.close();
    }
  },
);

journey(
  "a cold build is waited for until it completes, through a missing run, an outage and a malformed answer",
  async () => {
    const host = await github([
      "none",
      "jobless",
      502,
      429,
      "malformed",
      "badjobs",
      "badjob",
      warm.restoring,
      warm.cold,
      warm.cold,
      warm.saved,
    ]);
    try {
      const result = await script(host.api, polled(seconds(60)));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(host.state.reads, 11);
      assert.ok(host.state.savedAt <= result.endedAt);
      assert.match(
        result.stdout,
        /^warm-linux \(run 42\) saved this key's build; waited \d+ s\.\n$/,
      );
      assert.equal(result.stderr, "");
    } finally {
      await host.close();
    }
  },
);

journey(
  "the step's own deadline is 27 minutes after the guard's start",
  async () => {
    const host = await github([warm.cold]);
    try {
      // A job that began 27 minutes ago has no room left for one more poll.
      const started = (await guardStarted()) - 27 * 60 + 5;
      const result = await workflowStep(host, started);
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stderr,
        /^::warning::warm-linux had not saved the build when this job's room to wait ran out \(warm-linux was 'in_progress'\)/,
      );
      assert.equal(host.state.reads, 1);
    } finally {
      await host.close();
    }
  },
);

journey(
  "GITHUB_TOKEN stands in for GH_TOKEN, and with neither the reads go unauthenticated",
  async () => {
    for (const [env, authorization] of [
      [{ GITHUB_TOKEN: "fallback" }, "Bearer fallback"],
      [{}, undefined],
    ]) {
      const host = await github([warm.exact]);
      try {
        const result = await settle(
          execute("node", [SCRIPT, ...polled(seconds(60))], {
            cwd: ROOT,
            timeout: CHILD_TIMEOUT_MS,
            env: {
              PATH: process.env.PATH,
              GITHUB_API_URL: host.api,
              GITHUB_REPOSITORY: REPO,
              ...env,
            },
          }),
        );
        assert.equal(result.code, 0, result.stderr);
        assert.ok(host.state.requests.length > 0);
        for (const request of host.state.requests)
          assert.equal(request.authorization, authorization);
      } finally {
        await host.close();
      }
    }
  },
);

journey(
  "--repo names the repository read when GITHUB_REPOSITORY is unset",
  async () => {
    const host = await github([warm.exact]);
    try {
      const result = await script(
        host.api,
        [...polled(seconds(60)), "--repo", REPO],
        {},
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /restored this key's own build/);
    } finally {
      await host.close();
    }
  },
);

journey(
  "at the deadline a build still cold, or a read that never answers, warns and lets the update go ahead",
  async () => {
    for (const [answer, reason] of [
      [warm.cold, /\(warm-linux was 'in_progress'\)/],
      ["hang", /\(the last read failed: .+\)/],
    ]) {
      const host = await github([answer]);
      try {
        const started = Date.now();
        const result = await script(host.api, polled(seconds(2), "0.2"));
        assert.equal(result.code, 0, result.stderr);
        assert.match(
          result.stderr,
          /^::warning::warm-linux had not saved the build when this job's room to wait ran out/,
        );
        assert.match(result.stderr, reason);
        assert.match(
          result.stderr,
          /ACTION: if that attempt is cancelled, rerun its test-linux/,
        );
        assert.ok(Date.now() - started < 5000, "it stopped at the deadline");
      } finally {
        await host.close();
      }
    }
  },
);

journey(
  "a warm build that failed, or a read GitHub refuses, warns at once and lets the update go ahead",
  async () => {
    for (const [answer, warning] of [
      [
        warm.failed,
        /^::warning::warm-linux \(run 42\) ended 'failure'.* ACTION: read warm-linux in ci-cache\.yml run 42/,
      ],
      [
        403,
        /^::warning::GitHub refused the read of warm-linux: .*HTTP 403\. ACTION: check that release-plz\.yml grants its job 'actions: read'/,
      ],
      [404, /^::warning::GitHub refused the read of warm-linux: .*HTTP 404/],
    ]) {
      const host = await github([answer]);
      try {
        const result = await script(host.api, polled(seconds(60), "30"));
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stderr, warning);
        assert.equal(host.state.reads, 1, "nothing was waited for");
      } finally {
        await host.close();
      }
    }
  },
);

journey(
  "a usage error exits 2, names what was wrong, and reads nothing",
  async () => {
    const host = await github([warm.exact]);
    const sha = ["--sha", SHA];
    const until = ["--until", seconds(60)];
    try {
      for (const [args, message, env] of [
        [until, /--sha must be a full commit id/],
        [["--sha", "abc", ...until], /--sha must be a full commit id/],
        [["--sha"], /--sha needs a value/],
        [["--sha", "", ...until], /--sha needs a value/],
        [["--sha", ...until], /--sha needs a value/],
        [sha, /--until must be a time in epoch seconds/],
        [[...sha, "--until", "soon"], /--until must be a time/],
        [
          [...sha, "--until", seconds(2 * 24 * 60 * 60)],
          /at most 86400 s from now/,
        ],
        [[...sha, ...until, "--interval", "7200"], /at most 3600/],
        [
          [...sha, ...until, "--interval", "0"],
          /--interval must be a positive number/,
        ],
        [[...sha, ...until, "--wait", "1"], /unknown argument: --wait/],
        [[...sha, ...until], /no repository/, { GITHUB_REPOSITORY: "" }],
        [[...sha, ...until, "--repo", "not a repo"], /no repository/],
        [
          [...sha, ...until],
          /GITHUB_API_URL is not a URL/,
          { GITHUB_API_URL: "::" },
        ],
        [
          [...sha, ...until],
          /GITHUB_API_URL must use HTTPS or loopback HTTP/,
          { GITHUB_API_URL: "http://github.example" },
        ],
      ]) {
        const result = await script(host.api, args, {
          GITHUB_REPOSITORY: REPO,
          ...env,
        });
        assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
        assert.match(result.stderr, message);
        assert.match(result.stderr, /^usage: /m);
      }
      assert.deepEqual(host.state.requests, []);
    } finally {
      await host.close();
    }
  },
);
