// Publication regression journeys use a native wheel and real release clients.
// The separate manylinux rehearsal still proves the shipping build and its
// glibc floor. These tests need no container or external registry: they compile
// the current server locally and publish/install only through registry doubles.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { plan } from "../../scripts/release.mjs";
import { cmdRuns, windowsHost } from "./doubles/windows-host.mjs";
import {
  githubDouble,
  platformSbom,
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
const linuxPlan = plan("linux");
const fileOf = (kind) => linuxPlan.artifacts.find((a) => a.kind === kind);
let OUT;
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
before(() => {
  mkdirSync(join(ROOT, "target"), { recursive: true });
  OUT = mkdtempSync(join(ROOT, "target/publication-"));
  const wheels = join(OUT, "native-wheels");
  execFileSync(
    join(ROOT, ".tools/release-venv/bin/maturin"),
    [
      "build",
      "--strip",
      "--locked",
      "--features",
      "bundled-ui",
      "--compatibility",
      "linux",
      "--out",
      wheels,
    ],
    { cwd: ROOT, stdio: "pipe" },
  );
  // Keep the release's planned carrier names while using a host-native wheel.
  // This fixture makes no portability assertion; the manylinux rehearsal does.
  const wheel = join(OUT, fileOf("wheel").file);
  copyFileSync(
    join(
      wheels,
      readdirSync(wheels).find((f) => f.endsWith(".whl")),
    ),
    wheel,
  );
  execFileSync(
    "python3",
    [
      "scripts/release-package.py",
      "--target",
      TARGET,
      "--wheel",
      wheel,
      "--out",
      OUT,
      "--tag",
      TAG,
      "--sbom",
      platformSbom(OUT, TARGET),
    ],
    { cwd: ROOT, stdio: "pipe" },
  );
});
after(() => {
  if (OUT) rmSync(OUT, { recursive: true, force: true });
});

describe("native publication regressions", () => {
  let dir;
  let gh;
  let registries;
  let env;
  before(async () => {
    dir = scratch("native-publication");
    gh = githubDouble(dir, TAG);
    registries = await registryDoubles(dir);
    env = releaseEnv({ gh, registries, home: dir });
    for (const registry of ["github", "pypi", "npm"]) {
      const run = recipe("linux", ["upload", registry, "--out", OUT], env);
      assert.equal(run.status, 0, run.output);
    }
  });
  after(async () => {
    await registries?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  test("on Windows, the staged verification hands bash the npm launcher's sh shim, not the .cmd that v0.40.0's handed it", () => {
    // build-windows' own check, unmodified, over this release's staged files
    // on a stand-in Windows host (./doubles/windows-host.mjs): npm writes the
    // .bin a Windows npm writes, Git Bash reads its .cmd as not executable,
    // and cmd.exe is what runs the .cmd Node spawns.
    const work = scratch("windows-host");
    const host = windowsHost(work);
    try {
      const verify = spawnSync(
        "node",
        [
          ...host.node,
          "scripts/verify-staged-release.mjs",
          OUT,
          TARGET,
          VERSION,
        ],
        { cwd: ROOT, env: host.env, encoding: "utf8", timeout: 600_000 },
      );
      assert.equal(verify.status, 0, `${verify.stdout}${verify.stderr}`);
      assert.match(
        verify.stdout,
        new RegExp(
          `${TARGET}: staged archive/wheel/npm install, server and embedded view passed`,
        ),
      );
      // The server was started from the launcher's .cmd, by cmd.exe.
      assert.deepEqual(
        cmdRuns(host).map((cmd) => cmd.split("/").slice(-3).join("/")),
        ["node_modules/.bin/onepipeline-api.cmd"],
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// A whole release's publication phases, in release.yml's order, against doubles
// that start from nothing — and from what v0.40.0 left: its build-linux
// published its wheel and npm package, then failed its verify; macOS
// published its wheel too, and build-windows failed before publishing anything, so publish released nothing
// platform-independent. A release that finds any of its own version already
// served must treat it as published and finish the rest.
//
// The arm64 Linux, macOS and Windows files are staged as their jobs would stage
// them, from this host's x86_64 Linux build renamed to their planned names and
// npm metadata: this host can run their uploads, not their builds or their
// verify.
describe("a whole release against registry doubles", () => {
  const publishOut = join(ROOT, "target/local-publication/whole-publish");
  const outs = {
    get linux() {
      return OUT;
    },
    "linux-arm64": join(ROOT, "target/local-publication/linux-arm64"),
    macos: join(ROOT, "target/local-publication/macos"),
    windows: join(ROOT, "target/local-publication/windows"),
  };
  // The jobs whose files this host stages rather than builds.
  const foreign = ["linux-arm64", "macos", "windows"];
  const stagedOf = (job, artifact) =>
    job === "linux"
      ? staged(artifact)
      : join(
          outs[job],
          {
            archive: "assets",
            checksum: "assets",
            wheel: "wheels",
            npm: "npm-artifacts",
          }[artifact.kind],
          artifact.file,
        );
  const plans = {
    linux: linuxPlan,
    "linux-arm64": plan("linux-arm64"),
    macos: plan("macos"),
    windows: plan("windows"),
  };
  const everything = () => [
    ...Object.values(plans).flatMap((p) => p.artifacts),
    ...plan("publish").artifacts,
  ];

  before(() => {
    assert.ok(
      existsSync(join(OUT, "assets")),
      "the native fixture staged the Linux carriers",
    );
    for (const job of foreign) {
      rmSync(outs[job], { recursive: true, force: true });
      for (const artifact of plans[job].artifacts) {
        const file = stagedOf(job, artifact);
        mkdirSync(join(file, ".."), { recursive: true });
        if (artifact.kind === "wheel")
          writeFileSync(file, readFileSync(staged(fileOf("wheel"))));
        else if (artifact.kind === "npm") {
          const work = join(outs[job], "npm-package");
          mkdirSync(work, { recursive: true });
          execFileSync("tar", ["-xzf", staged(fileOf("npm")), "-C", work]);
          const manifest = JSON.parse(
            readFileSync(join(work, "package/package.json"), "utf8"),
          );
          const [os, cpu] = artifact.package
            .replace("onepipeline-api-cli-", "")
            .split("-");
          writeFileSync(
            join(work, "package/package.json"),
            JSON.stringify({
              ...manifest,
              name: artifact.package,
              os: [os],
              cpu: [cpu],
            }),
          );
          execFileSync("tar", ["-czf", file, "-C", work, "package"]);
          rmSync(work, { recursive: true });
        } else writeFileSync(file, `${artifact.file}\n`);
      }
    }
  });
  after(() => {
    for (const job of foreign)
      rmSync(outs[job], { recursive: true, force: true });
    rmSync(publishOut, { recursive: true, force: true });
  });

  // release.yml's publication steps, each job's in its order.
  function release(env) {
    const steps = [];
    const step = (job, args, extra = {}) => {
      const out = job === "publish" ? publishOut : outs[job];
      const run = recipe(
        job,
        [
          ...args,
          ...(["check", "settle"].includes(args[0]) ? [] : ["--out", out]),
        ],
        { ...env, ...extra },
      );
      steps.push({ job, args, ...run });
      assert.equal(run.status, 0, `${job} ${args.join(" ")}: ${run.output}`);
      return run;
    };
    for (const job of ["linux", ...foreign]) {
      for (const registry of ["npm", "pypi", "github"])
        step(job, ["upload", registry]);
      // Only this host's own platform can be installed and run here.
      if (job === "linux") step(job, ["verify"]);
    }
    const BUILD_RESULTS =
      "build-linux=success build-linux-arm64=success build-macos=success build-windows=success";
    step("publish", ["check"], { BUILD_RESULTS });
    step("publish", ["build"]);
    for (const registry of ["crate", "npm", "github"])
      step("publish", ["upload", registry], { BUILD_RESULTS });
    step("publish", ["verify"], { BUILD_RESULTS });
    step("publish", ["settle"], {
      BUILD_RESULTS,
      STEP_RESULTS:
        "check=success build=success upload-crate=success upload-npm=success upload-github=success verify=success",
    });
    return steps;
  }

  // Where each artifact is once a double holds it, and the bytes it holds.
  function held(gh, registries, artifact) {
    const path = {
      github: () => join(gh.assets, artifact.file),
      pypi: () => join(registries.state, "pypi", artifact.file),
      npm: () =>
        join(registries.state, "npm", artifact.package, `${VERSION}.tgz`),
      crate: () => join(registries.state, "crates", artifact.file),
    }[artifact.registry]();
    return existsSync(path) ? readFileSync(path) : undefined;
  }
  const jobOf = (artifact) =>
    Object.keys(plans).find((job) =>
      plans[job].targets.includes(artifact.target),
    );
  const stagedBytes = (artifact) => {
    const job = jobOf(artifact);
    if (job) return readFileSync(stagedOf(job, artifact));
    const dir = { crate: "crates", npm: "npm-artifacts", sbom: "assets" }[
      artifact.kind
    ];
    return readFileSync(join(publishOut, dir, artifact.file));
  };

  // What v0.40.0's run left on each registry, by the bytes this release built.
  const v040 = (a) =>
    (a.kind === "wheel" &&
      ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"].includes(
        a.target,
      )) ||
    (a.kind === "npm" && a.target === "x86_64-unknown-linux-gnu");

  for (const [name, seeded, count] of [
    ["from nothing published", () => false, 0],
    ["over v0.40.0's wheels and npm platform package", v040, 3],
  ])
    test(`${name}, it ends with every artifact it builds published`, async () => {
      const dir = scratch("whole");
      const gh = githubDouble(dir, TAG);
      const registries = await registryDoubles(dir);
      try {
        const seed = everything().filter(seeded);
        for (const artifact of seed) {
          const bytes = readFileSync(stagedOf(jobOf(artifact), artifact));
          if (artifact.registry === "pypi")
            writeFileSync(join(registries.state, "pypi", artifact.file), bytes);
          else {
            const pkg = join(registries.state, "npm", artifact.package);
            mkdirSync(pkg, { recursive: true });
            writeFileSync(join(pkg, `${VERSION}.tgz`), bytes);
            writeFileSync(
              join(pkg, `${VERSION}.json`),
              execFileSync("tar", [
                "-xzOf",
                join(pkg, `${VERSION}.tgz`),
                "package/package.json",
              ]),
            );
          }
        }
        assert.equal(seed.length, count);

        const steps = release(releaseEnv({ gh, registries, home: dir }));

        for (const artifact of everything()) {
          const bytes = held(gh, registries, artifact);
          assert.ok(bytes, `${artifact.file} was published`);
          assert.ok(
            bytes.equals(stagedBytes(artifact)),
            `${artifact.file} is the file this release built`,
          );
        }
        // What was already served was left alone, and everything else was
        // published once.
        const uploaded = [
          ...registries.uploads().map((line) => line.split(" ")[1]),
          ...gh.uploads().map((call) => call.at(-1).split("/").at(-1)),
        ].sort();
        const named = (a) =>
          a.registry === "npm" ? `${a.package}-${VERSION}.tgz` : a.file;
        assert.deepEqual(
          uploaded,
          everything()
            .filter((a) => !seed.includes(a))
            .map(named)
            .sort(),
        );
        for (const artifact of seed)
          assert.ok(
            steps.some(
              (s) =>
                s.args[0] === "upload" &&
                s.stdout.split("already served")[1]?.includes(artifact.file),
            ),
            `${artifact.file} was reported as already served`,
          );
        assert.ok(!gh.prerelease(), "the Release stands as a release");
        assert.doesNotMatch(gh.body(), /did not publish/);
      } finally {
        await registries.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
});

// v0.41.2's build-windows was re-run twice after its first attempt had
// published every file and npm held its package unserved: the second attempt
// could not publish over it, and the third, once npm served it, refused it as
// not the build that attempt made — a rebuild is not byte-identical — so
// publish never shipped the launcher. Here the same re-runs of build-linux,
// whose files this host can build, install and run.
describe("a re-run of a platform job whose earlier attempt published part of it", () => {
  let EARLIER;
  const PACKAGE = fileOf("npm").package;
  const stagedIn = (out, artifact) =>
    join(
      out,
      {
        archive: "assets",
        checksum: "assets",
        wheel: "wheels",
        npm: "npm-artifacts",
      }[artifact.kind],
      artifact.file,
    );
  const integrityOf = (path) =>
    `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
  const sha256Of = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

  // The build an earlier attempt made: this one's binary with bytes appended —
  // the same program, as a rebuild is, and not the same file — packed into
  // every carrier by the release's own packaging.
  before(() => {
    EARLIER = mkdtempSync(join(ROOT, "target/publication-earlier-"));
    const wheel = join(EARLIER, fileOf("wheel").file);
    execFileSync(
      "python3",
      [
        "-c",
        String.raw`
import base64, hashlib, sys, zipfile
source, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(source) as old, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as new:
    infos = old.infolist()
    members = {info.filename: old.read(info) for info in infos}
    exe = next(name for name in members if name.endswith('.data/scripts/onepipeline-api'))
    members[exe] += b'\0built by an earlier attempt of this release\n'
    record = next(name for name in members if name.endswith('.dist-info/RECORD'))
    digest = base64.urlsafe_b64encode(hashlib.sha256(members[exe]).digest()).rstrip(b'=').decode()
    members[record] = ''.join(f'{exe},sha256={digest},{len(members[exe])}\n' if line.split(',')[0] == exe
                              else line + '\n' for line in members[record].decode().splitlines()).encode()
    for info in infos:
        new.writestr(info, members[info.filename])
`,
        staged(fileOf("wheel")),
        wheel,
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      "python3",
      [
        "scripts/release-package.py",
        "--target",
        TARGET,
        "--wheel",
        wheel,
        "--out",
        EARLIER,
        "--tag",
        TAG,
        "--sbom",
        platformSbom(EARLIER, TARGET),
      ],
      { cwd: ROOT, stdio: "pipe" },
    );
    for (const artifact of linuxPlan.artifacts)
      assert.notEqual(
        sha256Of(stagedIn(EARLIER, artifact)),
        sha256Of(staged(artifact)),
        `the earlier attempt's ${artifact.kind} is another file`,
      );
  });
  after(() => {
    if (EARLIER) rmSync(EARLIER, { recursive: true, force: true });
  });

  async function services(extra = {}) {
    const dir = scratch("rerun");
    const gh = githubDouble(dir, TAG);
    const registries = await registryDoubles(dir);
    const env = { ...releaseEnv({ gh, registries, home: dir }), ...extra };
    const step = (out, ...args) =>
      recipe("linux", [...args, "--out", out], env);
    const writes = () => ({
      registries: registries.uploads(),
      release: gh.uploads().length,
    });
    const close = async () => {
      await registries.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { gh, registries, step, writes, close };
  }
  const release = (s, artifact) =>
    readFileSync(join(s.gh.assets, artifact.file));

  test("keeps everything the earlier attempt published, says so with both digests, and verifies that build", async () => {
    const s = await services();
    try {
      for (const registry of ["npm", "pypi", "github"]) {
        const run = s.step(EARLIER, "upload", registry);
        assert.equal(run.status, 0, run.output);
      }
      const landed = s.writes();

      const said = [];
      for (const registry of ["npm", "pypi", "github"]) {
        const run = s.step(OUT, "upload", registry);
        assert.equal(run.status, 0, `${registry}: ${run.output}`);
        said.push(run.stdout);
      }
      const [npm, pypi, github] = said;
      assert.ok(
        npm.includes(
          `npm already holds ${PACKAGE}@${VERSION} from an earlier attempt of ${TAG} (${integrityOf(stagedIn(EARLIER, fileOf("npm")))}, where this build's is ${integrityOf(staged(fileOf("npm")))})`,
        ),
        npm,
      );
      assert.ok(
        pypi.includes(
          `PyPI already holds ${fileOf("wheel").file} from an earlier attempt of ${TAG} (${sha256Of(stagedIn(EARLIER, fileOf("wheel")))}, where this build's is ${sha256Of(staged(fileOf("wheel")))})`,
        ),
        pypi,
      );
      assert.ok(
        github.includes(
          `the Release already holds ${fileOf("archive").file} and ${fileOf("checksum").file} from an earlier attempt of ${TAG} (${sha256Of(stagedIn(EARLIER, fileOf("archive")))}, where this build's is ${sha256Of(staged(fileOf("archive")))}); kept`,
        ),
        github,
      );
      assert.deepEqual(s.writes(), landed, "nothing was uploaded or replaced");

      const verified = s.step(OUT, "verify");
      assert.equal(verified.status, 0, verified.output);
      assert.match(
        verified.stdout,
        /the Release serves .* from an earlier attempt .*; installing and running that build/,
      );
      assert.match(
        verified.stdout,
        /PyPI serves .* from an earlier attempt .*; installing and running that build/,
      );
      assert.doesNotMatch(verified.stdout, /more than one build/);
      assert.match(
        verified.stdout,
        /installed from the Release and PyPI and ran/,
      );
      assert.ok(
        release(s, fileOf("archive")).equals(
          readFileSync(stagedIn(EARLIER, fileOf("archive"))),
        ),
        "the Release still serves the earlier attempt's archive",
      );
    } finally {
      await s.close();
    }
  });

  test("replaces a Release pair the earlier attempt left half uploaded, and verify reports the registries serving two builds", async () => {
    const s = await services();
    try {
      for (const registry of ["npm", "pypi"]) {
        const run = s.step(EARLIER, "upload", registry);
        assert.equal(run.status, 0, run.output);
      }
      s.gh.failUploads(fileOf("checksum").file);
      const half = s.step(EARLIER, "upload", "github");
      assert.notEqual(half.status, 0, half.output);
      s.gh.healUploads();
      assert.deepEqual(readdirSync(s.gh.assets), [fileOf("archive").file]);

      for (const registry of ["npm", "pypi"])
        assert.equal(s.step(OUT, "upload", registry).status, 0);
      const github = s.step(OUT, "upload", "github");
      assert.equal(github.status, 0, github.output);
      assert.ok(
        github.stdout.includes(
          `the Release held ${fileOf("archive").file} from an earlier attempt of ${TAG}; replaced with this build's, because the Release held only part of that attempt's pair`,
        ),
        github.stdout,
      );
      for (const kind of ["archive", "checksum"])
        assert.ok(
          release(s, fileOf(kind)).equals(readFileSync(staged(fileOf(kind)))),
          `the Release serves this build's ${kind}`,
        );

      const verified = s.step(OUT, "verify");
      assert.equal(verified.status, 0, verified.output);
      assert.match(
        verified.stdout,
        new RegExp(
          `^release linux: ${TARGET} is served as more than one build: the Release [0-9a-f]{12}…, PyPI [0-9a-f]{12}…;`,
          "m",
        ),
      );
    } finally {
      await s.close();
    }
  });

  test("replaces the earlier attempt's Release pair when neither PyPI nor npm holds that build", async () => {
    const s = await services({ PYPI_PUBLISH: "false", NPM_PUBLISH: "false" });
    try {
      assert.equal(s.step(EARLIER, "upload", "github").status, 0);
      const github = s.step(OUT, "upload", "github");
      assert.equal(github.status, 0, github.output);
      assert.ok(
        github.stdout.includes(
          `the Release held ${fileOf("archive").file} and ${fileOf("checksum").file} from an earlier attempt of ${TAG}; replaced with this build's, because neither PyPI nor npm holds that attempt's ${TARGET} build`,
        ),
        github.stdout,
      );
      const verified = s.step(OUT, "verify");
      assert.equal(verified.status, 0, verified.output);
      assert.doesNotMatch(
        verified.stdout,
        /earlier attempt|more than one build/,
      );
    } finally {
      await s.close();
    }
  });
});
