// Publication regression journeys use a native wheel and real release clients.
// The separate manylinux rehearsal still proves the shipping build and its
// glibc floor. These tests need no container or external registry: they compile
// the current server locally and publish/install only through registry doubles.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { launcherShims, plan } from "../../scripts/release.mjs";
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
  test("on Windows, bash is handed the npm launcher's sh shim, not the .cmd that v0.40.0's handed it", async () => {
    // The staged launcher and this target's package, installed by npm from
    // their tarballs, then given the .bin npm writes on Windows, by npm's own
    // cmd-shim: an sh script, a .cmd and a .ps1. Git Bash counts a file
    // executable only by an .exe, .com or .bat name or a `#!` first line, so
    // the .cmd is left as it sees it, not executable.
    const work = join(dir, "windows-shims");
    const prefix = join(work, "npm");
    mkdirSync(prefix, { recursive: true });
    const launcher = execFileSync(
      "node",
      ["scripts/npm-build.mjs", "launcher", "--out", join(work, "launcher")],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    execFileSync("npm", ["pack", "--pack-destination", work], {
      cwd: launcher,
      stdio: "pipe",
    });
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--offline",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(work, "npm-cache"),
        join(work, `onepipeline-api-cli-${VERSION}.tgz`),
        staged(fileOf("npm")),
      ],
      { cwd: ROOT, stdio: "pipe" },
    );
    const bin = join(prefix, "node_modules", ".bin");
    const npmHome = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
    }).trim();
    const cmdShim = createRequire(join(npmHome, "npm", "package.json"))(
      "cmd-shim",
    );
    rmSync(join(bin, "onepipeline-api"));
    await cmdShim(
      join(prefix, "node_modules/onepipeline-api-cli/bin/onepipeline-api.js"),
      join(bin, "onepipeline-api"),
    );
    chmodSync(join(bin, "onepipeline-api.cmd"), 0o644);
    const smoke = (command) =>
      spawnSync(
        "bash",
        [
          "scripts/smoke-published.sh",
          "--expect-version",
          VERSION,
          "--command",
          command,
          "--label",
          "staged windows shim",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
    const shims = launcherShims(bin, true);
    assert.equal(shims.spawn, join(bin, "onepipeline-api.cmd"));
    const ran = smoke(shims.bash);
    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /staged windows shim: smoke test passed/);
    // What v0.40.0's build-windows handed bash, refused as it was there.
    const refused = smoke(shims.spawn);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(
      refused.stderr,
      /onepipeline-api\.cmd' is not on PATH after the install/,
    );
  });

  test("build-linux's npm check waits for npm to serve what it published, and names the package and version when npm never does", async () => {
    const pkg = fileOf("npm").package;
    // Metadata can be visible while the tarball still returns 404, as in
    // v0.40.0. Prove we tried that unavailable tarball before recovering.
    registries.delay([`tarball:${pkg}@${VERSION}=4`]);
    const metadata = await fetch(`${registries.npm}${pkg}`);
    assert.equal(metadata.status, 200);
    assert.ok((await metadata.json()).versions[VERSION]);
    const served = registries.served().length;
    try {
      const run = recipe("linux", ["verify", "--out", OUT], {
        ...env,
        PYPI_PUBLISH: "false",
        RELEASE_VERIFY_BUDGET: "12",
      });
      assert.equal(run.status, 0, run.output);
      const reads = registries.served().slice(served);
      assert.ok(
        reads.includes(`npm-unavailable ${pkg}-${VERSION}.tgz`),
        reads.join("\n"),
      );
      assert.ok(reads.includes(`npm ${pkg}-${VERSION}.tgz`), reads.join("\n"));
    } finally {
      registries.clear();
    }
    registries.hide([`tarball:${pkg}@${VERSION}`]);
    try {
      const run = recipe("linux", ["verify", "--out", OUT], {
        ...env,
        PYPI_PUBLISH: "false",
      });
      assert.notEqual(run.status, 0, run.output);
      assert.match(
        run.stderr,
        new RegExp(
          `npm ${pkg} ${VERSION.replace(/\./g, "\\.")}: still not installable after \\d+ attempts`,
        ),
      );
      assert.ok(
        run.stderr.includes(`ACTION: check that npm serves ${pkg}@${VERSION}`),
        run.stderr,
      );
    } finally {
      registries.clear();
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
// The macOS and Windows files are staged as their jobs would stage them, from
// this host's Linux build renamed to their planned names and npm metadata: a
// Linux host can run their uploads, not their builds or their verify.
describe("a whole release against registry doubles", () => {
  const publishOut = join(ROOT, "target/local-publication/whole-publish");
  const outs = {
    get linux() {
      return OUT;
    },
    macos: join(ROOT, "target/local-publication/macos"),
    windows: join(ROOT, "target/local-publication/windows"),
  };
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
    for (const job of ["macos", "windows"]) {
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
    for (const job of ["macos", "windows"])
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
    for (const job of ["linux", "macos", "windows"]) {
      for (const registry of ["npm", "pypi", "github"])
        step(job, ["upload", registry]);
      // Only this host's own platform can be installed and run here.
      if (job === "linux") step(job, ["verify"]);
    }
    const BUILD_RESULTS =
      "build-linux=success build-macos=success build-windows=success";
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
