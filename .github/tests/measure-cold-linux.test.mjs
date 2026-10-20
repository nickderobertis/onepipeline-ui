// scripts/measure-cold-linux.sh, the measurement behind
// docs/linux-cold-cache-timing.md, run as a reader runs it: real git and a real
// clone of this repository, with `just`, `docker` and `taskset` replaced by
// doubles that record what they were asked, so no build runs. The double `just`
// starts a `docker run` the way the wheel build does, which is how the script's
// Docker shim is reached.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
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

function doubles(dir, { jobStatus = 0 } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls");
  const write = (name, body) =>
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {
      mode: 0o755,
    });
  write("docker", `printf 'docker %s\\n' "$*" >> '${log}'`);
  write(
    "taskset",
    `printf 'taskset %s %s\\n' "$1" "$2" >> '${log}'\nshift 2\nexec "$@"`,
  );
  write(
    "just",
    [
      `printf 'just %s cwd=%s\\n' "$*" "$PWD" >> '${log}'`,
      'if [ "$1" = ci-test-linux ]; then',
      `  printf 'env RUSTC_WRAPPER=[%s] CARGO_BUILD_RUSTC_WRAPPER=[%s] SCRATCH=%s BASE=%s\\n' "\${RUSTC_WRAPPER-unset}" "\${CARGO_BUILD_RUSTC_WRAPPER-unset}" "$ONEPIPELINE_NODE_SCRATCH_DIR" "$ONEPIPELINE_UI_NX_BASE_SHA" >> '${log}'`,
      "  docker run --rm --cpu-shares 4096 -v /x:/y image build",
      "  docker info",
      '  echo "  Run duration:      1m 2s"',
      `  exit ${jobStatus}`,
      "fi",
    ].join("\n"),
  );
  return { bin, log };
}

function measure(args, dir, d) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${d.bin}:${process.env.PATH}` },
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
    assert.match(calls, /^docker info$/m, "other commands pass untouched");
    assert.ok(!existsSync(clone), "the clone is removed without --keep");
    assert.ok(existsSync(join(work, "t.log")), "the recipe's log is left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--default-cpu-weight drops the wheel build's weight, and the recipe's failure is the script's", () => {
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
        "--default-cpu-weight",
        "--keep",
      ],
      dir,
      d,
    );
    assert.equal(run.status, 7, run.stdout + run.stderr);
    assert.match(run.stdout, /^measure-cold-linux: w exit=7 /m);
    const calls = readFileSync(d.log, "utf8");
    assert.match(calls, /^taskset -c 2-5$/m);
    assert.match(
      calls,
      /^docker run --cpuset-cpus=2-5 --rm -v \/x:\/y image build$/m,
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

test("a call it cannot measure is refused before anything is cloned", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-cold-"));
  try {
    const d = doubles(dir);
    const work = join(dir, "work");
    for (const [args, reason] of [
      [[], /--commit is required/],
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
