// What the build-linux recipe does with staged files that do not install: the
// rehearsal's own files, from ./journeys.test.mjs, broken one way at a time,
// and a host on which the test-install cannot make its environment. A target of
// its own (`onepipeline-ui-release:test-staged`), after the
// rehearsal and beside ./registries.test.mjs, because neither reads what the
// other writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  fileOf,
  OUT,
  requireRehearsal,
  sha,
  staged,
  TAG,
} from "./rehearsal.mjs";
import { githubDouble, ROOT, recipe, releaseEnv, scratch } from "./support.mjs";

describe("the build-linux recipe, over staged files that do not install", () => {
  let dir;
  let gh;
  before(() => {
    requireRehearsal();
    dir = scratch("rehearsal-failures");
    gh = githubDouble(dir, TAG);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a test-install that fails stops the recipe before any publish command", () => {
    const shim = join(dir, "broken-venv");
    mkdirSync(shim, { recursive: true });
    const python = execFileSync("bash", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(shim, "python3"),
      `#!/usr/bin/env bash\nif [ "$1 $2" = "-m venv" ]; then echo "venv: no ensurepip on this host" >&2; exit 1; fi\nexec ${python} "$@"\n`,
      { mode: 0o755 },
    );
    const env = releaseEnv({
      gh,
      registries: { base: "http://127.0.0.1:9", npm: "http://127.0.0.1:9/" },
      home: dir,
    });
    const failed = recipe(
      "linux",
      [
        "all",
        "--dry-run",
        "--out",
        join(ROOT, "target/release-journey/linux-failing"),
      ],
      { ...env, PATH: `${shim}:${env.PATH}` },
    );
    assert.notEqual(failed.status, 0, failed.output);
    assert.match(
      failed.stderr,
      /installing the staged x86_64-unknown-linux-gnu files failed/,
    );
    assert.match(
      failed.stderr,
      /ACTION: the files this job would publish do not install and run/,
    );
    assert.doesNotMatch(failed.stdout, /would run/);
    assert.deepEqual(gh.calls(), []);
  });

  test("a staged checksum that does not describe its archive fails the test-install", () => {
    const tampered = join(ROOT, "target/release-journey/tampered");
    const checksum = join(tampered, "assets", fileOf("checksum").file);
    const env = releaseEnv({
      gh,
      registries: { base: "http://127.0.0.1:9", npm: "http://127.0.0.1:9/" },
      home: dir,
    });
    for (const line of [
      `${"0".repeat(64)}  ${fileOf("archive").file}\n`,
      `${sha(readFileSync(staged(fileOf("archive"))))}  another-archive.tar.gz\n`,
    ]) {
      rmSync(tampered, { recursive: true, force: true });
      execFileSync("cp", ["-a", OUT, tampered]);
      writeFileSync(checksum, line);
      const run = recipe("linux", ["test-install", "--out", tampered], env);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        /the staged checksum does not describe the staged archive/,
      );
    }
    // A staged npm platform package whose manifest names another version, or
    // another platform, than the one it is staged for.
    const pkg = fileOf("npm").package;
    for (const bend of [
      (manifest) => ({ ...manifest, version: "9.9.9" }),
      (manifest) => ({ ...manifest, os: ["darwin"] }),
    ]) {
      rmSync(tampered, { recursive: true, force: true });
      execFileSync("cp", ["-a", OUT, tampered]);
      const path = join(tampered, "npm", pkg, "package.json");
      writeFileSync(
        path,
        JSON.stringify(bend(JSON.parse(readFileSync(path, "utf8")))),
      );
      const run = recipe("linux", ["test-install", "--out", tampered], env);
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.stderr, /invalid staged npm platform metadata/);
    }
    rmSync(tampered, { recursive: true, force: true });
  });
});
