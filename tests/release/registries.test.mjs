// The publication phases of build-linux and publish against local doubles of
// PyPI, npm, the crate registry and the GitHub Release (./doubles), over the
// files the rehearsal in ./journeys.test.mjs staged. A target of its own
// (`onepipeline-ui-release:test-staged`), after the rehearsal and beside
// ./rehearsal-failures.test.mjs, because neither reads what the other writes.
//
// What this x86_64 Linux host cannot do is build the arm64 Linux, macOS and
// Windows targets; their files are the hosted jobs' to produce, so where a
// journey needs them on a registry (publish's availability check, the
// launcher's optional dependencies) they are seeded under their planned names,
// as those jobs would leave them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { plan, sbomScratch } from "../../scripts/release.mjs";
import {
  fileOf,
  linuxPlan,
  OUT,
  sha,
  staged,
  TAG,
  TARGET,
  VERSION,
} from "./rehearsal.mjs";
import {
  githubDouble,
  ROOT,
  recipe,
  recipeRunning,
  registryDoubles,
  releaseEnv,
  scratch,
} from "./support.mjs";

describe("publication against registry doubles", () => {
  let dir;
  let gh;
  let registries;
  let env;
  const platforms = {
    "linux-arm64": plan("linux-arm64"),
    macos: plan("macos"),
    windows: plan("windows"),
  };
  before(async () => {
    assert.ok(
      existsSync(join(OUT, "assets")),
      "the rehearsal above staged the Linux build",
    );
    dir = scratch("publication");
    gh = githubDouble(dir, TAG);
    registries = await registryDoubles(dir);
    env = releaseEnv({ gh, registries, home: dir });
  });
  after(async () => {
    await registries?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const linux = (...args) => recipe("linux", [...args, "--out", OUT], env);

  test("build-linux publishes exactly the files it built, and a failed upload is finished by a re-run", () => {
    // A switched-on registry without its credential is a failure, not a skip,
    // and it publishes nothing.
    for (const [registry, token, message] of [
      ["pypi", "PYPI_TOKEN", /PYPI_PUBLISH is on but PYPI_TOKEN is empty/],
      [
        "npm",
        "NODE_AUTH_TOKEN",
        /NPM_PUBLISH is on but NODE_AUTH_TOKEN is empty/,
      ],
    ]) {
      const run = recipe("linux", ["upload", registry, "--out", OUT], {
        ...env,
        [token]: "",
      });
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.stderr, message);
    }
    assert.deepEqual(registries.uploads(), []);

    // The checksum, the second asset, fails until the Release accepts it again.
    gh.failUploads(fileOf("checksum").file);
    const first = linux("upload", "github");
    assert.notEqual(first.status, 0, first.output);
    assert.match(first.stderr, /uploading .*\.sha256 failed/);
    assert.deepEqual(readdirSync(gh.assets), [fileOf("archive").file]);
    gh.healUploads();
    const before = gh.uploads().length;
    const again = linux("upload", "github");
    assert.equal(again.status, 0, again.output);
    const reuploaded = gh
      .uploads()
      .slice(before)
      .map((c) => c.at(-1));
    assert.deepEqual(
      reuploaded,
      [staged(fileOf("checksum"))],
      "only what was missing",
    );

    registries.failUploads(fileOf("wheel").file);
    const refused = linux("upload", "pypi");
    assert.notEqual(refused.status, 0, refused.output);
    assert.match(refused.stderr, /uploading .*\.whl to PyPI failed/);
    assert.deepEqual(registries.uploads(), []);
    // The npm platform package, likewise, until the registry takes it again.
    registries.failUploads(`${fileOf("npm").package}-${VERSION}.tgz`);
    const unpublished = recipe("linux", ["upload", "npm", "--out", OUT], {
      ...env,
      NPM_CONFIG_FETCH_RETRIES: "0",
    });
    assert.notEqual(unpublished.status, 0, unpublished.output);
    assert.match(unpublished.stderr, /publishing .*\.tgz to npm failed/);
    assert.deepEqual(registries.uploads(), []);
    registries.clear();
    for (const registry of ["pypi", "npm"]) {
      const run = linux("upload", registry);
      assert.equal(run.status, 0, run.output);
    }
    for (const registry of ["github", "pypi", "npm"]) {
      const count = gh.uploads().length;
      const log = registries.uploads().length;
      const run = linux("upload", registry);
      assert.equal(run.status, 0, run.output);
      assert.equal(gh.uploads().length, count);
      assert.equal(registries.uploads().length, log);
    }
    for (const artifact of linuxPlan.artifacts.filter(
      (a) => a.registry === "github",
    ))
      assert.equal(
        sha(readFileSync(join(gh.assets, artifact.file))),
        sha(readFileSync(staged(artifact))),
      );
    assert.deepEqual(readdirSync(join(registries.state, "pypi")), [
      fileOf("wheel").file,
    ]);
    assert.equal(
      sha(readFileSync(join(registries.state, "pypi", fileOf("wheel").file))),
      sha(readFileSync(staged(fileOf("wheel")))),
    );
    const npmPackage = fileOf("npm").package;
    assert.deepEqual(readdirSync(join(registries.state, "npm")), [npmPackage]);
    assert.deepEqual(
      readdirSync(join(registries.state, "npm", npmPackage)).sort(),
      [`${VERSION}.json`, `${VERSION}.tgz`],
    );
    assert.equal(
      sha(
        readFileSync(
          join(registries.state, "npm", npmPackage, `${VERSION}.tgz`),
        ),
      ),
      sha(readFileSync(staged(fileOf("npm")))),
    );
    // A version npm already serves from some other build is an earlier
    // attempt's, since nothing else publishes under this version's name: npm
    // never replaces a version, so it is kept, named with both digests, and
    // nothing is published over it — as v0.41.2's build-windows re-run had to.
    const tarball = join(registries.state, "npm", npmPackage, `${VERSION}.tgz`);
    const ours = readFileSync(tarball);
    writeFileSync(tarball, "another build's tarball");
    try {
      const count = registries.uploads().length;
      const other = linux("upload", "npm");
      assert.equal(other.status, 0, other.output);
      assert.match(
        other.stdout,
        new RegExp(
          `npm already holds ${npmPackage}@${VERSION.replace(/\./g, "\\.")} from an earlier attempt of ${TAG.replace(/\./g, "\\.")} \\(sha512-\\S+, where this build's is sha512-\\S+\\); it is kept`,
        ),
      );
      assert.equal(registries.uploads().length, count, "it published nothing");
    } finally {
      writeFileSync(tarball, ours);
    }
    assert.equal(linux("upload", "npm").status, 0, "restored, it is served");
  });

  test("build-linux's verification installs the version from the Release and PyPI and runs it, and leaves npm to publish's check", () => {
    const served = registries.served().length;
    const downloads = gh.calls().length;
    const run = linux("verify");
    assert.equal(run.status, 0, run.output);
    assert.equal(
      run.stdout.trim(),
      "release linux: x86_64-unknown-linux-gnu installed from the Release and PyPI and ran; npm's copy is publish's check to wait for",
    );
    // What it installed came from each registry double, and nothing from npm:
    // npm serves a publish minutes after taking it, which publish's check
    // waits out once rather than each platform job inside its own timeout.
    assert.deepEqual(registries.served().slice(served), [
      `pypi ${fileOf("wheel").file}`,
    ]);
    assert.ok(
      gh
        .calls()
        .slice(downloads)
        .some((c) => c[1] === "download" && c.includes(fileOf("archive").file)),
    );
  });

  test("a registry that is switched off is neither verified nor required", () => {
    // Were either asked, it would fail: neither serves this platform now.
    registries.hide([
      fileOf("wheel").file,
      `${fileOf("npm").package}@${VERSION}`,
    ]);
    const served = registries.served().length;
    try {
      const run = recipe("linux", ["verify", "--out", OUT], {
        ...env,
        PYPI_PUBLISH: "false",
        NPM_PUBLISH: "false",
      });
      assert.equal(run.status, 0, run.output);
      assert.equal(
        registries.served().length,
        served,
        "nothing was installed from PyPI or npm",
      );
    } finally {
      registries.clear();
    }
  });

  test("verification fails when a registry serves an unusable package, another build that does not run, or none for this platform", () => {
    const cases = [
      [
        "PyPI has no wheel for this platform",
        () => registries.hide([fileOf("wheel").file]),
        /PyPI onepipeline-api-cli/,
      ],
      [
        "PyPI serves an unusable wheel",
        () => registries.corrupt([fileOf("wheel").file]),
        /PyPI onepipeline-api-cli/,
      ],
    ];
    for (const [name, bend, culprit] of cases) {
      bend();
      try {
        const run = linux("verify");
        assert.notEqual(run.status, 0, `${name}: ${run.output}`);
        assert.match(run.stderr, culprit, name);
        assert.match(run.stderr, /ACTION:/, name);
      } finally {
        registries.clear();
      }
    }
    // PyPI serving an installable wheel, and the Release an archive with a
    // checksum that matches it, each carrying some other binary. Each records
    // that file as the one it holds, so it is read as an earlier attempt's
    // build, which is installed and run — and this one does not run.
    const wheel = join(registries.state, "pypi", fileOf("wheel").file);
    const wheelBytes = readFileSync(wheel);
    execFileSync("python3", [
      "-c",
      "import sys,zipfile\nsrc=zipfile.ZipFile(sys.argv[1]).infolist(), zipfile.ZipFile(sys.argv[1])\nentries=[(i.filename, src[1].read(i.filename)) for i in src[0]]\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n  for name,data in entries: z.writestr(name, b'#!/bin/sh\\necho another build\\n' if name.endswith('.data/scripts/onepipeline-api') else data)",
      wheel,
    ]);
    const archive = join(gh.assets, fileOf("archive").file);
    const checksumFile = join(gh.assets, fileOf("checksum").file);
    const archiveBytes = readFileSync(archive);
    const checksumBytes = readFileSync(checksumFile);
    const rebuilt = join(dir, "other-archive");
    rmSync(rebuilt, { recursive: true, force: true });
    mkdirSync(rebuilt, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", rebuilt]);
    writeFileSync(
      join(rebuilt, "onepipeline-api"),
      "#!/bin/sh\necho another build\n",
      { mode: 0o755 },
    );
    execFileSync("tar", ["-czf", archive, "-C", rebuilt, "."]);
    writeFileSync(
      checksumFile,
      `${sha(readFileSync(archive))}  ${fileOf("archive").file}\n`,
    );
    try {
      const run = linux("verify");
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stdout,
        /the Release serves \S+ from an earlier attempt .*; installing and running that build/,
      );
      assert.match(
        run.stderr,
        new RegExp(
          `GitHub Release ${TAG.replace(/\./g, "\\.")} ${TARGET}: smoke test failed`,
        ),
      );
    } finally {
      writeFileSync(archive, archiveBytes);
      writeFileSync(checksumFile, checksumBytes);
    }
    try {
      const run = linux("verify");
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stdout,
        /PyPI serves \S+ from an earlier attempt .*; installing and running that build/,
      );
      assert.match(
        run.stderr,
        new RegExp(
          `PyPI onepipeline-api-cli ${VERSION.replace(/\./g, "\\.")} on ${TARGET}: smoke test failed`,
        ),
      );
    } finally {
      writeFileSync(wheel, wheelBytes);
    }
    // The Release serving an archive its checksum does not describe.
    const original = readFileSync(archive);
    writeFileSync(archive, Buffer.from("not the archive"));
    try {
      const run = linux("verify");
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        /does not match the checksum published beside it/,
      );
    } finally {
      writeFileSync(archive, original);
    }
    assert.equal(linux("verify").status, 0, "restored, it verifies again");
  });

  const publishOut = join(ROOT, "target/release-journey/publish");
  const publish = (args, extra = {}) =>
    recipe(
      "publish",
      [
        ...args,
        ...(["upload", "build", "verify"].includes(args[0])
          ? ["--out", publishOut]
          : []),
      ],
      {
        ...env,
        ...extra,
      },
    );
  const independent = () =>
    registries
      .uploads()
      .filter(
        (u) =>
          / (onepipeline-ui|onepipeline-api-cli)-\d/.test(u) ||
          u.startsWith("crate "),
      )
      .concat(readdirSync(gh.assets).filter((f) => f.endsWith(".cdx.json")));
  // The publish job's steps in the order release.yml runs them, each run
  // whatever the step before it did (the workflow would skip them; running
  // them anyway shows each refuses on its own), then the verdict.
  function publishJob(buildResults) {
    const results = {};
    const extra = { BUILD_RESULTS: buildResults };
    for (const [id, args] of [
      ["check", ["check"]],
      ["upload-crate", ["upload", "crate"]],
      ["upload-npm", ["upload", "npm"]],
      ["upload-github", ["upload", "github"]],
      ["verify", ["verify"]],
    ]) {
      const run = publish(args, extra);
      results[id] = run.status === 0 ? "success" : "failure";
      results[`${id}-output`] = run.output;
    }
    const steps = `check=${results.check} build=success upload-crate=${results["upload-crate"]} upload-npm=${results["upload-npm"]} upload-github=${results["upload-github"]} verify=${results.verify}`;
    const settle = publish(["settle"], { ...extra, STEP_RESULTS: steps });
    return { results, settle };
  }
  const allBuilt =
    "build-linux=success build-linux-arm64=success build-macos=success build-windows=success";

  test("the publish recipe assembles every platform-independent file", () => {
    // What the arm64 Linux, macOS and Windows jobs leave on each registry,
    // under their planned names: this host cannot build them.
    for (const p of Object.values(platforms))
      for (const artifact of p.artifacts) {
        if (artifact.registry === "github")
          writeFileSync(join(gh.assets, artifact.file), artifact.file);
        if (artifact.registry === "pypi")
          writeFileSync(
            join(registries.state, "pypi", artifact.file),
            artifact.file,
          );
        if (artifact.registry === "npm") {
          const [os, cpu] = artifact.package
            .replace("onepipeline-api-cli-", "")
            .split("-");
          mkdirSync(join(registries.state, "npm", artifact.package), {
            recursive: true,
          });
          writeFileSync(
            join(registries.state, "npm", artifact.package, `${VERSION}.json`),
            JSON.stringify({
              name: artifact.package,
              version: VERSION,
              os: [os],
              cpu: [cpu],
            }),
          );
          writeFileSync(
            join(registries.state, "npm", artifact.package, `${VERSION}.tgz`),
            artifact.file,
          );
        }
      }
    const run = publish(["build"]);
    assert.equal(run.status, 0, run.output);
    for (const artifact of plan("publish").artifacts) {
      const dir = { crate: "crates", npm: "npm-artifacts", sbom: "assets" }[
        artifact.kind
      ];
      assert.ok(
        existsSync(join(publishOut, dir, artifact.file)),
        artifact.file,
      );
    }
    assert.ok(
      !existsSync(sbomScratch(publishOut)) &&
        !existsSync(join(ROOT, "bom.json")),
      "the SBOM is moved out of the checkout",
    );
    // A dry run of each upload names what it would publish, and neither reads
    // nor writes any registry or the Release.
    const calls = gh.calls().length;
    for (const [registry, command] of [
      ["crate", "cargo publish --locked"],
      [
        "npm",
        `scripts/publish-npm.sh ${join(publishOut, "npm-artifacts", `onepipeline-api-cli-${VERSION}.tgz`)}`,
      ],
      [
        "github",
        `gh release upload ${TAG} ${join(publishOut, "assets", `onepipeline-api-${TAG}.cdx.json`)}`,
      ],
    ]) {
      const dry = publish(["upload", registry, "--dry-run"], {
        BUILD_RESULTS: allBuilt,
      });
      assert.equal(dry.status, 0, dry.output);
      assert.match(dry.stdout, new RegExp(`dry run — ${registry} would run: `));
      assert.ok(dry.stdout.includes(command), dry.stdout);
    }
    assert.equal(
      gh.calls().length,
      calls,
      "a dry run asks the Release nothing",
    );
    assert.deepEqual(independent(), [], "a dry run publishes nothing");
  });

  test("a registry read that fails is refused, never read as nothing served", () => {
    const extra = { BUILD_RESULTS: allBuilt, NPM_CONFIG_FETCH_RETRIES: "0" };
    for (const [name, bend, args, message] of [
      ["PyPI answers 503", ["pypi-json=503"], ["check"], /PyPI answered 503/],
      [
        "PyPI answers without a file list",
        ["pypi-json=malformed"],
        ["check"],
        /PyPI answered .* with no list of files/,
      ],
      [
        "npm names another version than the one asked for",
        ["npm-packument=other-version"],
        ["check"],
        /npm answered onepipeline-api-cli-.*@.* with "0\.0\.0-other"/,
      ],
      [
        "npm answers 503",
        ["npm-packument=503"],
        ["check"],
        /cannot ask npm about/,
      ],
      [
        "the crate index serves a record that is not JSON",
        ["crate-index=malformed"],
        ["upload", "crate"],
        /serves a record that is not JSON/,
      ],
      [
        "PyPI answers 200 with null",
        ["pypi-json=empty"],
        ["check"],
        /PyPI answered .* with no list of files/,
      ],
      [
        "the crate index answers 200 with no records",
        ["crate-index=empty"],
        ["upload", "crate"],
        /the crate index answered with no records/,
      ],
      [
        "the crate index answers 503",
        ["crate-index=503"],
        ["upload", "crate"],
        /the crates\.io index answered 503/,
      ],
      [
        "the crate index serves JSON that is no index entry",
        ["crate-index=foreign"],
        ["upload", "crate"],
        /serves a record that is not an index entry/,
      ],
    ]) {
      registries.breakReads(bend);
      try {
        const run = publish(args, extra);
        assert.notEqual(run.status, 0, `${name}: ${run.output}`);
        assert.match(run.stderr, message, name);
      } finally {
        registries.clear();
      }
    }
    const unreachable = publish(["check"], {
      ...extra,
      RELEASE_PYPI_URL: "http://127.0.0.1:9",
    });
    assert.notEqual(unreachable.status, 0);
    assert.match(unreachable.stderr, /cannot reach PyPI/);
    const noIndex = publish(["upload", "crate"], {
      ...extra,
      RELEASE_CRATES_INDEX: "http://127.0.0.1:9",
    });
    assert.notEqual(noIndex.status, 0);
    assert.match(noIndex.stderr, /cannot reach the crates\.io index/);
    assert.deepEqual(independent(), [], "nothing was published");
  });

  test("with one platform missing, publish uploads nothing platform-independent and demotes the release", () => {
    const of = (job, registry) =>
      platforms[job].artifacts.find((a) => a.registry === registry);
    const macosArchive = join(gh.assets, of("macos", "github").file);
    const aside = join(dir, "aside");
    for (const [missing, bend, mend, named] of [
      [
        "the Windows npm package",
        () => registries.hide([`${of("windows", "npm").package}@${VERSION}`]),
        () => registries.clear(),
        `npm ${of("windows", "npm").package}@`,
      ],
      [
        "the macOS archive on the Release",
        () => renameSync(macosArchive, aside),
        () => renameSync(aside, macosArchive),
        `GitHub Release ${of("macos", "github").file}`,
      ],
      [
        "the Windows wheel",
        () => registries.hide([of("windows", "pypi").file]),
        () => registries.clear(),
        `PyPI ${of("windows", "pypi").file}`,
      ],
    ]) {
      bend();
      try {
        const { results, settle } = publishJob(allBuilt);
        assert.equal(results.check, "failure", missing);
        assert.ok(results["check-output"].includes(named), missing);
        for (const id of ["upload-crate", "upload-npm", "upload-github"]) {
          assert.equal(results[id], "failure", `${missing}: ${id}`);
          assert.match(
            results[`${id}-output`],
            /not every platform published/,
            `${missing}: ${id}`,
          );
        }
        assert.deepEqual(
          independent(),
          [],
          `${missing}: nothing platform-independent was published`,
        );
        assert.notEqual(settle.status, 0, missing);
        assert.match(settle.stderr, /did not publish — check \(failure\)/);
        assert.ok(gh.prerelease(), `${missing}: the Release is demoted`);
        assert.match(gh.body(), /This release did not publish/);
      } finally {
        mend();
      }
    }
  });

  test("with a failed platform build, publish uploads nothing platform-independent and demotes the release", () => {
    const { results, settle } = publishJob(
      "build-linux=success build-linux-arm64=success build-macos=failure build-windows=success",
    );
    assert.equal(results.check, "failure");
    assert.match(results["check-output"], /build-macos \(failure\)/);
    for (const id of ["upload-crate", "upload-npm", "upload-github"])
      assert.equal(results[id], "failure", id);
    assert.deepEqual(independent(), []);
    // Still demoted (the journey above demoted it, and a demoted Release is not
    // bannered twice), and this run's verdict names the failed job.
    assert.notEqual(settle.status, 0);
    assert.ok(gh.prerelease());
    assert.match(settle.stderr, /did not publish — build-macos \(failure\)/);
  });

  test("once every platform is served, publish publishes exactly its files, finishes a failed upload on a re-run, and restores the release", () => {
    const extra = { BUILD_RESULTS: allBuilt };
    assert.equal(publish(["check"], extra).status, 0);
    // Without its secret the crate is switched off, which is not a failure.
    const off = publish(["upload", "crate"], {
      ...extra,
      CARGO_REGISTRY_TOKEN: "",
    });
    assert.equal(off.status, 0, off.output);
    assert.match(
      off.stdout,
      /CARGO_REGISTRY_TOKEN is not set; the crate is not published/,
    );
    // npm switched on without its token is a failure that publishes nothing.
    const noToken = publish(["upload", "npm"], {
      ...extra,
      NODE_AUTH_TOKEN: "",
    });
    assert.notEqual(noToken.status, 0, noToken.output);
    assert.match(
      noToken.stderr,
      /NPM_PUBLISH is on but NODE_AUTH_TOKEN is empty/,
    );
    assert.deepEqual(independent(), []);
    // A crate upload the registry refuses fails the step; the re-run publishes it.
    registries.failUploads(`onepipeline-ui-${VERSION}.crate`);
    const refusedCrate = publish(["upload", "crate"], extra);
    assert.notEqual(refusedCrate.status, 0, refusedCrate.output);
    assert.match(refusedCrate.stderr, /cargo publish failed/);
    registries.clear();
    const crate = publish(["upload", "crate"], extra);
    assert.equal(crate.status, 0, crate.output);
    // The frontend, the second npm package, fails until npm accepts it again.
    registries.failUploads(`onepipeline-ui-${VERSION}.tgz`);
    const npmFirst = publish(["upload", "npm"], extra);
    assert.notEqual(npmFirst.status, 0, npmFirst.output);
    assert.match(npmFirst.stderr, /publishing onepipeline-ui-.*\.tgz failed/);
    registries.clear();
    const published = registries.uploads().length;
    const npmAgain = publish(["upload", "npm"], extra);
    assert.equal(npmAgain.status, 0, npmAgain.output);
    assert.deepEqual(
      registries.uploads().slice(published),
      [`npm onepipeline-ui-${VERSION}.tgz`],
      "the re-run publishes only what was missing",
    );
    gh.failUploads(`onepipeline-api-${TAG}.cdx.json`);
    const refusedSbom = publish(["upload", "github"], extra);
    assert.notEqual(refusedSbom.status, 0, refusedSbom.output);
    assert.match(
      refusedSbom.stderr,
      /uploading onepipeline-api-.*\.cdx\.json failed/,
    );
    gh.healUploads();
    const sbom = publish(["upload", "github"], extra);
    assert.equal(sbom.status, 0, sbom.output);
    assert.deepEqual(independent().sort(), [
      `crate onepipeline-ui-${VERSION}.crate`,
      `npm onepipeline-api-cli-${VERSION}.tgz`,
      `npm onepipeline-ui-${VERSION}.tgz`,
      `onepipeline-api-${TAG}.cdx.json`,
    ]);
    for (const [registryFile, stagedFile] of [
      [
        join(registries.state, "crates", `onepipeline-ui-${VERSION}.crate`),
        join(publishOut, "crates", `onepipeline-ui-${VERSION}.crate`),
      ],
      [
        join(registries.state, "npm", "onepipeline-api-cli", `${VERSION}.tgz`),
        join(publishOut, "npm-artifacts", `onepipeline-api-cli-${VERSION}.tgz`),
      ],
      [
        join(registries.state, "npm", "onepipeline-ui", `${VERSION}.tgz`),
        join(publishOut, "npm-artifacts", `onepipeline-ui-${VERSION}.tgz`),
      ],
      [
        join(gh.assets, `onepipeline-api-${TAG}.cdx.json`),
        join(publishOut, "assets", `onepipeline-api-${TAG}.cdx.json`),
      ],
    ])
      assert.equal(
        sha(readFileSync(registryFile)),
        sha(readFileSync(stagedFile)),
        registryFile,
      );
    const count = registries.uploads().length;
    for (const registry of ["crate", "npm", "github"])
      assert.equal(publish(["upload", registry], extra).status, 0);
    assert.equal(registries.uploads().length, count);

    const launcherServed = registries.served().length;
    const verify = publish(["verify"], extra);
    assert.equal(verify.status, 0, verify.output);
    // The launcher it installed came from the npm double and pulled this
    // platform's package in beside it, and the frontend was installed too.
    assert.deepEqual(
      registries.served().slice(launcherServed).sort(),
      [
        `npm onepipeline-api-cli-${VERSION}.tgz`,
        `npm ${fileOf("npm").file}`,
        `npm onepipeline-ui-${VERSION}.tgz`,
      ].sort(),
    );
    // The launcher served while this platform's package is not, the order
    // v0.39.0's verification met them in: npm installs the launcher alone and
    // exits 0, which is no install of anything that runs, so it is retried as
    // one the registry has not caught up with, and refused once the wait ends.
    registries.unserve([`${fileOf("npm").package}@${VERSION}`]);
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        /the install exited 0 without writing \S+\/node_modules\/onepipeline-api-cli-linux-x64\/package\.json/,
      );
      assert.match(
        run.stderr,
        /npm onepipeline-api-cli \S+: still not installable after \d+ attempts/,
      );
      assert.doesNotMatch(run.stderr, /smoke test/, "nothing ran it");
    } finally {
      registries.clear();
    }
    // A frontend package published without its bundle fails the read-back.
    const uiTarball = join(
      registries.state,
      "npm",
      "onepipeline-ui",
      `${VERSION}.tgz`,
    );
    const uiBytes = readFileSync(uiTarball);
    const bare = join(dir, "bare-frontend");
    rmSync(bare, { recursive: true, force: true });
    mkdirSync(bare, { recursive: true });
    execFileSync("tar", ["-xzf", uiTarball, "-C", bare]);
    rmSync(join(bare, "package/dist"), { recursive: true });
    execFileSync("tar", ["-czf", uiTarball, "-C", bare, "package"]);
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        /does not carry the frontend this release built/,
      );
    } finally {
      writeFileSync(uiTarball, uiBytes);
    }
    // So does one whose bundle is there but is not the one this release built.
    rmSync(bare, { recursive: true, force: true });
    mkdirSync(bare, { recursive: true });
    execFileSync("tar", ["-xzf", uiTarball, "-C", bare]);
    writeFileSync(
      join(bare, "package/dist/index.html"),
      "<!doctype html><title>another build</title>\n",
    );
    execFileSync("tar", ["-czf", uiTarball, "-C", bare, "package"]);
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        /does not carry the frontend this release built/,
      );
    } finally {
      writeFileSync(uiTarball, uiBytes);
    }
    // With every registry switched off, publish requires nothing of them and
    // installs nothing from npm: the crate and the frontend lost, it still
    // verifies, by the SBOM on the Release. The probe still asks each registry,
    // and what it answers is reported rather than held to this version.
    registries.hide([`onepipeline-ui@${VERSION}`]);
    const offServed = registries.served().length;
    try {
      const off = publish(["verify"], {
        ...extra,
        PYPI_PUBLISH: "false",
        NPM_PUBLISH: "false",
        CARGO_REGISTRY_TOKEN: "",
      });
      assert.equal(off.status, 0, off.output);
      assert.equal(
        registries.served().length,
        offServed,
        "nothing was installed from npm",
      );
    } finally {
      registries.clear();
    }
    // The Release without its SBOM fails the read-back.
    const sbomAsset = join(gh.assets, `onepipeline-api-${TAG}.cdx.json`);
    renameSync(sbomAsset, join(dir, "sbom-aside"));
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        new RegExp(
          `the Release has no onepipeline-api-${TAG.replace(/\./g, "\\.")}\\.cdx\\.json`,
        ),
      );
    } finally {
      renameSync(join(dir, "sbom-aside"), sbomAsset);
    }
    assert.match(
      verify.stdout,
      new RegExp(`npm:onepipeline-api-cli -> ${VERSION.replace(/\./g, "\\.")}`),
    );
    assert.match(
      verify.stdout,
      new RegExp(`crate:onepipeline-ui -> ${VERSION.replace(/\./g, "\\.")}`),
    );
    // A registry that has lost the crate or the frontend fails the read-back.
    registries.hide([`onepipeline-ui@${VERSION}`]);
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.stderr, /the crate index does not list onepipeline-ui/);
    } finally {
      registries.clear();
    }
    // Hiding is keyed by name@version for the crate and npm alike, so the
    // frontend is lost by moving its files aside instead. It is waited for as
    // a publish npm has not listed yet, and refused once the wait ends.
    const frontend = join(registries.state, "npm", "onepipeline-ui");
    renameSync(frontend, join(dir, "frontend-aside"));
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        new RegExp(
          `npm onepipeline-ui ${VERSION.replace(/\./g, "\\.")}: still not installable after \\d+ attempts`,
        ),
      );
      assert.match(run.stderr, /re-run this job's upload npm/);
    } finally {
      renameSync(join(dir, "frontend-aside"), frontend);
    }
    // A registry whose newest release is not this one fails the probe's
    // question, and so does one the probe cannot get an answer from.
    const newer = join(registries.state, "npm", "onepipeline-ui");
    writeFileSync(
      join(newer, "99.0.0.json"),
      JSON.stringify({ name: "onepipeline-ui", version: "99.0.0" }),
    );
    writeFileSync(join(newer, "99.0.0.tgz"), "a later release");
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        /the release probe answers 99\.0\.0 for npm:onepipeline-ui/,
      );
    } finally {
      rmSync(join(newer, "99.0.0.json"));
      rmSync(join(newer, "99.0.0.tgz"));
    }
    registries.breakReads(["crate-api=503"]);
    try {
      const run = publish(["verify"], extra);
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        /could not establish what crate:onepipeline-ui serves/,
      );
    } finally {
      registries.clear();
    }

    // The earlier runs demoted it; this one published, so the Release is one again.
    const settle = publish(["settle"], {
      ...extra,
      STEP_RESULTS:
        "check=success build=success upload-crate=success upload-npm=success upload-github=success verify=success",
    });
    assert.equal(settle.status, 0, settle.output);
    assert.ok(!gh.prerelease(), "the recovered release is not a prerelease");
    assert.doesNotMatch(gh.body(), /did not publish/);
  });

  test("a launcher npm serves before its platform package is installed again until npm serves both, and then runs", async () => {
    registries.unserve([`${fileOf("npm").package}@${VERSION}`]);
    const served = registries.served().length;
    const running = recipeRunning("publish", ["verify", "--out", publishOut], {
      ...env,
      BUILD_RESULTS: allBuilt,
      RELEASE_VERIFY_BUDGET: "120",
    });
    // npm begins serving the platform package only once an install has
    // fetched the launcher without it.
    const launcher = `npm onepipeline-api-cli-${VERSION}.tgz`;
    for (
      let i = 0;
      i < 600 && !registries.served().slice(served).includes(launcher);
      i++
    )
      await sleep(100);
    assert.ok(
      registries.served().slice(served).includes(launcher),
      "the launcher was installed while its platform package was not served",
    );
    await sleep(500);
    registries.clear();
    const run = await running;
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /platform-independent artifacts are served/);
    // Its platform package came on a later attempt, the one that counted.
    const fetched = registries.served().slice(served);
    assert.ok(
      fetched.indexOf(`npm ${fileOf("npm").file}`) > fetched.indexOf(launcher),
      fetched.join(", "),
    );
  });

  test("a failed verification demotes the release", () => {
    registries.corrupt([`onepipeline-ui-${VERSION}.tgz`]);
    try {
      const { results, settle } = publishJob(allBuilt);
      assert.equal(results.check, "success");
      assert.equal(results.verify, "failure", results["verify-output"]);
      assert.notEqual(settle.status, 0);
      assert.ok(gh.prerelease());
      assert.match(gh.body(), /verify \(failure\)/);
    } finally {
      registries.clear();
    }
  });
});
