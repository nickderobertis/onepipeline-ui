// The coverage tiers against real Nx in a scratch copy of this repository's graph.
//
// Nx, every tier's declared inputs and outputs, the real `just _crate-coverage`,
// `scripts/coverage-tiers.mjs` and `scripts/coverage-merge.mjs` run for real, and each
// tool version is the real one read through the real `scripts/coverage-unit.sh`. Only
// the instrumented tests are stood in for (`coverage-tier-double.mjs`), since what these
// journeys ask is whether a report is served or re-made, and which reports reach the floor.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";
import { compiledFromRoots, compiledReads } from "./rust-compile-reads.mjs";

const TIERS = {
  unit: ["onepipeline-ui", "project.json"],
  e2e: ["onepipeline-ui-e2e", "tests/tiers/e2e/project.json"],
  "repo-tooling": [
    "onepipeline-ui-repo-tooling",
    "tests/tiers/repo-tooling/project.json",
  ],
  "npm-launcher": [
    "onepipeline-ui-npm-launcher",
    "tests/tiers/npm-launcher/project.json",
  ],
  versions: ["onepipeline-ui-versions", "tests/tiers/versions/project.json"],
};
const NAMES = Object.keys(TIERS);
const DOUBLE = resolve(".github/tests/nx-cache/coverage-tier-double.mjs");

// `covered` lines of `total` in one file, numbered from `first`.
const lcovBlock = (file, covered, total, first = 1) => {
  const lines = [`SF:${file}`];
  for (let i = 0; i < total; i += 1)
    lines.push(`DA:${first + i},${i < covered ? 1 : 0}`);
  return `${lines.join("\n")}\nend_of_record\n`;
};
// A report per tier over one shared file and one of its own.
const passingReports = (extraMissed = 0) =>
  Object.fromEntries(
    NAMES.map((tier, at) => [
      tier,
      lcovBlock("src/shared.rs", 2000, 2000) +
        lcovBlock(`src/${tier}.rs`, 100 - (at === 0 ? extraMissed : 0), 100),
    ]),
  );

// The line-wise union of a set of LCOV files, by this test's own reader.
function readUnion(dir, tiers) {
  const files = new Map();
  for (const tier of tiers) {
    let current = null;
    for (const line of readFileSync(join(dir, `${tier}.lcov`), "utf8").split(
      "\n",
    )) {
      if (line.startsWith("SF:")) {
        current = files.get(line.slice(3)) ?? new Map();
        files.set(line.slice(3), current);
      } else if (line.startsWith("DA:")) {
        const [number, count] = line.slice(3).split(",");
        current.set(
          Number(number),
          (current.get(Number(number)) ?? false) || Number(count) > 0,
        );
      }
    }
  }
  let covered = 0;
  let total = 0;
  const uncovered = {};
  for (const [file, lines] of files)
    for (const [number, hit] of lines) {
      total += 1;
      if (hit) covered += 1;
      else {
        uncovered[file] = uncovered[file] ?? [];
        uncovered[file].push(number);
      }
    }
  for (const numbers of Object.values(uncovered)) numbers.sort((a, b) => a - b);
  return { covered, total, uncovered };
}

// What `coverage-merge.mjs` printed, read back into the same shape.
function printedUnion(stdout) {
  const value = (label) =>
    Number(new RegExp(`${label}: (\\d+)`).exec(stdout)[1]);
  const uncovered = {};
  const at = stdout.indexOf("Uncovered lines:");
  if (at >= 0)
    for (const line of stdout.slice(at).split("\n").slice(1)) {
      const match = /^(\S+): ([\d,]+)$/.exec(line);
      if (match) uncovered[match[1]] = match[2].split(",").map(Number);
    }
  return {
    covered: value("lines covered"),
    total: value("lines total"),
    uncovered,
  };
}

function coverageFixture(reports = passingReports()) {
  const cwd = workspaceFixture();
  const doubles = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "coverage-double-",
    ),
  );
  const fixture = {
    cwd,
    doubles,
    log: join(doubles, "ran.log"),
    remove() {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(doubles, { recursive: true, force: true });
    },
    setReports(next) {
      for (const [tier, text] of Object.entries(next))
        writeFileSync(join(doubles, `${tier}.lcov`), text);
    },
  };
  fixture.setReports(reports);
  for (const [tier, [, file]] of Object.entries(TIERS)) {
    const path = join(cwd, file);
    const project = JSON.parse(readFileSync(path, "utf8"));
    const target = project.targets.test;
    target.command = `node ${DOUBLE} ${tier}`;
    delete target.dependsOn;
    writeFileSync(path, JSON.stringify(project, null, 2));
  }
  execFileSync("git", ["add", "."], { cwd });
  return fixture;
}

// One run of the real aggregate, parsed from Nx's own per-task and summary output.
function runCoverage(fixture, extraEnv = {}) {
  const { cwd, doubles, log } = fixture;
  rmSync(log, { force: true });
  // One per fixture: Nx keeps the cache's metadata here, and outside the checkout because
  // the key hashes everything under it that git does not ignore.
  const workspaceData = join(doubles, "nx-data");
  mkdirSync(workspaceData, { recursive: true });
  const done = spawnSync(
    join(cwd, "node_modules/.bin/nx"),
    [
      "run",
      "onepipeline-ui-coverage:coverage",
      "--outputStyle=static",
      "--parallel=5",
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        // Under the suite's own Nx run, its cache and task identity must not reach these.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith("NX_"),
          ),
        ),
        NX_DAEMON: "false",
        NX_ISOLATE_PLUGINS: "false",
        NX_TUI: "false",
        CI: "true",
        NX_WORKSPACE_DATA_DIRECTORY: workspaceData,
        COVERAGE_TIER_DOUBLE_DIR: doubles,
        COVERAGE_TIER_DOUBLE_LOG: log,
        ...extraEnv,
      },
    },
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Nx styles its summary with ANSI.
  const output = (done.stdout + done.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const replayed = NAMES.filter((tier) =>
    new RegExp(
      `nx run ${TIERS[tier][0]}:test\\s+\\[(local cache|remote cache|existing outputs match the cache, left as is)\\]`,
    ).test(output),
  );
  return {
    status: done.status,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: as above.
    stdout: done.stdout.replace(/\x1b\[[0-9;]*m/g, ""),
    output,
    replayed,
    executed: NAMES.filter((tier) => !replayed.includes(tier)),
  };
}

function assertRun(run, { executed }, label) {
  assert.equal(run.status, 0, `${label}: the run failed\n${run.output}`);
  assert.deepEqual(
    [...run.executed].sort(),
    [...executed].sort(),
    `${label}: the tiers Nx executed differ from the tiers that read it\n${run.output}`,
  );
}

// Nx keeps a file's hash while its whole-second mtime stands, so every write claims a
// later second than the last, as an edit a moment later would.
let clock = Date.now() + 10_000;
const stamp = (path) => {
  clock += 2_000;
  utimesSync(path, new Date(clock), new Date(clock));
};
const edit = (cwd, file, change) => {
  const path = join(cwd, file);
  const original = readFileSync(path);
  const changed = change(original.toString());
  assert.notEqual(
    changed,
    original.toString(),
    `${file}: the probe edits nothing`,
  );
  writeFileSync(path, changed);
  stamp(path);
  return () => {
    writeFileSync(path, original);
    stamp(path);
  };
};
const appendLine = (text) => `${text}\n`;
const REUSED = [];

// Edit `file`, assert exactly `executed` re-run, restore, and assert every tier replays.
function probeFile(fixture, file, change, executed) {
  const restore = edit(fixture.cwd, file, change);
  try {
    assertRun(runCoverage(fixture), { executed }, `editing ${file}`);
  } finally {
    restore();
  }
  assertRun(runCoverage(fixture), { executed: REUSED }, `restoring ${file}`);
}

test("a tier replays until something its run reads changes, and only those tiers re-run", () => {
  const fixture = coverageFixture();
  try {
    assertRun(runCoverage(fixture), { executed: NAMES }, "the first run");
    assertRun(runCoverage(fixture), { executed: REUSED }, "nothing changed");
    probeFile(fixture, "docs/dag-ui.md", appendLine, REUSED);
    // One tier's own test source.
    probeFile(
      fixture,
      "tests/tiers/repo-tooling/project.json",
      (text) => text.replace('"lang:rust"', '"lang:rust", "probe"'),
      ["repo-tooling"],
    );
    for (const [file, change] of [
      ["src/lib.rs", appendLine],
      ["apps/dag-ui/src/main.tsx", appendLine],
      [
        "Cargo.lock",
        (text) =>
          text.replace(/(name = "onepipeline"\nversion = ")[^"]+/, "$1999.0.0"),
      ],
      ["rust-toolchain.toml", appendLine],
      [
        ".github/ci-tool-versions",
        (text) => text.replace(/^cargo-llvm-cov=.*$/m, "cargo-llvm-cov=9.9.9"),
      ],
      [
        ".github/ci-tool-versions",
        (text) => text.replace(/^nextest=.*$/m, "nextest=9.9.9"),
      ],
    ])
      probeFile(fixture, file, change, NAMES);
    // The version alone: only the tiers that compare its value keep it in their key.
    const bump = (text) =>
      text.replace(/^version = "[^"]+"/m, 'version = "9.9.9"');
    const undo = edit(fixture.cwd, "Cargo.toml", bump);
    const undoLock = edit(fixture.cwd, "Cargo.lock", (text) =>
      text.replace(/(name = "onepipeline-ui"\nversion = ")[^"]+/, "$19.9.9"),
    );
    try {
      assertRun(
        runCoverage(fixture),
        { executed: ["npm-launcher", "versions"] },
        "a version-only bump",
      );
    } finally {
      undo();
      undoLock();
    }
    assertRun(
      runCoverage(fixture),
      { executed: REUSED },
      "restoring the version",
    );
  } finally {
    fixture.remove();
  }
});

// A wrapper early on PATH that answers `--version`-style reads differently and passes
// everything else to the real tool, as a host with another build of it would.
function versionWrapper(dir, name, realPath, detect) {
  const body = `#!/usr/bin/env bash
if ${detect}; then echo "${name} wrapped-version-probe"; exit 0; fi
exec "${realPath}" "$@"
`;
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
function realTool(name) {
  return execFileSync("bash", ["-c", `command -v ${name}`], {
    encoding: "utf8",
  }).trim();
}
const sysrootTool = (name) => {
  const root = execFileSync("rustc", ["--print", "sysroot"], {
    encoding: "utf8",
  }).trim();
  const host = /host: (\S+)/.exec(
    execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
  )[1];
  return join(root, "lib/rustlib", host, "bin", name);
};

const ENV_INPUTS = [
  "COVERAGE_UNIT_IGNORE_REGEX",
  "LLVM_PROFDATA",
  "LLVM_COV",
  "RUSTFLAGS",
  "UPDATE_CONTRACT_FIXTURES",
];
// Each non-file input, as a function building the env that changes it, with what it moves.
function toolInputs(wrapDir) {
  const path = (name) => join(wrapDir, name);
  return [
    [
      "rustc",
      () =>
        versionWrapper(wrapDir, "rustc", realTool("rustc"), '[ "$1" = -vV ]'),
    ],
    [
      "cargo-llvm-cov",
      () =>
        versionWrapper(
          wrapDir,
          "cargo",
          realTool("cargo"),
          '[ "$1 $2" = "llvm-cov --version" ]',
        ),
    ],
    [
      "cargo-nextest",
      () =>
        versionWrapper(
          wrapDir,
          "cargo",
          realTool("cargo"),
          '[ "$1 $2" = "nextest --version" ]',
        ),
    ],
    [
      "llvm-profdata",
      () =>
        versionWrapper(
          wrapDir,
          "llvm-profdata",
          sysrootTool("llvm-profdata"),
          '[ "$1" = --version ]',
        ),
    ],
    [
      "llvm-cov",
      () =>
        versionWrapper(
          wrapDir,
          "llvm-cov",
          sysrootTool("llvm-cov"),
          '[ "$1" = --version ]',
        ),
    ],
    [
      "llvm-readobj",
      () =>
        versionWrapper(
          wrapDir,
          "llvm-readobj",
          sysrootTool("llvm-readobj"),
          '[ "$1" = --version ]',
        ),
    ],
    [
      "the platform",
      () => {
        writeFileSync(
          path("node"),
          `#!/usr/bin/env bash
if [ "$1 $2" = "-p process.platform" ]; then echo probed-platform; exit 0; fi
exec "${process.execPath}" "$@"
`,
        );
        chmodSync(path("node"), 0o755);
      },
    ],
  ];
}

function assertNonFileInputMoves(fixture, label, env, baseEnv = {}) {
  const changed = runCoverage(fixture, { ...baseEnv, ...env });
  assert.equal(changed.status, 0, changed.output);
  const replayed = changed.replayed;
  if (replayed.length)
    throw new Error(
      `${replayed.join(", ")} replayed from the cache after ${label} changed, so ${label} is not in their key`,
    );
  assertRun(
    runCoverage(fixture, baseEnv),
    { executed: REUSED },
    `restoring ${label}`,
  );
}

test("every non-file input moves the tiers whose keys name it", () => {
  const fixture = coverageFixture();
  try {
    assertRun(runCoverage(fixture), { executed: NAMES }, "the first run");
    for (const name of ENV_INPUTS)
      assertNonFileInputMoves(fixture, name, { [name]: "/probe" });
    const wrapDir = mkdtempSync(join(fixture.doubles, "wrap-"));
    const onPath = { PATH: `${wrapDir}:${process.env.PATH}` };
    for (const [label, install] of toolInputs(wrapDir)) {
      install();
      assertNonFileInputMoves(fixture, label, onPath);
      for (const name of readdirSync(wrapDir)) rmSync(join(wrapDir, name));
    }
    // Negative control: with one input out of the key, the same change replays.
    const nx = readFileSync(join(fixture.cwd, "nx.json"), "utf8");
    writeFileSync(
      join(fixture.cwd, "nx.json"),
      nx.replace(/\s*\{\s*"env":\s*"RUSTFLAGS"\s*\},/, ""),
    );
    runCoverage(fixture);
    assert.throws(
      () =>
        assertNonFileInputMoves(fixture, "RUSTFLAGS", { RUSTFLAGS: "/probe" }),
      /replayed from the cache after RUSTFLAGS changed/,
    );
    writeFileSync(join(fixture.cwd, "nx.json"), nx);
  } finally {
    fixture.remove();
  }
});

// Everything one tier's journeys can open, read off the sources that decide them.
const COMMENT = /^\s*(\/\/|#)/;
const stripComments = (text) =>
  text
    .split("\n")
    .filter((line) => !COMMENT.test(line))
    .join("\n");
// A crate-root file's `mod`s, each to the file it reads.
function declaredModules(cwd, rootFile) {
  const text = readFileSync(join(cwd, rootFile), "utf8");
  const dir = rootFile.slice(0, rootFile.lastIndexOf("/") + 1);
  const modules = new Map();
  for (const match of text.matchAll(
    /(?:#\[path = "([^"]+)"\]\s*(?:#\[[^\n]*\]\s*)*)?(?:pub )?mod (\w+);/g,
  )) {
    modules.set(
      match[2],
      match[1]
        ? join(dir, match[1]).replace(/\\/g, "/")
        : `${dir}${match[2]}.rs`,
    );
  }
  return modules;
}
// The test modules one tier's nextest profile selects, and every helper they reach.
function tierModules(cwd, tier) {
  const toml = readFileSync(join(cwd, ".config/nextest.toml"), "utf8");
  const filter = new RegExp(
    `\\[profile\\.${tier}\\]\\ndefault-filter = "(.*)"`,
  ).exec(toml)[1];
  const roots = tier === "unit" ? ["tests/contract.rs"] : ["tests/e2e/main.rs"];
  if (/(?<!not )binary\(=packaging\)/.test(filter))
    roots.push("tests/packaging.rs");
  const declared = new Map();
  for (const root of roots)
    for (const [name, file] of declaredModules(cwd, root))
      declared.set(name, file);
  const named = (pattern) => pattern.split("|").filter(Boolean);
  const excluded = new Set(
    [...filter.matchAll(/not test\(\/\^\(([^)]*)\)::\//g)].flatMap((m) =>
      named(m[1]),
    ),
  );
  const included = [...filter.matchAll(/test\(\/\^\(([^)]*)\)::\//g)]
    .filter((m) => !filter.slice(0, m.index).endsWith("not "))
    .flatMap((m) => named(m[1]));
  const start =
    tier === "e2e"
      ? [...declared.keys()].filter(
          (name) =>
            !excluded.has(name) && declared.get(name).startsWith("tests/e2e/"),
        )
      : tier === "unit"
        ? [...declared.keys()]
        : included;
  const files = new Set(roots);
  const pending = [...start];
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name) || !declared.has(name)) continue;
    seen.add(name);
    const file = declared.get(name);
    files.add(file);
    if (!existsSync(join(cwd, file))) continue;
    for (const match of readFileSync(join(cwd, file), "utf8").matchAll(
      /(?:crate|support)::(\w+)/g,
    ))
      pending.push(match[1]);
  }
  return [...files];
}

// Files the journeys only name as an edit to their scratch copy, never reading its bytes.
const NAMED_AS_A_SCRATCH_EDIT = {
  has: (path) =>
    /^docs\/(screens\/|dag-ui\.md$|linux-cold-cache-timing\.md$)/.test(path),
};

// A journey that names a directory at least two levels deep can read anything under it.
const namedDirectory = (text, candidate) => {
  const parts = candidate.split("/").slice(0, -1);
  return parts.some(
    (_, at) => at >= 1 && text.includes(`${parts.slice(0, at + 1).join("/")}/`),
  );
};
// Manifests reach a key through their version-free digests rather than as files, and a
// release's changelog through the `git hash-object` input of the tier that packs it.
const DIGESTED =
  /(^|\/)(Cargo\.toml|Cargo\.lock|package\.json|bun\.lock|pyproject\.toml|uv\.lock|CHANGELOG\.md)$/;
// Every tracked file a tier's build or journeys can reach that its task hash does not
// cover: what compiling the crate reads, whichever tests its profile then selects; what
// its test modules name, conditional paths included; and what a script they name names.
function uncoveredReads(cwd, tier, keyed) {
  const tracked = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const modules = tierModules(cwd, tier);
  const missing = new Set();
  const compiled = compiledReads(cwd);
  assert.deepEqual(
    compiled.unresolved,
    [],
    "an include naming no fixed path hides what the build reads from every key",
  );
  const trackedSet = new Set(tracked);
  for (const file of [...compiled.files, ...COMPILE_CONFIGURATION])
    if (trackedSet.has(file) && !DIGESTED.test(file) && !keyed.has(file))
      missing.add(`${file} (compiled by the tier's build)`);
  const scan = (file) => {
    const text = stripComments(readFileSync(join(cwd, file), "utf8"));
    const scripts = [];
    for (const candidate of tracked) {
      const named = text.includes(candidate) || namedDirectory(text, candidate);
      if (!named || NAMED_AS_A_SCRATCH_EDIT.has(candidate)) continue;
      if (DIGESTED.test(candidate)) continue;
      if (!keyed.has(candidate)) missing.add(`${candidate} (named by ${file})`);
      else if (/^scripts\/[^/]+\.(sh|mjs|py)$/.test(candidate))
        scripts.push(candidate);
    }
    return scripts;
  };
  for (const script of new Set(modules.flatMap(scan)))
    if (!modules.includes(script)) scan(script);
  return [...missing].sort();
}

// What cargo and rustc read beside the sources, whichever target they build.
const COMPILE_CONFIGURATION = [".cargo/config.toml", "rust-toolchain.toml"];

// Every tracked file a tier's key hashes: Nx's file inputs and the coverage digest's list.
function keyedFiles(cwd) {
  const ids = NAMES.map((tier) => `${TIERS[tier][0]}:test`);
  const hashes = taskHashes(cwd, ids);
  return Object.fromEntries(
    NAMES.map((tier) => {
      const inputs = hashes[`${TIERS[tier][0]}:test`].inputs;
      const groups = [
        ...JSON.stringify(inputs.runtime ?? {}).matchAll(
          /coverage-tier-key\.mjs (\S+?)["\\]/g,
        ),
      ].map((match) => match[1]);
      assert.equal(groups.length, 1, `${tier} hashes no coverage digest`);
      const listed = execFileSync(
        "node",
        ["scripts/coverage-tier-key.mjs", groups[0], "--list"],
        { cwd, encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean);
      return [tier, new Set([...inputs.files, ...listed])];
    }),
  );
}

test("the coverage digest tells a missing file from an empty one", () => {
  const cwd = workspaceFixture();
  const digest = () =>
    execFileSync("node", ["scripts/coverage-tier-key.mjs", "base"], {
      cwd,
      encoding: "utf8",
    }).trim();
  try {
    const before = digest();
    const file = join(cwd, "docs/contract.md");
    const original = readFileSync(file);
    writeFileSync(file, "");
    const empty = digest();
    assert.notEqual(empty, before, "an emptied file must move the digest");
    rmSync(file);
    assert.notEqual(
      digest(),
      empty,
      "a vanished file must not read like an empty one",
    );
    writeFileSync(file, original);
    assert.equal(digest(), before, "restoring the file restores the digest");
    // A tiers file with a malformed target definition is refused with its next step.
    const project = join(cwd, "tests/tiers/e2e/project.json");
    const text = readFileSync(project, "utf8");
    writeFileSync(project, JSON.stringify({ name: "x", targets: [] }));
    const refused = spawnSync("node", ["scripts/coverage-tiers.mjs"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /ACTION: run from the repository root/);
    writeFileSync(project, text);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("every workspace file a tier can read is covered by its task hash", () => {
  const fixture = coverageFixture();
  const { cwd } = fixture;
  try {
    const keyed = keyedFiles(cwd);
    const always = [
      "Cargo.lock",
      "rust-toolchain.toml",
      ".github/ci-tool-versions",
      "apps/dag-ui/src/main.tsx",
      "scripts/coverage-unit.sh",
      "scripts/coverage-merge.mjs",
      "justfile",
    ];
    for (const tier of NAMES) {
      for (const file of always)
        assert.ok(
          keyed[tier].has(file) || file === "Cargo.lock",
          `${tier} does not hash ${file}`,
        );
      assert.deepEqual(
        uncoveredReads(cwd, tier, keyed[tier]),
        [],
        `${tier} can read files its task hash does not cover`,
      );
    }
    // Cargo.lock reaches every key through its version-free digest.
    const hashes = taskHashes(cwd, ["onepipeline-ui-e2e:test"]);
    assert.ok(
      JSON.stringify(hashes["onepipeline-ui-e2e:test"].inputs.runtime).includes(
        "--ecosystem cargo",
      ),
      "the crate's manifests and lock are not in the key",
    );
    // Negative: a file only repo-tooling's journeys read; out of its key it is named.
    const fixturePath = "pool-maintenance/measure.sh";
    const key = join(cwd, "scripts/coverage-tier-key.mjs");
    const script = readFileSync(key, "utf8");
    writeFileSync(
      key,
      script.replace(
        "const NEVER_READ = [",
        `const NEVER_READ = [\n  /^${fixturePath.replaceAll("/", "\\/").replaceAll(".", "\\.")}$/,`,
      ),
    );
    const narrowed = keyedFiles(cwd);
    assert.ok(!narrowed["repo-tooling"].has(fixturePath));
    const reported = uncoveredReads(
      cwd,
      "repo-tooling",
      narrowed["repo-tooling"],
    );
    assert.ok(
      reported.some((line) => line.startsWith(`${fixturePath} `)),
      `the read left out of the key is not reported: ${reported}`,
    );
    writeFileSync(key, script);
    // Back in its key, editing it re-runs that tier and replays the rest.
    assertRun(runCoverage(fixture), { executed: NAMES }, "the first run");
    probeFile(fixture, fixturePath, appendLine, ["repo-tooling"]);
  } finally {
    fixture.remove();
  }
});

test("dropping a file only the compiler reads from a tier's inputs is refused, and restoring it moves that tier's key", () => {
  const cwd = workspaceFixture();
  const file = "src/encoding.rs";
  const id = `${TIERS.unit[0]}:test`;
  const hashOfUnit = () => taskHashes(cwd, [id])[id].hash;
  const editSource = () => {
    const path = join(cwd, file);
    const original = readFileSync(path);
    writeFileSync(path, `${original}\n// probe\n`);
    stamp(path);
    return () => {
      writeFileSync(path, original);
      stamp(path);
    };
  };
  const nxPath = join(cwd, "nx.json");
  const keyPath = join(cwd, "scripts/coverage-tier-key.mjs");
  const projectPath = join(cwd, "project.json");
  const originals = [nxPath, keyPath, projectPath].map((path) => [
    path,
    readFileSync(path, "utf8"),
  ]);
  try {
    assert.ok(
      compiledReads(cwd).files.includes(file),
      `${file} is compiled into the crate, so the walk must find it`,
    );
    // Out of the digest every tier shares, and out of the unit tier's Nx file inputs.
    writeFileSync(
      keyPath,
      originals[1][1].replace(
        "const NEVER_READ = [",
        "const NEVER_READ = [\n  /^src\\/encoding\\.rs$/,",
      ),
    );
    const project = JSON.parse(originals[2][1]);
    project.targets.test.inputs.push(`!{workspaceRoot}/${file}`);
    writeFileSync(projectPath, JSON.stringify(project, null, 2));
    const narrowed = keyedFiles(cwd);
    assert.equal(narrowed.unit.has(file), false, "the probe narrowed nothing");
    assert.ok(
      uncoveredReads(cwd, "unit", narrowed.unit).includes(
        `${file} (compiled by the tier's build)`,
      ),
      `dropping ${file} from unit's inputs is not refused`,
    );
    // The finding is the real hole: the narrowed key does not see the edit.
    const narrowedHash = hashOfUnit();
    let restoreSource = editSource();
    assert.equal(hashOfUnit(), narrowedHash);
    restoreSource();
    // Back in its inputs, the same edit moves the key and nothing is refused.
    for (const [path, text] of originals) writeFileSync(path, text);
    const restored = keyedFiles(cwd);
    assert.ok(restored.unit.has(file));
    assert.deepEqual(uncoveredReads(cwd, "unit", restored.unit), []);
    const hash = hashOfUnit();
    restoreSource = editSource();
    assert.notEqual(hashOfUnit(), hash, `editing ${file} left unit's key`);
    restoreSource();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the compile walk reads exactly what rustc reads", () => {
  const root = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "compile-walk-"),
  );
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  // Every way a crate reaches a file; each of the decoys names one nothing compiles.
  write(
    "src/lib.rs",
    `#![doc = include_str!("../README.md")]
// mod commented;
/* mod block_commented; include_str!("../decoy.txt"); */
pub const WRITTEN: &str = r#"mod in_a_raw_string; include_str!("../decoy.txt")"#;
pub const QUOTED: &str = "include_bytes!(\\"../decoy.txt\\")";
pub const LIFETIME: &'static str = include_str!(
    "data/multi-line.txt"
);
pub const FROM_ROOT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/rooted.txt"));
pub const BYTES: &[u8] = core::include_bytes!("data/bytes.bin");
pub mod plain;
pub(crate) mod directory;
#[path = "elsewhere/renamed.rs"]
#[allow(dead_code)]
mod attributed;
pub mod inline {
    pub mod inner_file;
    #[path = "by_path.rs"]
    pub mod inner_path;
}
include!("included.rs");
`,
  );
  write("README.md", "read\n");
  write("rooted.txt", "");
  write("src/data/multi-line.txt", "");
  write("src/data/bytes.bin", "");
  write("src/plain.rs", "pub mod child;\n");
  write(
    "src/plain/child.rs",
    'pub const C: &str = include_str!("sibling.txt");\n',
  );
  write("src/plain/sibling.txt", "");
  write("src/directory/mod.rs", "pub mod beside;\n");
  write("src/directory/beside.rs", "");
  write("src/elsewhere/renamed.rs", "pub mod next_to_it;\n");
  write("src/elsewhere/next_to_it.rs", "");
  write("src/inline/inner_file.rs", "");
  write("src/inline/by_path.rs", "");
  write("src/included.rs", "pub mod from_included;\n");
  write("src/from_included.rs", "");
  write("decoy.txt", "");
  const roots = [join(root, "src/lib.rs")];
  try {
    const depInfo = join(root, "out.d");
    execFileSync(
      "rustc",
      [
        "--edition=2021",
        "--crate-type=lib",
        "--crate-name=walked",
        "--emit=dep-info",
        "-o",
        depInfo,
        roots[0],
      ],
      { env: { ...process.env, CARGO_MANIFEST_DIR: root }, stdio: "pipe" },
    );
    const byRustc = [
      ...new Set(
        readFileSync(depInfo, "utf8")
          .split("\n")
          .filter((line) => line.startsWith(root) && line.endsWith(":"))
          .map((line) => normalize(line.slice(root.length + 1, -1))),
      ),
    ].sort();
    assert.ok(byRustc.length >= 10, `rustc listed too little: ${byRustc}`);
    assert.deepEqual(compiledFromRoots(root, roots).files, byRustc);
    // A module another configuration turns on is a read of that tier's build too, and a
    // path no reading can resolve is reported rather than dropped.
    write(
      "src/cfgd.rs",
      `#[cfg(any())] mod off;\nconst X: &str = include_str!(env!("WHERE"));\n`,
    );
    write("src/off.rs", "");
    const walked = compiledFromRoots(root, [join(root, "src/cfgd.rs")]);
    assert.ok(walked.files.includes("src/off.rs"));
    assert.deepEqual(walked.unresolved, ["include_str! in src/cfgd.rs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the merge is exact over the same reports, cached or fresh", () => {
  const fixture = coverageFixture({
    unit:
      lcovBlock("src/shared.rs", 900, 1000) + lcovBlock("src/unit.rs", 90, 100),
    e2e: lcovBlock("src/shared.rs", 950, 1000),
    "repo-tooling": lcovBlock("src/other.rs", 5, 10),
    "npm-launcher": lcovBlock("src/shared.rs", 10, 1000),
    versions: lcovBlock("src/ver.rs", 8, 8),
  });
  const { cwd } = fixture;
  try {
    const first = runCoverage(fixture);
    assert.equal(
      first.status,
      1,
      `below the floor must exit 1\n${first.output}`,
    );
    assert.match(first.output, /below the floor of 95\.29/);
    const unitReport = join(cwd, "target/coverage-units/unit.lcov");
    assert.ok(existsSync(unitReport));
    // Every tier but one replayed; the re-run tier's new report is in the merge.
    const restore = edit(cwd, "tests/tiers/repo-tooling/project.json", (text) =>
      text.replace('"lang:rust"', '"lang:rust", "probe"'),
    );
    fixture.setReports({
      "repo-tooling": lcovBlock("src/other.rs", 7, 10),
    });
    const second = runCoverage(fixture);
    restore();
    assert.deepEqual(second.executed, ["repo-tooling"], second.output);
    const dir = join(cwd, "target/coverage-units");
    assert.deepEqual(
      printedUnion(second.stdout),
      readUnion(dir, NAMES),
      "the merged report differs from a line-wise sum of the same files",
    );
  } finally {
    fixture.remove();
  }
});

test("the floor is 95.29 on the merged LCOV, and a total between 95 and it fails naming the uncovered lines", () => {
  // 9519/10000 is 95.19%: above the old 95 and below the floor.
  const fixture = coverageFixture({
    unit: lcovBlock("src/shared.rs", 9519, 10000),
    e2e: lcovBlock("src/shared.rs", 100, 10000),
    "repo-tooling": lcovBlock("src/shared.rs", 1, 10000),
    "npm-launcher": lcovBlock("src/shared.rs", 1, 10000),
    versions: lcovBlock("src/shared.rs", 1, 10000),
  });
  try {
    const failing = runCoverage(fixture);
    assert.equal(failing.status, 1, failing.output);
    assert.match(failing.stdout, /lines percent: 95\.1900/);
    assert.match(failing.stdout, /below the floor of 95\.29/);
    assert.match(failing.stdout, /src\/shared\.rs: 9520,/);
    // 9529/10000 is exactly the floor: it passes.
    fixture.setReports({
      unit: lcovBlock("src/shared.rs", 9529, 10000),
    });
    const restore = edit(fixture.cwd, "src/lib.rs", appendLine);
    const passing = runCoverage(fixture);
    restore();
    assert.equal(passing.status, 0, passing.output);
  } finally {
    fixture.remove();
  }
});

test("a coverage tier the aggregate does not depend on fails the check, naming it", () => {
  const fixture = coverageFixture();
  try {
    assert.equal(runCoverage(fixture).status, 0);
    const dir = join(fixture.cwd, "tests/tiers/ghost");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        name: "onepipeline-ui-ghost",
        targets: {
          test: {
            command: "just _tier-test-covered ghost",
            outputs: ["{workspaceRoot}/target/coverage-units/ghost.lcov"],
          },
        },
      }),
    );
    const run = runCoverage(fixture);
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /onepipeline-ui-ghost:test/);
    assert.match(run.output, /does not depend on/);
  } finally {
    fixture.remove();
  }
});

test("a report left by another commit cannot reach the merge", () => {
  const fixture = coverageFixture();
  const { cwd, doubles } = fixture;
  const dir = join(cwd, "target/coverage-units");
  const planted = lcovBlock("src/planted.rs", 1, 100000);
  const plant = () => {
    mkdirSync(dir, { recursive: true });
    for (const tier of NAMES) writeFileSync(join(dir, `${tier}.lcov`), planted);
  };
  try {
    const first = runCoverage(fixture);
    assert.equal(first.status, 0, first.output);
    const stored = Object.fromEntries(
      NAMES.map((tier) => [
        tier,
        readFileSync(join(dir, `${tier}.lcov`), "utf8"),
      ]),
    );
    // Some tiers restored from the cache, the rest executed, every file planted first.
    plant();
    fixture.setReports({ versions: lcovBlock("src/versions.rs", 100, 100) });
    const restore = edit(cwd, "scripts/release-probe.sh", appendLine);
    const mixed = runCoverage(fixture);
    restore();
    assert.equal(mixed.status, 0, mixed.output);
    assert.deepEqual(mixed.executed.sort(), [
      "npm-launcher",
      "repo-tooling",
      "versions",
    ]);
    for (const tier of NAMES) {
      const now = readFileSync(join(dir, `${tier}.lcov`), "utf8");
      assert.ok(
        !now.includes("src/planted.rs"),
        `${tier} kept the planted report`,
      );
      if (mixed.replayed.includes(tier))
        assert.equal(now, stored[tier], `${tier} is not its cached output`);
      else
        assert.equal(
          now,
          readFileSync(join(doubles, `${tier}.lcov`), "utf8"),
          `${tier} is not this run's output`,
        );
    }
    assert.deepEqual(
      printedUnion(mixed.stdout).covered,
      readUnion(dir, NAMES).covered,
    );
    assert.deepEqual(
      printedUnion(mixed.stdout).total,
      readUnion(dir, NAMES).total,
    );
    // A file no tier owns makes the merge exit 2 naming it.
    writeFileSync(join(dir, "ghost.lcov"), planted);
    const stray = runCoverage(fixture);
    assert.equal(stray.status, 1, stray.output);
    assert.match(stray.output, /no named unit owns: ghost\.lcov/);
    assert.match(stray.output, /exited|exit code 2|status 2|code 2/i);
    rmSync(join(dir, "ghost.lcov"));
    // A named tier whose report is missing exits 2 too.
    const removed = join(dir, "e2e.lcov");
    const once = runCoverage(fixture);
    assert.equal(once.status, 0, once.output);
    rmSync(removed);
    // Removing the report behind Nx's back leaves the cache to restore it, so plant the
    // miss directly against the merge the aggregate runs.
    const merge = spawnSync(
      "node",
      [
        "scripts/coverage-merge.mjs",
        "--fail-under-lines",
        "95.29",
        "--dir",
        "target/coverage-units",
        "--unit",
        ...NAMES,
      ],
      { cwd, encoding: "utf8" },
    );
    assert.equal(merge.status, 2, merge.stderr);
    assert.match(merge.stderr, /no report for unit\(s\) e2e/);
  } finally {
    fixture.remove();
  }
});
