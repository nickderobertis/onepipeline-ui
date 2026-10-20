// The release jobs' own recipes, driven on this host the way release.yml runs
// them: the Linux build for real, end to end, in the rehearsal — the
// build-linux recipe in its dry-run mode — which stages the files every
// journey over a manylinux build reads (./rehearsal.mjs names them).
//
// The journeys over those files run after this one, in a target of their own,
// beside each other: ./rehearsal-failures.test.mjs, the recipe refusing staged
// files that do not install, and ./registries.test.mjs, the publication phases
// of build-linux and publish against local doubles of PyPI, npm, the crate
// registry and the GitHub Release (./doubles), which serve exactly what was
// uploaded to them, so the real clients — gh, twine, pip, npm, cargo and the
// release probe — are what publish and install. ./publication.test.mjs builds a
// native wheel instead, so its registry journeys run without a manylinux image
// or its external mirrors, beside this file rather than after it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { npmLauncher } from "../../scripts/release.mjs";
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
  registryDoubles,
  releaseEnv,
  scratch,
} from "./support.mjs";

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
