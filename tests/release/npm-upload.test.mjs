// A platform job's `upload npm`, on what npm's registry does with a publish it
// takes. npm can stage a publish — hold it for a maintainer's 2FA approval,
// served to nobody — and `npm publish` exits 0 on that exactly as on a
// publication. The real recipe and the real npm CLI are driven here against the
// npm double, which stages a publish the way npm's registry does: a 2xx to the
// PUT, the version listed only in the stage queue, and a 409 to any later
// publish of it.
//
// What an upload publishes is the tarball its build staged and nothing else, so
// each job's is packed here from a manifest alone: no binary is compiled, and
// what is under test is the publish and its report, not the package.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { plan } from "../../scripts/release.mjs";
import {
  githubDouble,
  ROOT,
  recipe,
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
// phase leaves it.
function stagedPackage(job) {
  const artifact = plan(job).artifacts.find((a) => a.registry === "npm");
  const out = join(outs, job);
  const source = join(out, "source");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(out, "npm-artifacts"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: artifact.package,
      version: VERSION,
      description: `the ${job} platform package this journey publishes`,
      license: "MIT",
    }),
  );
  execFileSync(
    "npm",
    ["pack", "--pack-destination", join(out, "npm-artifacts")],
    { cwd: source, env, stdio: "ignore" },
  );
  return { artifact, out, id: `${artifact.package}@${VERSION}` };
}

const upload = (job, out, extra = {}) =>
  recipe(job, ["upload", "npm", "--out", out], { ...env, ...extra });

function npmServes(id) {
  const view = spawnSync(
    "npm",
    ["view", id, "version", "--json", "--prefer-online"],
    { env, encoding: "utf8" },
  );
  return view.status === 0 && view.stdout.trim() === JSON.stringify(VERSION);
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

    // A re-run while it is still staged cannot publish over it, and says so.
    const rerun = upload("windows", out);
    assert.notEqual(rerun.status, 0, rerun.output);
    assert.match(
      rerun.stderr,
      new RegExp(
        `Cannot publish over previously staged version "${escapeRegExp(VERSION)}"`,
      ),
    );
    assert.match(rerun.stderr, new RegExp(`'${escapeRegExp(id)}'`));
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
