// The cache paths through their real interfaces: the exact commands and expressions the
// workflows state, read from them and run against a local server standing in for GitHub
// over a listing recorded from this repository.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { interpolate } from "../workflow-graph.mjs";
import {
  cleanupFamilies,
  cleanupStep,
  LEG_FAMILIES,
  PULL_REQUEST_JOBS,
  rustCacheId,
  targetDeletion,
  writesCache,
} from "./cache-retention.mjs";

const run = promisify(execFile);
const REPO = "nickderobertis/onepipeline-ui";
const workflow = (name) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
const recorded = JSON.parse(
  readFileSync(".github/fixtures/actions-cache/listing.json", "utf8"),
);
const budget = () =>
  parse(readFileSync("budgets.yaml", "utf8")).budgets.find(
    (entry) => entry.id === "onepipeline-ui-cache-headroom",
  );

// GitHub's listing and deletion as these scripts use them: `key` filters by prefix, pages
// hold 100, and a deleted id answers 404 from then on.
async function github(entries) {
  const state = {
    entries: structuredClone(entries),
    deleted: [],
    nextId: 90000000000,
    clock: Date.parse("2026-11-08T00:00:00Z"),
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://github.test");
    const answer = (status, body) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4000",
      });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    const base = `/repos/${REPO}/actions/cache`;
    if (url.pathname === `${base}/storage-limit`)
      return answer(200, recorded.storage_limit);
    if (url.pathname === `${base}s` && request.method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      const field = url.searchParams.get("sort");
      const descending = url.searchParams.get("direction") === "desc";
      const sized = field === "size_in_bytes";
      const matched = state.entries
        .filter((entry) => entry.key.startsWith(key))
        .sort((a, b) => {
          const order = sized
            ? a.size_in_bytes - b.size_in_bytes
            : Date.parse(a.created_at) - Date.parse(b.created_at);
          return descending ? -order : order;
        });
      const size = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return answer(200, {
        total_count: matched.length,
        actions_caches: matched.slice((page - 1) * size, page * size),
      });
    }
    const id = Number(url.pathname.split("/").at(-1));
    if (request.method === "DELETE" && url.pathname === `${base}s/${id}`) {
      const at = state.entries.findIndex((entry) => entry.id === id);
      if (at < 0) return answer(404, { message: "Not Found" });
      state.deleted.push(state.entries.splice(at, 1)[0]);
      return answer(204);
    }
    return answer(404, { message: `unrecorded ${request.url}` });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const api = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    api,
    save(prefix, label, size = 1000) {
      state.clock += 60000;
      state.entries.push({
        id: state.nextId++,
        ref: "refs/heads/main",
        key: `${prefix}${label}`,
        version: "recorded-shape",
        created_at: new Date(state.clock).toISOString(),
        last_accessed_at: new Date(state.clock).toISOString(),
        size_in_bytes: size,
      });
    },
    family: (prefix) =>
      state.entries.filter((entry) => entry.key.startsWith(prefix)),
    close: () => new Promise((done) => server.close(done)),
  };
}

const leg = (name) => workflow("ci-cache").jobs[name];
// The step's own command and its own environment, as the runner would start them.
async function cleanup(name, host) {
  const step = cleanupStep(leg(name));
  return run(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
    {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: host.api,
        GITHUB_REPOSITORY: REPO,
        GH_TOKEN: interpolate(step.env.GH_TOKEN, {
          github: { token: "token" },
        }),
      },
    },
  );
}
async function headroom(host, scratch) {
  const out = join(scratch, `headroom-${Date.now()}-${Math.random()}.json`);
  const [command, ...args] = budget().command;
  await run(command, args, {
    env: {
      ...process.env,
      GITHUB_API_URL: host.api,
      GITHUB_REPOSITORY: REPO,
      GH_TOKEN: "token",
      ONEBUDGETSPEC_RESULT: out,
    },
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

test("a warm leg's own cleanup command leaves superseded copies and keeps main's newest", async () => {
  const entries = structuredClone(recorded.actions_caches);
  const prefix = "onepipeline-api-baseline-Linux-X64-";
  const held = entries.filter((entry) => entry.key.startsWith(prefix));
  assert.ok(held.length > 2, "the recording holds superseded baseline copies");
  const newest = [...held].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];
  const results = entries.filter((entry) => entry.key.startsWith("nx-cache-"));
  assert.ok(results.length > 100, "the recording holds test results");
  const rust = "v0-rust-test-linux-Linux-x64-";
  const main = entries.find((entry) => entry.key.startsWith(rust));
  // A later copy saved under a pull request's ref and a tag's must not count as the
  // newest: a pull request cannot restore those, and neither can main's next run.
  const foreign = [
    {
      ...main,
      id: 1,
      key: `${rust}pull`,
      ref: "refs/pull/1/merge",
      created_at: "2026-11-07T10:00:00Z",
    },
    {
      ...main,
      id: 2,
      key: `${rust}tag`,
      ref: "refs/heads/refs/tags/v0.69.0",
      created_at: "2026-11-07T11:00:00Z",
    },
  ];
  const host = await github([...entries, ...foreign]);
  try {
    const { stdout } = await cleanup("warm-linux", host);
    assert.deepEqual(
      host.family(prefix).map((entry) => entry.id),
      [newest.id],
    );
    assert.deepEqual(
      host.family(rust).map((entry) => entry.id),
      [main.id],
    );
    assert.deepEqual(
      host.state.deleted.map((entry) => entry.id).sort(),
      [
        ...held.filter((entry) => entry !== newest).map((entry) => entry.id),
        1,
        2,
      ].sort(),
    );
    // Only the families this leg names: another leg's copies and every result stay.
    assert.equal(
      host.state.entries.filter((entry) => entry.key.startsWith("nx-cache-"))
        .length,
      results.length,
    );
    assert.equal(host.family("v0-rust-test-windows-").length, 1);
    assert.match(stdout, new RegExp(`${rust}: kept ${main.key}, deleted 2`));
  } finally {
    await host.close();
  }
});

test("a failed cleanup deletes nothing and leaves the leg green", async () => {
  const host = await github(recorded.actions_caches);
  await host.close();
  const before = host.state.entries.length;
  const { stderr } = await cleanup("warm-windows", host);
  assert.match(stderr, /::warning::Cannot list cache family/);
  assert.equal(host.state.entries.length, before);
  assert.deepEqual(host.state.deleted, []);
});

test("cycles of cleanup then save never leave a family over two copies, a cancelled run among them", async () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "cleanup-cycles-",
    ),
  );
  const host = await github(recorded.actions_caches);
  const legs = Object.keys(LEG_FAMILIES);
  const named = legs.flatMap((name) => cleanupFamilies(cleanupStep(leg(name))));
  const bound = (when) => {
    for (const family of named)
      assert.ok(
        host.family(family).length <= 2,
        `${when}: ${family} holds ${host.family(family).length}`,
      );
  };
  // A warm run: each leg cleans before its own post step saves. `saves` names what a leg
  // saved; a leg a cancellation took before its post step saved nothing.
  const warmRun = async (cycle, { saved, beforeCleanup = [] }) => {
    for (const name of legs) {
      if (beforeCleanup.includes(name)) continue;
      await cleanup(name, host);
      bound(`cycle ${cycle}, after ${name}'s cleanup`);
    }
    for (const family of saved) {
      host.save(family, `lock-${cycle}`);
      bound(`cycle ${cycle}, after saving ${family}`);
    }
  };
  const allOf = (...names) => names.flatMap((name) => LEG_FAMILIES[name]);
  try {
    await warmRun(1, { saved: allOf(...legs) });
    // Cancelled having saved only some: Linux's build, none of Windows', and a Mac job the
    // cancellation reached before its cleanup ran at all.
    await warmRun(2, {
      saved: ["v0-rust-test-linux-Linux-x64-"],
      beforeCleanup: ["warm-macos"],
    });
    await warmRun(3, { saved: allOf(...legs) });
    await warmRun(4, { saved: allOf("warm-linux", "warm-macos") });
    for (const family of named)
      assert.ok(host.family(family).length > 0, family);
    // The newest copy of every family is the last one saved, so the next pull request
    // still restores it, and nothing here touched a test result.
    assert.ok(
      host
        .family("v0-rust-test-linux-Linux-x64-")
        .some((entry) => entry.key.endsWith("lock-4")),
    );
    assert.deepEqual(
      host.state.deleted.filter((entry) => entry.key.startsWith("nx-cache-")),
      [],
    );
    // The budget's own command reads that listing: never the 0 an overfull family reads.
    const reading = await headroom(host, scratch);
    assert.ok(reading.value > 0, reading.detail);
    assert.doesNotMatch(reading.detail, /more than the two/);
  } finally {
    await host.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the budget's own command reads 0 when a family it names holds more than a working cleanup leaves", async () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "cleanup-headroom-",
    ),
  );
  const host = await github(recorded.actions_caches);
  try {
    const { value, detail } = await headroom(host, scratch);
    assert.equal(value, 0);
    assert.match(
      detail,
      /family onepipeline-api-baseline-Linux-X64- holds 4 entries/,
    );
    await cleanup("warm-linux", host);
    const after = await headroom(host, scratch);
    const listed = host.state.entries.reduce(
      (sum, entry) => sum + entry.size_in_bytes,
      0,
    );
    assert.equal(
      after.value,
      Math.round(((10737418240 - listed) / 1e9) * 1000) / 1000,
    );
  } finally {
    await host.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The recorded payloads: a real fork's pull request and a real same-repository one.
const event = (name) =>
  JSON.parse(readFileSync(`.github/tests/nx-cache/events/${name}.json`, "utf8"))
    .pull_request;
// `read_only` comes from running the workflow's real trust script over the payload.
function contextFor(pullRequest, scratch) {
  const eventPath = join(scratch, "event.json");
  const output = join(scratch, "output");
  writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest }));
  writeFileSync(output, "");
  execFileSync(process.execPath, ["scripts/nx-remote-cache.mjs", "trust"], {
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: pullRequest.base.repo.full_name,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  return {
    github: {
      event: { pull_request: pullRequest },
      repository: pullRequest.base.repo.full_name,
      token: "token",
    },
    steps: { "nx-cache-trust": { outputs } },
  };
}

test("a fork's pull request skips every cache-writing step of ci.yml's jobs and a same-repository one does not", () => {
  const scratch = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "cache-guards-"),
  );
  try {
    const fork = contextFor(event("fork"), scratch);
    const same = contextFor(event("maintainer"), scratch);
    assert.equal(fork.steps["nx-cache-trust"].outputs.read_only, "true");
    assert.equal(same.steps["nx-cache-trust"].outputs.read_only, "false");
    const ci = workflow("ci");
    const seen = new Set();
    for (const id of PULL_REQUEST_JOBS)
      for (const step of ci.jobs[id].steps) {
        assert.equal(
          writesCache(step, fork),
          false,
          `${id}: ${step.uses ?? step.name} writes from a fork`,
        );
        const uses = step.uses ?? "";
        const guarded = [
          "oven-sh/setup-bun@",
          "astral-sh/setup-uv@",
          "op-nx/github-cache/start-cache-server@",
        ].some((prefix) => uses.startsWith(prefix));
        if (!guarded) continue;
        seen.add(uses.split("@")[0]);
        assert.equal(
          writesCache(step, same),
          true,
          `${id}: ${uses} stopped writing from this repository's own pull request`,
        );
      }
    assert.deepEqual([...seen].sort(), [
      "astral-sh/setup-uv",
      "op-nx/github-cache/start-cache-server",
      "oven-sh/setup-bun",
    ]);
    // And rust-cache saves for neither: pull requests only ever restore.
    for (const id of PULL_REQUEST_JOBS) {
      const rust = ci.jobs[id].steps.find((step) =>
        step.uses?.startsWith("Swatinem/rust-cache@"),
      );
      assert.equal(writesCache(rust, same), false, id);
      assert.equal(writesCache(rust, fork), false, id);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("each warm leg deletes target on an inexact restore and keeps it on an exact one", async () => {
  for (const name of Object.keys(LEG_FAMILIES)) {
    const job = leg(name);
    const step = targetDeletion(job);
    const taken = (hit) =>
      interpolate(`$${"{{"} ${step.if} }}`, {
        steps: { [rustCacheId(job)]: { outputs: { "cache-hit": hit } } },
      });
    const scratch = mkdtempSync(
      join(
        process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
        "warm-target-",
      ),
    );
    try {
      for (const [hit, expected] of [
        ["true", true],
        ["false", false],
      ]) {
        mkdirSync(join(scratch, "target/debug"), { recursive: true });
        writeFileSync(join(scratch, "target/debug/unit"), "built");
        if (taken(hit))
          await run("bash", ["--noprofile", "--norc", "-c", step.run], {
            cwd: scratch,
          });
        assert.equal(
          existsSync(join(scratch, "target")),
          expected,
          `${name}, cache-hit ${hit}`,
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
