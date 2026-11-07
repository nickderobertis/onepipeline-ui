// A merge landing between a pull request's final run and its merge: the copied cache-use,
// under onebudgetspec, over a real run's own evidence, names the release's re-run a miss.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  cacheSession,
  GithubCache,
  json,
  recordedREST,
  reportZip,
  run,
  sourceMetadata,
} from "./nx-cache-journey.mjs";
import { workspaceFixture } from "./nx-fixture.mjs";

const payload = (number, base, head) => {
  const recorded = json(
    ".github/tests/nx-cache/events/maintainer.json",
  ).pull_request;
  return {
    repository: { full_name: recorded.base.repo.full_name },
    pull_request: {
      ...recorded,
      number,
      head: { ...recorded.head, sha: head },
      base: { ...recorded.base, sha: base },
    },
  };
};

test("a merge between a pull request's final run and its merge reaches cache-use as a base_moved miss", async () => {
  const cwd = workspaceFixture();
  const cache = await new GithubCache().start();
  const repo = "/repos/nickderobertis/onepipeline-ui";
  try {
    const git = async (...args) =>
      (await run("git", args, { cwd })).stdout.trim();
    const commit = (message) =>
      git(
        "-c",
        "user.name=Cache journey",
        "-c",
        "user.email=cache@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        message,
      );
    writeFileSync(
      join(cwd, ".gitignore"),
      `${readFileSync(join(cwd, ".gitignore"), "utf8")}\n/observations/\n`,
    );
    await git("add", ".gitignore");
    await commit("tested base");
    const tested = await git("rev-parse", "HEAD");
    // The pull request's run, on the merge ref GitHub would check out: base and head.
    await git("checkout", "-q", "-b", "head");
    await commit("the pull request");
    const head = await git("rev-parse", "HEAD");
    await git(
      "-c",
      "user.name=Cache journey",
      "-c",
      "user.email=cache@example.invalid",
      "checkout",
      "-q",
      "--detach",
      tested,
    );
    await git(
      "-c",
      "user.name=Cache journey",
      "-c",
      "user.email=cache@example.invalid",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge ref",
      head,
    );
    const mergeRef = await git("rev-parse", "HEAD");
    const source = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/source"),
      payload(1, tested, head),
      { GITHUB_SHA: mergeRef },
    );
    try {
      await source.nx();
    } finally {
      await source.close();
    }
    const report = join(source.temp, "nx-cache-report");
    assert.equal(json(join(report, "executions.json")).base_sha, tested);
    // Another merge lands an input of the very task, then the pull request squashes on top.
    await git("checkout", "-q", "--detach", tested);
    const task = "packages/timeline-categories/README-intervening.md";
    writeFileSync(
      join(cwd, task),
      "landed between the final run and the merge\n",
    );
    await git("add", task);
    await commit("the intervening merge");
    const landed = await git("rev-parse", "HEAD");
    // cache-use carries only a pull request whose merge changes a published path.
    writeFileSync(
      join(cwd, "README.md"),
      `${readFileSync(join(cwd, "README.md"), "utf8")}\n`,
    );
    await git("add", "README.md");
    await commit("the squash of the pull request");
    const merged = await git("rev-parse", "HEAD");
    await commit("the release edits");
    const tip = await git("rev-parse", "HEAD");
    const sourceRecord = sourceMetadata(cache, report, {
      head,
      base: tested,
      merge: merged,
    });
    const mergeCommit = recordedREST("commit");
    mergeCommit.sha = merged;
    mergeCommit.parents = [{ ...mergeCommit.parents[0], sha: landed }];
    cache.metadata.set(`${repo}/commits/${merged}`, mergeCommit);
    const promotion = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/promotion"),
      { ref: "refs/heads/main" },
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: merged,
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
    // The release pull request's tree holds what landed, so it runs at a hash no run proved.
    rmSync(join(cwd, ".nx"), { recursive: true, force: true });
    const releaseHead = "5".repeat(40);
    const release = await cacheSession(
      cwd,
      cache,
      join(cwd, "observations/release"),
      payload(2, merged, releaseHead),
      { GITHUB_REF: "refs/pull/2/merge", GITHUB_RUN_ID: "3" },
    );
    try {
      await release.nx();
    } finally {
      await release.close();
    }
    sourceMetadata(cache, join(release.temp, "nx-cache-report"), {
      runId: 3,
      prNumber: 2,
      head: releaseHead,
      base: merged,
      merge: tip,
    });
    const repository = sourceRecord.pr.base.repo;
    const receipt = json(
      join(promotion.temp, "nx-cache-promotion/receipt.json"),
    );
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
      { ...recordedREST("commit"), sha: merged },
      { ...recordedREST("commit"), sha: tip },
    ]);
    cache.metadata.set(`${repo}/actions/workflows/release-plz.yml/runs`, {
      ...recordedREST("runs"),
      workflow_runs: [
        {
          ...recordedREST("run"),
          id: 4,
          run_attempt: 1,
          head_sha: merged,
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
          name: `nx-cache-promotion-${merged}`,
          expired: false,
          workflow_run: {
            ...recordedREST("artifacts").artifacts[0].workflow_run,
            id: 4,
            head_sha: merged,
            head_repository_id: repository.id,
          },
        },
      ],
    });
    cache.metadata.set(
      `${repo}/actions/artifacts/401/zip`,
      reportZip(join(promotion.temp, "nx-cache-promotion")),
    );
    const measure = async (name) => {
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
              RUNNER_TEMP: join(cwd, `observations/${name}`),
            },
            maxBuffer: 16 * 1024 * 1024,
          },
        );
      } catch (error) {
        return error;
      }
    };
    const moved = await measure("moved");
    assert.match(
      moved.stdout,
      new RegExp(
        `base_moved, #1 tested \\S+ on base ${tested}, merged on ${landed}`,
      ),
      moved.stdout + moved.stderr,
    );
    assert.match(moved.stdout, /release PR: 0\/1/);
    assert.doesNotMatch(moved.stdout, /— within/);
    // Recovery: the same hash change on a base the pull request did land on is new work.
    mergeCommit.parents = [{ ...mergeCommit.parents[0], sha: tested }];
    const unmoved = await measure("unmoved");
    assert.doesNotMatch(
      unmoved.stdout,
      /base_moved/,
      unmoved.stdout + unmoved.stderr,
    );
  } finally {
    await cache.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
