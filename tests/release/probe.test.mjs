// The question `publish`'s `verify` phase asks every declared target once a
// release is out, asked of a prerelease: crates.io and npm answer the version as
// Cargo spells it (`1.2.3-rc.1`) and PyPI as PEP 440 does (`1.2.3rc1`), so the
// verification has to accept each registry's own spelling of this version and
// nothing else. The publication journeys run at Cargo.toml's stable version,
// where the two spellings coincide, so this is where the difference is driven:
// the real scripts/release-probe.sh against the registry doubles, called the
// way the phase calls it, with the doubles serving a prerelease nothing built.
//
// The same verification then asks the probe's other two answers: a name nobody
// released is answered empty, and an identifier the probe cannot read is
// refused. The registry double can make a never-released name answer a version,
// which the real probe then reports. What it cannot make is the probe *fail* on
// that name while answering the declared targets, or *accept* an identifier it
// should refuse: those are regressions of scripts/release-probe.sh itself. For
// those two the verification runs from a scratch copy of scripts/release.mjs
// whose release-probe.sh hands every identifier to the real one except the one
// the case names, so the verifier under test is the real code and the fault is
// the one program it calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
function serve({
  wheelVersion,
  npmVersion = PRERELEASE,
  crateVersion = PRERELEASE,
}) {
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
    rmSync(packages, { recursive: true, force: true });
    mkdirSync(packages, { recursive: true });
    writeFileSync(
      join(packages, `${npmVersion}.json`),
      JSON.stringify({ name: pkg, version: npmVersion }),
    );
    writeFileSync(join(packages, `${npmVersion}.tgz`), "a package");
  }
  const crates = join(registries.state, "crates");
  rmSync(crates, { recursive: true, force: true });
  mkdirSync(crates);
  writeFileSync(
    join(crates, `onepipeline-ui-${crateVersion}.json`),
    JSON.stringify({ name: "onepipeline-ui", vers: crateVersion }),
  );
}

// The phase's own verification, in a process of its own as the phase runs it,
// so the operator's switches are read from the environment it was handed. From
// `root`, a checkout's copy of scripts/release.mjs and release-targets.toml.
function verify(release, { root = ROOT, extra = {} } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { probeDeclaredTargets } from "./scripts/release.mjs";\nconsole.log(probeDeclaredTargets(process.argv[1]).join("\\n"));',
      release,
    ],
    { cwd: root, env: { ...env, ...extra }, encoding: "utf8" },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

// A scratch checkout of the verifier whose release-probe.sh is the real one for
// every identifier but $PROBE_FAULT_ID, which it answers as $PROBE_FAULT says:
// `fail` exits non-zero as an unreachable registry does, `accept` exits zero
// with nothing, as a probe that stopped refusing an identifier would.
function faultyCheckout() {
  const root = join(dir, "faulty-checkout");
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(
    join(ROOT, "scripts/release.mjs"),
    join(root, "scripts/release.mjs"),
  );
  copyFileSync(
    join(ROOT, "release-targets.toml"),
    join(root, "release-targets.toml"),
  );
  const probe = join(root, "scripts/release-probe.sh");
  writeFileSync(
    probe,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "\${PROBE_FAULT_ID:-}" ]; then
  case "$PROBE_FAULT" in
    fail) echo "release-probe: the injected fault for $1" >&2; exit 1 ;;
    accept) exit 0 ;;
  esac
fi
cd ${JSON.stringify(ROOT)}
exec bash scripts/release-probe.sh "$1"
`,
  );
  chmodSync(probe, 0o755);
  return root;
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
    /the release probe answers 0\.39\.0rc2 for pypi:onepipeline-api-cli, not 0\.39\.0rc1/,
  );
});

test("npm or the crate registry answering PyPI's spelling of the prerelease fails the verification", () => {
  for (const [registry, spelling, id] of [
    ["npm", { npmVersion: "0.39.0rc1" }, "npm:onepipeline-api-cli"],
    ["crates.io", { crateVersion: "0.39.0rc1" }, "crate:onepipeline-ui"],
  ]) {
    serve({ wheelVersion: "0.39.0rc1", ...spelling });
    const run = verify(PRERELEASE);
    assert.notEqual(run.status, 0, `${registry}: ${run.output}`);
    assert.match(
      run.stderr,
      new RegExp(
        `the release probe answers 0\\.39\\.0rc1 for ${id}, not 0\\.39\\.0-rc\\.1`,
      ),
      registry,
    );
  }
});

test("a name nobody released that a registry answers fails the verification", () => {
  serve({ wheelVersion: "0.39.0rc1" });
  const never = join(
    registries.state,
    "npm",
    "onepipeline-ui-has-never-been-published",
  );
  mkdirSync(never, { recursive: true });
  writeFileSync(
    join(never, "1.0.0.json"),
    JSON.stringify({
      name: "onepipeline-ui-has-never-been-published",
      version: "1.0.0",
    }),
  );
  writeFileSync(join(never, "1.0.0.tgz"), "a package");
  try {
    const run = verify(PRERELEASE);
    assert.notEqual(run.status, 0, run.output);
    assert.match(
      run.stderr,
      /the release probe answered '1\.0\.0' \(exit 0\) for npm:onepipeline-ui-has-never-been-published/,
    );
  } finally {
    rmSync(never, { recursive: true, force: true });
  }
});

test("a probe that cannot answer for a name nobody released fails the verification", () => {
  serve({ wheelVersion: "0.39.0rc1" });
  const run = verify(PRERELEASE, {
    root: faultyCheckout(),
    extra: {
      PROBE_FAULT_ID: "pypi:onepipeline-ui-has-never-been-published",
      PROBE_FAULT: "fail",
    },
  });
  assert.notEqual(run.status, 0, run.output);
  assert.match(
    run.stderr,
    /the release probe answered '' \(exit 1\) for pypi:onepipeline-ui-has-never-been-published: release-probe: the injected fault/,
  );
});

test("a probe that accepts an identifier it must refuse fails the verification", () => {
  serve({ wheelVersion: "0.39.0rc1" });
  const root = faultyCheckout();
  // The same checkout without the fault verifies, so the refusal below is the
  // injected one and nothing else the copy changed.
  const sound = verify(PRERELEASE, { root });
  assert.equal(sound.status, 0, sound.output);
  const run = verify(PRERELEASE, {
    root,
    extra: { PROBE_FAULT_ID: "docker:onepipeline-ui", PROBE_FAULT: "accept" },
  });
  assert.notEqual(run.status, 0, run.output);
  assert.match(
    run.stderr,
    /the release probe answered docker:onepipeline-ui instead of refusing it/,
  );
});
