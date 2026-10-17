import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PLATFORMS, plan, TARGETS } from "../../scripts/release.mjs";
import { evaluate, workflows } from "../workflow-graph.mjs";

// The release's shape, read from the workflows themselves and from the plan of
// what each release job produces (`just release-<job> plan`, scripts/release.mjs).
const workflow = (file) => workflows().find((w) => w.file === file)?.document;
const release = () => workflow("release.yml");
const BUILD_JOBS = Object.keys(PLATFORMS).map((os) => `build-${os}`);
const RELEASE_JOBS = [...BUILD_JOBS, "publish"];
// The job a recipe belongs to: `release-linux` is build-linux's, and so on.
const jobOfRecipe = (recipe) =>
  recipe === "publish" ? "publish" : `build-${recipe}`;
const planOf = (job, version) =>
  plan(job === "publish" ? "publish" : job.replace(/^build-/, ""), version);

// Every step of every release job that runs one of the release recipes, with
// the phase and, for an upload, the registry it publishes to.
function recipeSteps() {
  const steps = [];
  for (const [job, definition] of Object.entries(release().jobs))
    definition.steps.forEach((step, index) => {
      for (const match of (step.run ?? "").matchAll(
        /just release-(\w+) ([\w-]+)(?: (\w+))?/g,
      ))
        steps.push({
          job,
          index,
          step,
          recipeJob: jobOfRecipe(match[1]),
          phase: match[2],
          registry: match[2] === "upload" ? match[3] : undefined,
        });
    });
  return steps;
}

// The scripts the release scripts read the Actions ref out of. A journey
// inherits whatever runner it happens on — on a pull request that is
// `<n>/merge` — so every command spawned here gets an environment without the
// runner's GITHUB_* context, plus only what the case sets.
const scratchRoot = () => process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir();
const hermetic = (extra = {}) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GITHUB_") && key !== "RELEASE_TAG",
    ),
  ),
  ...extra,
});

test("the release is exactly four jobs, three platform builds side by side and a publish that needs them all", () => {
  const jobs = release().jobs;
  assert.deepEqual(Object.keys(jobs).sort(), [...RELEASE_JOBS].sort());
  for (const [os, runner] of Object.entries(PLATFORMS)) {
    const job = jobs[`build-${os}`];
    assert.equal(job["runs-on"], runner, `build-${os} runs on ${runner}`);
    assert.equal(job["timeout-minutes"], 30, `build-${os}`);
    assert.equal(job.needs, undefined, `build-${os} needs nothing`);
  }
  assert.equal(jobs.publish["runs-on"], "ubuntu-latest");
  assert.equal(jobs.publish["timeout-minutes"], 30);
  assert.deepEqual([...jobs.publish.needs].sort(), [...BUILD_JOBS].sort());

  const plz = workflow("release-plz.yml").jobs;
  assert.deepEqual(Object.keys(plz), ["release-plz"]);
  assert.equal(plz["release-plz"]["timeout-minutes"], 30);
  assert.equal(plz["release-plz"]["runs-on"], "ubuntu-latest");
});

test("nothing follows a release on workflow_run, and no release job re-runs the gate or a test tier", () => {
  assert.ok(!existsSync(".github/workflows/published-smoke.yml"));
  for (const { file, document } of workflows()) {
    const trigger = document.on?.workflow_run;
    assert.ok(
      !trigger || !(trigger.workflows ?? []).includes(release().name),
      `${file} runs on the completion of the ${release().name} workflow`,
    );
  }
  for (const file of ["release.yml", "release-plz.yml"])
    for (const [job, definition] of Object.entries(workflow(file).jobs))
      for (const step of definition.steps)
        assert.doesNotMatch(
          step.run ?? "",
          /just (check|check-affected|check-cross|gate|test|test-quick|test-e2e|test-baseline|test-cost)\b|nextest|run-many -t (test|check)|-t check\b/,
          `${file} ${job} runs a test tier: ${step.run}`,
        );
});

test("every artifact the release produces is uploaded by exactly one step of exactly one job, its own", () => {
  const steps = recipeSteps();
  for (const job of RELEASE_JOBS)
    for (const artifact of planOf(job).artifacts) {
      const uploaders = steps.filter(
        (s) =>
          s.phase === "upload" &&
          s.recipeJob === job &&
          s.registry === artifact.registry,
      );
      assert.equal(
        uploaders.length,
        1,
        `${artifact.file} (${artifact.registry}) is uploaded by ${uploaders.length} steps`,
      );
      assert.equal(
        uploaders[0].job,
        job,
        `${artifact.file} is uploaded from ${uploaders[0].job}, not ${job}`,
      );
    }
  // And by nothing else: every publishing client is reached through a recipe,
  // so a step that uploads some other way is an artifact no plan accounts for.
  for (const [job, definition] of Object.entries(release().jobs))
    for (const step of definition.steps) {
      assert.doesNotMatch(
        `${step.run ?? ""} ${step.uses ?? ""}`,
        /gh release upload|twine upload|npm publish|cargo publish|publish-npm\.sh|gh-action-pypi-publish|upload-rust-binary-action|upload-artifact/,
        `${job} publishes outside its recipe`,
      );
      for (const s of steps.filter((s) => s.step === step))
        assert.equal(
          s.recipeJob,
          job,
          `${job} runs ${s.recipeJob}'s recipe: ${step.run}`,
        );
    }
});

test("every release target is uploaded by the jobs release-targets.toml says publish it", () => {
  const declaration = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,tomllib\nwith open('release-targets.toml','rb') as f: print(json.dumps(tomllib.load(f)))",
      ],
      { encoding: "utf8" },
    ),
  );
  const uploaders = new Map();
  for (const job of RELEASE_JOBS)
    for (const artifact of planOf(job).artifacts.filter((a) => a.package)) {
      const id = `${artifact.registry}:${artifact.package}`;
      uploaders.set(id, new Set([...(uploaders.get(id) ?? []), job]));
    }
  const declared = new Set();
  for (const target of declaration.target) {
    const named = new Set(
      RELEASE_JOBS.filter((job) =>
        new RegExp(`\\b${job}\\b(?! release)`).test(target.published_by),
      ),
    );
    const ids = [target.id, ...(target.covers ?? [])];
    for (const id of ids) {
      declared.add(id);
      assert.ok(uploaders.has(id), `${id} is declared and nothing uploads it`);
      for (const job of uploaders.get(id))
        assert.ok(
          named.has(job),
          `${id} is uploaded by ${job}, which ${target.name}'s published_by does not name: ${target.published_by}`,
        );
    }
    // A target spread across platforms is each build job together.
    const all = new Set(ids.flatMap((id) => [...uploaders.get(id)]));
    assert.deepEqual(
      [...named].sort(),
      [...all].sort(),
      `${target.name}'s published_by names ${[...named]} and ${[...all]} upload it`,
    );
  }
  assert.deepEqual(
    [...uploaders.keys()].sort(),
    [...declared].sort(),
    "the release uploads a package release-targets.toml does not declare",
  );
});

test("in each build job the test-install comes before every publish, and the registry verification after", () => {
  const steps = recipeSteps();
  for (const job of BUILD_JOBS) {
    const mine = steps.filter((s) => s.job === job);
    const install = mine.filter((s) => s.phase === "test-install");
    const uploads = mine.filter((s) => s.phase === "upload");
    const verify = mine.filter((s) => s.phase === "verify");
    const build = mine.filter((s) => s.phase === "build");
    assert.equal(build.length, 1, `${job} builds once`);
    assert.equal(install.length, 1, `${job} test-installs once`);
    assert.equal(verify.length, 1, `${job} verifies once`);
    assert.deepEqual(uploads.map((s) => s.registry).sort(), [
      "github",
      "npm",
      "pypi",
    ]);
    assert.ok(
      build[0].index < install[0].index,
      `${job} installs what it built`,
    );
    for (const upload of uploads) {
      assert.ok(
        install[0].index < upload.index,
        `${job} publishes to ${upload.registry} before installing`,
      );
      assert.ok(
        upload.index < verify[0].index,
        `${job} verifies before publishing to ${upload.registry}`,
      );
    }
    const view = release().jobs[job].steps.findIndex((s) =>
      /^just build$/m.test(s.run ?? ""),
    );
    assert.ok(
      view >= 0 && view < build[0].index,
      `${job} builds the view first`,
    );
  }
});

test("publish uploads only platform-independent artifacts, and only after every platform is confirmed", () => {
  const steps = recipeSteps().filter((s) => s.job === "publish");
  const check = steps.find((s) => s.phase === "check");
  assert.ok(check, "publish has an availability check");
  const uploads = steps.filter((s) => s.phase === "upload");
  assert.deepEqual(uploads.map((s) => s.registry).sort(), [
    "crate",
    "github",
    "npm",
  ]);
  for (const upload of uploads) {
    assert.ok(check.index < upload.index, `${upload.registry} before check`);
    for (const artifact of plan("publish").artifacts.filter(
      (a) => a.registry === upload.registry,
    ))
      assert.equal(
        artifact.target,
        undefined,
        `${artifact.file} is a platform's`,
      );
  }
  // No platform file can reach publish's uploads: none of its plan is staged
  // by a platform recipe, and no platform recipe runs in it.
  const platformFiles = new Set(
    Object.keys(PLATFORMS).flatMap((os) =>
      plan(os).artifacts.map((a) => a.file),
    ),
  );
  for (const artifact of plan("publish").artifacts)
    assert.ok(!platformFiles.has(artifact.file), artifact.file);
});

test("the demotion is reached when a platform job fails", () => {
  const publish = release().jobs.publish;
  assert.match(publish.if, /always\(\)/);
  const settle = publish.steps.find((s) =>
    /just release-publish settle/.test(s.run ?? ""),
  );
  assert.ok(settle, "publish settles the Release");
  assert.match(settle.if, /always\(\)/);
  for (const failed of BUILD_JOBS) {
    const needs = Object.fromEntries(
      BUILD_JOBS.map((job) => [
        job,
        { result: job === failed ? "failure" : "success", outputs: {} },
      ]),
    );
    const context = { needs, vars: {}, github: {}, secrets: {} };
    assert.equal(
      evaluate(publish.if, context).coerceString(),
      "true",
      `publish is skipped when ${failed} fails`,
    );
  }
  // And it is the last step that can hold the Release: everything that
  // publishes comes before it.
  const steps = recipeSteps().filter((s) => s.job === "publish");
  for (const s of steps.filter((s) => s.phase !== "settle"))
    assert.ok(
      s.index < publish.steps.indexOf(settle),
      `${s.phase} runs after the verdict`,
    );
});

test("no workflow, recipe or release declaration builds or names arm64 Linux", () => {
  const sources = [
    ...workflows().map((w) => `.github/workflows/${w.file}`),
    "justfile",
    "release-targets.toml",
    "npm/onepipeline-api-cli/package.json",
  ];
  for (const source of sources)
    assert.doesNotMatch(
      readFileSync(source, "utf8"),
      /aarch64-unknown-linux-gnu|linux-arm64|ubuntu-[\w.]*-arm\b|linux\/arm64|manylinux\w*_aarch64/,
      source,
    );
  for (const { file, document } of workflows())
    for (const [job, definition] of Object.entries(document.jobs ?? {}))
      assert.doesNotMatch(
        JSON.stringify(definition["runs-on"] ?? ""),
        /arm/,
        `${file} ${job} runs on an arm64 runner`,
      );
  assert.ok(!Object.keys(TARGETS).includes("aarch64-unknown-linux-gnu"));
  // The scripts the recipes run refuse it rather than building it.
  const wheel = spawnSync(
    "bash",
    ["scripts/build-linux-wheel.sh", "--target", "aarch64-unknown-linux-gnu"],
    { encoding: "utf8", env: hermetic() },
  );
  assert.equal(wheel.status, 2, wheel.stderr);
  assert.match(wheel.stderr, /no manylinux build is defined/);
  const npm = spawnSync(
    "node",
    [
      "scripts/npm-build.mjs",
      "platform",
      "--target",
      "aarch64-unknown-linux-gnu",
      "--binary",
      "package.json",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(npm.status, 0);
  assert.match(npm.stderr, /unknown target/);
  const pkg = spawnSync(
    "python3",
    [
      "scripts/release-package.py",
      "--target",
      "aarch64-unknown-linux-gnu",
      "--wheel",
      "missing.whl",
      "--out",
      ".",
      "--tag",
      "v1.0.0",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(pkg.status, 0);
  assert.match(pkg.stderr, /invalid choice/);
});

// Plan mode is the macOS and Windows contract here: the macOS and Windows build recipes need native macOS and Windows toolchains this Linux host cannot run, so inside the dispatch their proof is the recipes' plan mode checked against the last release's published artifacts; the Linux recipe is driven for real end to end, and the hosted build jobs build and run the foreign artifacts on every release.
test("every release job's plan is what v0.37.0 published, with arm64 Linux dropped and no Intel macOS", () => {
  const published = JSON.parse(
    readFileSync(".github/fixtures/release-v0.37.0.json", "utf8"),
  );
  const dropped = /aarch64-unknown-linux-gnu|_aarch64|linux-arm64/;
  const planned = (job) => {
    const os = job === "publish" ? "publish" : job.replace(/^build-/, "");
    const result = spawnSync(
      "node",
      ["scripts/release.mjs", os, "plan", "--version", published.version],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const plans = RELEASE_JOBS.map(planned);
  const all = plans.flatMap((p) => p.artifacts);
  for (const p of plans)
    assert.ok(!p.targets.includes("x86_64-apple-darwin"), p.job);
  assert.deepEqual(
    all
      .filter((a) => a.registry === "github")
      .map((a) => a.file)
      .sort(),
    published.github.filter((f) => !dropped.test(f)).sort(),
  );
  assert.deepEqual(
    all
      .filter((a) => a.registry === "pypi")
      .map((a) => ({ file: a.file, tags: a.tags }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    published.pypi.filter((w) => !dropped.test(w.file)),
  );
  assert.deepEqual(
    all
      .filter((a) => a.registry === "npm")
      .map((a) => ({ package: a.package, file: a.file }))
      .sort((a, b) => a.package.localeCompare(b.package)),
    published.npm
      .filter((p) => !dropped.test(p.package))
      .sort((a, b) => a.package.localeCompare(b.package)),
  );
  assert.deepEqual(
    all
      .filter((a) => a.registry === "crate")
      .map((a) => ({ package: a.package, file: a.file })),
    published.crate,
  );
  for (const p of plans.filter((p) => p.job !== "publish"))
    for (const artifact of p.artifacts)
      assert.equal(TARGETS[artifact.target].platform, p.job, artifact.file);
});

test("the tools the release recipes reach are pinned once for the workflows and the journeys", () => {
  const just = readFileSync("justfile", "utf8");
  const pin = (name) =>
    just.match(new RegExp(`^${name} := "([^"]+)"$`, "m"))?.[1];
  const plz = readFileSync(".github/workflows/release-plz.yml", "utf8");
  const rel = readFileSync(".github/workflows/release.yml", "utf8");
  assert.equal(
    plz.match(/RELEASE_PLZ_VERSION: "([^"]+)"/)[1],
    pin("release-plz-version"),
  );
  assert.equal(
    rel.match(/cargo-cyclonedx@([\d.]+)/)[1],
    pin("cyclonedx-version"),
  );
  assert.equal(
    readFileSync("scripts/build-linux-wheel.sh", "utf8").match(
      /^maturin_version="([^"]+)"$/m,
    )[1],
    pin("maturin-version"),
  );
  assert.doesNotMatch(rel, /pip install/);
  for (const job of BUILD_JOBS)
    assert.ok(
      release().jobs[job].steps.some(
        (s) => s.run === "just release-python-tools",
      ),
      job,
    );
});

test("Darwin artifact contracts preserve wheel bytes and reject an architecture mismatch without executing them", () => {
  const scratch = mkdtempSync(join(scratchRoot(), "darwin-contract-"));
  try {
    const target = "aarch64-apple-darwin";
    // A structural Mach-O fixture exercises the carrier boundary. It is never
    // executed; native installs remain the hosted Mac job's proof.
    const fixture = (cpu, wheelArch) => {
      const wheel = join(
        scratch,
        `onepipeline_api_cli-1.0.0-py3-none-macosx_11_0_${wheelArch}.whl`,
      );
      execFileSync("python3", [
        "-c",
        `import struct,zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('onepipeline_api_cli-1.0.0.data/scripts/onepipeline-api',struct.pack('<IIIIIIII',0xfeedfacf,int(sys.argv[2]),0,2,0,0,0,0))
 z.writestr('onepipeline_api_cli-1.0.0.dist-info/METADATA','Name: onepipeline-api-cli\\nVersion: 1.0.0\\n')
 z.writestr('onepipeline_api_cli-1.0.0.dist-info/WHEEL','Wheel-Version: 1.0\\nTag: py3-none-macosx_11_0_'+sys.argv[3]+'\\n')`,
        wheel,
        String(cpu),
        wheelArch,
      ]);
      return wheel;
    };
    const wheel = fixture(0x0100000c, "arm64");
    const args = [
      "scripts/release-package.py",
      "--target",
      target,
      "--wheel",
      wheel,
      "--out",
      scratch,
      "--tag",
      "v1.0.0",
    ];
    execFileSync("python3", args, { stdio: "pipe" });
    execFileSync("python3", [
      "-c",
      `import hashlib,sys,tarfile,zipfile,pathlib
root=pathlib.Path(sys.argv[1]); target=sys.argv[2]
with zipfile.ZipFile(sys.argv[3]) as z:
 expected=z.read('onepipeline_api_cli-1.0.0.data/scripts/onepipeline-api')
archive=root/'assets'/('onepipeline-api-v1.0.0-'+target+'.tar.gz')
with tarfile.open(archive) as t:
 assert set(t.getnames()) == {'onepipeline-api','README.md','LICENSE','CHANGELOG.md'}
 assert t.extractfile('onepipeline-api').read() == expected
checksum=(root/'assets'/('onepipeline-api-v1.0.0-'+target+'.sha256')).read_text().split()[0]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == checksum
with tarfile.open(root/'npm-artifacts'/'onepipeline-api-cli-darwin-arm64-1.0.0.tgz') as t:
 assert t.extractfile('package/bin/onepipeline-api').read() == expected
`,
      scratch,
      target,
      wheel,
    ]);
    const record = JSON.parse(
      readFileSync(join(scratch, target, "reuse.json"), "utf8"),
    );
    assert.equal(record.target, target);
    assert.equal(record.binarySha256, record.archiveBinarySha256);
    assert.equal(record.binarySha256, record.wheelBinarySha256);
    assert.equal(record.binarySha256, record.npmBinarySha256);
    // An Intel Mach-O handed in as the Apple Silicon target is refused.
    const intel = fixture(0x01000007, "x86_64");
    const refused = spawnSync(
      "python3",
      args.map((value) => (value === wheel ? intel : value)),
      { encoding: "utf8" },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /declared Darwin architecture/);
    // And the discontinued Intel target is no longer a staging choice.
    const discontinued = spawnSync(
      "python3",
      args.map((value) => (value === target ? "x86_64-apple-darwin" : value)),
      { encoding: "utf8" },
    );
    assert.notEqual(discontinued.status, 0);
    assert.match(discontinued.stderr, /invalid choice/);
    const provider = join(scratch, "npm-provider");
    mkdirSync(provider, { recursive: true });
    writeFileSync(
      join(provider, "npm"),
      '#!/usr/bin/env bash\nprintf "%s\n" "$PACK_RESPONSE"\n',
      { mode: 0o755 },
    );
    for (const response of [
      "[]",
      JSON.stringify([
        {
          name: "onepipeline-api-cli-darwin-arm64",
          version: "1.0.0",
          filename: "../escaped.tgz",
        },
      ]),
    ]) {
      const malformed = spawnSync("python3", args, {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${provider}:${process.env.PATH}`,
          PACK_RESPONSE: response,
        },
      });
      assert.notEqual(malformed.status, 0);
      assert.match(
        malformed.stderr,
        /npm pack returned invalid package metadata/,
      );
      assert.match(malformed.stderr, /ACTION:/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the Windows carriers are a .zip and v0.37.0's checksum line, holding the wheel's PE binary byte for byte", () => {
  const scratch = mkdtempSync(join(scratchRoot(), "windows-contract-"));
  try {
    const target = "x86_64-pc-windows-msvc";
    // A structural PE header: MZ, the PE offset, and the AMD64 machine. Never
    // executed; the hosted Windows job installs and runs the real one.
    const fixture = (machine) => {
      const wheel = join(scratch, `w-${machine}.whl`);
      execFileSync("python3", [
        "-c",
        `import struct,zipfile,sys
pe=b'MZ'+b'\\0'*58+struct.pack('<I',64)+b'PE\\0\\0'+struct.pack('<H',int(sys.argv[2]))+b'\\0'*64
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('onepipeline_api_cli-1.0.0.data/scripts/onepipeline-api.exe',pe)
 z.writestr('onepipeline_api_cli-1.0.0.dist-info/METADATA','Name: onepipeline-api-cli\\nVersion: 1.0.0\\n')
 z.writestr('onepipeline_api_cli-1.0.0.dist-info/WHEEL','Wheel-Version: 1.0\\nTag: py3-none-win_amd64\\n')`,
        wheel,
        String(machine),
      ]);
      return wheel;
    };
    const args = (wheel) => [
      "scripts/release-package.py",
      "--target",
      target,
      "--wheel",
      wheel,
      "--out",
      scratch,
      "--tag",
      "v1.0.0",
    ];
    execFileSync("python3", args(fixture(0x8664)), { stdio: "pipe" });
    const stem = `onepipeline-api-v1.0.0-${target}`;
    execFileSync("python3", [
      "-c",
      `import hashlib,sys,zipfile,tarfile,pathlib
root=pathlib.Path(sys.argv[1]); stem=sys.argv[2]
exe=(root/'x86_64-pc-windows-msvc'/'onepipeline-api.exe').read_bytes()
with zipfile.ZipFile(root/'assets'/(stem+'.zip')) as z:
 assert sorted(z.namelist()) == ['CHANGELOG.md','LICENSE','README.md','onepipeline-api.exe']
 assert z.read('onepipeline-api.exe') == exe
line=(root/'assets'/(stem+'.sha256')).read_text()
assert line == hashlib.sha256((root/'assets'/(stem+'.zip')).read_bytes()).hexdigest()+' *'+stem+'.zip\\n', line
with tarfile.open(root/'npm-artifacts'/'onepipeline-api-cli-win32-x64-1.0.0.tgz') as t:
 assert t.extractfile('package/bin/onepipeline-api.exe').read() == exe
`,
      scratch,
      stem,
    ]);
    // An ARM64 PE handed in as the x64 target is refused.
    const arm = spawnSync("python3", args(fixture(0xaa64)), {
      encoding: "utf8",
    });
    assert.notEqual(arm.status, 0);
    assert.match(arm.stderr, /declared Windows architecture/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("production packaging commands reject unsupported targets and malformed versions with next actions", () => {
  for (const [args, message] of [
    [[".", "unrecognized-target", "1.0.0"], /unsupported staged target/],
    [[".", "x86_64-apple-darwin", "1.0.0"], /unsupported staged target/],
    [[".", "aarch64-unknown-linux-gnu", "1.0.0"], /unsupported staged target/],
    [[".", "aarch64-apple-darwin", "bad-version"], /invalid release version/],
    [
      ["package.json", "aarch64-apple-darwin", "1.0.0"],
      /ROOT is not a directory/,
    ],
  ]) {
    const result = spawnSync(
      "node",
      ["scripts/verify-staged-release.mjs", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /ACTION:/);
  }
});

test("all producer and installer target declarations match the release targets", () => {
  const targets = Object.keys(TARGETS).sort();
  const npmSource = readFileSync("scripts/npm-build.mjs", "utf8");
  const npmTargets = Function(
    `return (${npmSource.match(/const TARGETS = (\{[\s\S]*?\n\});/)[1]})`,
  )();
  assert.deepEqual(Object.keys(npmTargets).sort(), targets);
  const wheelTargets = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import runpy,json; print(json.dumps(runpy.run_path('scripts/release-package.py')['TARGET_ARCHES']))",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(Object.keys(wheelTargets).sort(), targets);
  const launcher = JSON.parse(
    readFileSync("npm/onepipeline-api-cli/package.json", "utf8"),
  );
  for (const target of targets) {
    const { platform, arch } = npmTargets[target];
    assert.equal(`${platform}-${arch}`, TARGETS[target].npm);
    assert.ok(
      `onepipeline-api-cli-${TARGETS[target].npm}` in
        launcher.optionalDependencies,
      target,
    );
    assert.ok(TARGETS[target].wheelTag.includes(wheelTargets[target]), target);
  }
  assert.equal(
    Object.keys(launcher.optionalDependencies).length,
    targets.length,
  );
});

test("real workflow command usage errors return 2 with an actionable diagnostic", () => {
  for (const [command, args, env] of [
    ["node", [".github/macos-policy.mjs"], {}],
    ["node", [".github/macos-policy.mjs", "classify", "--unknown"], {}],
    ["node", ["scripts/verify-staged-release.mjs"], {}],
    ["node", ["scripts/release.mjs"], {}],
    ["node", ["scripts/release.mjs", "linux"], {}],
    ["node", ["scripts/release.mjs", "linux", "upload", "crate"], {}],
    ["node", ["scripts/release.mjs", "publish", "upload", "pypi"], {}],
    [
      "node",
      ["scripts/release.mjs", "linux", "build", "--version", "1.0.0"],
      {},
    ],
    ["node", ["scripts/release.mjs", "linux", "verify", "--bogus"], {}],
    // Every staging phase deletes --out first, so it is held to target/.
    ["node", ["scripts/release.mjs", "linux", "build", "--out", "."], {}],
    ["node", ["scripts/release.mjs", "publish", "build", "--out", ".."], {}],
    ["node", ["scripts/release.mjs", "linux", "build", "--out", "target"], {}],
    [
      "node",
      ["scripts/release.mjs", "publish", "check"],
      { NPM_PUBLISH: "yes" },
    ],
  ]) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: hermetic(env),
    });
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /ACTION:/);
  }
});

test("an --out that leaves target/ through a symlink is refused before anything is deleted", () => {
  const outside = mkdtempSync(join(scratchRoot(), "symlinked-out-"));
  const link = "target/release-test/escape";
  try {
    mkdirSync("target/release-test", { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(outside, link);
    writeFileSync(join(outside, "keep"), "a file the build must not delete");
    for (const out of [link, `${link}/staging`]) {
      const result = spawnSync(
        "node",
        ["scripts/release.mjs", "linux", "build", "--out", out],
        { encoding: "utf8", env: hermetic() },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /is not a directory under/);
    }
    assert.ok(existsSync(join(outside, "keep")));
  } finally {
    rmSync(link, { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a release tag that is not Cargo.toml's version is refused before anything builds", () => {
  const out = mkdtempSync(join(scratchRoot(), "tag-refusal-"));
  try {
    const result = spawnSync(
      "node",
      [
        "scripts/release.mjs",
        "linux",
        "build",
        "--out",
        "target/release-test/tag-refusal",
      ],
      { encoding: "utf8", env: hermetic({ RELEASE_TAG: "v0.0.1-not-this" }) },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /differs from Cargo.toml/);
    assert.match(result.stderr, /ACTION: build the tag whose version matches/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("no workflow or release declaration still names an Intel macOS target or runner", () => {
  const sources = [
    ...workflows().map((w) => `.github/workflows/${w.file}`),
    "release-targets.toml",
    "npm/onepipeline-api-cli/package.json",
    "npm/onepipeline-api-cli/bin/onepipeline-api.js",
    "scripts/npm-build.mjs",
    "scripts/release-package.py",
    "scripts/verify-staged-release.mjs",
    "rust-toolchain.toml",
  ];
  for (const source of sources) {
    const text = readFileSync(source, "utf8");
    assert.doesNotMatch(text, /x86_64-apple-darwin|macos-[\w.]*-intel/, source);
    // The launcher may name darwin-x64 only to refuse it.
    if (!source.endsWith("onepipeline-api.js"))
      assert.doesNotMatch(text, /darwin-x64/, source);
  }
});

test("real release commands diagnose failed external toolchain setup with next actions", () => {
  const scratch = mkdtempSync(join(scratchRoot(), "toolchain-failure-"));
  try {
    const provider = join(scratch, "rustup");
    mkdirSync(provider);
    writeFileSync(
      join(provider, "rustup"),
      '#!/usr/bin/env bash\necho "toolchain provider unavailable" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      "node",
      [
        "scripts/release.mjs",
        "macos",
        "build",
        "--out",
        "target/release-test/toolchain-failure",
      ],
      {
        encoding: "utf8",
        env: hermetic({ PATH: `${provider}:${process.env.PATH}` }),
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /rustup target add failed/);
    assert.match(result.stderr, /ACTION: confirm the pinned toolchain/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The journeys above once failed on a pull-request runner, whose
// GITHUB_REF_NAME is `<n>/merge`, by reaching the release-tag check instead of
// the case under test. Re-run them as a child under that same runner context.
test("release command journeys hold under a pull-request runner's ref context", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      "^real (workflow command usage errors|release commands diagnose failed external toolchain setup)",
      ".github/tests/release.test.mjs",
    ],
    {
      encoding: "utf8",
      env: {
        // Without the parent runner's context the child reports on stdout.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "NODE_TEST_CONTEXT",
          ),
        ),
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/315/merge",
        GITHUB_REF_NAME: "315/merge",
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# pass 2$/m);
});
