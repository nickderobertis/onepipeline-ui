// What the build-linux recipe does when the files a phase acts on were never
// staged: every phase after `build` reads the plan's files from --out, and one
// that found nothing there must say so and stop, rather than install, upload or
// report on less than the plan names. Driven over an empty --out against the
// registry and `gh` doubles, so a refusal that let anything through would show
// up as an upload.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
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
