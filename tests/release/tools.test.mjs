// The release journeys' tools, provisioned by `just release-tools`: release-plz
// and cargo-cyclonedx copied from PATH when it carries exactly their pins, and
// compiled when it does not; and the Python environment, through
// `_release-venv`, reused while it was built with the justfile's pins and
// rebuilt from nothing as soon as one of them differs — from the wheelhouse
// `.tools/release-wheels` alone, with the index made unreachable, so a rebuild
// for pins already fetched never reaches PyPI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, scratch } from "./support.mjs";

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
    "release-plz": pin("release-plz-version"),
    "cargo-cyclonedx": pin("cyclonedx-version"),
  };
};
const provision = (env = {}) => {
  const run = spawnSync("just", ["_release-venv"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
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
  for (const tool of ["maturin", "twine", "packaging"])
    assert.equal(installed(tool), wanted[tool], tool);
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
  // it is rebuilt from nothing, and holds the justfile's pins again. Nothing
  // listens on the discard port, so a rebuild that asked an index fails here.
  writeFileSync(
    STAMP,
    `maturin==${wanted.maturin} twine==0.0.1 packaging==${wanted.packaging}\n`,
  );
  provision({
    PIP_INDEX_URL: "http://127.0.0.1:9/simple",
    PIP_RETRIES: "0",
    PIP_TIMEOUT: "1",
  });
  assert.ok(!existsSync(marker), "the stale environment was reused");
  for (const tool of ["maturin", "twine", "packaging"])
    assert.equal(installed(tool), wanted[tool], tool);
});

test("release-plz and cargo-cyclonedx are copied from PATH at exactly their pins, and compiled otherwise", () => {
  provision();
  const wanted = pins();
  const dir = scratch("release-bins");
  const onPath = join(dir, "on-path");
  const shims = join(dir, "shims");
  mkdirSync(onPath, { recursive: true });
  mkdirSync(shims, { recursive: true });
  // A cargo that records being asked and compiles nothing, so the journey sees
  // whether the recipe fell through to a build.
  const asked = join(dir, "cargo-asked");
  writeFileSync(
    join(shims, "cargo"),
    `#!/usr/bin/env bash\necho "$*" >> ${asked}\necho "cargo: this journey compiles nothing" >&2\nexit 97\n`,
    { mode: 0o755 },
  );
  const tools = ["release-plz", "cargo-cyclonedx"];
  const bin = (tool) => join(ROOT, ".tools/bin", tool);
  const run = () =>
    spawnSync("just", ["release-tools"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${shims}:${onPath}:${process.env.PATH}` },
    });
  // The pinned binaries leave .tools for a directory on PATH, as ci.yml's
  // install step leaves them.
  for (const tool of tools) renameSync(bin(tool), join(onPath, tool));
  try {
    const copied = run();
    assert.equal(copied.status, 0, copied.stdout + copied.stderr);
    assert.ok(!existsSync(asked), "cargo was asked to compile a pinned tool");
    for (const tool of tools)
      assert.ok(
        readFileSync(bin(tool)).equals(readFileSync(join(onPath, tool))),
        `${tool} in .tools is the one on PATH`,
      );

    // Another release on PATH is passed over for the pin, which is compiled.
    rmSync(bin("release-plz"));
    renameSync(join(onPath, "release-plz"), join(dir, "release-plz"));
    writeFileSync(
      join(onPath, "release-plz"),
      `#!/usr/bin/env bash\necho "release-plz 0.0.1"\n`,
      { mode: 0o755 },
    );
    const refused = run();
    assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
    assert.match(
      refused.stderr,
      new RegExp(
        `cannot install release-plz ${wanted["release-plz"]} into \\.tools`,
      ),
    );
    assert.match(
      readFileSync(asked, "utf8"),
      new RegExp(`^install release-plz --version ${wanted["release-plz"]} `),
    );
    assert.ok(
      !existsSync(bin("release-plz")),
      "the other release was copied in",
    );
  } finally {
    for (const [tool, from] of [
      ["release-plz", join(dir, "release-plz")],
      ["release-plz", join(onPath, "release-plz")],
      ["cargo-cyclonedx", join(onPath, "cargo-cyclonedx")],
    ])
      if (!existsSync(bin(tool)) && existsSync(from))
        renameSync(from, bin(tool));
    rmSync(dir, { recursive: true, force: true });
  }
  for (const tool of tools)
    assert.ok(existsSync(bin(tool)), `${tool} restored`);
});
