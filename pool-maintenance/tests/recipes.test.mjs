// Drives the justfile's pool-maintenance recipes through `just`, as onevcs and
// `just bootstrap` invoke them. That `pool-maintenance` prunes is proven by
// `measure.test.mjs`, which runs it over a fixture's real superseded build;
// these hold its refusal and `_ensure-pruner`'s idempotence.
//
// `_ensure-pruner`'s install path is not driven here: it compiles the crate from
// crates.io, about seventy seconds and a network fetch on every run of this
// cheap per-change target, to prove what `cargo install` itself guarantees.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scratch = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pool-maintenance-recipes-"));
  scratch.push(dir);
  return dir;
}

function just(recipe, env) {
  return spawnSync("just", ["--justfile", join(ROOT, "justfile"), recipe], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
}

test("pool-maintenance without the pruner on PATH refuses and names the fix", () => {
  const which = spawnSync("bash", ["-c", "command -v just"], { encoding: "utf8" });
  assert.equal(which.status, 0, "just is not on PATH — run 'just bootstrap' first");
  const bin = tempDir();
  symlinkSync(which.stdout.trim(), join(bin, "just"));
  const run = just("pool-maintenance", {
    HOME: process.env.HOME,
    PATH: `${bin}:/usr/bin:/bin`,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /cargo-prune-superseded is not on PATH — run 'just bootstrap'/,
  );
  assert.equal(run.stdout, "");
});

test("_ensure-pruner installs nothing when the pinned release is on PATH", () => {
  const pinned = spawnSync("just", ["--evaluate", "prune-superseded-version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const onPath = spawnSync("cargo-prune-superseded", ["--version"], { encoding: "utf8" });
  assert.equal(
    onPath.stdout.trim(),
    `cargo-prune-superseded ${pinned.stdout.trim()}`,
    "the pinned pruner is not on PATH — run 'just bootstrap' first",
  );
  const root = tempDir();
  const run = just("_ensure-pruner", { ...process.env, CARGO_INSTALL_ROOT: root });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout + run.stderr, "");
  assert.deepEqual(readdirSync(root), []);
});
