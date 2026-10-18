// The question `publish`'s `verify` phase asks every declared target once a
// release is out, asked of a prerelease: crates.io and npm answer the version as
// Cargo spells it (`1.2.3-rc.1`) and PyPI as PEP 440 does (`1.2.3rc1`), so the
// verification has to accept each registry's own spelling of this version and
// nothing else. The publication journeys run at Cargo.toml's stable version,
// where the two spellings coincide, so this is where the difference is driven:
// the real scripts/release-probe.sh against the registry doubles, called the
// way the phase calls it, with the doubles serving a prerelease nothing built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  githubDouble,
  ROOT,
  registryDoubles,
  releaseEnv,
  scratch,
  version,
} from "./support.mjs";

const PRERELEASE = "0.39.0-rc.1";
let dir;
let registries;
let env;

// What each registry serves once `PRERELEASE` is published, in the files its
// double reads: the probe reads only the version each answers.
function serve({ wheelVersion }) {
  const pypi = join(registries.state, "pypi");
  rmSync(pypi, { recursive: true, force: true });
  mkdirSync(pypi);
  writeFileSync(
    join(
      pypi,
      `onepipeline_api_cli-${wheelVersion}-py3-none-manylinux_2_17_x86_64.whl`,
    ),
    "a wheel",
  );
  for (const pkg of ["onepipeline-api-cli", "onepipeline-ui"]) {
    const packages = join(registries.state, "npm", pkg);
    mkdirSync(packages, { recursive: true });
    writeFileSync(
      join(packages, `${PRERELEASE}.json`),
      JSON.stringify({ name: pkg, version: PRERELEASE }),
    );
    writeFileSync(join(packages, `${PRERELEASE}.tgz`), "a package");
  }
  writeFileSync(
    join(registries.state, "crates", `onepipeline-ui-${PRERELEASE}.json`),
    JSON.stringify({ name: "onepipeline-ui", vers: PRERELEASE }),
  );
}

// The phase's own verification, in a process of its own as the phase runs it,
// so the operator's switches are read from the environment it was handed.
function verify(release) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { probeDeclaredTargets } from "./scripts/release.mjs";\nconsole.log(probeDeclaredTargets(process.argv[1]).join("\\n"));',
      release,
    ],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

before(async () => {
  dir = scratch("probe");
  registries = await registryDoubles(dir);
  env = releaseEnv({
    gh: githubDouble(dir, `v${version()}`),
    registries,
    home: dir,
  });
});

after(async () => {
  await registries?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a prerelease is verified against PyPI's PEP 440 spelling and every other registry's Cargo one", () => {
  serve({ wheelVersion: "0.39.0rc1" });
  const run = verify(PRERELEASE);
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /^pypi:onepipeline-api-cli -> 0\.39\.0rc1$/m);
  assert.match(run.stdout, /^crate:onepipeline-ui -> 0\.39\.0-rc\.1$/m);
  assert.match(run.stdout, /^npm:onepipeline-api-cli -> 0\.39\.0-rc\.1$/m);
  assert.match(run.stdout, /^npm:onepipeline-ui -> 0\.39\.0-rc\.1$/m);
});

test("PyPI serving another prerelease of the same version fails the verification", () => {
  serve({ wheelVersion: "0.39.0rc2" });
  const run = verify(PRERELEASE);
  assert.notEqual(run.status, 0, run.output);
  assert.match(
    run.stderr,
    /the release probe answers 0\.39\.0rc2 for pypi:onepipeline-api-cli, not 0\.39\.0-rc\.1/,
  );
});
