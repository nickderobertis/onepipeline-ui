// The release journeys' Python environment, provisioned by `just release-tools`
// through `_release-venv`: reused while it was built with the justfile's pins,
// and rebuilt from nothing as soon as one of them differs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./support.mjs";

const VENV = join(ROOT, ".tools/release-venv");
const STAMP = join(VENV, "pins");
const pins = () => {
  const just = readFileSync(join(ROOT, "justfile"), "utf8");
  const pin = (name) =>
    just.match(new RegExp(`^${name} := "([^"]+)"$`, "m"))[1];
  return {
    maturin: pin("maturin-version"),
    twine: pin("twine-version"),
    packaging: pin("packaging-version"),
  };
};
const provision = () => {
  const run = spawnSync("just", ["_release-venv"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
};
const installed = (tool) =>
  execFileSync(join(VENV, "bin/python"), ["-m", "pip", "show", tool], {
    encoding: "utf8",
  }).match(/^Version: (.+)$/m)[1];

test("the release tools' environment is reused while its pins hold, and rebuilt when one changes", () => {
  provision();
  const wanted = pins();
  for (const [tool, version] of Object.entries(wanted))
    assert.equal(installed(tool), version, tool);
  assert.equal(
    readFileSync(STAMP, "utf8").trim(),
    `maturin==${wanted.maturin} twine==${wanted.twine} packaging==${wanted.packaging}`,
  );

  // Reused: a file left in it survives another provisioning.
  const marker = join(VENV, "journey-marker");
  writeFileSync(marker, "left by the journey");
  provision();
  assert.ok(
    existsSync(marker),
    "the environment was rebuilt with its pins unchanged",
  );

  // A stamp naming another pin is an environment built for another release:
  // it is rebuilt from nothing, and holds the justfile's pins again.
  writeFileSync(
    STAMP,
    `maturin==${wanted.maturin} twine==0.0.1 packaging==${wanted.packaging}\n`,
  );
  provision();
  assert.ok(!existsSync(marker), "the stale environment was reused");
  for (const [tool, version] of Object.entries(wanted))
    assert.equal(installed(tool), version, tool);
});
