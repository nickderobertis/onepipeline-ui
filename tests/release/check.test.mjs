// `publish`'s availability check, the gate in front of everything
// platform-independent, on the answers that stop it before any platform's
// files are even looked for. It reads the build jobs' results and the
// registries and builds nothing, so it is driven here over the `gh` and
// registry doubles with nothing staged: whatever it lets through would show up
// as an upload.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  githubDouble,
  recipe,
  registryDoubles,
  releaseEnv,
  scratch,
  version,
} from "./support.mjs";

let dir;
let gh;
let registries;
let env;

before(async () => {
  dir = scratch("check");
  gh = githubDouble(dir, `v${version()}`);
  registries = await registryDoubles(dir);
  env = releaseEnv({ gh, registries, home: dir });
});

after(async () => {
  await registries?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const allBuilt =
  "build-linux=success build-macos=success build-windows=success";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const publish = (args, extra) => recipe("publish", args, { ...env, ...extra });

test("a build job the workflow reported no result for counts as missing, and publish uploads nothing platform-independent", () => {
  // build-windows is left out, as a workflow that stopped reporting it would.
  const extra = {
    BUILD_RESULTS: "build-linux=success build-macos=success",
  };
  const check = publish(["check"], extra);
  assert.notEqual(check.status, 0, check.output);
  assert.match(
    check.stderr,
    /so nothing platform-independent will: .*build-windows \(not reported\)/,
  );
  for (const registry of ["crate", "npm", "github"]) {
    const upload = publish(["upload", registry], extra);
    assert.notEqual(upload.status, 0, `${registry}: ${upload.output}`);
    assert.match(upload.stderr, /build-windows \(not reported\)/, registry);
  }
  assert.deepEqual(registries.uploads(), []);
  assert.deepEqual(gh.uploads(), []);
});

test("PyPI answering a 200 that is not JSON is refused, never read as nothing served", () => {
  registries.breakReads(["pypi-json=not-json"]);
  try {
    const check = publish(["check"], {
      BUILD_RESULTS:
        "build-linux=success build-macos=success build-windows=success",
    });
    assert.notEqual(check.status, 0, check.output);
    assert.match(
      check.stderr,
      /PyPI answered \S+ with something that is not JSON/,
    );
    assert.doesNotMatch(check.stderr, /not every platform published/);
  } finally {
    registries.clear();
  }
  assert.deepEqual(registries.uploads(), []);
});

test("an npm platform package npm has no such version of is missing, and publish uploads nothing", () => {
  const pkg = join(registries.state, "npm", "onepipeline-api-cli-linux-x64");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "0.0.1.json"),
    JSON.stringify({ name: "onepipeline-api-cli-linux-x64", version: "0.0.1" }),
  );
  writeFileSync(join(pkg, "0.0.1.tgz"), "an earlier release");
  try {
    const extra = { BUILD_RESULTS: allBuilt };
    const check = publish(["check"], extra);
    assert.notEqual(check.status, 0, check.output);
    assert.match(
      check.stderr,
      new RegExp(
        `npm onepipeline-api-cli-linux-x64@${escapeRegExp(version())}`,
      ),
    );
    const upload = publish(["upload", "npm"], extra);
    assert.notEqual(upload.status, 0, upload.output);
    assert.deepEqual(registries.uploads(), []);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("npm serving this version with no version in its manifest is refused, never read as not served", () => {
  const pkg = join(registries.state, "npm", "onepipeline-api-cli-linux-x64");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, `${version()}.json`),
    JSON.stringify({ name: "onepipeline-api-cli-linux-x64" }),
  );
  writeFileSync(join(pkg, `${version()}.tgz`), "a package");
  try {
    const check = publish(["check"], { BUILD_RESULTS: allBuilt });
    assert.notEqual(check.status, 0, check.output);
    assert.match(
      check.stderr,
      new RegExp(
        `npm answered onepipeline-api-cli-linux-x64@${escapeRegExp(version())} with nothing`,
      ),
    );
    assert.doesNotMatch(check.stderr, /not every platform published/);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("results the workflow hands over in another shape are refused before anything is checked, published or edited", () => {
  const check = publish(["check"], { BUILD_RESULTS: "build-linux=ok" });
  assert.equal(check.status, 2, check.output);
  assert.match(
    check.stderr,
    /BUILD_RESULTS takes 'name=<success\|failure\|cancelled\|skipped>' pairs, not 'build-linux=ok'/,
  );
  const calls = gh.calls().length;
  const settle = publish(["settle"], {
    BUILD_RESULTS: allBuilt,
    STEP_RESULTS: "check=success verify",
  });
  assert.equal(settle.status, 2, settle.output);
  assert.match(settle.stderr, /STEP_RESULTS takes .* not 'verify'/);
  assert.equal(gh.calls().length, calls, "the Release was not read or edited");
  assert.ok(!gh.prerelease());
  assert.deepEqual(registries.uploads(), []);
});
