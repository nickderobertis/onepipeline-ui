import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluate } from "../../workflow-graph.mjs";
import {
  cacheSession,
  GithubCache,
  json,
  reportZip,
  run,
  sourceMetadata,
} from "./nx-cache-journey.mjs";
import { workspaceFixture } from "./nx-fixture.mjs";

const payload = (identity) => ({
  repository: { full_name: "nickderobertis/onepipeline-ui" },
  pull_request: {
    number: 1,
    head: {
      sha: "1".repeat(40),
      repo: {
        full_name:
          identity === "fork"
            ? "contributor/onepipeline-ui"
            : "nickderobertis/onepipeline-ui",
      },
    },
    base: {
      sha: "2".repeat(40),
      repo: { full_name: "nickderobertis/onepipeline-ui" },
    },
    user: {
      login: identity === "dependabot" ? "dependabot[bot]" : "maintainer",
    },
  },
});

test("workflow cache steps run the real task and sidecar, with untrusted PRs read-only", async () => {
  const cwd = workspaceFixture();
  const cache = await new GithubCache().start();
  try {
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
      } finally {
        await session.close();
      }
      const manifest = json(
        join(session.temp, "nx-cache-report/manifest.json"),
      );
      assert.equal(manifest.entries.length, identity === "maintainer" ? 1 : 0);
      assert.equal(cache.entries.size, identity === "maintainer" ? 1 : 0);
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
          "/repos/nickderobertis/onepipeline-ui/commits/" +
            "4".repeat(40) +
            "/pulls",
          [
            {
              ...pr,
              head: {
                ...pr.head,
                repo: {
                  ...pr.head.repo,
                  full_name:
                    identity === "fork" ? "fork/ui" : pr.head.repo.full_name,
                },
              },
              user: {
                login:
                  identity === "dependabot" ? "dependabot[bot]" : "maintainer",
              },
            },
          ],
        );
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
        const selected = {
          ...pr,
          head: {
            ...pr.head,
            repo: {
              ...pr.head.repo,
              full_name:
                identity === "fork" ? "fork/ui" : pr.head.repo.full_name,
            },
          },
          user: {
            login: identity === "dependabot" ? "dependabot[bot]" : "maintainer",
          },
        };
        cache.metadata.set(
          "/repos/nickderobertis/onepipeline-ui/commits/" +
            "4".repeat(40) +
            "/pulls",
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
    const first = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/first"),
      ordinary,
    );
    try {
      await first.nx();
    } finally {
      await first.close();
    }
    sourceMetadata(cache, join(first.temp, "nx-cache-report"), { base, merge });
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
    const repository = { id: 1, full_name: "nickderobertis/onepipeline-ui" };
    cache.metadata.set(`${repo}/releases`, [
      {
        tag_name: "simulated-next",
        draft: false,
        published_at: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    cache.metadata.set(`${repo}/commits/simulated-next`, { sha: tip });
    cache.metadata.set(`${repo}/commits?sha=simulated-next`, [
      { sha: merge },
      { sha: tip },
    ]);
    cache.metadata.set(`${repo}/actions/workflows/release-plz.yml/runs`, {
      workflow_runs: [
        {
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
      artifacts: [
        {
          id: 401,
          name: `nx-cache-promotion-${merge}`,
          expired: false,
          workflow_run: { id: 4, head_sha: merge, head_repository_id: 1 },
        },
      ],
    });
    cache.metadata.set(
      `${repo}/actions/artifacts/401/zip`,
      reportZip(join(promotion.temp, "nx-cache-promotion")),
    );
    cache.metadata.set(`${repo}/commits/${merge}`, { sha: merge });
    cache.metadata.set(`${repo}/compare/${merge}...${merge}`, {
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
