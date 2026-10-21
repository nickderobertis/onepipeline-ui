// scripts/measure-cold-linux.sh, the measurement behind
// docs/linux-cold-cache-timing.md, run as a reader runs it: real git and a real
// clone of this repository, with `just`, `docker` and `taskset` replaced by
// doubles that record what they were asked, so no build runs. The double `just`
// starts a `docker run` the way the wheel build does, which is how the script's
// Docker shim is reached.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts/measure-cold-linux.sh");
const HEAD = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

function doubles(
  dir,
  {
    jobStatus = 0,
    bootstrapStatus = 0,
    toolsStatus = 0,
    summary = true,
    without = [],
    gitFails = "",
    stickyCache = false,
    stickyAfter = false,
  } = {},
) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls");
  const write = (name, body) =>
    without.includes(name) ||
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {
      mode: 0o755,
    });
  write("docker", `printf 'docker %s\\n' "$*" >> '${log}'`);
  // The real git, but for the one subcommand a journey has fail.
  if (gitFails)
    write(
      "git",
      [
        'for word in "$@"; do',
        `  if [ "$word" = '${gitFails}' ]; then echo "fatal: ${gitFails} refused by the journey" >&2; exit 128; fi`,
        "done",
        `exec '${REAL_GIT}' "$@"`,
      ].join("\n"),
    );
  write(
    "taskset",
    `printf 'taskset %s %s\\n' "$1" "$2" >> '${log}'\nshift 2\nexec "$@"`,
  );
  write(
    "just",
    [
      `printf 'just %s cwd=%s\\n' "$*" "$PWD" >> '${log}'`,
      // What a provisioned clone holds that a cold job does not: the timed run
      // must start without each of them.
      'if [ "$1" = bootstrap ]; then',
      "  mkdir -p target/debug .nx/cache .nx/workspace-data .tools/bin",
      "  touch target/debug/unit .nx/cache/entry .tools/bin/onepipeline-api-baseline .tools/bin/onepipeline-api-baseline.commit",
      `  [ ${bootstrapStatus} -eq 0 ] || { echo "bootstrap: cannot reach the registry" >&2; exit ${bootstrapStatus}; }`,
      // A build tree rm cannot clear: a file in a directory with no write bit.
      stickyCache
        ? "  mkdir -p target/debug/held && touch target/debug/held/unit && chmod 555 target/debug/held"
        : "  true",
      "fi",
      `if [ "$1" = release-tools ] && [ ${toolsStatus} -ne 0 ]; then echo "release-tools: cannot install release-plz" >&2; exit ${toolsStatus}; fi`,
      'if [ "$1" = ci-test-linux ]; then',
      `  printf 'env RUSTC_WRAPPER=[%s] CARGO_BUILD_RUSTC_WRAPPER=[%s] SCRATCH=%s BASE=%s\\n' "\${RUSTC_WRAPPER-unset}" "\${CARGO_BUILD_RUSTC_WRAPPER-unset}" "$ONEPIPELINE_NODE_SCRATCH_DIR" "$ONEPIPELINE_UI_NX_BASE_SHA" >> '${log}'`,
      `  for left in target .nx/cache .nx/workspace-data .tools/bin/onepipeline-api-baseline .tools/bin/onepipeline-api-baseline.commit; do [ ! -e "$left" ] || printf 'left %s\\n' "$left" >> '${log}'; done`,
      `  printf 'head %s %s\\n' "$(git rev-parse HEAD^{tree})" "$(git log -1 --format=%s)" >> '${log}'`,
      "  docker run --rm --cpu-shares 4096 -v /x:/y image build",
      "  docker run image check --cpu-shares 7 --trailing",
      "  docker info",
      stickyAfter
        ? "  mkdir -p held && touch held/unit && chmod 555 held"
        : "  true",
      summary ? '  echo "  Run duration:      1m 2s"' : "  true",
      `  [ ${jobStatus} -eq 0 ] || echo "Failed tasks: dag-ui:test" >&2`,
      `  exit ${jobStatus}`,
      "fi",
    ].join("\n"),
  );
  return { bin, log };
}

const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

// What a journey left without a write bit, given one back so it can be removed.
const writable = (path) =>
  existsSync(path) && execFileSync("chmod", ["-R", "u+w", path]);

const git = (...args) =>
  execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

function measure(args, dir, d, path = `${d.bin}:${process.env.PATH}`) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: path },
    cwd: dir,
  });
}

test("a cold run is timed in a clone of the commit, with Docker pinned to the run's CPUs", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir);
    const work = join(dir, "work");
    const run = measure(
      ["--commit", "HEAD", "--label", "t", "--workdir", work],
      dir,
      d,
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      new RegExp(
        `^measure-cold-linux: t exit=0 wall=\\d+s nx=1m 2s log=${work}/t\\.log$`,
        "m",
      ),
    );
    const calls = readFileSync(d.log, "utf8");
    const clone = join(work, "t");
    assert.match(calls, new RegExp(`^just bootstrap cwd=${clone}$`, "m"));
    assert.match(calls, new RegExp(`^just release-tools cwd=${clone}$`, "m"));
    assert.match(calls, /^taskset -c 0-3$/m);
    assert.match(calls, new RegExp(`^just ci-test-linux cwd=${clone}$`, "m"));
    // No compiler cache, the scratch beside the clone, the commit as the base.
    assert.match(
      calls,
      new RegExp(
        `^env RUSTC_WRAPPER=\\[\\] CARGO_BUILD_RUSTC_WRAPPER=\\[\\] SCRATCH=${work}/t-scratch BASE=${HEAD}$`,
        "m",
      ),
    );
    assert.match(
      calls,
      /^docker run --cpuset-cpus=0-3 --rm --cpu-shares 4096 -v \/x:\/y image build$/m,
      "the wheel build's own weight is passed through",
    );
    assert.match(
      calls,
      /^docker run --cpuset-cpus=0-3 image check --cpu-shares 7 --trailing$/m,
      "the container's own command keeps every argument",
    );
    assert.match(calls, /^docker info$/m, "other commands pass untouched");
    assert.doesNotMatch(calls, /^left /m, "the timed run starts cold");
    assert.ok(!existsSync(clone), "the clone is removed without --keep");
    assert.ok(existsSync(join(work, "t.log")), "the recipe's log is left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--cpus pins the run and its containers, and the recipe's failure is the script's", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir, { jobStatus: 7 });
    const work = join(dir, "work");
    const run = measure(
      [
        "--commit",
        "HEAD",
        "--label",
        "w",
        "--workdir",
        work,
        "--cpus",
        "2-5",
        "--keep",
      ],
      dir,
      d,
    );
    assert.equal(run.status, 7, run.stdout + run.stderr);
    assert.match(run.stdout, /^measure-cold-linux: w exit=7 /m);
    assert.match(run.stderr, /'just ci-test-linux' failed in the clone/);
    assert.match(run.stderr, /Failed tasks: dag-ui:test/, "the log's tail");
    assert.match(run.stderr, /^ACTION: read .*w\.log/m);
    const calls = readFileSync(d.log, "utf8");
    assert.match(calls, /^taskset -c 2-5$/m);
    assert.match(
      calls,
      /^docker run --cpuset-cpus=2-5 --rm --cpu-shares 4096 -v \/x:\/y image build$/m,
    );
    assert.ok(existsSync(join(work, "w")), "--keep leaves the clone");
    assert.equal(
      execFileSync("git", ["-C", join(work, "w"), "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      HEAD,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fixture is applied on --commit as one commit, and the commit stays the base", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir);
    const work = join(dir, "work");
    const parent = git("rev-parse", "HEAD~1");
    const run = measure(
      [
        "--commit",
        "HEAD~1",
        "--fixture",
        "HEAD~1...HEAD",
        "--label",
        "f",
        "--workdir",
        work,
      ],
      dir,
      d,
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const calls = readFileSync(d.log, "utf8");
    assert.match(calls, new RegExp(` BASE=${parent}$`, "m"));
    assert.match(
      calls,
      new RegExp(
        `^head ${git("rev-parse", "HEAD^{tree}")} fixture: HEAD~1\\.\\.\\.HEAD$`,
        "m",
      ),
      "the clone holds HEAD's tree, as HEAD~1 plus the fixture",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fixture that does not apply, or a provisioning that fails, stops before anything is timed", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir);
    const work = join(dir, "work");
    const applied = measure(
      ["--commit", "HEAD", "--fixture", "HEAD~1...HEAD", "--workdir", work],
      dir,
      d,
    );
    assert.equal(applied.status, 1, applied.stdout + applied.stderr);
    assert.match(applied.stderr, /the fixture HEAD~1\.\.\.HEAD does not apply/);
    assert.match(applied.stderr, /^ACTION: /m);
    assert.ok(!existsSync(d.log), "nothing was provisioned or timed");
    const empty = measure(
      ["--commit", "HEAD", "--fixture", "HEAD...HEAD", "--workdir", work],
      dir,
      d,
    );
    assert.equal(empty.status, 1, empty.stdout + empty.stderr);
    assert.match(empty.stderr, /the fixture HEAD\.\.\.HEAD does not apply/);
    assert.ok(!existsSync(d.log), "an empty fixture provisions nothing either");

    mkdirSync(join(dir, "b"));
    const broken = doubles(join(dir, "b"), { bootstrapStatus: 3 });
    const failed = measure(
      ["--commit", "HEAD", "--label", "p", "--workdir", work],
      dir,
      broken,
    );
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /'just bootstrap' failed in the clone/);
    assert.match(failed.stderr, /^ACTION: fix what the log names/m);
    assert.match(
      readFileSync(join(work, "p-bootstrap.log"), "utf8"),
      /cannot reach the registry/,
    );
    const calls = readFileSync(broken.log, "utf8");
    assert.doesNotMatch(calls, /release-tools|ci-test-linux/);
    assert.doesNotMatch(failed.stdout, /measure-cold-linux: p exit=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing release-tools stops before the timed run, and a log with no Nx summary says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const work = join(dir, "work");
    mkdirSync(join(dir, "t"));
    const tools = doubles(join(dir, "t"), { toolsStatus: 4 });
    const failed = measure(
      ["--commit", "HEAD", "--label", "r", "--workdir", work],
      dir,
      tools,
    );
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /'just release-tools' failed in the clone/);
    assert.doesNotMatch(readFileSync(tools.log, "utf8"), /ci-test-linux/);

    mkdirSync(join(dir, "s"));
    const quiet = doubles(join(dir, "s"), { summary: false });
    const run = measure(
      ["--commit", "HEAD", "--label", "q", "--workdir", work],
      dir,
      quiet,
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /^measure-cold-linux: q exit=0 wall=\d+s nx=unknown /m,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workdir and label that name the checkout itself are refused before anything is deleted", () => {
  // A checkout of its own, holding a copy of the script, so a refusal that
  // regressed would delete this scratch tree rather than the repository.
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir);
    const checkout = join(dir, "checkout");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(checkout, "scripts/measure-cold-linux.sh"));
    for (const args of [
      ["init", "--quiet"],
      ["add", "-A"],
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@localhost",
        "commit",
        "--quiet",
        "-m",
        "c",
      ],
    ])
      execFileSync("git", ["-C", checkout, ...args]);
    const run = spawnSync(
      "bash",
      [
        join(checkout, "scripts/measure-cold-linux.sh"),
        "--commit",
        "HEAD",
        "--workdir",
        dir,
        "--label",
        "checkout",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${d.bin}:${process.env.PATH}` },
        cwd: dir,
      },
    );
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /names .*checkout, which holds this checkout/);
    assert.ok(
      existsSync(join(checkout, "scripts/measure-cold-linux.sh")),
      "the checkout is still there",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a working directory, clone, checkout or ref it cannot make stops it before provisioning", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const readOnly = join(dir, "read-only");
    mkdirSync(readOnly, { mode: 0o555 });
    for (const [fails, workdir, reason] of [
      ["", join(readOnly, "work"), /could not create .*read-only\/work/],
      ["clone", join(dir, "w1"), /could not clone /],
      ["checkout", join(dir, "w2"), /could not check [0-9a-f]{40} out in /],
      [
        "update-ref",
        join(dir, "w3"),
        /could not point the clone's origin\/main at /,
      ],
    ]) {
      const home = mkdtempSync(join(dir, "doubles-"));
      const d = doubles(home, { gitFails: fails });
      const run = measure(["--commit", "HEAD", "--workdir", workdir], dir, d);
      assert.equal(run.status, 1, `${fails}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, reason, fails);
      assert.match(run.stderr, /^ACTION: /m, fails);
      assert.ok(
        !existsSync(d.log),
        `${fails || "mkdir"}: nothing was provisioned`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run whose trees rm cannot clear says which, and keeps the measured status", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  const work = join(dir, "work");
  try {
    // The last run's clone, which this one must remove first.
    mkdirSync(join(work, "old", "held"), { recursive: true });
    writeFileSync(join(work, "old", "held", "unit"), "");
    execFileSync("chmod", ["555", join(work, "old", "held")]);
    const stale = doubles(mkdtempSync(join(dir, "d-")));
    const refused = measure(
      ["--commit", "HEAD", "--label", "old", "--workdir", work],
      dir,
      stale,
    );
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /could not remove the last run's .*old/);
    assert.ok(!existsSync(stale.log), "nothing was provisioned");

    // Caches the timed run must start without.
    const sticky = doubles(mkdtempSync(join(dir, "d-")), { stickyCache: true });
    const warm = measure(
      ["--commit", "HEAD", "--label", "warm", "--workdir", work],
      dir,
      sticky,
    );
    assert.equal(warm.status, 1, warm.stdout + warm.stderr);
    assert.match(warm.stderr, /so the run would not start cold/);
    assert.doesNotMatch(readFileSync(sticky.log, "utf8"), /ci-test-linux/);

    // A cleanup that fails after the run: the measured status stands.
    const after = doubles(mkdtempSync(join(dir, "d-")), { stickyAfter: true });
    const run = measure(
      ["--commit", "HEAD", "--label", "after", "--workdir", work],
      dir,
      after,
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^measure-cold-linux: after exit=0 /m);
    assert.match(run.stderr, /could not remove .*after.* after the run/);
    assert.match(run.stderr, /^ACTION: remove them by hand/m);
  } finally {
    writable(work);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fixture that applies but cannot be committed says git refused it", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir, { gitFails: "commit" });
    const run = measure(
      [
        "--commit",
        "HEAD~1",
        "--fixture",
        "HEAD~1...HEAD",
        "--workdir",
        join(dir, "work"),
      ],
      dir,
      d,
    );
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /fatal: commit refused by the journey/);
    assert.match(
      run.stderr,
      /could not commit the fixture HEAD~1\.\.\.HEAD on /,
    );
    assert.match(
      run.stderr,
      /^ACTION: if git says there is nothing to commit/m,
    );
    assert.ok(!existsSync(d.log), "nothing was provisioned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the measurement's own Docker shim on PATH is refused rather than run in a loop", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir, { without: ["docker"] });
    const run = measure(
      ["--commit", "HEAD", "--workdir", join(dir, "work")],
      dir,
      d,
      `${d.bin}:${join(ROOT, "scripts/measure-cold-linux.d")}:${process.env.PATH}`,
    );
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stderr,
      /the docker on PATH is this measurement's own shim/,
    );
    assert.ok(!existsSync(join(dir, "work")), "nothing was cloned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing tool is named before anything is cloned", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir, { without: ["just"] });
    const work = join(dir, "work");
    const run = measure(
      ["--commit", "HEAD", "--workdir", work],
      dir,
      d,
      `${d.bin}:/usr/bin:/bin`,
    );
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /just is not on PATH/);
    assert.match(run.stderr, /^ACTION: install just/m);
    assert.ok(!existsSync(work), "nothing was cloned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call it cannot measure is refused before anything is cloned", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir);
    const work = join(dir, "work");
    for (const [args, reason] of [
      [[], /--commit is required/],
      [["--commit"], /--commit needs a value/],
      [["--commit", "no-such-ref", "--workdir", work], /is not a commit/],
      [
        ["--commit", "HEAD", "--workdir", join(ROOT, "x")],
        /inside this checkout/,
      ],
      [["--commit", "HEAD", "--workdir", "relative"], /not an absolute path/],
      [
        ["--commit", "HEAD", "--cpus", "all", "--workdir", work],
        /not a CPU list/,
      ],
      [
        ["--commit", "HEAD", "--fixture", "HEAD", "--workdir", work],
        /not FROM\.\.\.TO/,
      ],
      [
        ["--commit", "HEAD", "--fixture", "HEAD...x...HEAD", "--workdir", work],
        /not FROM\.\.\.TO/,
      ],
      [
        ["--commit", "HEAD", "--label", "..", "--workdir", work],
        /not a plain name/,
      ],
      [
        ["--commit", "HEAD", "--workdir", `${ROOT}/target/../x`],
        /inside this checkout/,
      ],
      [
        [
          "--commit",
          "HEAD",
          "--fixture",
          "HEAD...no-such-ref",
          "--workdir",
          work,
        ],
        /does not name two commits/,
      ],
      // A label nothing on this host is named: were the refusal to regress,
      // what it deletes does not exist and what it creates is refused by /.
      [
        [
          "--commit",
          "HEAD",
          "--workdir",
          "/",
          "--label",
          "measure-cold-no-such-dir",
        ],
        /is the root directory/,
      ],
      [["--commit", "HEAD", "--bogus"], /unknown argument/],
    ]) {
      const run = measure(args, dir, d);
      assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, reason);
      assert.match(run.stderr, /^ACTION: /m);
    }
    assert.ok(!existsSync(work), "nothing was cloned");
    assert.ok(!existsSync(d.log), "no tool was asked anything");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
