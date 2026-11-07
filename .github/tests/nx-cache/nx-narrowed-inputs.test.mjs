// What an intervening merge may move, against real Nx: a change to the crate's manifests
// moves what reads them and no one else's hash, and a tool's version moves every cached
// target, whatever its explicit inputs name.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";

// Node, npm and biome tasks over the frontend and the release tests' own formatting, none
// of which opens a Cargo file. `repoFile`'s walk only tests the root manifest's existence.
const NOT_CARGO_READERS =
  /^(dag-layout|dag-model|dag-ui|telemetry-client|timeline-categories|docs|pool-maintenance):|^dag-ui-e2e:(budgets|format-check|lint|typecheck)$|^onepipeline-ui-release:lint$/;
const moved = (before, after) =>
  Object.keys(before).filter((id) => before[id].hash !== after[id].hash);
const edit = (cwd, file, change, body) => {
  const original = readFileSync(join(cwd, file), "utf8");
  const changed = change(original);
  assert.notEqual(changed, original, `${file}: the probe edits nothing`);
  writeFileSync(join(cwd, file), changed);
  try {
    return body();
  } finally {
    writeFileSync(join(cwd, file), original);
  }
};

test("a real dependency change moves every task that reads the crate's manifests and no other", () => {
  const cwd = workspaceFixture();
  try {
    const before = taskHashes(cwd);
    const ids = Object.keys(before);
    const readers = ids.filter((id) => !NOT_CARGO_READERS.test(id));
    const others = ids.filter((id) => NOT_CARGO_READERS.test(id));
    assert.ok(others.length >= 20, `only ${others.length} tasks are narrowed`);
    assert.ok(readers.length >= 20, `only ${readers.length} tasks read Cargo`);
    for (const [file, change] of [
      [
        "Cargo.toml",
        (text) =>
          text.replace(/(onepipeline = .*?=)(\d+\.\d+\.\d+)/, "$1999.0.0"),
      ],
      [
        "Cargo.lock",
        (text) => text.replace(/(name = "serde"\nversion = ")[^"]+/, "$11.0.999"),
      ],
    ]) {
      const after = edit(cwd, file, change, () => taskHashes(cwd, ids));
      assert.deepEqual(
        moved(before, after).sort(),
        [...readers].sort(),
        `${file} moved something other than its readers`,
      );
    }
    // The frontend's own lockfile is not narrowed: what it installs is what these run.
    const after = edit(
      cwd,
      "package.json",
      (text) => text.replace(/("vitest": ")([^"]+)"/, '$1^$2"'),
      () => taskHashes(cwd, ids),
    );
    for (const id of ["dag-ui:test", "dag-layout:lint", "docs:test"])
      assert.notEqual(after[id].hash, before[id].hash, id);
    // Negative control: a crate target that stops naming the manifests stops moving.
    const definition = readFileSync(join(cwd, "project.json"), "utf8");
    writeFileSync(
      join(cwd, "project.json"),
      definition.replaceAll('"crateInputs"', '"default"'),
    );
    const broken = taskHashes(cwd, ["onepipeline-ui:test-quick"]);
    const brokenAfter = edit(
      cwd,
      "Cargo.lock",
      (text) => text.replace(/(name = "serde"\nversion = ")[^"]+/, "$11.0.999"),
      () => taskHashes(cwd, ["onepipeline-ui:test-quick"]),
    );
    assert.equal(
      brokenAfter["onepipeline-ui:test-quick"].hash,
      broken["onepipeline-ui:test-quick"].hash,
      "the crate's reach to its manifests no longer comes from crateInputs",
    );
    writeFileSync(join(cwd, "project.json"), definition);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a tool's version moves every cached target, explicit inputs that omit the shared globals among them", () => {
  const cwd = workspaceFixture();
  try {
    const before = taskHashes(cwd);
    const ids = Object.keys(before);
    const pins = readFileSync(join(cwd, ".github/ci-tool-versions"), "utf8");
    const tools = pins
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")[0]);
    // Those with explicit inputs naming no shared globals are the ones a pin could miss.
    for (const id of [
      "onepipeline-ui-e2e:test-quick",
      "dag-ui-build-cache:test",
      "pool-maintenance:test",
      "dag-ui-e2e:budgets",
    ])
      assert.ok(ids.includes(id), `${id} is no longer a cached CI task`);
    for (const tool of ["nextest", "cargo-llvm-cov", "node", "just"]) {
      assert.ok(tools.includes(tool), tool);
      const after = edit(
        cwd,
        ".github/ci-tool-versions",
        (text) => text.replace(new RegExp(`^${tool}=.*$`, "m"), `${tool}=9.9.9`),
        () => taskHashes(cwd, ids),
      );
      assert.deepEqual(moved(before, after).sort(), [...ids].sort(), tool);
    }
    // Negative control: the file out of `platform`, and a target naming only that misses it.
    const nx = readFileSync(join(cwd, "nx.json"), "utf8");
    writeFileSync(
      join(cwd, "nx.json"),
      nx.replace(/,\s*"\{workspaceRoot\}\/\.github\/ci-tool-versions"/, ""),
    );
    const id = "onepipeline-ui-e2e:test-quick";
    const unwired = taskHashes(cwd, [id]);
    const unwiredAfter = edit(
      cwd,
      ".github/ci-tool-versions",
      (text) => text.replace(/^nextest=.*$/m, "nextest=9.9.9"),
      () => taskHashes(cwd, [id]),
    );
    assert.equal(unwiredAfter[id].hash, unwired[id].hash);
    writeFileSync(join(cwd, "nx.json"), nx);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
