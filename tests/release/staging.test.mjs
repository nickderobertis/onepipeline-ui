// What the build-linux recipe does when the files a phase acts on were never
// staged: every phase after `build` reads the plan's files from --out, and one
// that found nothing there must say so and stop, rather than install, upload or
// report on less than the plan names. Driven over an empty --out against the
// registry and `gh` doubles, so a refusal that let anything through would show
// up as an upload.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

let dir;
let gh;
let registries;
let env;
let out;

before(async () => {
  dir = scratch("staging");
  gh = githubDouble(dir, `v${version()}`);
  registries = await registryDoubles(dir);
  env = releaseEnv({ gh, registries, home: dir });
  // Staging is only taken under target/, so the empty --out is made there.
  mkdirSync(join(ROOT, "target"), { recursive: true });
  out = mkdtempSync(join(ROOT, "target", "release-journey-unstaged-"));
});

after(async () => {
  await registries?.close();
  if (out) rmSync(out, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

for (const phase of [
  ["test-install"],
  ["upload", "github"],
  ["upload", "pypi"],
  ["upload", "npm"],
  ["verify"],
])
  test(`build-linux's ${phase.join(" ")} refuses an --out nothing was staged in, and publishes nothing`, () => {
    const run = recipe("linux", [...phase, "--out", out], env);
    assert.notEqual(run.status, 0, run.output);
    assert.match(
      run.stderr,
      new RegExp(
        `nothing staged under ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} for: \\S`,
      ),
    );
    assert.match(
      run.stderr,
      /ACTION: run the build phase of this recipe first, with the same --out/,
    );
    assert.deepEqual(registries.uploads(), []);
    assert.deepEqual(gh.uploads(), []);
  });

test("build-linux's verify refuses carriers staged without the binary they were packed from", () => {
  // Every planned file is there, so what is missing is only the reference the
  // installed binaries are held to.
  const carriers = mkdtempSync(
    join(ROOT, "target", "release-journey-carriers-"),
  );
  const dirs = {
    archive: "assets",
    checksum: "assets",
    wheel: "wheels",
    npm: "npm-artifacts",
  };
  try {
    const { artifacts, targets } = plan("linux");
    for (const artifact of artifacts) {
      mkdirSync(join(carriers, dirs[artifact.kind]), { recursive: true });
      writeFileSync(
        join(carriers, dirs[artifact.kind], artifact.file),
        artifact.file,
      );
    }
    const run = recipe("linux", ["verify", "--out", carriers], env);
    assert.notEqual(run.status, 0, run.output);
    assert.match(
      run.stderr,
      new RegExp(
        `nothing staged under \\S+ for: ${targets[0]}/onepipeline-api`,
      ),
    );
    assert.deepEqual(gh.calls(), [], "nothing was downloaded to compare");
  } finally {
    rmSync(carriers, { recursive: true, force: true });
  }
});

test("publish's build names the path and the re-run when the filesystem refuses its --out", () => {
  // A regular file where the staging tree needs a directory: the refusal comes
  // from the filesystem rather than from a check of the recipe's own, and the
  // operator still has to be told which path to repair and what to run next.
  const blocker = join(out, "not-a-directory");
  writeFileSync(blocker, "a file\n");
  const staging = join(blocker, "publish");
  const run = recipe("publish", ["build", "--out", staging], env);
  assert.notEqual(run.status, 0, run.output);
  assert.match(
    run.stderr,
    new RegExp(
      `ACTION: ENOTDIR on ${blocker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\S+: repair that path`,
    ),
  );
  assert.match(
    run.stderr,
    /then re-run `node scripts\/release\.mjs publish build --out \S+`/,
  );
  assert.deepEqual(registries.uploads(), []);
  assert.deepEqual(gh.uploads(), []);
});
