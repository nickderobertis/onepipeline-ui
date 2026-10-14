// Drives `pool-maintenance/measure.sh` the way `onebudgetspec check` does —
// as a subprocess, with `ONEBUDGETSPEC_RESULT` naming the file it reports to —
// over a one-crate fixture rather than this repository, so the journey costs a
// few seconds instead of the two full builds the budget itself pays. Nothing is
// stubbed: the fixture carries this repository's real justfile and a copy of
// the real script, and the real cargo-nextest, just and cargo-prune-superseded
// build and prune it. The figure itself is the budget's to judge; these assert
// the workload, the report's shape and the refusals, never a threshold.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(PROJECT);
const scratch = [];

// The tools the script delegates to; a missing one is a provisioning gap with
// one fix, not a failure of the script under test.
before(() => {
  for (const [tool, args] of [
    ["cargo", ["nextest", "--version"]],
    ["cargo-prune-superseded", ["--version"]],
    ["just", ["--version"]],
  ]) {
    const probe = spawnSync(tool, args, { encoding: "utf8" });
    assert.equal(
      probe.status,
      0,
      `${tool} ${args.join(" ")} is unavailable — run 'just bootstrap' first`,
    );
  }
});

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A repository root holding one crate, the real justfile and the real script. */
function fixture({ feature = true, view = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pool-maintenance-measure-"));
  scratch.push(root);
  mkdirSync(join(root, "pool-maintenance"));
  copyFileSync(
    join(PROJECT, "measure.sh"),
    join(root, "pool-maintenance", "measure.sh"),
  );
  copyFileSync(join(ROOT, "justfile"), join(root, "justfile"));
  writeFileSync(
    join(root, "Cargo.toml"),
    [
      "[package]",
      'name = "fixture-unit"',
      'version = "0.1.0"',
      'edition = "2021"',
      "",
      "[features]",
      feature ? "bundled-ui = []" : "",
      "",
    ].join("\n"),
  );
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "lib.rs"),
    [
      "pub fn answer() -> u32 {",
      '    if cfg!(feature = "bundled-ui") { 1 } else { 2 }',
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn answers() {",
      "        assert!(super::answer() > 0);",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  if (view) {
    mkdirSync(join(root, "apps", "dag-ui", "dist"), { recursive: true });
    writeFileSync(join(root, "apps", "dag-ui", "dist", "index.html"), "<!doctype html>\n");
  }
  const lock = spawnSync("cargo", ["generate-lockfile", "--offline"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(lock.status, 0, lock.stderr);
  return root;
}

/** Run the script as onebudgetspec would, reporting to a file of the fixture's. */
function measure(root) {
  const result = join(root, "result.json");
  const env = { ...process.env, ONEBUDGETSPEC_RESULT: result };
  delete env.CARGO_TARGET_DIR;
  const run = spawnSync(join(root, "pool-maintenance", "measure.sh"), [], {
    cwd: tmpdir(),
    env,
    encoding: "utf8",
  });
  return { ...run, result };
}

const lines = (root, name) =>
  readFileSync(join(root, "target", "pool-maintenance", name), "utf8")
    .split("\n")
    .filter(Boolean);

test("the timed pass removes exactly the superseded build and reports itself", () => {
  const root = fixture();
  const run = measure(root);
  assert.equal(run.status, 0, run.stderr);

  const report = JSON.parse(readFileSync(run.result, "utf8"));
  assert.equal(typeof report.value, "number");
  assert.ok(Number.isFinite(report.value) && report.value >= 0);
  const removed = Number(/builds removed: (\d+)/.exec(report.detail)?.[1]);
  assert.ok(removed > 0, `the timed pass removed no build: ${report.detail}`);
  assert.match(report.detail, /entries walked: \d+/);
  assert.match(
    report.detail,
    /; untimed backlog pass seconds \(evidence, not the figure\): \d+\.\d{3}$/,
  );

  const alternative = lines(root, "alternative");
  assert.ok(
    alternative.some((entry) => entry.includes("fixture_unit-")),
    `the alternative build created none of the crate's own units: ${alternative}`,
  );
  assert.deepEqual(lines(root, "removed"), alternative);
  const kept = new Set(lines(root, "after-timed"));
  const ordinary = lines(root, "before-timed").filter(
    (entry) => !alternative.includes(entry),
  );
  assert.ok(ordinary.some((entry) => entry.includes("fixture_unit-")));
  for (const entry of ordinary) {
    assert.ok(kept.has(entry), `the timed pass removed the ordinary ${entry}`);
    assert.ok(existsSync(join(root, entry)), `${entry} is gone from disk`);
  }
  assert.match(run.stderr, /the timed pass removed \d+ entries, all the alternative build's/);
});

test("a tree with no browser view is refused before anything is built", () => {
  const root = fixture({ view: false });
  const run = measure(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /apps\/dag-ui\/dist holds no browser view/);
  assert.match(run.stderr, /ACTION: run 'just build' first/);
  assert.equal(existsSync(run.result), false);
  assert.equal(existsSync(join(root, "target")), false);
});

test("a build that fails names the step it broke and reports no figure", () => {
  const root = fixture({ feature: false });
  const run = measure(root);
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /measure\.sh: the alternative build \('cargo nextest run --no-run --features bundled-ui'\) failed \(exit \d+\)/,
  );
  assert.match(run.stderr, /ACTION: fix that error/);
  assert.equal(existsSync(run.result), false);
});
