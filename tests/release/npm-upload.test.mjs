// A platform job's `upload npm`, on what npm's registry does with a publish it
// takes. npm can stage a publish — hold it for a maintainer's 2FA approval,
// served to nobody — and `npm publish` exits 0 on that exactly as on a
// publication. The real recipe and the real npm CLI are driven here against the
// npm double, which stages a publish the way npm's registry does: a 2xx to the
// PUT, the version listed only in the stage queue, and a 409 to any later
// publish of it.
//
// What an upload publishes is the tarball its build staged and nothing else, so
// each job's is packed here from a manifest and the smallest SBOM an upload
// takes alone: no binary is compiled, and what is under test is the publish
// and its report, not the package.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
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
import { plan } from "../../scripts/release.mjs";
import { PACKAGED_SBOM } from "../../scripts/sbom.mjs";
import {
  githubDouble,
  minimalSbom,
  ROOT,
  recipe,
  recipeRunning,
  registryDoubles,
  releaseEnv,
  scratch,
  version,
} from "./support.mjs";

const VERSION = version();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let dir;
let outs;
let registries;
let env;

before(async () => {
  dir = scratch("npm-upload");
  // An upload takes its --out only under the checkout's target/.
  mkdirSync(join(ROOT, "target"), { recursive: true });
  outs = mkdtempSync(join(ROOT, "target", "release-journey-npm-upload-"));
  const gh = githubDouble(dir, `v${VERSION}`);
  registries = await registryDoubles(dir);
  env = releaseEnv({ gh, registries, home: dir });
});

after(async () => {
  await registries?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (outs) rmSync(outs, { recursive: true, force: true });
});

// The job's npm platform package, staged under a fresh --out as its build
// phase leaves it. `attempt` names the attempt of the release that built it:
// two attempts' packages differ in their bytes, as a rebuild's do, because the
// binary is not reproducible.
function stagedPackage(job, attempt = "") {
  const artifact = plan(job).artifacts.find((a) => a.registry === "npm");
  const out = join(outs, `${job}${attempt && `-${attempt}`}`);
  const source = join(out, "source");
  mkdirSync(join(source, "sboms"), { recursive: true });
  mkdirSync(join(out, "npm-artifacts"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: artifact.package,
      version: VERSION,
      description: `the ${job} platform package this journey publishes${attempt && `, as ${attempt} built it`}`,
      license: "MIT",
      files: [PACKAGED_SBOM],
    }),
  );
  writeFileSync(join(source, PACKAGED_SBOM), minimalSbom());
  execFileSync(
    "npm",
    ["pack", "--pack-destination", join(out, "npm-artifacts")],
    { cwd: source, env, stdio: "ignore" },
  );
  const tarball = join(out, "npm-artifacts", artifact.file);
  return {
    artifact,
    out,
    id: `${artifact.package}@${VERSION}`,
    integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
  };
}

const upload = (job, out, extra = {}, against = env) =>
  recipe(job, ["upload", "npm", "--out", out], { ...against, ...extra });

function npmView(id, field, against = env) {
  const view = spawnSync(
    "npm",
    ["view", id, field, "--json", "--prefer-online"],
    { env: against, encoding: "utf8" },
  );
  return view.status === 0 ? view.stdout.trim() : undefined;
}
const npmServes = (id, against = env) =>
  npmView(id, "version", against) === JSON.stringify(VERSION);

// Registries of a journey's own, for one that leaves a package on npm at this
// version which the journeys sharing the file's registries publish too.
async function ownRegistries() {
  const home = scratch("npm-upload-own");
  const registries = await registryDoubles(home);
  const gh = githubDouble(home, `v${VERSION}`);
  return {
    registries,
    env: releaseEnv({ gh, registries, home }),
    close: async () => {
      await registries.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// Until `running` has printed what `pattern` matches, or has exited.
async function until(running, pattern) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    if (pattern.test(running.output()) || running.exited()) return;
    await sleep(100);
  }
}

test("a publish npm stages instead of publishing fails the upload, naming the package, version and stage, and is never reported published", () => {
  const { artifact, out, id } = stagedPackage("windows");
  registries.stage([id]);
  try {
    const staged = upload("windows", out);
    assert.notEqual(staged.status, 0, staged.output);
    assert.match(
      staged.stderr,
      new RegExp(
        `npm staged '${escapeRegExp(id)}' \\(stage id [0-9a-f-]{36}\\) instead of publishing it`,
      ),
    );
    assert.match(staged.stderr, /npm stage approve [0-9a-f-]{36}/);
    assert.match(
      staged.stderr,
      new RegExp(`publishing ${escapeRegExp(artifact.file)} to npm failed`),
    );
    assert.doesNotMatch(staged.output, /npm published/);
    assert.equal(npmServes(id), false, "npm serves nothing it staged");

    // A re-run while it is still staged cannot publish over it: it waits its
    // bounded deadline for npm to serve what it holds, and then fails, saying
    // so and naming the approval that would release it.
    const rerun = upload("windows", out, { RELEASE_NPM_HELD_BUDGET: "2" });
    assert.notEqual(rerun.status, 0, rerun.output);
    assert.match(
      rerun.stderr,
      new RegExp(
        `Cannot publish over previously staged version "${escapeRegExp(VERSION)}"`,
      ),
    );
    assert.match(
      rerun.stderr,
      new RegExp(
        `npm holds ${escapeRegExp(id)} from an earlier attempt of v${escapeRegExp(VERSION)} and still does not serve it after \\d+s`,
      ),
    );
    assert.match(rerun.stderr, /npm stage approve [0-9a-f-]{36}/);
    assert.doesNotMatch(rerun.output, /npm published/);

    // Once a maintainer approves it npm serves it, and the re-run that finishes
    // the release reports it already served, held to this build's bytes.
    registries.approveStaged();
    const approved = upload("windows", out);
    assert.equal(approved.status, 0, approved.output);
    assert.match(
      approved.stdout,
      new RegExp(
        `npm published nothing; already served ${escapeRegExp(artifact.file)}`,
      ),
    );
    assert.equal(npmServes(id), true);
  } finally {
    registries.clear();
  }
});

test("a publish npm takes is reported published, and npm serves it, beside another version and another package npm has staged", () => {
  const { artifact, out, id } = stagedPackage("macos");
  // Only this package at this version is held to the stage queue.
  const held = join(registries.state, "npm-staged");
  for (const [packageName, staged] of [
    [artifact.package, "0.0.1"],
    ["onepipeline-api-cli-win32-x64", VERSION],
  ])
    writeFileSync(
      join(held, `${packageName}@${staged}.json`),
      JSON.stringify({
        id: randomUUID(),
        packageName,
        version: staged,
        tag: "latest",
      }),
    );
  try {
    const published = upload("macos", out);
    assert.equal(published.status, 0, published.output);
    assert.match(
      published.stdout,
      new RegExp(
        `release macos: npm published ${escapeRegExp(artifact.file)}; already served nothing`,
      ),
    );
    assert.deepEqual(
      registries.uploads().filter((line) => line.includes(artifact.package)),
      [`npm ${artifact.file}`],
    );
    assert.equal(npmServes(id), true);
  } finally {
    for (const file of readdirSync(held)) rmSync(join(held, file));
  }
});

test("a stage queue npm does not answer after a publish fails the upload rather than reading it as published", () => {
  const { artifact, out, id } = stagedPackage("linux-arm64");
  registries.breakReads(["npm-stage=503"]);
  try {
    const unread = upload("linux-arm64", out, {
      NPM_CONFIG_FETCH_RETRIES: "0",
    });
    assert.notEqual(unread.status, 0, unread.output);
    assert.match(
      unread.stderr,
      new RegExp(
        `cannot ask npm whether it staged '${escapeRegExp(id)}' rather than publishing it`,
      ),
    );
    assert.doesNotMatch(unread.output, /npm published/);
  } finally {
    registries.clear();
  }
  // npm did take this one, so the re-run finds it served.
  const rerun = upload("linux-arm64", out);
  assert.equal(rerun.status, 0, rerun.output);
  assert.match(
    rerun.stdout,
    new RegExp(`already served ${escapeRegExp(artifact.file)}`),
  );
});

test("a stage queue whose entries name no version or stage id fails the upload rather than reading it as published", () => {
  const { artifact, out, id } = stagedPackage("linux");
  registries.breakReads(["npm-stage=malformed"]);
  try {
    const unread = upload("linux", out);
    assert.notEqual(unread.status, 0, unread.output);
    assert.match(
      unread.stderr,
      new RegExp(
        `npm answered its stage list for '${escapeRegExp(id)}' with something that is not one`,
      ),
    );
    assert.match(unread.stderr, /did not return staged versions with ids/);
    assert.doesNotMatch(unread.output, /npm published/);
  } finally {
    registries.clear();
  }
  const rerun = upload("linux", out);
  assert.equal(rerun.status, 0, rerun.output);
  assert.match(
    rerun.stdout,
    new RegExp(`already served ${escapeRegExp(artifact.file)}`),
  );
});

test("a re-run whose earlier attempt's package npm serves keeps it, naming both builds, and publishes nothing", async () => {
  // v0.41.2's build-windows, attempt 3: npm serves the package attempt 1
  // published, and the re-run rebuilt a binary that is not byte-identical.
  const own = await ownRegistries();
  try {
    const earlier = stagedPackage("windows", "attempt-1");
    const first = upload("windows", earlier.out, {}, own.env);
    assert.equal(first.status, 0, first.output);
    const rebuilt = stagedPackage("windows", "attempt-3");
    assert.notEqual(rebuilt.integrity, earlier.integrity);
    const landed = own.registries.uploads();

    const rerun = upload("windows", rebuilt.out, {}, own.env);
    assert.equal(rerun.status, 0, rerun.output);
    assert.match(
      rerun.stdout,
      new RegExp(
        `npm already holds ${escapeRegExp(earlier.id)} from an earlier attempt of v${escapeRegExp(VERSION)} \\(${escapeRegExp(earlier.integrity)}, where this build's is ${escapeRegExp(rebuilt.integrity)}\\); it is kept`,
      ),
    );
    assert.match(
      rerun.stdout,
      new RegExp(
        `npm published nothing; already served ${escapeRegExp(rebuilt.artifact.file)}`,
      ),
    );
    assert.deepEqual(
      own.registries.uploads(),
      landed,
      "nothing was sent again",
    );
    assert.equal(
      npmView(earlier.id, "dist.integrity", own.env),
      JSON.stringify(earlier.integrity),
      "npm still serves the earlier attempt's package",
    );
  } finally {
    await own.close();
  }
});

// v0.41.2's build-windows, attempt 2: npm held attempt 1's package and served
// nothing for it, and refused the re-run's publish over it. npm answers such a
// publish two ways: a 409 for a version it staged, and a 403 for one it took
// and does not list yet.
for (const [held, hold, release, refusal] of [
  [
    "staged",
    (registries, id) => registries.stage([id]),
    (registries) => registries.approveStaged(),
    /Cannot publish over previously staged version/,
  ],
  [
    "published and not listed yet",
    (registries, id) => registries.hide([id]),
    (registries) => registries.clear(),
    /You cannot publish over the previously published versions/,
  ],
])
  test(`a re-run while npm holds an earlier attempt's version ${held}, and serves nothing for it, waits for it rather than failing, and keeps it`, async () => {
    const own = await ownRegistries();
    try {
      const earlier = stagedPackage("macos", `attempt-1-${held.split(" ")[0]}`);
      hold(own.registries, earlier.id);
      // The earlier attempt's publish, which npm took and does not serve.
      if (held === "staged")
        assert.notEqual(
          upload("macos", earlier.out, {}, own.env).status,
          0,
          "npm staged it",
        );
      else assert.equal(upload("macos", earlier.out, {}, own.env).status, 0);
      assert.equal(npmServes(earlier.id, own.env), false);
      const accepted = own.registries.uploads();

      const rebuilt = stagedPackage("macos", `attempt-2-${held.split(" ")[0]}`);
      const rerun = recipeRunning(
        "macos",
        ["upload", "npm", "--out", rebuilt.out],
        { ...own.env, RELEASE_NPM_HELD_BUDGET: "120" },
      );
      await until(rerun, /from an earlier attempt/);
      assert.equal(
        rerun.exited(),
        false,
        `the re-run waits for npm rather than failing: ${rerun.output()}`,
      );
      assert.match(rerun.output(), refusal);
      release(own.registries);
      const finished = await rerun;
      assert.equal(finished.status, 0, finished.output);
      assert.match(
        finished.stdout,
        new RegExp(
          `npm already holds ${escapeRegExp(earlier.id)} from an earlier attempt of v${escapeRegExp(VERSION)} \\(${escapeRegExp(earlier.integrity)}, where this build's is ${escapeRegExp(rebuilt.integrity)}\\)`,
        ),
      );
      assert.match(
        finished.stdout,
        new RegExp(
          `npm published nothing; already served ${escapeRegExp(rebuilt.artifact.file)}`,
        ),
      );
      assert.deepEqual(
        own.registries.uploads(),
        accepted,
        "the re-run's build was never taken",
      );
      assert.equal(
        npmView(earlier.id, "dist.integrity", own.env),
        JSON.stringify(earlier.integrity),
      );
    } finally {
      await own.close();
    }
  });
