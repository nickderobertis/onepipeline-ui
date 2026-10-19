// `publish`'s availability check, the gate in front of everything
// platform-independent, on the answers that stop it before any platform's
// files are even looked for. It reads the build jobs' results and the
// registries and builds nothing, so it is driven here over the `gh` and
// registry doubles with nothing staged: whatever it lets through would show up
// as an upload.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PLATFORMS, plan } from "../../scripts/release.mjs";
import {
  githubDouble,
  ROOT,
  recipe,
  recipeRunning,
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

test("with npm and PyPI switched off, every platform's Release assets are all it requires, and neither registry is asked", () => {
  for (const job of Object.keys(PLATFORMS))
    for (const artifact of plan(job).artifacts)
      if (artifact.registry === "github")
        writeFileSync(join(gh.assets, artifact.file), artifact.file);
  // Both registries' reads are broken, so asking either would fail the check.
  registries.breakReads(["pypi-json=503", "npm-packument=503"]);
  try {
    const off = {
      BUILD_RESULTS: allBuilt,
      PYPI_PUBLISH: "false",
      NPM_PUBLISH: "false",
    };
    const check = publish(["check"], off);
    assert.equal(check.status, 0, check.output);
    assert.match(check.stdout, /every platform's v\S+ files are served/);
    // One platform's archive gone, and the same check refuses again.
    const [archive] = plan("windows").artifacts.filter(
      (a) => a.kind === "archive",
    );
    rmSync(join(gh.assets, archive.file));
    const missing = publish(["check"], off);
    assert.notEqual(missing.status, 0, missing.output);
    assert.match(
      missing.stderr,
      new RegExp(`GitHub Release ${escapeRegExp(archive.file)}`),
    );
    assert.doesNotMatch(missing.stderr, /PyPI|npm /);
  } finally {
    registries.clear();
    for (const file of readdirSync(gh.assets)) rmSync(join(gh.assets, file));
  }
  assert.deepEqual(registries.uploads(), []);
});

// Every process descended from `pid`, read from /proc: the one a signal goes to
// is found under the recipe this journey started, never by name.
function descendants(pid) {
  const parents = new Map();
  for (const entry of readdirSync("/proc").filter((e) => /^\d+$/.test(e))) {
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      parents.set(
        Number(entry),
        Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
      );
    } catch {
      // Gone between the listing and the read.
    }
  }
  const found = [];
  const pending = [pid];
  while (pending.length) {
    const parent = pending.pop();
    for (const [child, of] of parents)
      if (of === parent) {
        found.push(child);
        pending.push(child);
      }
  }
  return found;
}

test("a release-status.sh stopped by a signal fails settle rather than ending it as a success", async () => {
  const hold = join(gh.state, "hold");
  writeFileSync(hold, "");
  const child = spawn("just", ["release-publish", "settle"], {
    cwd: ROOT,
    env: {
      ...env,
      BUILD_RESULTS: allBuilt,
      STEP_RESULTS:
        "check=success build=success upload-crate=success upload-npm=success upload-github=success verify=success",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const exited = new Promise((done) =>
    child.once("exit", (code) => done(code)),
  );
  try {
    let status;
    for (let i = 0; i < 400 && !status; i++) {
      status = descendants(child.pid).find((pid) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8")
            .split("\0")
            .includes("scripts/release-status.sh");
        } catch {
          return false;
        }
      });
      if (!status) await sleep(50);
    }
    assert.ok(status, "release-status.sh started under the recipe");
    // Waiting on the held `gh`, so it has decided nothing yet.
    for (let i = 0; i < 400 && !gh.calls().length; i++) await sleep(50);
    process.kill(status, "SIGTERM");
  } finally {
    rmSync(hold, { force: true });
  }
  const code = await exited;
  assert.notEqual(code, 0, stderr);
  assert.match(
    stderr,
    /scripts\/release-status\.sh was stopped by SIGTERM before it decided the release/,
  );
  assert.match(stderr, /ACTION: re-run the publish job/);
  assert.ok(!gh.prerelease(), "nothing edited the Release");
  assert.ok(!existsSync(hold));
});

// Every platform's files where the three build jobs leave them, under their
// planned names; `unseed` takes them away again.
function seedPlatforms() {
  const V = version();
  for (const job of Object.keys(PLATFORMS))
    for (const artifact of plan(job).artifacts) {
      if (artifact.registry === "github")
        writeFileSync(join(gh.assets, artifact.file), artifact.file);
      if (artifact.registry === "pypi")
        writeFileSync(
          join(registries.state, "pypi", artifact.file),
          artifact.file,
        );
      if (artifact.registry === "npm") {
        const pkg = join(registries.state, "npm", artifact.package);
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
          join(pkg, `${V}.json`),
          JSON.stringify({ name: artifact.package, version: V }),
        );
        writeFileSync(join(pkg, `${V}.tgz`), artifact.file);
      }
    }
}
function unseed() {
  registries.clear();
  for (const file of readdirSync(gh.assets)) rmSync(join(gh.assets, file));
  for (const dir of ["pypi", "npm"]) {
    rmSync(join(registries.state, dir), { recursive: true, force: true });
    mkdirSync(join(registries.state, dir));
  }
}

const platformPackages = () =>
  Object.keys(PLATFORMS).flatMap((job) =>
    plan(job)
      .artifacts.filter((a) => a.registry === "npm")
      .map((a) => a.package),
  );

test("a platform package npm lists before it serves is waited for, and check passes only once npm serves it", async () => {
  const V = version();
  const linux = `onepipeline-api-cli-linux-x64@${V}`;
  seedPlatforms();
  // v0.40.0's linux-x64, minutes after its publish: the packument names the
  // version and the tarball answers 404.
  registries.unserve([linux]);
  const served = registries.served().length;
  try {
    const started = Date.now();
    const running = recipeRunning("publish", ["check"], {
      ...env,
      BUILD_RESULTS: allBuilt,
      RELEASE_CHECK_BUDGET: "120",
    });
    await sleep(4000);
    assert.deepEqual(
      registries
        .served()
        .slice(served)
        .filter((line) => line.includes("linux-x64")),
      [],
      "nothing served it while npm did not",
    );
    registries.clear();
    const check = await running;
    assert.equal(check.status, 0, check.output);
    assert.match(check.stdout, /every platform's v\S+ files are served/);
    assert.ok(Date.now() - started >= 4000, "it waited for npm to serve it");
    // Every platform package was fetched by version, the late one included.
    assert.deepEqual(
      registries
        .served()
        .slice(served)
        .map((line) => line.split(" ")[1])
        .sort(),
      platformPackages()
        .map((pkg) => `${pkg}-${V}.tgz`)
        .sort(),
    );
    assert.deepEqual(registries.uploads(), []);
  } finally {
    unseed();
  }
});

test("a platform package npm does not list yet is waited for beside one it lists and does not serve, and check passes once npm serves both", async () => {
  const V = version();
  seedPlatforms();
  // A successful build's package npm has not even listed, and another it lists
  // with no tarball behind it.
  registries.hide([`onepipeline-api-cli-linux-x64@${V}`]);
  registries.unserve([`onepipeline-api-cli-win32-x64@${V}`]);
  const served = registries.served().length;
  try {
    const running = recipeRunning("publish", ["check"], {
      ...env,
      BUILD_RESULTS: allBuilt,
      RELEASE_CHECK_BUDGET: "120",
    });
    await sleep(4000);
    registries.clear();
    const check = await running;
    assert.equal(check.status, 0, check.output);
    assert.deepEqual(
      registries
        .served()
        .slice(served)
        .map((line) => line.split(" ")[1])
        .sort(),
      platformPackages()
        .map((pkg) => `${pkg}-${V}.tgz`)
        .sort(),
    );
  } finally {
    unseed();
  }
});

test("the wait is one deadline for every platform package, not one per package", () => {
  const V = version();
  seedPlatforms();
  // Two packages npm never serves: the second gets what the first left.
  registries.unserve([
    `onepipeline-api-cli-linux-x64@${V}`,
    `onepipeline-api-cli-win32-x64@${V}`,
  ]);
  try {
    const started = Date.now();
    const check = publish(["check"], {
      BUILD_RESULTS: allBuilt,
      RELEASE_CHECK_BUDGET: "20",
    });
    const elapsed = (Date.now() - started) / 1000;
    assert.notEqual(check.status, 0, check.output);
    for (const pkg of ["linux-x64", "win32-x64"])
      assert.match(
        check.stderr,
        new RegExp(
          `not every platform published .*npm onepipeline-api-cli-${pkg}@`,
        ),
      );
    // retry-install backs off 1, 2, 4 and 8 s, so one 20 s budget runs out
    // after about 15 s of waiting, and two of them after about 30.
    assert.ok(elapsed >= 14, `it waited the budget: ${elapsed} s`);
    assert.ok(elapsed < 26, `not a budget per package: ${elapsed} s`);
  } finally {
    unseed();
  }
});

test("a budget that is not whole seconds is refused before anything is asked", () => {
  const check = publish(["check"], {
    BUILD_RESULTS: allBuilt,
    RELEASE_CHECK_BUDGET: "-5",
  });
  assert.equal(check.status, 2, check.output);
  assert.match(
    check.stderr,
    /RELEASE_CHECK_BUDGET must be a whole number of seconds, not '-5'/,
  );
});

test("a platform package npm never serves within the wait fails check, and no upload publishes the launcher past it", () => {
  const V = version();
  seedPlatforms();
  registries.unserve([`onepipeline-api-cli-win32-x64@${V}`]);
  try {
    const extra = { BUILD_RESULTS: allBuilt, RELEASE_CHECK_BUDGET: "3" };
    const check = publish(["check"], extra);
    assert.notEqual(check.status, 0, check.output);
    assert.match(
      check.stderr,
      /npm onepipeline-api-cli-win32-x64 \S+: still not installable after \d+ attempts/,
    );
    assert.match(
      check.stderr,
      new RegExp(
        `not every platform published .*npm onepipeline-api-cli-win32-x64@${escapeRegExp(V)}`,
      ),
    );
    // An upload's own check does not wait, and does not take npm's listing of
    // a version for npm serving it either.
    for (const registry of ["crate", "npm", "github"]) {
      const upload = publish(["upload", registry], extra);
      assert.notEqual(upload.status, 0, `${registry}: ${upload.output}`);
      assert.match(upload.stderr, /not every platform published/, registry);
    }
    assert.deepEqual(registries.uploads(), []);
    assert.deepEqual(gh.uploads(), []);
  } finally {
    unseed();
  }
});

test("a platform package whose build job did not succeed is reported at once, never waited for as a slow registry", () => {
  const V = version();
  seedPlatforms();
  registries.hide([`onepipeline-api-cli-win32-x64@${V}`]);
  const served = registries.served().length;
  try {
    const started = Date.now();
    const check = publish(["check"], {
      BUILD_RESULTS:
        "build-linux=success build-macos=success build-windows=failure",
      RELEASE_CHECK_BUDGET: "600",
    });
    assert.notEqual(check.status, 0, check.output);
    assert.ok(
      Date.now() - started < 60_000,
      "it did not spend the wait on a package nothing published",
    );
    assert.match(
      check.stderr,
      new RegExp(
        `build-windows \\(failure\\), npm onepipeline-api-cli-win32-x64@${escapeRegExp(V)}`,
      ),
    );
    assert.doesNotMatch(
      check.stderr,
      /attempt \d+ failed|still not installable/,
    );
    assert.deepEqual(
      registries.served().slice(served),
      [],
      "no package was fetched",
    );
  } finally {
    unseed();
  }
});

test("once every platform is served, publish's uploads still refuse an --out its build never staged", () => {
  seedPlatforms();
  mkdirSync(join(ROOT, "target"), { recursive: true });
  const out = mkdtempSync(join(ROOT, "target", "release-journey-unbuilt-"));
  try {
    const extra = { BUILD_RESULTS: allBuilt };
    const check = publish(["check"], extra);
    assert.equal(check.status, 0, check.output);
    const uploads = gh.uploads().length;
    for (const registry of ["crate", "npm", "github"]) {
      const run = publish(["upload", registry, "--out", out], extra);
      assert.notEqual(run.status, 0, `${registry}: ${run.output}`);
      assert.match(
        run.stderr,
        new RegExp(`nothing staged under ${escapeRegExp(out)} for: \\S`),
        registry,
      );
      assert.match(
        run.stderr,
        /ACTION: run the build phase of this recipe first/,
        registry,
      );
    }
    assert.equal(gh.uploads().length, uploads);
    assert.deepEqual(registries.uploads(), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
    unseed();
  }
});
