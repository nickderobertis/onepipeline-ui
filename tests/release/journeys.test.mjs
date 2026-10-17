// The release jobs' own recipes, driven on this host the way release.yml runs
// them: the Linux build for real, end to end, and the publication phases of
// build-linux and publish against local doubles of PyPI, npm, the crate
// registry and the GitHub Release (./doubles), which serve exactly what was
// uploaded to them, so the real clients — gh, twine, pip, npm, cargo and the
// release probe — are what publish and install.
//
// One real build is shared by every journey: it is the manylinux image compiling
// the release binary, and every journey after the first is about what happens
// to the files it produced.
//
// What a Linux host cannot do is build the macOS and Windows targets; their
// files are the hosted jobs' to produce, so where a journey needs them on a
// registry (publish's availability check, the launcher's optional dependencies)
// they are seeded under their planned names, as those jobs would leave them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
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
const TAG = `v${VERSION}`;
const TARGET = "x86_64-unknown-linux-gnu";
// Inside the checkout: the manylinux container mounts only that.
const OUT = join(ROOT, "target/release-journey/linux");
const linuxPlan = plan("linux");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const staged = (artifact) =>
  join(
    OUT,
    {
      archive: "assets",
      checksum: "assets",
      wheel: "wheels",
      npm: "npm-artifacts",
    }[artifact.kind],
    artifact.file,
  );
const fileOf = (kind) => linuxPlan.artifacts.find((a) => a.kind === kind);

// The bytes of the one binary inside each carrier.
function carried(dir) {
  const work = join(dir, "carried");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    staged(fileOf("archive")),
    "-C",
    work,
    "onepipeline-api",
  ]);
  const archive = readFileSync(join(work, "onepipeline-api"));
  const wheel = execFileSync(
    "python3",
    [
      "-c",
      "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nsys.stdout.buffer.write(z.read(next(n for n in z.namelist() if n.endswith('.data/scripts/onepipeline-api'))))",
      staged(fileOf("wheel")),
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  const npm = execFileSync(
    "tar",
    ["-xzOf", staged(fileOf("npm")), "package/bin/onepipeline-api"],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  return { archive, wheel, npm, path: join(work, "onepipeline-api") };
}

function glibcFloor(binary) {
  const symbols = execFileSync("objdump", ["-T", binary], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...symbols.matchAll(/GLIBC_(\d+)\.(\d+)/g)]
    .map((m) => [Number(m[1]), Number(m[2])])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .at(-1)
    .join(".");
}
const below = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] < y[0] || (x[0] === y[0] && x[1] <= y[1]);
};

describe("the build-linux recipe, with publication in its dry-run mode", () => {
  let dir;
  let gh;
  let rehearsal;
  before(() => {
    dir = scratch("rehearsal");
    gh = githubDouble(dir, TAG);
    const started = Date.now();
    rehearsal = recipe("linux", ["all", "--dry-run", "--out", OUT], {
      ...releaseEnv({
        gh,
        registries: { base: "http://127.0.0.1:9", npm: "http://127.0.0.1:9/" },
        home: dir,
      }),
    });
    console.log(
      `release-linux all --dry-run took ${Math.round((Date.now() - started) / 1000)} s`,
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("builds each Linux target once and packs archive, wheel and npm package from that one binary", () => {
    assert.equal(rehearsal.status, 0, rehearsal.output);
    for (const target of linuxPlan.targets)
      assert.equal(
        rehearsal.output.split(`built the ${target} wheel`).length - 1,
        1,
        `${target} was compiled once`,
      );
    const files = ["assets", "wheels", "npm-artifacts"].flatMap((d) =>
      readdirSync(join(OUT, d)),
    );
    assert.deepEqual(
      files.sort(),
      linuxPlan.artifacts.map((a) => a.file).sort(),
    );
    const { archive, wheel, npm } = carried(dir);
    assert.equal(
      sha(archive),
      sha(wheel),
      "the archive carries the wheel's binary",
    );
    assert.equal(
      sha(npm),
      sha(wheel),
      "the npm package carries the wheel's binary",
    );
    const record = JSON.parse(
      readFileSync(join(OUT, TARGET, "reuse.json"), "utf8"),
    );
    assert.equal(record.binarySha256, sha(wheel));
  });

  test("installs those exact files, runs each, and only then names what it would publish", () => {
    const installed = rehearsal.stdout.indexOf(
      "staged archive/wheel/npm install, server and embedded view passed",
    );
    assert.ok(installed > 0, rehearsal.output);
    const publishes = [
      ...rehearsal.stdout.matchAll(/release: would run: (.*)/g),
    ].map((m) => m[1]);
    for (const artifact of linuxPlan.artifacts)
      assert.ok(
        publishes.some((p) => p.includes(staged(artifact))),
        `${artifact.file} would be published: ${publishes}`,
      );
    assert.ok(rehearsal.stdout.indexOf("release: would run:") > installed);
    assert.match(
      rehearsal.stdout,
      /dry run — registry verification skipped, nothing was published/,
    );
    assert.deepEqual(
      gh.calls(),
      [],
      "a dry run asks the GitHub Release nothing",
    );
  });

  test("every file matches v0.37.0's for its target in name, wheel tags and glibc floor", () => {
    const v037 = JSON.parse(
      readFileSync(join(ROOT, ".github/fixtures/release-v0.37.0.json"), "utf8"),
    );
    const as037 = (file) => file.replaceAll(VERSION, v037.version);
    for (const artifact of linuxPlan.artifacts) {
      const name = as037(artifact.file);
      if (artifact.registry === "github")
        assert.ok(v037.github.includes(name), name);
      if (artifact.registry === "npm")
        assert.ok(
          v037.npm.some(
            (p) => p.package === artifact.package && p.file === name,
          ),
          name,
        );
      if (artifact.registry === "pypi") {
        const published = v037.pypi.find((w) => w.file === name);
        assert.ok(published, name);
        const tags = execFileSync(
          "python3",
          [
            "-c",
            "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nw=z.read(next(n for n in z.namelist() if n.endswith('.dist-info/WHEEL'))).decode()\nprint('\\n'.join(l[5:] for l in w.splitlines() if l.startswith('Tag: ')))",
            staged(artifact),
          ],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n");
        assert.deepEqual(tags, published.tags);
      }
    }
    // One binary, so one floor: the wheel's tag needs exactly 2.17, and the
    // archive and npm package, which v0.37.0 built separately against 2.39,
    // may need no newer glibc than they did.
    const floor = glibcFloor(carried(dir).path);
    const was = v037.glibc[TARGET];
    assert.equal(floor, was.wheel, "the wheel's glibc floor");
    assert.ok(
      below(floor, was.archive),
      `archive floor ${floor} <= ${was.archive}`,
    );
    assert.ok(below(floor, was.npm), `npm floor ${floor} <= ${was.npm}`);
  });

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
});

describe("publication against registry doubles", () => {
  let dir;
  let gh;
  let registries;
  let env;
  const platforms = { macos: plan("macos"), windows: plan("windows") };
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
    // The checksum, the second asset, fails once.
    gh.failOnce(fileOf("checksum").file);
    const first = linux("upload", "github");
    assert.notEqual(first.status, 0, first.output);
    assert.match(first.stderr, /uploading .*\.sha256 failed/);
    assert.deepEqual(readdirSync(gh.assets), [fileOf("archive").file]);
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

    registries.failOnce(fileOf("wheel").file);
    assert.notEqual(linux("upload", "pypi").status, 0);
    assert.deepEqual(registries.uploads(), []);
    for (const registry of ["pypi", "npm"]) {
      const run = linux("upload", registry);
      assert.equal(run.status, 0, run.output);
    }
    // A complete release re-run publishes nothing more.
    for (const registry of ["github", "pypi", "npm"]) {
      const count = gh.uploads().length;
      const log = registries.uploads().length;
      const run = linux("upload", registry);
      assert.equal(run.status, 0, run.output);
      assert.equal(gh.uploads().length, count);
      assert.equal(registries.uploads().length, log);
    }
    // Exactly the build's files, byte for byte, at the release's version.
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
  });

  test("build-linux's verification installs the version from every registry and runs it", () => {
    const run = linux("verify");
    assert.equal(run.status, 0, run.output);
    assert.match(
      run.stdout,
      /x86_64-unknown-linux-gnu installed from every switched-on registry and ran/,
    );
    for (const label of [
      `GitHub Release ${TAG}`,
      `PyPI onepipeline-api-cli ${VERSION}`,
      `npm ${fileOf("npm").package} ${VERSION}`,
    ])
      assert.match(run.output, new RegExp(label.replace(/[.]/g, "\\.")));
  });

  test("verification fails when a registry serves another version, an unusable package, or none for this platform", () => {
    const cases = [
      [
        "npm serves another version",
        () => registries.hide([`${fileOf("npm").package}@${VERSION}`]),
        /npm onepipeline-api-cli-linux-x64/,
      ],
      [
        "PyPI has no wheel for this platform",
        () => registries.hide([fileOf("wheel").file]),
        /PyPI onepipeline-api-cli/,
      ],
      [
        "npm serves an unusable package",
        () => registries.corrupt([`${fileOf("npm").package}-${VERSION}.tgz`]),
        /npm onepipeline-api-cli-linux-x64/,
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
    // The Release serving an archive its checksum does not describe.
    const archive = join(gh.assets, fileOf("archive").file);
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

  // ---------------------------------------------------------------- publish
  const publishOut = join(ROOT, "target/release-journey/publish");
  const publish = (args, extra = {}) =>
    recipe(
      "publish",
      [
        ...args,
        ...(args[0] === "upload" || args[0] === "build"
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
    "build-linux=success build-macos=success build-windows=success";

  test("the publish recipe assembles every platform-independent file", () => {
    // What the macOS and Windows jobs leave on each registry, under their
    // planned names: this host cannot build them.
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
      !existsSync(join(ROOT, "bom.json")),
      "the SBOM is moved out of the checkout",
    );
  });

  test("with one platform missing, publish uploads nothing platform-independent and demotes the release", () => {
    const windowsNpm = platforms.windows.artifacts.find(
      (a) => a.registry === "npm",
    );
    registries.hide([`${windowsNpm.package}@${VERSION}`]);
    try {
      const { results, settle } = publishJob(allBuilt);
      assert.equal(results.check, "failure");
      assert.match(
        results["check-output"],
        new RegExp(`npm ${windowsNpm.package}@`),
      );
      for (const id of ["upload-crate", "upload-npm", "upload-github"]) {
        assert.equal(results[id], "failure", id);
        assert.match(
          results[`${id}-output`],
          /not every platform published/,
          id,
        );
      }
      assert.deepEqual(
        independent(),
        [],
        "nothing platform-independent was published",
      );
      assert.notEqual(settle.status, 0);
      assert.ok(gh.prerelease(), "the Release is demoted");
      assert.match(gh.body(), /This release did not publish/);
      assert.match(gh.body(), /check \(failure\)/);
    } finally {
      registries.clear();
    }
  });

  test("with a failed platform build, publish uploads nothing platform-independent and demotes the release", () => {
    const { results, settle } = publishJob(
      "build-linux=success build-macos=failure build-windows=success",
    );
    assert.equal(results.check, "failure");
    assert.match(results["check-output"], /build-macos \(failure\)/);
    for (const id of ["upload-crate", "upload-npm", "upload-github"])
      assert.equal(results[id], "failure", id);
    assert.deepEqual(independent(), []);
    assert.notEqual(settle.status, 0);
    assert.ok(gh.prerelease());
    assert.match(gh.body(), /build-macos \(failure\)/);
  });

  test("once every platform is served, publish publishes exactly its files, finishes a failed upload on a re-run, and restores the release", () => {
    // The frontend, the second npm package, fails once.
    registries.failOnce(`onepipeline-ui-${VERSION}.tgz`);
    const extra = { BUILD_RESULTS: allBuilt };
    assert.equal(publish(["check"], extra).status, 0);
    const crate = publish(["upload", "crate"], extra);
    assert.equal(crate.status, 0, crate.output);
    const npmFirst = publish(["upload", "npm"], extra);
    assert.notEqual(npmFirst.status, 0, npmFirst.output);
    const npmAgain = publish(["upload", "npm"], extra);
    assert.equal(npmAgain.status, 0, npmAgain.output);
    const sbom = publish(["upload", "github"], extra);
    assert.equal(sbom.status, 0, sbom.output);
    assert.deepEqual(independent().sort(), [
      `crate onepipeline-ui-${VERSION}.crate`,
      `npm onepipeline-api-cli-${VERSION}.tgz`,
      `npm onepipeline-ui-${VERSION}.tgz`,
      `onepipeline-api-${TAG}.cdx.json`,
    ]);
    // Each exactly as the build staged it.
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
    // A re-run of every upload publishes nothing more.
    const count = registries.uploads().length;
    for (const registry of ["crate", "npm", "github"])
      assert.equal(publish(["upload", registry], extra).status, 0);
    assert.equal(registries.uploads().length, count);

    const verify = publish(["verify"], extra);
    assert.equal(verify.status, 0, verify.output);
    assert.match(
      verify.output,
      new RegExp(`npm onepipeline-api-cli ${VERSION.replace(/\./g, "\\.")}`),
    );
    assert.match(
      verify.stdout,
      new RegExp(`npm:onepipeline-api-cli -> ${VERSION.replace(/\./g, "\\.")}`),
    );
    assert.match(
      verify.stdout,
      new RegExp(`crate:onepipeline-ui -> ${VERSION.replace(/\./g, "\\.")}`),
    );

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

  test("a failed verification demotes the release", () => {
    registries.corrupt([`${fileOf("npm").package}-${VERSION}.tgz`]);
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
