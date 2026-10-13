import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflows } from "../workflow-graph.mjs";

const release = () =>
  workflows().find((w) => w.file === "release.yml").document;

// The release scripts read the Actions ref they run under. A journey inherits
// whatever runner it happens on — on a pull request that is `<n>/merge` — so
// every command spawned here gets an environment without the runner's GITHUB_*
// context, plus only what the case sets.
const scratchRoot = () => process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir();
const hermetic = (extra = {}) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_")),
  ),
  ...extra,
});
test("all release platforms retain archive, wheel and npm producers; Darwin publishes verified bytes on Linux", () => {
  const jobs = release().jobs;
  const launcher = JSON.parse(
    readFileSync("npm/onepipeline-api-cli/package.json", "utf8"),
  );
  const targets = jobs["build-npm"].strategy.matrix.include.map(
    (row) => row.target,
  );
  // Apple Silicon is the one Darwin release; Intel macOS is discontinued.
  assert.equal(jobs.darwin.env.DARWIN_TARGETS, "aarch64-apple-darwin");
  targets.push("aarch64-apple-darwin");
  assert.equal(
    targets.length,
    Object.keys(launcher.optionalDependencies).length,
  );
  for (const job of ["upload", "build-wheels"])
    assert.deepEqual(
      jobs[job].strategy.matrix.include.map((row) => row.target).sort(),
      targets.filter((t) => !t.includes("darwin")).sort(),
    );
  assert.ok(jobs["publish-pypi"].needs.includes("darwin"));
  assert.ok(jobs["publish-npm"].needs.includes("darwin"));
  assert.equal(jobs["upload-darwin"]["runs-on"], "ubuntu-latest");
  assert.deepEqual(jobs["upload-darwin"].needs, "darwin");
  const commands = jobs.darwin.steps.map((s) => s.run || "").join("\n");
  assert.match(commands, /just build/);
  assert.match(commands, /release-darwin.sh/);
  assert.match(commands, /CycloneDX|cargo cyclonedx/);
  for (const target of targets.filter((t) => t.includes("darwin")))
    assert.ok(
      commands.includes(`verify-staged-release.mjs darwin-dist ${target}`),
    );
  assert.doesNotMatch(commands, /rosetta/i);
  for (const step of jobs.darwin.steps)
    assert.notEqual(step.with?.architecture, "x64", JSON.stringify(step));
  const names = jobs.darwin.steps
    .filter((s) => s.uses === "actions/upload-artifact@v4")
    .map((s) => s.with.name);
  assert.deepEqual(names.sort(), [
    "darwin-assets",
    "darwin-reuse",
    "npm-darwin",
    "wheels-darwin",
  ]);
  const builder = readFileSync("scripts/release-darwin.sh", "utf8");
  assert.equal((builder.match(/maturin build/g) || []).length, 1);
  assert.doesNotMatch(builder, /cargo build/);
  assert.match(builder, /--features bundled-ui/);
});

test("Darwin artifact contracts preserve wheel bytes and reject an architecture mismatch without executing them", () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "darwin-contract-",
    ),
  );
  try {
    for (const target of release().jobs.darwin.env.DARWIN_TARGETS.split(
      /\s+/,
    )) {
      // A structural Mach-O fixture exercises the carrier boundary. It is never
      // executed; native installs remain the hosted Mac job's proof.
      assert.equal(target, "aarch64-apple-darwin");
      const arch = "arm64";
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
      const wheel = fixture(0x0100000c, arch);
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
      assert.ok(record.archive.includes(`${target}.tar.gz`));
      assert.ok(record.npm.includes("darwin-arm64"));
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
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("production packaging commands reject unsupported targets and malformed versions with next actions", () => {
  for (const [args, message] of [
    [[".", "unrecognized-target", "1.0.0"], /unsupported staged target/],
    [[".", "x86_64-apple-darwin", "1.0.0"], /unsupported staged target/],
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
  const unknown = spawnSync(
    "python3",
    [
      "scripts/release-package.py",
      "--target",
      "unknown",
      "--wheel",
      "missing.whl",
      "--out",
      ".",
      "--tag",
      "v1.0.0",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /invalid choice/);
  assert.match(unknown.stderr, /ACTION:/);
});

test("all producer and installer target declarations match the actual release matrix", () => {
  const jobs = release().jobs;
  const targets = [
    ...jobs["build-npm"].strategy.matrix.include.map((row) => row.target),
    ...jobs.darwin.env.DARWIN_TARGETS.split(/\s+/),
  ].sort();
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
  for (const target of targets) {
    const { platform, arch } = npmTargets[target];
    assert.equal(
      wheelTargets[target],
      arch === "x64"
        ? platform === "win32"
          ? "amd64"
          : "x86_64"
        : platform === "darwin"
          ? "arm64"
          : "aarch64",
    );
  }
  const installer = readFileSync("scripts/verify-staged-release.mjs", "utf8");
  const allowed = JSON.parse(
    installer
      .match(/const allowed = (\[[\s\S]*?\n {2}\]);/)[1]
      .replace(/,\s*]/, "]"),
  );
  assert.deepEqual(
    allowed.sort(),
    targets.filter((target) => !npmTargets[target].exe),
  );
});

test("real workflow command usage errors return 2 with an actionable diagnostic", () => {
  for (const [command, args, env] of [
    ["node", [".github/macos-policy.mjs"], {}],
    ["node", [".github/macos-policy.mjs", "classify", "--unknown"], {}],
    ["node", ["scripts/verify-staged-release.mjs"], {}],
    ["bash", ["scripts/release-darwin.sh"], {}],
    ["bash", ["scripts/release-native-dry-run.sh"], {}],
    [
      "bash",
      ["scripts/release-darwin.sh", scratchRoot()],
      { DARWIN_TARGETS: "" },
    ],
  ]) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: hermetic(env),
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /ACTION:/);
  }
});

test("the Darwin builder refuses the discontinued Intel macOS target before compiling", () => {
  const out = mkdtempSync(join(scratchRoot(), "intel-refusal-"));
  try {
    const result = spawnSync("bash", ["scripts/release-darwin.sh", out], {
      encoding: "utf8",
      env: hermetic({ DARWIN_TARGETS: "x86_64-apple-darwin" }),
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Intel macOS is no longer released/);
    assert.match(
      result.stderr,
      /ACTION: set DARWIN_TARGETS to aarch64-apple-darwin/,
    );
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
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "toolchain-failure-",
    ),
  );
  try {
    for (const [script, tool, expected] of [
      [
        "scripts/release-darwin.sh",
        "rustup",
        /confirm the pinned Rust toolchain/,
      ],
      [
        "scripts/release-native-dry-run.sh",
        "python3",
        /install Python with venv support/,
      ],
    ]) {
      const provider = join(scratch, tool);
      mkdirSync(provider);
      writeFileSync(
        join(provider, tool),
        '#!/usr/bin/env bash\necho "toolchain provider unavailable" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const result = spawnSync("bash", [script, join(scratch, "out")], {
        encoding: "utf8",
        env: hermetic({
          PATH: `${provider}:${process.env.PATH}`,
          DARWIN_TARGETS: "aarch64-apple-darwin",
        }),
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /failed/);
      assert.match(result.stderr, /ACTION:/);
      assert.match(result.stderr, expected);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The two journeys above failed on a pull-request runner, whose GITHUB_REF_NAME
// is `<n>/merge`, by reaching the release-tag check instead of the case under
// test. Re-run them as a child under that same runner context.
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
