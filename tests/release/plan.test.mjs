// The wheel names a release plans, held to PEP 440 as its own implementation
// spells it. scripts/release.mjs restates maturin's conversion of a Cargo
// version (`1.2.3-rc.1` -> `1.2.3rc1`), because a plan names files without
// building them; this is the drift gate on that restatement, asking
// `packaging` — the PyPA reference implementation, which release-package.py also
// compares a built wheel's version with — for every spelling the plan accepts,
// through the recipe's own plan phase.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./support.mjs";

const canonical = (version) =>
  execFileSync(
    join(ROOT, ".tools/release-venv/bin/python"),
    [
      "-c",
      "import sys\nfrom packaging.version import Version\nprint(Version(sys.argv[1]))",
      version,
    ],
    { encoding: "utf8" },
  ).trim();

const planned = (version) =>
  spawnSync(
    "node",
    ["scripts/release.mjs", "linux", "plan", "--version", version],
    { cwd: ROOT, encoding: "utf8" },
  );

test("every version spelling a plan accepts names its wheel as PEP 440 does", () => {
  for (const version of [
    "1.2.3",
    "0.38.0",
    "1.2.3-rc.1",
    "1.2.3-rc1",
    "1.2.3-alpha.2",
    "1.2.3-beta.10",
    "1.2.3+build.5",
    "1.2.3-rc.1+abc-def",
  ]) {
    const run = planned(version);
    assert.equal(run.status, 0, `${version}: ${run.stderr}`);
    const wheel = JSON.parse(run.stdout).artifacts.find(
      (a) => a.kind === "wheel",
    );
    assert.equal(
      wheel.file.split("-")[1],
      canonical(version),
      `${version}'s wheel`,
    );
    // Every other file keeps the Cargo spelling, as v0.37.0's did.
    for (const artifact of JSON.parse(run.stdout).artifacts.filter(
      (a) => a.kind !== "wheel",
    ))
      assert.ok(artifact.file.includes(version), artifact.file);
  }
});

test("a prerelease the plan cannot spell is refused before anything is named", () => {
  for (const version of ["1.2.3-foo", "1.2.3-dev.1", "1.2.3-rc.x"]) {
    const run = planned(version);
    assert.equal(run.status, 2, `${version}: ${run.stdout}`);
    assert.match(run.stderr, /has no PEP 440 spelling this release knows/);
    assert.match(run.stderr, /ACTION:/);
  }
});
