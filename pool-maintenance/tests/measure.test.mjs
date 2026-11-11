// Drives `pool-maintenance/measure.sh` the way `onebudgetspec check` does —
// as a subprocess, with `ONEBUDGETSPEC_RESULT` naming the file it reports to —
// over a one-crate fixture rather than this repository, so the journey costs a
// few seconds instead of the two full builds the budget itself pays. Nothing is
// stubbed: the fixture carries this repository's real justfile and a copy of
// the real script, and the real cargo-nextest, just and cargo-prune-superseded
// build and prune it. The figure itself is the budget's to judge; these assert
// the workload, the report's shape and the refusals, never a threshold.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  const root = mkdtempSync(join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "pool-maintenance-measure-"));
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
function measure(root, args = []) {
  const result = join(root, "result.json");
  const env = { ...process.env, ONEBUDGETSPEC_RESULT: result };
  delete env.CARGO_TARGET_DIR;
  const run = spawnSync(join(root, "pool-maintenance", "measure.sh"), args, {
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
    assert.ok(existsSync(entry), `${entry} is gone from disk`);
  }
  assert.match(run.stderr, /the timed pass removed \d+ entries, all the alternative build's/);
});

test("a private tree starts from the checkout's ordinary build, and the timed pass still removes exactly the alternative build", () => {
  const root = fixture();
  // Every compilation, logged by a wrapper that runs the compiler unchanged, so
  // what the measurement compiled is read off the compiler's own invocations.
  const log = join(root, "rustc.log");
  const wrapper = join(root, "rustc-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, RUSTC_WRAPPER: wrapper };
  delete env.CARGO_TARGET_DIR;
  // The ordinary build the gate's tiers leave in the checkout's own target.
  const ordinary = spawnSync("cargo", ["nextest", "run", "--locked", "--no-run"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  writeFileSync(log, "");

  const result = join(root, "result.json");
  const run = spawnSync(join(root, "pool-maintenance", "measure.sh"), [], {
    cwd: tmpdir(),
    env: { ...env, ONEBUDGETSPEC_RESULT: result },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);

  const compiled = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes("--crate-name fixture_unit"));
  assert.ok(compiled.length > 0, "the alternative build compiled nothing");
  for (const line of compiled)
    assert.match(
      line,
      /feature="bundled-ui"/,
      `the ordinary build was compiled again rather than taken from the checkout's: ${line}`,
    );
  const alternative = lines(root, "alternative");
  assert.ok(alternative.some((entry) => entry.includes("fixture_unit-")));
  assert.deepEqual(lines(root, "removed"), alternative);
  const report = JSON.parse(readFileSync(result, "utf8"));
  assert.ok(Number(/builds removed: (\d+)/.exec(report.detail)?.[1]) > 0, report.detail);
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

test("the view the budget's command names is the one it needs", () => {
  const root = fixture();
  const run = measure(root, ["../apps/dag-ui/dist/absent.html"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /apps\/dag-ui\/dist holds no browser view/);
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

function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("another cargo build in the ordinary target survives the measurement", async () => {
  const root = fixture();
  const other = fixture();
  const target = join(root, "target");
  const env = { ...process.env, CARGO_TARGET_DIR: target };
  const build = async (flags) => {
    const run = await execute("cargo", ["build", "--offline"], {
      cwd: other, env: { ...env, RUSTFLAGS: flags }, stdio: ["ignore", "ignore", "pipe"],
    });
    assert.equal(run.status, 0, run.stderr);
  };
  await build("--cfg old_build");
  // A real superseded build, old enough for the declared maintenance to select.
  const stamp = spawnSync("find", [join(target, "debug"), "-exec", "touch", "-h", "-t", "200001010000", "{}", "+"]);
  assert.equal(stamp.status, 0);
  await build("--cfg current_build");
  const old = spawnSync("find", [join(target, "debug"), "-mindepth", "2", "-maxdepth", "2"], { encoding: "utf8" }).stdout.trim().split("\n");
  let running = true;
  let rounds = 0;
  const writer = (async () => {
    while (running) {
      await build(`--cfg concurrent_${rounds}`);
      rounds++;
    }
  })();
  let run;
  try {
    run = await execute(join(root, "pool-maintenance", "measure.sh"), [], {
      cwd: root,
      env: { ...process.env, ONEBUDGETSPEC_RESULT: join(root, "result.json") },
      stdio: ["ignore", "ignore", "pipe"],
    });
  } finally {
    running = false;
    await writer;
  }
  assert.equal(run.status, 0, run.stderr);
  assert.ok(rounds > 0, "another cargo build completed during the measurement");
  const report = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  assert.ok(Number.isFinite(report.value));
  for (const entry of old) assert.ok(existsSync(entry), `measurement removed another build's ${entry}`);
});

test("a repeated measurement keeps its private tree and refreshes the evidence and report", () => {
  const root = fixture();
  const first = measure(root);
  assert.equal(first.status, 0, first.stderr);
  const ordinary = lines(root, "after-timed");
  assert.ok(ordinary.length > 0);
  const retained = join(root, "target", "pool-maintenance", "target", "retained");
  writeFileSync(retained, "private build tree survives\n");
  writeFileSync(first.result, JSON.stringify({ value: -1, detail: "stale" }));
  writeFileSync(join(root, "target", "pool-maintenance", "removed"), "stale\n");
  const second = measure(root);
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(readFileSync(second.result, "utf8"));
  assert.ok(Number.isFinite(report.value) && report.value >= 0);
  assert.doesNotMatch(report.detail, /stale/);
  assert.equal(readFileSync(retained, "utf8"), "private build tree survives\n");
  assert.deepEqual(lines(root, "removed"), lines(root, "alternative"));
  assert.ok(lines(root, "removed").length > 0);
  for (const entry of ordinary) assert.ok(existsSync(entry), `ordinary build disappeared: ${entry}`);
});

test("the maintenance target argument is a literal path", () => {
  const root = fixture();
  const marker = join(root, "executed");
  const target = `$(touch ${marker})`;
  const run = spawnSync("just", ["pool-maintenance", target], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(existsSync(marker), false, "a directory argument executed shell code");
  assert.equal(run.status, 0, run.stderr);
});
