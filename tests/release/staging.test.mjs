// What the build-linux recipe does when the files a phase acts on were never
// staged: every phase after `build` reads the plan's files from --out, and one
// that found nothing there must say so and stop, rather than install, upload or
// report on less than the plan names. Driven over an empty --out against the
// registry and `gh` doubles, so a refusal that let anything through would show
// up as an upload.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { plan, sbomScratch, TARGETS } from "../../scripts/release.mjs";
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

// Two publish builds run at once in the release journeys — registries.test.mjs
// stages into target/release-journey/publish while publication.test.mjs stages
// into target/local-publication/whole-publish — and cargo-cyclonedx can write
// only at the checkout root, so each build's SBOM must have a name there of its
// own, and the same one every time it builds that tree.
test("publish builds into different staging trees write their SBOMs to different files", () => {
  const registriesOut = join(ROOT, "target/release-journey/publish");
  const publicationOut = join(ROOT, "target/local-publication/whole-publish");
  const named = [registriesOut, publicationOut].map((tree) =>
    sbomScratch(tree),
  );
  assert.notEqual(named[0], named[1]);
  for (const file of named) {
    assert.equal(
      dirname(file),
      ROOT,
      `${file} is where cargo-cyclonedx writes`,
    );
    assert.match(file, /\/bom-[0-9a-f]{16}\.json$/);
  }
  assert.equal(sbomScratch(registriesOut), named[0], "stable for one tree");
  assert.equal(
    sbomScratch(
      join(ROOT, "target/release-journey/../release-journey/publish"),
    ),
    named[0],
    "one tree however its path is spelled",
  );
  // A platform build writes one per target into its tree, each its own file.
  const perTarget = Object.keys(TARGETS).map((target) =>
    sbomScratch(registriesOut, target),
  );
  assert.equal(new Set([...named, ...perTarget]).size, named.length + 4);
});
