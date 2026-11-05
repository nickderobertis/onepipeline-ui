import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const labels = [
  "Before Rust cache restore",
  "After Rust cache restore",
  "End of job",
];
function reportsValid(job) {
  const steps = job.steps;
  const restore = steps.findIndex((s) =>
    s.uses?.startsWith("Swatinem/rust-cache@"),
  );
  const positions = labels.map((label) =>
    steps.findIndex((s) => s.name === `Disk — ${label}`),
  );
  return (
    positions[0] === restore - 1 &&
    positions[1] === restore + 1 &&
    positions[2] === steps.length - 1 &&
    positions.every(
      (position, i) =>
        steps[position]?.if === "always()" &&
        steps[position]?.shell === "bash" &&
        steps[position]?.run.includes(
          `bash .github/scripts/report-disk.sh "${labels[i]}" || true`,
        ),
    )
  );
}

for (const [id, job] of Object.entries(workflow.jobs).filter(
  ([, job]) =>
    job["runs-on"].startsWith("ubuntu") &&
    job.steps.some((s) => s.uses?.startsWith("Swatinem/rust-cache@")),
)) {
  test(`${id} preserves all three best-effort reports around the restore`, () => {
    assert.ok(reportsValid(job));
    for (const label of labels) {
      for (const defect of ["missing", "moved", "conditional", "fatal"]) {
        const broken = structuredClone(job);
        const index = broken.steps.findIndex(
          (s) => s.name === `Disk — ${label}`,
        );
        if (defect === "missing") broken.steps.splice(index, 1);
        if (defect === "moved") {
          const [step] = broken.steps.splice(index, 1);
          broken.steps.unshift(step);
        }
        if (defect === "conditional") broken.steps[index].if = "success()";
        if (defect === "fatal")
          broken.steps[index].run = broken.steps[index].run.replace(
            `bash .github/scripts/report-disk.sh "${label}" || true`,
            `bash .github/scripts/report-disk.sh "${label}"`,
          );
        assert.equal(reportsValid(broken), false, `${label}: ${defect}`);
      }
    }
  });
}

function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function assertFigures(output, expected) {
  const figures = [...output.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/gm)];
  assert.equal(figures.length, 2);
  for (const match of figures)
    assert.deepEqual(match.slice(1).map(Number), expected);
}

function churnWriter(path, acknowledgementMs = 30000) {
  const writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { execFileSync } from "node:child_process";
    import { rmSync } from "node:fs";
    process.on("message", (action) => {
      if (action === "allocate") execFileSync("dd", ["if=/dev/zero", "of=" + process.env.DISK_CHURN, "bs=1M", "count=384", "conv=fsync", "status=none"], { timeout: 20000 });
      else rmSync(process.env.DISK_CHURN, { force: true });
      process.send(action);
    });
  `,
    ],
    {
      env: { ...process.env, DISK_CHURN: path },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let diagnostic = "";
  let failure;
  writer.stderr.setEncoding("utf8");
  writer.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-8192);
  });
  // Keep a permanent error listener: IPC can fail after a request has settled.
  writer.on("error", (error) => {
    failure = error;
  });
  const exited = new Promise((resolve) => {
    writer.once("exit", resolve);
    writer.once("error", resolve);
  });
  const changeUsage = (action) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        writer.off("message", onMessage);
        writer.off("error", onError);
        writer.off("exit", onExit);
        writer.off("disconnect", onDisconnect);
        if (error) {
          failure = error;
          reject(
            new Error(
              `Disk churn writer ${action}: ${error.message}\n${diagnostic}`,
            ),
          );
        } else resolve();
      };
      const onMessage = (message) => {
        if (message === action) finish();
        else finish(new Error(`unexpected acknowledgement: ${message}`));
      };
      const onError = (error) => finish(error);
      const onExit = (code, signal) =>
        finish(
          new Error(
            `exited before acknowledgement (code ${code}, signal ${signal})`,
          ),
        );
      const onDisconnect = () =>
        finish(new Error("IPC disconnected before acknowledgement"));
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `acknowledgement timed out after ${acknowledgementMs} ms`,
            ),
          ),
        acknowledgementMs,
      );
      writer.once("message", onMessage);
      writer.once("error", onError);
      writer.once("exit", onExit);
      writer.once("disconnect", onDisconnect);
      if (
        failure ||
        !writer.connected ||
        writer.exitCode !== null ||
        writer.signalCode !== null
      ) {
        finish(failure ?? new Error("writer is no longer connected"));
        return;
      }
      writer.send(action, (error) => {
        if (error) onError(error);
      });
    });
  const stop = async () => {
    // No further IPC is needed to clean up a failed writer. Kill only this
    // child, whose PID came from spawn, and await its already-registered exit.
    if (writer.exitCode === null && writer.signalCode === null)
      writer.kill("SIGKILL");
    await exited;
    writer.stderr.destroy();
    rmSync(path, { force: true });
  };
  return { changeUsage, stop, writer };
}

test("churn writer failures reject promptly and clean up without IPC", {
  timeout: 5000,
}, async () => {
  const root = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(),
      "disk-writer-errors-",
    ),
  );
  try {
    // dd really fails at the filesystem boundary; no acknowledgement follows.
    const failed = churnWriter(join(root, "missing", "cache"));
    try {
      await assert.rejects(
        failed.changeUsage("allocate"),
        /Disk churn writer allocate:[\s\S]*No such file or directory/,
      );
      await assert.rejects(
        failed.changeUsage("remove"),
        /Disk churn writer remove:/,
      );
      for (const event of ["message", "disconnect"])
        assert.equal(failed.writer.listenerCount(event), 0);
      assert.equal(failed.writer.listenerCount("error"), 2);
    } finally {
      await failed.stop();
    }

    const stalled = churnWriter(join(root, "stalled"), 100);
    try {
      // Stop our own child before it can handle a request, exercising the bound.
      stalled.writer.kill("SIGSTOP");
      await assert.rejects(
        stalled.changeUsage("allocate"),
        /acknowledgement timed out after 100 ms/,
      );
    } finally {
      await stalled.stop();
    }

    const disconnected = churnWriter(join(root, "disconnected"));
    try {
      disconnected.writer.disconnect();
      await assert.rejects(
        disconnected.changeUsage("remove"),
        /writer is no longer connected/,
      );
    } finally {
      await disconnected.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow reports real filesystem usage and survives a reporting failure", async () => {
  const root = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "disk-report-"),
  );
  // A private mount keeps unrelated host allocations out of the oracle. The
  // outer directory remains on the workspace filesystem for the churn process.
  if (!process.env.DISK_REPORT_PRIVATE_ROOT) {
    try {
      const result = spawnSync(
        "unshare",
        [
          "--user",
          "--map-root-user",
          "--mount",
          "bash",
          "-euc",
          'mount -t tmpfs -o size=32m tmpfs "$DISK_REPORT_PRIVATE_ROOT"; exec "$@"',
          "disk-report",
          process.execPath,
          "--test",
          "--test-name-pattern",
          "^workflow reports real filesystem usage and survives a reporting failure$",
          import.meta.filename,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_TEST_CONTEXT: undefined,
            DISK_REPORT_PRIVATE_ROOT: root,
          },
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /tests 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  rmSync(root, { recursive: true, force: true });
  const privateRoot = process.env.DISK_REPORT_PRIVATE_ROOT;
  assert.equal(
    command("findmnt", [
      "--noheadings",
      "--output",
      "FSTYPE",
      "--mountpoint",
      privateRoot,
    ]).trim(),
    "tmpfs",
    "The supplied root must be the isolated tmpfs mount",
  );
  const churn = join(
    process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(),
    `disk-churn-${process.pid}`,
  );
  const { changeUsage, stop } = churnWriter(churn);
  try {
    const workspace = join(privateRoot, "workspace");
    const home = join(privateRoot, "home");
    const summary = `${churn}.summary`;
    mkdirSync(join(workspace, "target"), { recursive: true });
    mkdirSync(home);
    writeFileSync(
      join(workspace, "target", "cache"),
      Buffer.alloc(1024 * 1024, 7),
    );
    const targetBytes = command("du", ["-s", "-B1", join(workspace, "target")])
      .trim()
      .split(/\s+/)[0];
    for (const label of labels) {
      writeFileSync(summary, "");
      const step = workflow.jobs.lint.steps.find(
        (s) => s.name === `Disk — ${label}`,
      );
      const sample = () =>
        command("df", ["-B1", "--output=size,used,avail", workspace])
          .trim()
          .split("\n")[1]
          .trim()
          .split(/\s+/)
          .map(Number);
      const before = sample();
      await changeUsage("allocate");
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            GITHUB_WORKSPACE: workspace,
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      await changeUsage("remove");
      const after = sample();
      assert.deepEqual(after, before);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(summary, "utf8"), result.stdout);
      assert.ok(result.stdout.includes(label));
      assertFigures(result.stdout, before);
      // Both stale/fabricated numbers and figures from a different filesystem
      // must be rejected by the same oracle used above.
      for (const wrong of [
        [before[0], before[1] + 4096, before[2] - 4096],
        command("df", [
          "-B1",
          "--output=size,used,avail",
          process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(),
        ])
          .trim()
          .split("\n")[1]
          .trim()
          .split(/\s+/)
          .map(Number),
      ]) {
        assert.throws(() =>
          assertFigures(`${wrong.join(" ")}\n${wrong.join(" ")}\n`, before),
        );
      }
      if (label === labels[1])
        assert.ok(
          result.stdout.includes(`${targetBytes}\t${workspace}/target`),
        );
      if (label === labels[1]) {
        rmSync(join(workspace, "target"), { recursive: true });
        writeFileSync(summary, "");
        const absent = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: home,
              GITHUB_WORKSPACE: workspace,
              GITHUB_STEP_SUMMARY: summary,
            },
          },
        );
        assert.equal(absent.status, 0, absent.stderr);
        assert.match(absent.stdout, /target directory absent/);
        assert.ok(absent.stdout.includes(label));
        assert.equal(readFileSync(summary, "utf8"), absent.stdout);
      }
      const failed = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            GITHUB_WORKSPACE: join(root, "missing"),
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      assert.equal(failed.status, 0);
      assert.match(failed.stderr, /No such file or directory/);
      assert.match(
        failed.stderr,
        /verify the workspace, home and step-summary paths/,
      );
    }
  } finally {
    await stop();
    rmSync(`${churn}.summary`, { force: true });
  }
});

test("workflow preserves its verdict for input, allocation and summary failures", () => {
  const root = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "disk-errors-"),
  );
  const target = join(root, "target");
  mkdirSync(target);
  writeFileSync(join(target, "cache"), "restored cache");
  const summary = join(root, "summary");
  const step = workflow.jobs.lint.steps.find(
    (s) => s.name === `Disk — ${labels[1]}`,
  );
  const env = {
    ...process.env,
    HOME: root,
    GITHUB_WORKSPACE: root,
    GITHUB_STEP_SUMMARY: summary,
  };
  const run = (environment, invocation = step.run) =>
    spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", invocation],
      {
        encoding: "utf8",
        env: environment,
      },
    );
  try {
    for (const key of ["GITHUB_WORKSPACE", "HOME", "GITHUB_STEP_SUMMARY"]) {
      for (const value of [undefined, ""]) {
        const invalid = { ...env, [key]: value };
        const result = run(invalid);
        assert.equal(result.status, 0);
        assert.match(result.stderr, new RegExp(`Set ${key}`));
      }
    }
    for (const argument of ['""', ""]) {
      const result = run(env, step.run.replace(`"${labels[1]}"`, argument));
      assert.equal(result.status, 0);
      assert.match(result.stderr, /Pass the report label/);
    }
    const unwritable = run({ ...env, GITHUB_STEP_SUMMARY: root });
    assert.equal(unwritable.status, 0);
    assert.match(unwritable.stderr, /Is a directory/);
    assert.match(unwritable.stderr, /Disk report incomplete/);

    chmodSync(target, 0);
    const allocation = run(env);
    assert.equal(allocation.status, 0);
    assert.match(allocation.stderr, /Permission denied/);
    assert.match(allocation.stderr, /Disk report incomplete/);
    assert.match(allocation.stdout, /Restored target allocated bytes/);
    assert.equal(readFileSync(summary, "utf8"), allocation.stdout);
  } finally {
    chmodSync(target, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
