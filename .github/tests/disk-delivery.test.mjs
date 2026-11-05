import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"));
test("Linux reporting steps use the job token with checks write and bracket the restore", () => {
  for (const job of Object.values(workflow.jobs).filter((job) =>
    job["runs-on"].startsWith("ubuntu"),
  )) {
    assert.equal(job.permissions.checks, "write");
    const index = job.steps.findIndex((step) =>
      step.uses?.startsWith("Swatinem/rust-cache@"),
    );
    assert.match(
      job.steps[index - 1].run,
      /disk-delivery.mjs start "\$PPID" \|\| true/,
    );
    assert.match(job.steps[index + 1].run, /disk-delivery.mjs stop \|\| true/);
    for (const step of job.steps.filter((step) =>
      step.name?.startsWith("Disk —"),
    ))
      assert.match(step.env.GH_TOKEN, /^\$\{\{ github.token \}\}$/);
  }
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  const end = Date.now() + 20000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, "diagnostic did not arrive or exit in time");
    await pause(100);
  }
}
async function capture(command, env) {
  const child = spawn("bash", ["-eo", "pipefail", "-c", command], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status] = await once(child, "exit");
  return { status, stdout, stderr };
}
async function run(command, env) {
  const child = spawn("bash", ["-eo", "pipefail", "-c", command], {
    env,
    stdio: "ignore",
  });
  return (await once(child, "exit"))[0];
}
async function startRunner(steps, env, root) {
  const pidPath = join(root, `child-${Date.now()}.pid`);
  const runner = spawn(
    "python3",
    [
      "-c",
      `import os, subprocess, sys
child = subprocess.Popen(["bash", "-c", os.environ["DISK_STEPS"]])
with open(os.environ["CHILD_PID_PATH"], "w") as output:
    output.write(str(child.pid))
sys.exit(child.wait())
`,
    ],
    {
      env: { ...env, DISK_STEPS: steps, CHILD_PID_PATH: pidPath },
      stdio: "ignore",
    },
  );
  await until(async () => {
    try {
      return (await readFile(pidPath, "utf8")).length > 0;
    } catch {
      return false;
    }
  });
  return { runner, stepPid: Number(await readFile(pidPath, "utf8")) };
}
async function killRunner(runner, stepPid) {
  const exited = once(runner, "exit");
  try {
    process.kill(stepPid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  runner.kill("SIGKILL");
  await exited;
}
test("workflow delivers reports and growing-tree samples before restore ends, including runner death and API refusal", async () => {
  const root = await mkdtemp(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "delivery-"),
  );
  const acknowledged = [];
  let attempts = 0;
  let refuse = false;
  let disposition = "ok";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    attempts++;
    assert.equal(req.headers.authorization, "Bearer test-token");
    assert.equal(req.url, "/repos/owner/repo/check-runs");
    const value = JSON.parse(body);
    if (disposition === "hang") return;
    if (disposition === "reset") {
      res.destroy();
      return;
    }
    res.writeHead(refuse ? 503 : 201, { "Content-Type": "application/json" });
    res.end("{}");
    if (!refuse) acknowledged.push(value);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = {
    ...process.env,
    GH_TOKEN: "test-token",
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_JOB: "lint",
    HOME: join(root, "home"),
    GITHUB_WORKSPACE: join(root, "workspace"),
    RUNNER_TEMP: root,
    GITHUB_STEP_SUMMARY: join(root, "summary"),
  };
  await mkdir(join(env.HOME, "growing"), { recursive: true });
  await mkdir(join(env.GITHUB_WORKSPACE, "target"), { recursive: true });
  const before = workflow.jobs.lint.steps.find(
    (s) => s.name === "Disk — Before Rust cache restore",
  ).run;
  const after = workflow.jobs.lint.steps.find(
    (s) => s.name === "Disk — After Rust cache restore",
  ).run;
  const end = workflow.jobs.lint.steps.find(
    (s) => s.name === "Disk — End of job",
  ).run;
  let runner;
  let stepPid;
  let sampler;
  try {
    // A real parent runner launches the reporting shell and sampled step.
    ({ runner, stepPid } = await startRunner(
      `${before}\nexec sleep 60`,
      env,
      root,
    ));
    await until(async () => {
      try {
        sampler = JSON.parse(
          await readFile(join(root, "disk-sampler-lint.json"), "utf8"),
        ).pid;
        return sampler;
      } catch {
        return false;
      }
    });
    await until(() => acknowledged.length >= 2);
    await writeFile(
      join(env.HOME, "growing", "cache"),
      Buffer.alloc(4 * 1024 * 1024, 7),
    );
    await until(() => acknowledged.length >= 3);
    assert.equal(
      runner.exitCode,
      null,
      "samples acknowledged while restore runs",
    );
    const samples = acknowledged.filter(
      (v) => v.output.title === "During Rust cache restore",
    );
    for (const value of acknowledged) {
      assert.match(
        value.output.annotations[0].message,
        /Bytes \(filesystem total, used, available\)/,
      );
      assert.match(value.output.summary, /500\/hour/);
      assert.equal(
        [
          ...value.output.annotations[0].message.matchAll(
            /^\s*\d+\s+\d+\s+\d+\s*$/gm,
          ),
        ].length,
        2,
      );
      assert.equal(value.conclusion, "neutral");
    }
    const size = (v) =>
      Number(
        v.output.annotations[0].message.match(
          new RegExp(`(\\d+)\\t${env.HOME}/growing`),
        )[1],
      );
    assert.ok(
      size(samples.at(-1)) > size(samples[0]),
      "real directory growth is measured",
    );
    // Kill only the PID this test started; its exec child is the sampled step.
    await killRunner(runner, stepPid);
    runner = undefined;
    await until(async () => {
      try {
        const stat = await readFile(`/proc/${sampler}/stat`, "utf8");
        return stat.includes(") Z ");
      } catch {
        return true;
      }
    });
    const saved = acknowledged.length;
    await pause(300);
    assert.equal(
      acknowledged.length,
      saved,
      "acknowledged records survive runner loss",
    );
    assert.equal(await run(after, env), 0);
    assert.equal(await run(end, env), 0);
    assert.ok(
      acknowledged.some((v) => v.output.title === "After Rust cache restore"),
    );
    assert.ok(acknowledged.some((v) => v.output.title === "End of job"));
    const normalSamples = acknowledged.filter(
      (v) => v.output.title === "During Rust cache restore",
    ).length;
    for (let index = 1; index <= 15; index++) {
      const directory = join(env.HOME, `largest-${index}`);
      await mkdir(directory);
      await writeFile(join(directory, "bytes"), Buffer.alloc(index * 8192, 7));
    }
    await writeFile(env.GITHUB_STEP_SUMMARY, "");
    const normalStart = acknowledged.length;
    const normal = await capture(`${before}\nsleep 3\n${after}\n${end}`, env);
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(
      normal.stdout,
      await readFile(env.GITHUB_STEP_SUMMARY, "utf8"),
    );
    for (const report of acknowledged
      .slice(normalStart)
      .filter((value) => value.output.title !== "During Rust cache restore"))
      assert.ok(
        normal.stdout.includes(report.output.annotations[0].message),
        "delivered figures remain in both the job log and summary",
      );
    const normalSample = acknowledged
      .slice(normalStart)
      .find((value) => value.output.title === "During Rust cache restore");
    const largest = normalSample.output.annotations[0].message
      .split(`Largest directories under ${env.HOME} (allocated bytes):`)[1]
      .split("Largest directories under ")[0]
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(
        (parts) =>
          parts[1] === env.HOME || parts[1]?.startsWith(`${env.HOME}/`),
      )
      .map((parts) => Number(parts[0]));
    assert.equal(largest.length, 12);
    assert.deepEqual(
      largest,
      [...largest].sort((a, b) => b - a),
    );
    assert.ok(
      acknowledged.filter((v) => v.output.title === "During Rust cache restore")
        .length > normalSamples,
    );
    await assert.rejects(readFile(join(root, "disk-sampler-lint.json")));
    const priorWorkerSamples = acknowledged.filter(
      (v) => v.output.title === "During Rust cache restore",
    ).length;
    const worker = spawn(
      "python3",
      [
        "-c",
        `import os, subprocess, time
subprocess.run(["bash", "-c", os.environ["BEFORE"]], check=True)
time.sleep(3)
subprocess.run(["bash", "-c", os.environ["AFTER"]], check=True)
`,
      ],
      { env: { ...env, BEFORE: before, AFTER: after }, stdio: "ignore" },
    );
    assert.equal((await once(worker, "exit"))[0], 0);
    assert.ok(
      acknowledged.filter((v) => v.output.title === "During Rust cache restore")
        .length > priorWorkerSamples,
      "the explicit runner identity survives the reporting shell exiting",
    );
    refuse = true;
    const previous = acknowledged.length;
    const count = attempts;
    assert.equal(
      await run(`${before}\nsleep 11\n${after}\n${end}\nexit 17`, env),
      17,
    );
    assert.equal(acknowledged.length, previous);
    assert.ok(attempts - count <= 5, "refusals are not retried");
    refuse = false;
    const input = join(root, "input");
    await writeFile(input, "x".repeat(70000));
    const report = `node .github/scripts/disk-delivery.mjs report "End of job" < "$REPORT_INPUT"`;
    const reportEnv = { ...env, REPORT_INPUT: input };
    assert.equal(await run(report, reportEnv), 0);
    assert.equal(
      acknowledged.at(-1).output.annotations[0].message.length,
      16000,
    );
    for (const mode of ["hang", "reset"]) {
      disposition = mode;
      const delivered = acknowledged.length;
      assert.equal(await run(report, reportEnv), 1);
      assert.equal(acknowledged.length, delivered);
    }
    disposition = "hang";
    const pendingAttempts = attempts;
    const durableBeforeCancellation = acknowledged.length;
    ({ runner, stepPid } = await startRunner(
      `${before}
exec sleep 60`,
      env,
      root,
    ));
    await until(() => attempts >= pendingAttempts + 2);
    sampler = JSON.parse(
      await readFile(join(root, "disk-sampler-lint.json"), "utf8"),
    ).pid;
    await killRunner(runner, stepPid);
    runner = undefined;
    await until(async () => {
      try {
        return (await readFile(`/proc/${sampler}/stat`, "utf8")).includes(
          ") Z ",
        );
      } catch {
        return true;
      }
    });
    assert.equal(acknowledged.length, durableBeforeCancellation);
    await run("node .github/scripts/disk-delivery.mjs stop", env);
    disposition = "ok";
    const damaged = { ...env, HOME: join(root, "absent-home") };
    const previousSamples = acknowledged.length;
    assert.equal(await run(`${before}\nsleep 3\n${after}`, damaged), 0);
    const incomplete = acknowledged
      .slice(previousSamples)
      .find((v) => v.output.title === "During Rust cache restore");
    assert.match(
      incomplete.output.annotations[0].message,
      /absent-home.*No such file/s,
    );
    assert.match(
      incomplete.output.annotations[0].message,
      /Directory scan incomplete/,
    );
    // Keep real du measurements, then delay its exit to exercise the sampler’s OS timeout boundary.
    const delayedTools = join(root, "delayed-tools");
    await mkdir(delayedTools);
    const delayedDu = join(delayedTools, "du");
    await writeFile(delayedDu, '#!/bin/bash\n/usr/bin/du "$@"\nexec sleep 5\n');
    await chmod(delayedDu, 0o755);
    const beforeTimeout = acknowledged.length;
    assert.equal(
      await run(
        'node .github/scripts/disk-delivery.mjs start "$PPID"\nsleep 3\nnode .github/scripts/disk-delivery.mjs stop',
        { ...env, PATH: `${delayedTools}:${env.PATH}` },
      ),
      0,
    );
    const timed = acknowledged
      .slice(beforeTimeout)
      .find((v) => v.output.title === "During Rust cache restore");
    assert.match(
      timed.output.annotations[0].message,
      /Directory scan incomplete/,
    );
    assert.ok(
      timed.output.annotations[0].message.includes(`${env.HOME}/growing`),
      "timed-out scan retains real directory measurements",
    );
    const state = join(root, "disk-sampler-lint.json");
    for (const malformed of [
      "{",
      "null",
      JSON.stringify({ pid: -1, stamp: "bad" }),
    ]) {
      await writeFile(state, malformed);
      assert.equal(
        await run("node .github/scripts/disk-delivery.mjs stop", env),
        1,
      );
      assert.equal(
        await run("node .github/scripts/disk-delivery.mjs stop || true", env),
        0,
      );
    }
    await rm(state);
    await mkdir(state);
    assert.equal(
      await run("node .github/scripts/disk-delivery.mjs stop", env),
      1,
    );
    await rm(state, { recursive: true });
    await mkdir(state);
    const failedStart = spawn(
      process.execPath,
      [".github/scripts/disk-delivery.mjs", "start", String(process.pid)],
      {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let diagnostic = "";
    failedStart.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    assert.equal((await once(failedStart, "exit"))[0], 1);
    const failedPid = Number(diagnostic.match(/sampler PID (\d+)/)[1]);
    await until(async () => {
      try {
        return (await readFile(`/proc/${failedPid}/stat`, "utf8")).includes(
          ") Z ",
        );
      } catch {
        return true;
      }
    });
    await rm(state, { recursive: true });
    // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] Linux starttime is field 22 per https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html; reading the real test process supplies a deliberately stale identity. CI on GitHub-hosted runners proves compatibility with this proc ABI.
    const selfStartTime = (await readFile(`/proc/${process.pid}/stat`, "utf8"))
      .split(") ")[1]
      .split(" ")[19];
    const staleStamp = String(BigInt(selfStartTime) + 1n);
    await writeFile(
      state,
      JSON.stringify({ pid: process.pid, stamp: staleStamp }),
    );
    assert.equal(
      await run("node .github/scripts/disk-delivery.mjs stop", env),
      0,
      "stop does not wait for a live PID with a stale identity",
    );
    await writeFile(
      state,
      JSON.stringify({ pid: process.pid, stamp: selfStartTime }),
    );
    const staleStart = acknowledged.length;
    assert.equal(
      await run(
        `node .github/scripts/disk-delivery.mjs sample ${process.pid} ${staleStamp}`,
        env,
      ),
      0,
    );
    assert.equal(
      acknowledged.length,
      staleStart,
      "a stale worker identity never samples an unrelated live process",
    );
    await rm(state);
    const absentStart = acknowledged.length;
    assert.equal(
      await run(
        `node .github/scripts/disk-delivery.mjs sample ${process.pid} ${selfStartTime}`,
        env,
      ),
      0,
    );
    assert.equal(
      acknowledged.length,
      absentStart,
      "a missing startup state expires without sampling",
    );
    const blockedTemp = join(root, "not-a-directory");
    await writeFile(blockedTemp, "occupied");
    assert.equal(
      await run('node .github/scripts/disk-delivery.mjs start "$PPID"', {
        ...env,
        RUNNER_TEMP: blockedTemp,
      }),
      1,
    );
    assert.equal(
      await run(
        'node .github/scripts/disk-delivery.mjs start "$PPID" || true\nexit 17',
        { ...env, RUNNER_TEMP: blockedTemp },
      ),
      17,
    );
    const logFailure = await capture(
      '(bash .github/scripts/report-disk.sh "End of job" | head -c 0) || true\nexit 17',
      env,
    );
    assert.equal(logFailure.status, 17);
    assert.match(logFailure.stderr, /Disk log copy failed/);
    const watchStart = acknowledged.length;
    ({ runner, stepPid } = await startRunner(
      'node .github/scripts/disk-delivery.mjs start "$PPID"\nexec sleep 60',
      env,
      root,
    ));
    await until(() => acknowledged.length > watchStart);
    sampler = JSON.parse(await readFile(state, "utf8")).pid;
    disposition = "hang";
    const watchAttempts = attempts;
    await until(() => attempts > watchAttempts);
    await rm(state);
    await mkdir(state);
    await until(async () => {
      try {
        return (await readFile(`/proc/${sampler}/stat`, "utf8")).includes(
          ") Z ",
        );
      } catch {
        return true;
      }
    });
    assert.match(
      await readFile(join(root, "disk-sampler-lint.log"), "utf8"),
      /Disk sampler stopped:.*EISDIR/,
    );
    await killRunner(runner, stepPid);
    runner = undefined;
    await rm(state, { recursive: true });
    const stopLog = await capture(
      "node .github/scripts/disk-delivery.mjs stop",
      env,
    );
    assert.match(stopLog.stderr, /Disk sampler stopped/);
    disposition = "ok";
    const withoutToken = { ...env, GH_TOKEN: undefined };
    const tokenlessWrites = attempts;
    assert.equal(await run(report, { ...reportEnv, GH_TOKEN: undefined }), 0);
    assert.equal(await run(before, withoutToken), 0);
    assert.equal(attempts, tokenlessWrites);
    await assert.rejects(readFile(state), { code: "ENOENT" });
    for (const command of [
      "",
      "unknown",
      "report",
      "start nope",
      "sample nope bad",
    ]) {
      assert.equal(
        await run(`node .github/scripts/disk-delivery.mjs ${command}`, env),
        2,
      );
    }
    for (const invalid of [
      { GITHUB_JOB: "../bad" },
      { GITHUB_SHA: "wrong" },
      { GITHUB_API_URL: "https://untrusted.invalid" },
      { RUNNER_TEMP: "relative" },
      { GITHUB_REPOSITORY: "no-owner" },
    ])
      assert.equal(await run(report, { ...reportEnv, ...invalid }), 1);
  } finally {
    if (runner) {
      await killRunner(runner, stepPid);
    }
    await run("node .github/scripts/disk-delivery.mjs stop", env);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
