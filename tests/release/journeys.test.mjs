// The release jobs' own recipes, driven on this host the way release.yml runs
// them: the Linux build for real, end to end, and the publication phases of
// build-linux and publish against local doubles of PyPI, npm, the crate
// registry and the GitHub Release (./doubles), which serve exactly what was
// uploaded to them, so the real clients — gh, twine, pip, npm, cargo and the
// release probe — are what publish and install.
//
// The journeys below share one manylinux build. ./publication.test.mjs, beside
// this file in the project's test target, builds a native wheel instead, so its
// registry journeys run without a manylinux image or its external mirrors.
//
// What this x86_64 Linux host cannot do is build the arm64 Linux, macOS and
// Windows targets; their files are the hosted jobs' to produce, so where a
// journey needs them on a registry (publish's availability check, the
// launcher's optional dependencies) they are seeded under their planned names,
// as those jobs would leave them.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { npmLauncher, plan } from "../../scripts/release.mjs";
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
        readFileSync(join(OUT, `build-${target}.log`), "utf8").split(
          `built the ${target} wheel`,
        ).length - 1,
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
    // One line reports the rehearsal: what it installed and ran, and every
    // publish command it skipped. That the install comes first, and stops the
    // rest when it fails, is the journey below.
    const summary = rehearsal.stdout
      .split("\n")
      .find((line) =>
        line.startsWith("release linux: built, installed and ran"),
      );
    assert.ok(summary, rehearsal.stdout);
    assert.match(
      summary,
      /dry run — registry verification skipped, nothing was published/,
    );
    for (const artifact of linuxPlan.artifacts)
      assert.ok(
        summary.includes(staged(artifact)),
        `${artifact.file} would be published: ${summary}`,
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

  // tests/e2e/linux_wheel.rs runs the script's yum repository rewrite over
  // copies of each Linux image's repository files, offline. This rehearsal has
  // just built in the x86_64 image, so it holds the copies to the images: each
  // is the image's file (bar the trailing whitespace the checkout trims), and
  // every image file with a section yum reads is among them. The files are
  // copied out of a created container rather than read by running one, so the
  // aarch64 image is read on this host without emulating it.
  test("the images' yum repository files are the ones the offline build journey rewrites", () => {
    assert.equal(rehearsal.status, 0, rehearsal.output);
    const script = readFileSync(
      join(ROOT, "scripts/build-linux-wheel.sh"),
      "utf8",
    );
    for (const [arch, platform] of [
      ["x86_64", "linux/amd64"],
      ["aarch64", "linux/arm64"],
    ]) {
      const image = script
        .match(/^image="([^"]+)"$/m)[1]
        .replace("$arch", arch);
      const copy = join(dir, `yum.repos.d-${arch}`);
      rmSync(copy, { recursive: true, force: true });
      const container = execFileSync(
        "docker",
        ["create", "--platform", platform, image, "true"],
        { encoding: "utf8" },
      ).trim();
      try {
        execFileSync("docker", ["cp", `${container}:/etc/yum.repos.d`, copy]);
      } finally {
        execFileSync("docker", ["rm", container]);
      }
      const files = new Map(
        readdirSync(copy)
          .filter((name) => name.endsWith(".repo"))
          .map((name) => [name, readFileSync(join(copy, name), "utf8")]),
      );
      const trimmed = (text) => text.replace(/[ \t]+$/gm, "").trimEnd();
      // Whether a file names a baseurl in a section yum reads: one that does
      // not say `enabled=0`.
      const read = (text) =>
        text
          .split(/^\[/m)
          .slice(1)
          .some(
            (section) =>
              /^baseurl=/m.test(section) && !/^enabled=0[ \t]*$/m.test(section),
          );
      const fixture = `tests/fixtures/manylinux2014_${arch}-yum.repos.d`;
      const copies = readdirSync(join(ROOT, fixture)).sort();
      for (const name of copies)
        assert.equal(
          trimmed(readFileSync(join(ROOT, fixture, name), "utf8")),
          trimmed(files.get(name) ?? ""),
          `${image} has changed /etc/yum.repos.d/${name}; copy it to ${fixture}/ and check tests/e2e/linux_wheel.rs's expected repositories`,
        );
      const unread = [...files]
        .filter(([name, text]) => read(text) && !copies.includes(name))
        .map(([name]) => name);
      assert.deepEqual(
        unread,
        [],
        `${image} has repository files with an enabled baseurl the offline journey does not copy; add them to ${fixture}/`,
      );
    }
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

// npm writes three launchers into node_modules/.bin on Windows — an
// extensionless sh script, a .cmd and a .ps1 — through its own cmd-shim, which
// this host can run too, so the staged install is laid out that way here and
// the smoke is handed what npmLauncher picks for Windows. It is handed them by
// the path v0.40.0's build-windows job handed it, drive letter and 8.3 short
// name included: that run's scratch root, laid out under this one, which the
// smoke runs from, so the path reads as Git Bash read it.
const WINDOWS_STAGED =
  "C:/Users/RUNNER~1/AppData/Local/Temp/staged-release-S94UW0";
describe("the npm install's launcher as Windows lays it out", () => {
  let dir;
  let registries;
  before(async () => {
    assert.ok(
      existsSync(join(OUT, "npm-artifacts")),
      "the rehearsal above staged the Linux build",
    );
    dir = scratch("windows-shims");
    registries = await registryDoubles(dir);
  });
  after(async () => {
    await registries?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const smoke = (command) =>
    spawnSync(
      "bash",
      [
        join(ROOT, "scripts/smoke-published.sh"),
        "--expect-version",
        VERSION,
        "--command",
        command,
        "--label",
        "staged x86_64-pc-windows-msvc shape",
      ],
      { cwd: dir, encoding: "utf8" },
    );

  test("the smoke runs the shim Git Bash can run, and refuses the .cmd and an install that provides none", async () => {
    // The staged platform package on the npm double, as `upload npm` leaves it.
    const pkg = fileOf("npm").package;
    mkdirSync(join(registries.state, "npm", pkg), { recursive: true });
    writeFileSync(
      join(registries.state, "npm", pkg, `${VERSION}.tgz`),
      readFileSync(staged(fileOf("npm"))),
    );
    writeFileSync(
      join(registries.state, "npm", pkg, `${VERSION}.json`),
      readFileSync(join(OUT, "npm", pkg, "package.json")),
    );
    const launcher = execFileSync(
      "node",
      ["scripts/npm-build.mjs", "launcher", "--out", join(dir, "launcher")],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    execFileSync("npm", ["pack", "--pack-destination", dir], {
      cwd: launcher,
      stdio: "pipe",
    });
    const npmRoot = `${WINDOWS_STAGED}/npm`;
    const prefix = join(dir, npmRoot);
    mkdirSync(prefix, { recursive: true });
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--registry",
        registries.npm,
        "--cache",
        join(dir, "npm-cache"),
        "--no-audit",
        "--no-fund",
        join(dir, `onepipeline-api-cli-${VERSION}.tgz`),
      ],
      {
        stdio: "pipe",
        env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" },
      },
    );
    // What npm's bin-links writes on Windows, in place of the symlink it
    // writes here.
    const cmdShim = createRequire(import.meta.url)(
      join(
        execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
        "npm/node_modules/cmd-shim",
      ),
    );
    const bin = join(prefix, "node_modules", ".bin");
    rmSync(join(bin, "onepipeline-api"));
    await cmdShim(
      join(prefix, "node_modules/onepipeline-api-cli/bin/onepipeline-api.js"),
      join(bin, "onepipeline-api"),
    );
    assert.deepEqual(readdirSync(bin).sort(), [
      "onepipeline-api",
      "onepipeline-api.cmd",
      "onepipeline-api.ps1",
    ]);

    const shim = npmLauncher(npmRoot, true);
    assert.equal(
      shim.spawn,
      `${WINDOWS_STAGED}/npm/node_modules/.bin/onepipeline-api.cmd`,
      "the .cmd is the file v0.40.0's smoke was handed",
    );
    assert.equal(
      shim.bash,
      `${WINDOWS_STAGED}/npm/node_modules/.bin/onepipeline-api`,
    );
    assert.match(readFileSync(join(dir, shim.bash), "utf8"), /^#!\/bin\/sh\n/);
    const passed = smoke(shim.bash);
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
    assert.match(passed.stdout, /shape: smoke test passed/);

    // The .cmd as Git Bash sees it — a file it cannot execute — is refused
    // the way v0.40.0's run refused it.
    chmodSync(join(dir, shim.spawn), 0o644);
    const cmd = smoke(shim.spawn);
    assert.equal(cmd.status, 1, cmd.stderr);
    assert.ok(
      cmd.stderr.includes(
        `'${WINDOWS_STAGED}/npm/node_modules/.bin/onepipeline-api.cmd' is not a file this shell can run after the install`,
      ),
      cmd.stderr,
    );
    // So is the shim of an install, at the same shape of path, that provided
    // no launcher at all.
    const emptyRoot = `${WINDOWS_STAGED}/npm-empty`;
    mkdirSync(join(dir, emptyRoot), { recursive: true });
    const none = smoke(npmLauncher(emptyRoot, true).bash);
    assert.equal(none.status, 1, none.stderr);
    assert.ok(
      none.stderr.includes(
        `'${WINDOWS_STAGED}/npm-empty/node_modules/.bin/onepipeline-api' is not a file this shell can run after the install`,
      ),
      none.stderr,
    );
    assert.match(none.stderr, /ACTION: check that the install wrote it/);
  });
});

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
