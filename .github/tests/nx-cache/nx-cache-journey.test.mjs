import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { evaluate } from "../../workflow-graph.mjs";
import {
  cacheSession,
  GithubCache,
  json,
  recordedREST,
  reportZip,
  run,
  sessionEnvironment,
  sidecarCheckout,
  sourceMetadata,
} from "./nx-cache-journey.mjs";
import { workspaceFixture } from "./nx-fixture.mjs";

// Preserve the recorded trust inputs (user, head.repo and base.repo). Only the
// selection ids are synthetic, so each independent local journey has its own scope.
const payload = (identity) => {
  const recorded = json(
    `.github/tests/nx-cache/events/${identity}.json`,
  ).pull_request;
  return {
    repository: { full_name: recorded.base.repo.full_name },
    pull_request: {
      ...recorded,
      number: 1,
      head: { ...recorded.head, sha: "1".repeat(40) },
      base: { ...recorded.base, sha: "2".repeat(40) },
    },
  };
};

test("workflow cache steps run the real task and sidecar, with untrusted PRs read-only", async () => {
  const cwd = workspaceFixture();
  const cache = await new GithubCache().start();
  try {
    await assert.rejects(sidecarCheckout(cwd), /ACTION: run just nx run/);
    for (const identity of ["fork", "dependabot", "maintainer"]) {
      rmSync(join(cwd, ".nx"), { recursive: true, force: true });
      const session = await cacheSession(
        cwd,
        cache,
        join(cwd, `record-${identity}`),
        payload(identity),
      );
      try {
        assert.equal(
          session.outputs.read_only,
          String(identity !== "maintainer"),
        );
        assert.equal(
          session.env.CACHE_READ_ONLY,
          identity === "maintainer" ? "" : "1",
        );
        await session.nx();
        if (identity === "maintainer") {
          await session.nx([
            "run",
            "timeline-categories:manifest-inputs-for-affected",
          ]);
          await session.nx(["run", "dag-ui:build"]);
        }
      } finally {
        await session.close();
      }
      const manifest = json(
        join(session.temp, "nx-cache-report/manifest.json"),
      );
      assert.equal(manifest.entries.length, identity === "maintainer" ? 1 : 0);
      assert.equal(cache.entries.size, identity === "maintainer" ? 1 : 0);
      const outputSizes = readFileSync(
        join(session.temp, "report.log"),
        "utf8",
      );
      if (identity === "maintainer")
        assert.match(outputSizes, /\d+\s+apps\/dag-ui\/dist/);
      else
        assert.match(
          outputSizes,
          /apps\/dag-ui\/dist: not built in this workspace/,
        );
      if (identity === "maintainer") {
        assert.ok(manifest.stored_bytes > 0);
        rmSync(join(cwd, ".nx"), { recursive: true, force: true });
        const replay = await cacheSession(
          cwd,
          cache,
          join(cwd, "record-replay"),
          payload(identity),
          { GITHUB_RUN_ID: "2" },
        );
        try {
          await replay.nx();
        } finally {
          await replay.close();
        }
        const executions = json(
          join(replay.temp, "nx-cache-report/executions.json"),
        );
        assert.equal(
          executions.tasks.find(
            (task) => task.task === "timeline-categories:test",
          ).result,
          "remote_hit",
        );
        rmSync(join(cwd, ".nx"), { recursive: true, force: true });
        const releasePayload = payload(identity);
        releasePayload.pull_request.head.ref = "release-plz-next";
        const sweep = await cacheSession(
          cwd,
          cache,
          join(cwd, "release-sweep"),
          releasePayload,
          { GITHUB_RUN_ID: "3" },
        );
        try {
          await sweep.nx([
            "run-many",
            "-t",
            "test",
            "-p",
            "timeline-categories",
          ]);
        } finally {
          await sweep.close();
        }
        assert.deepEqual(
          json(join(sweep.temp, "nx-cache-report/executions.json")).selection,
          {
            mode: "affected",
            base_sha: releasePayload.pull_request.base.sha,
            head_sha: releasePayload.pull_request.head.sha,
          },
        );
      }
    }
    assert.ok(!cache.calls.some((call) => call.method === "DELETE"));
  } finally {
    await cache.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("merge promotion reuses the latest replay-only report and never promotes untrusted or missing reports", async () => {
  const cwd = workspaceFixture();
  const cache = await new GithubCache().start();
  try {
    const first = await cacheSession(
      cwd,
      cache,
      join(cwd, "store"),
      payload("maintainer"),
    );
    try {
      await first.nx();
    } finally {
      await first.close();
    }
    sourceMetadata(cache, join(first.temp, "nx-cache-report"));
    rmSync(join(cwd, ".nx"), { recursive: true, force: true });
    const latest = await cacheSession(
      cwd,
      cache,
      join(cwd, "replay"),
      payload("maintainer"),
      { GITHUB_RUN_ID: "2" },
    );
    try {
      await latest.nx();
    } finally {
      await latest.close();
    }
    const reports = join(latest.temp, "nx-cache-report");
    assert.equal(
      json(join(reports, "manifest.json")).entries[0].source,
      "replayed",
    );
    const { pr } = sourceMetadata(cache, reports, { runId: 2 });
    const main = await cacheSession(
      cwd,
      cache,
      join(cwd, "merge"),
      { ref: "refs/heads/main" },
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: "4".repeat(40),
      },
      "release-plz",
      "release-plz",
    );
    try {
      const promote = main.steps.find((step) =>
        step.run?.includes("nx-remote-cache.mjs promote"),
      );
      // The release CLI is doubled at its executable boundary; cache code and sidecar are real.
      const bin = join(cwd, "release-plz");
      writeFileSync(
        bin,
        '#!/bin/sh\nprintf "release-plz ran\\n" >> "$RUNNER_TEMP/release-ran"\n',
      );
      chmodSync(bin, 0o755);
      main.env.PATH = `${cwd}:${main.env.PATH}`;
      const release = main.steps.find(
        (step) => step.name === "Tag and publish a merged version bump",
      );
      for (const identity of ["fork", "dependabot", "missing", "trusted"]) {
        cache.metadata.set(
          "/repos/nickderobertis/onepipeline-ui/actions/runs/2/artifacts",
          {
            artifacts:
              identity === "missing"
                ? []
                : [sourceMetadata(cache, reports, { runId: 2 }).artifact],
          },
        );
        // Restore the selected PR after registering the artifact metadata.
        const identityPr =
          identity === "fork" || identity === "dependabot"
            ? payload(identity).pull_request
            : pr;
        main.env.GITHUB_REPOSITORY = identityPr.base.repo.full_name;
        const selected = {
          ...pr,
          user: identityPr.user,
          head: { ...pr.head, repo: identityPr.head.repo },
          base: { ...pr.base, repo: identityPr.base.repo },
        };
        cache.metadata.set(
          `/repos/${main.env.GITHUB_REPOSITORY}/commits/${"4".repeat(40)}/pulls`,
          [selected],
        );
        rmSync(join(main.temp, "nx-cache-evidence"), {
          recursive: true,
          force: true,
        });
        await main.execute(promote.run);
        await main.execute(release.run);
        const baseEntries = [...cache.entries.keys()].filter((key) =>
          key.startsWith("refs/heads/main:"),
        );
        assert.equal(
          baseEntries.length,
          identity === "trusted" ? 1 : 0,
          `${identity}: ${readFileSync(join(main.temp, "summary"), "utf8")}`,
        );
      }
      const summary = readFileSync(join(main.temp, "summary"), "utf8");
      assert.match(summary, /fork head/);
      assert.match(summary, /Dependabot author/);
      assert.match(summary, /missing artifact/);
      assert.match(summary, /1 promoted/);
      assert.equal(
        readFileSync(join(main.temp, "release-ran"), "utf8").trim().split("\n")
          .length,
        4,
      );
    } finally {
      await main.close();
    }
    const manual = await cacheSession(
      cwd,
      cache,
      join(cwd, "manual"),
      { ref: "refs/heads/cache-promote/1" },
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/cache-promote/1",
        GITHUB_REF_NAME: "cache-promote/1",
        GITHUB_SHA: "1".repeat(40),
      },
      "release-plz",
      "release-plz",
    );
    try {
      await manual.execute(
        manual.steps.find((step) =>
          step.run?.includes("nx-remote-cache.mjs promote"),
        ).run,
      );
      assert.ok(
        [...cache.entries.keys()].some((key) =>
          key.startsWith("refs/heads/cache-promote/1:"),
        ),
      );
      const context = {
        github: {
          event_name: "push",
          ref: "refs/heads/cache-promote/1",
          event: { head_commit: { message: "demonstration promotion" } },
        },
        steps: {
          guard: { outputs: { enabled: "true" } },
          baseline: { outputs: { root: "baseline" } },
        },
      };
      for (const step of manual.steps.filter((step) =>
        /release-plz (?:release|update)|just semver-check|gh pr merge/.test(
          step.run || "",
        ),
      ))
        assert.equal(evaluate(step.if, context).value, false);
    } finally {
      await manual.close();
    }
    rmSync(join(cwd, ".nx"), { recursive: true, force: true });
    const other = await cacheSession(
      cwd,
      cache,
      join(cwd, "other-pr"),
      payload("maintainer"),
      { GITHUB_REF: "refs/pull/3/merge", GITHUB_RUN_ID: "3" },
    );
    try {
      await other.nx();
    } finally {
      await other.close();
    }
    assert.equal(
      json(join(other.temp, "nx-cache-report/executions.json")).tasks[0].result,
      "remote_hit",
    );
    assert.ok(
      [...cache.entries.keys()].some((key) =>
        key.startsWith("refs/pull/1/merge:"),
      ),
    );
    assert.ok(!cache.calls.some((call) => call.method === "DELETE"));
  } finally {
    await cache.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cache-use under onebudgetspec measures real executions behind simulated release selection", async () => {
  const cwd = workspaceFixture();
  const cache = await new GithubCache().start();
  const repo = "/repos/nickderobertis/onepipeline-ui";
  try {
    const git = async (...args) =>
      (await run("git", args, { cwd })).stdout.trim();
    await git(
      "-c",
      "user.name=Cache journey",
      "-c",
      "user.email=cache@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture base",
    );
    const base = await git("rev-parse", "HEAD");
    writeFileSync(
      join(cwd, ".gitignore"),
      `${readFileSync(join(cwd, ".gitignore"), "utf8")}\n/observations/\n`,
    );
    writeFileSync(
      join(cwd, "README.md"),
      `${readFileSync(join(cwd, "README.md"), "utf8")}\n`,
    );
    await git("add", "README.md", ".gitignore");
    await git(
      "-c",
      "user.name=Cache journey",
      "-c",
      "user.email=cache@example.invalid",
      "commit",
      "-qm",
      "published input",
    );
    const merge = await git("rev-parse", "HEAD");
    writeFileSync(
      join(cwd, "CHANGELOG.md"),
      `${readFileSync(join(cwd, "CHANGELOG.md"), "utf8")}\n`,
    );
    await git("add", "CHANGELOG.md");
    await git(
      "-c",
      "user.name=Cache journey",
      "-c",
      "user.email=cache@example.invalid",
      "commit",
      "-qm",
      "simulated release",
    );
    const tip = await git("rev-parse", "HEAD");
    const ordinary = payload("maintainer");
    ordinary.pull_request.base.sha = base;
    const initialPush = structuredClone(ordinary);
    initialPush.pull_request.head.sha = "0".repeat(40);
    const first = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/first"),
      initialPush,
    );
    try {
      await first.nx();
    } finally {
      await first.close();
    }
    const initialRecord = sourceMetadata(
      cache,
      join(first.temp, "nx-cache-report"),
      {
        base,
        merge,
        head: initialPush.pull_request.head.sha,
      },
    );
    rmSync(join(cwd, ".nx"), { recursive: true, force: true });
    const retry = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/retry"),
      ordinary,
      { GITHUB_RUN_ID: "2" },
    );
    try {
      await retry.nx();
    } finally {
      await retry.close();
    }
    const source = sourceMetadata(cache, join(retry.temp, "nx-cache-report"), {
      runId: 2,
      base,
      merge,
    });
    const promotion = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/promotion"),
      { ref: "refs/heads/main" },
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: merge,
      },
      "release-plz",
      "release-plz",
    );
    try {
      await promotion.execute(
        promotion.steps.find((step) =>
          step.run?.includes("nx-remote-cache.mjs promote"),
        ).run,
      );
    } finally {
      await promotion.close();
    }
    rmSync(join(cwd, ".nx"), { recursive: true, force: true });
    const released = payload("maintainer");
    released.pull_request.number = 2;
    released.pull_request.base.sha = merge;
    released.pull_request.head.sha = "5".repeat(40);
    const release = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/release"),
      released,
      { GITHUB_REF: "refs/pull/2/merge", GITHUB_RUN_ID: "3" },
    );
    try {
      await release.nx();
    } finally {
      await release.close();
    }
    const releaseRecord = sourceMetadata(
      cache,
      join(release.temp, "nx-cache-report"),
      { runId: 3, prNumber: 2, head: "5".repeat(40), base: merge, merge: tip },
    );
    const receipt = json(
      join(promotion.temp, "nx-cache-promotion/receipt.json"),
    );
    const repository = source.pr.base.repo;
    cache.metadata.set(`${repo}/releases`, [
      {
        ...recordedREST("release"),
        tag_name: "simulated-next",
        draft: false,
        published_at: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    cache.metadata.set(`${repo}/commits/simulated-next`, {
      ...recordedREST("commit"),
      sha: tip,
    });
    cache.metadata.set(`${repo}/commits?sha=simulated-next`, [
      { ...recordedREST("commit"), sha: merge },
      { ...recordedREST("commit"), sha: tip },
    ]);
    cache.metadata.set(`${repo}/actions/workflows/release-plz.yml/runs`, {
      ...recordedREST("runs"),
      workflow_runs: [
        {
          ...recordedREST("run"),
          id: 4,
          run_attempt: 1,
          head_sha: merge,
          head_branch: "main",
          event: "push",
          head_repository: repository,
          updated_at: receipt.promoted_at,
        },
      ],
    });
    cache.metadata.set(`${repo}/actions/runs/4/artifacts`, {
      ...recordedREST("artifacts"),
      artifacts: [
        {
          ...recordedREST("artifacts").artifacts[0],
          id: 401,
          name: `nx-cache-promotion-${merge}`,
          expired: false,
          workflow_run: {
            ...recordedREST("artifacts").artifacts[0].workflow_run,
            id: 4,
            head_sha: merge,
            head_repository_id: repository.id,
          },
        },
      ],
    });
    cache.metadata.set(
      `${repo}/actions/artifacts/401/zip`,
      reportZip(join(promotion.temp, "nx-cache-promotion")),
    );
    cache.metadata.set(`${repo}/commits/${merge}`, {
      ...recordedREST("commit"),
      sha: merge,
    });
    cache.metadata.set(`${repo}/compare/${merge}...${merge}`, {
      ...recordedREST("compare"),
      status: "identical",
    });
    let attempt = 0;
    const measure = async () => {
      attempt++;
      try {
        return await run(
          process.execPath,
          [
            join(
              process.cwd(),
              "node_modules/@onebudgetspec/cli/bin/onebudgetspec.js",
            ),
            "check",
            "budgets.yaml",
            "--id",
            "onepipeline-ui-nx-cache-use",
          ],
          {
            cwd,
            env: {
              ...release.env,
              GITHUB_REF_NAME: "simulated-next",
              RUNNER_TEMP: join(cwd, `observations/measurement-${attempt}`),
            },
            maxBuffer: 16 * 1024 * 1024,
          },
        );
      } catch (error) {
        return error;
      }
    };
    const observed = await measure();
    assert.match(observed.stdout, /actual 100 percent/);
    assert.match(observed.stdout, /aggregate: 2\/2 remote hits/);
    assert.match(observed.stdout, /within/);
    // GitHub's recorded run shows this behavior: its embedded PR head moved
    // after the run, while head_sha and the saved execution stayed unchanged.
    const association = initialRecord.source.pull_requests[0];
    const priorHead = association.head.sha;
    association.head.sha = source.pr.head.sha;
    initialRecord.pr.head.sha = source.pr.head.sha;
    const earlierPush = await measure();
    assert.match(earlierPush.stdout, /actual 100 percent/);
    assert.match(earlierPush.stdout, /aggregate: 2\/2 remote hits/);
    association.head.sha = priorHead;
    initialRecord.pr.head.sha = priorHead;
    // Re-read the same real artifacts with unavailable or untrusted GitHub metadata.
    source.artifact.expired = true;
    const expired = await measure();
    assert.match(expired.stdout, /error/);
    assert.doesNotMatch(expired.stdout, /— within/);
    source.artifact.expired = false;
    releaseRecord.artifact.expired = true;
    const missing = await measure();
    assert.match(missing.stdout, /error/);
    assert.doesNotMatch(missing.stdout, /— within/);
    releaseRecord.artifact.expired = false;
    const jobPath = `${repo}/actions/runs/2/attempts/1/jobs`;
    const jobs = cache.metadata.get(jobPath);
    cache.metadata.set(jobPath, {
      jobs: [
        ...jobs.jobs,
        { name: "lint", conclusion: "success", labels: ["ubuntu-latest"] },
      ],
    });
    const noJob = await measure();
    assert.match(noJob.stdout, /missing artifact.*lint/);
    assert.doesNotMatch(noJob.stdout, /— within/);
    cache.metadata.set(jobPath, jobs);
    const receiptPath = join(promotion.temp, "nx-cache-promotion/receipt.json");
    const receiptBytes = readFileSync(receiptPath);
    writeFileSync(
      receiptPath,
      JSON.stringify({ ...receipt, scope: "refs/heads/untrusted" }),
    );
    cache.metadata.set(
      `${repo}/actions/artifacts/401/zip`,
      reportZip(join(promotion.temp, "nx-cache-promotion")),
    );
    const untrusted = await measure();
    assert.match(untrusted.stdout, /untrusted promotion/);
    assert.doesNotMatch(untrusted.stdout, /— within/);
    writeFileSync(receiptPath, receiptBytes);
    cache.metadata.set(
      `${repo}/actions/artifacts/401/zip`,
      reportZip(join(promotion.temp, "nx-cache-promotion")),
    );
    let nextRun = 10;
    const advance = async (
      name,
      { clearLocal = true, mode = "live", head = "5".repeat(40) } = {},
    ) => {
      nextRun++;
      if (clearLocal)
        rmSync(join(cwd, ".nx"), { recursive: true, force: true });
      cache.mode = mode;
      const event = structuredClone(released);
      event.pull_request.head.sha = head;
      const session = await cacheSession(
        cwd,
        cache,
        join(cwd, `observations/${name}`),
        event,
        { GITHUB_REF: "refs/pull/2/merge", GITHUB_RUN_ID: String(nextRun) },
      );
      try {
        await session.nx();
      } finally {
        await session.close();
      }
      const record = sourceMetadata(
        cache,
        join(session.temp, "nx-cache-report"),
        { runId: nextRun, prNumber: 2, head, base: merge, merge: tip },
      );
      cache.metadata.set(`${repo}/releases`, [
        {
          ...recordedREST("release"),
          tag_name: "simulated-next",
          draft: false,
          published_at: new Date(Date.now() + 1000).toISOString(),
        },
      ]);
      return { record, session };
    };
    cache.entries.clear(); // Eviction at the doubled GitHub boundary, not a production deletion.
    await advance("evicted");
    const evicted = await measure();
    assert.match(evicted.stdout, /actual 50 percent/);
    assert.match(evicted.stdout, /aggregate: 1\/2 remote hits/);
    assert.match(evicted.stdout, /evicted/);
    assert.match(evicted.stdout, /— over/);
    assert.equal(
      evicted.code,
      1,
      "over its line, the release tail's step goes red",
    );
    const local = await advance("local", { clearLocal: false });
    assert.equal(
      json(join(local.session.temp, "nx-cache-report/executions.json")).tasks[0]
        .result,
      "local_hit",
    );
    const localFigure = await measure();
    assert.match(localFigure.stdout, /aggregate: 1\/1 remote hits/);
    assert.match(localFigure.stdout, /skipped local hits: 1/);
    // Each failed promotion receipt is produced by the real CLI and sidecar.
    for (const mode of ["fault", "throttled"]) {
      cache.entries.clear();
      cache.mode = mode;
      const failedPromotion = await cacheSession(
        cwd,
        cache,
        join(cwd, `observations/promote-${mode}`),
        { ref: "refs/heads/main" },
        {
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REF_NAME: "main",
          GITHUB_SHA: merge,
        },
        "release-plz",
        "release-plz",
      );
      try {
        await failedPromotion.execute(
          failedPromotion.steps.find((step) =>
            step.run?.includes("nx-remote-cache.mjs promote"),
          ).run,
        );
      } finally {
        await failedPromotion.close();
      }
      const failedReceipt = json(
        join(failedPromotion.temp, "nx-cache-promotion/receipt.json"),
      );
      assert.ok(
        failedReceipt.attempts.some(
          (entry) => entry.status === "failed" || entry.status === "throttled",
        ),
      );
      cache.metadata.set(
        `${repo}/actions/artifacts/401/zip`,
        reportZip(join(failedPromotion.temp, "nx-cache-promotion")),
      );
      await advance(`after-${mode}`, { mode });
      const failure = await measure();
      assert.match(failure.stdout, /actual 50 percent/);
      assert.match(failure.stdout, /aggregate: 1\/2 remote hits/);
      assert.match(failure.stdout, /miss .*failed|miss .*throttled/);
    }
    cache.metadata.set(`${repo}/actions/workflows/release-plz.yml/runs`, {
      ...recordedREST("runs"),
      workflow_runs: [],
    });
    cache.entries.clear();
    await advance("never-promoted");
    const never = await measure();
    assert.match(never.stdout, /actual 50 percent/);
    assert.match(never.stdout, /never_promoted/);
    const sourceFile = join(cwd, "packages/timeline-categories/src/index.ts");
    const original = readFileSync(sourceFile, "utf8");
    writeFileSync(sourceFile, `${original}\n// changed hash probe\n`);
    await advance("fresh", { head: "6".repeat(40) });
    const fresh = await measure();
    assert.match(fresh.stdout, /aggregate: 1\/1 remote hits/);
    writeFileSync(sourceFile, original);
    const last = await advance("fresh-local", {
      clearLocal: false,
      head: "7".repeat(40),
    });
    // A second run of that same source is local; its new PR head does not add a remote execution.
    const lastLocal = await advance("local-final", {
      clearLocal: false,
      head: "7".repeat(40),
    });
    assert.equal(
      json(join(lastLocal.session.temp, "nx-cache-report/executions.json"))
        .tasks[0].result,
      "local_hit",
    );
    const listing = cache.metadata.get(`${repo}/actions/workflows/ci.yml/runs`);
    listing.workflow_runs = listing.workflow_runs.filter(
      (record) => record.id === 1 || record.id === lastLocal.record.source.id,
    );
    // This selection keeps only the first proving push as the merged source
    // head, plus a release execution that hit its local cache: nothing is eligible.
    source.pr.head.sha = initialPush.pull_request.head.sha;
    const zero = await measure();
    assert.match(zero.stdout, /zero eligible executions/);
    assert.doesNotMatch(zero.stdout, /— within/);
    assert.ok(last.record.source.id < lastLocal.record.source.id);
    assert.ok(!cache.calls.some((call) => call.method === "DELETE"));
  } finally {
    await cache.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The daemon gh's keyring lookup autolaunches outlives every test that started
// it, and enough of them use up a host's inotify instances. A `dbus-launch` that
// only records and fails stands first on gh's PATH, so even a failure starts none.
// gh looks in the keyring before it connects, so a closed loopback port is enough
// to ask with, and the journeys above still own what gh receives from the fake.
test("the session's real gh asks for no session bus", (t) => {
  if (process.platform !== "linux")
    return t.skip("gh autolaunches a session bus only on Linux");
  if (spawnSync("gh", ["--version"]).error)
    return t.skip("gh is not installed, so nothing here can ask for a bus");
  const scratch = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "session-bus-"),
  );
  try {
    const record = join(scratch, "asked");
    const recorder = join(scratch, "dbus-launch");
    writeFileSync(
      recorder,
      `#!/bin/sh\necho asked >> ${JSON.stringify(record)}\nexit 1\n`,
    );
    chmodSync(recorder, 0o755);
    const asked = () =>
      existsSync(record)
        ? readFileSync(record, "utf8").trim().split("\n").length
        : 0;
    const url = "http://127.0.0.1:9";
    const { DBUS_SESSION_BUS_ADDRESS: _ambient, ...inherited } = process.env;
    const session = sessionEnvironment({
      cwd: scratch,
      cache: { url },
      temp: scratch,
      payload: payload("maintainer"),
      document: parse(readFileSync(".github/workflows/ci.yml", "utf8")),
      job: "test-linux",
      inherited,
    });
    const gh = (env) =>
      spawnSync("gh", ["api", "--method", "GET", `${url}/repos/owner/repo`], {
        encoding: "utf8",
        env: { ...env, PATH: `${scratch}:${env.PATH}` },
        timeout: 60000,
      });

    const { DBUS_SESSION_BUS_ADDRESS: _site, ...bare } = session;
    const control = gh(bare);
    if (asked() === 0)
      return t.skip(
        "this gh asks for no bus without the variable, so none can leak",
      );
    assert.equal(asked(), 1, "the control asks for a bus exactly once");

    rmSync(record);
    const held = gh(session);
    assert.equal(
      asked(),
      0,
      "cacheSession's environment must set DBUS_SESSION_BUS_ADDRESS=disabled:",
    );
    assert.equal(held.status, control.status, held.stderr);
    assert.equal(held.stdout, control.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
