// `publish`'s availability check, the gate in front of everything
// platform-independent, on the answers that stop it before any platform's
// files are even looked for. It reads the build jobs' results and the
// registries and builds nothing, so it is driven here over the `gh` and
// registry doubles with nothing staged: whatever it lets through would show up
// as an upload.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
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
