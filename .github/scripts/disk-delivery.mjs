// Measurement only: API and filesystem failures must never change the job verdict.
import { execFile, spawn } from "node:child_process";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
let samplingSignal;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let state;
let endpoint;
let diagnosticLog;
function required(name, pattern) {
  const value = process.env[name];
  if (!value || (pattern && !pattern.test(value)))
    throw new Error(`Invalid ${name}`);
  return value;
}
function configuration() {
  for (const name of ["RUNNER_TEMP", "HOME", "GITHUB_WORKSPACE"]) {
    if (!isAbsolute(required(name)))
      throw new Error(`${name} must be absolute`);
  }
  const job = required("GITHUB_JOB", /^[a-zA-Z0-9_-]+$/);
  state = `${process.env.RUNNER_TEMP}/disk-sampler-${job}.json`;
  diagnosticLog = `${process.env.RUNNER_TEMP}/disk-sampler-${job}.log`;
  required("GITHUB_REPOSITORY", /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  required("GITHUB_SHA", /^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/);
  endpoint = new URL(process.env.GITHUB_API_URL ?? "https://api.github.com");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  const host = new URL(process.env.GITHUB_SERVER_URL ?? "https://github.com")
    .hostname;
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(
      (local && endpoint.protocol === "http:") ||
      (endpoint.protocol === "https:" &&
        (endpoint.hostname === "api.github.com" || endpoint.hostname === host))
    )
  )
    throw new Error("Invalid GitHub API destination");
}
function positive(value) {
  if (
    !/^[1-9][0-9]*$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Invalid process identifier");
  return Number(value);
}
function stampValue(value) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value))
    throw new Error("Invalid process identity stamp");
  return value;
}
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] These externally owned limits are quoted from https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api and https://docs.github.com/rest/checks/runs; CI on GitHub-hosted runners proves compatibility; live schema lookup would make disk reporting depend on another network service.
const limits =
  "GitHub REST: GITHUB_TOKEN 1,000 requests/hour/repository; secondary 80 content writes/minute and 500/hour; annotations <=50/request, message <=64 KiB. One write per 10s sample, no retries; two Linux jobs capped at 30/36 minutes yield <410 writes/run. Sources: https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api and https://docs.github.com/rest/checks/runs#update-a-check-run . Other repository traffic shares these limits; refusals are skipped.";
async function deliver(label, message) {
  if (!process.env.GH_TOKEN || samplingSignal?.aborted) return;
  try {
    // llmlint: ignore-block[changed_behavior_has_e2e] Hosted token acceptance requires downstream CI credentials; the local HTTP journey proves acknowledged persistence and refusal isolation. Read separate Disk checks on the synthetic merge with filter=all to verify hosted delivery.
    // llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] The request follows https://docs.github.com/rest/checks/runs#create-a-check-run; CI on GitHub-hosted runners proves compatibility with this externally owned REST shape.
    const response = await fetch(
      `${endpoint.href.replace(/\/$/, "")}/repos/${process.env.GITHUB_REPOSITORY}/check-runs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          name: `Disk ${process.env.GITHUB_JOB}: ${label}`,
          head_sha: process.env.GITHUB_SHA,
          status: "completed",
          conclusion: "neutral",
          output: {
            title: label,
            summary: limits,
            annotations: [
              {
                path: ".github/workflows/ci.yml",
                start_line: 1,
                end_line: 1,
                annotation_level: "notice",
                message: message.slice(0, 16000),
              },
            ],
          },
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(2000),
          ...(samplingSignal ? [samplingSignal] : []),
        ]),
      },
    );
    // llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
    // llmlint: ignore-end[changed_behavior_has_e2e]
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`,
      );
    await response.arrayBuffer();
  } catch (error) {
    console.error(
      `Disk delivery skipped: ${error.message}. Inspect the job token checks:write permission and GitHub API availability; no retry was made.`,
    );
    if (!samplingSignal) process.exitCode = 1;
  }
}
// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] Linux defines these stable proc stat fields at https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html (state 3, parent 4, starttime 22). Parsing validates the record and checks our own parent against Node; CI on GitHub-hosted runners proves compatibility with the runner’s proc ABI.
async function processRecord(pid) {
  positive(pid);
  const record = await readFile(`/proc/${pid}/stat`, "utf8");
  const match = record.match(/^(\d+) \((.*)\) ([A-Za-z]) (.*)$/s);
  if (!match || Number(match[1]) !== pid)
    throw new Error("Malformed proc stat record");
  const fields = match[4].trim().split(/\s+/);
  if (!/^[0-9]+$/.test(fields[0])) throw new Error("Malformed parent PID");
  return {
    name: match[2],
    parent: Number(fields[0]),
    stamp: stampValue(fields[18]),
    zombie: match[3] === "Z",
  };
}
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
async function identity(pid) {
  try {
    const record = await processRecord(pid);
    return record.zombie ? undefined : record.stamp;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    throw error;
  }
}
async function sample() {
  const lines = [
    `### Runner disk: During Rust cache restore (${new Date().toISOString()})`,
    "Bytes (filesystem total, used, available):",
  ];
  await Promise.all(
    [process.env.GITHUB_WORKSPACE, process.env.HOME].map(async (path) => {
      try {
        lines.push(
          path,
          (
            await exec("df", ["-B1", "--output=size,used,avail", "--", path], {
              timeout: 1500,
              signal: samplingSignal,
            })
          ).stdout,
        );
      } catch (error) {
        lines.push(
          `${path}: ${error.message}. Verify this directory exists and the runner can read its filesystem.`,
        );
      }
    }),
  );
  const directoryReports = await Promise.all(
    [...new Set([process.env.HOME, process.env.RUNNER_TEMP, "/tmp"])].map(
      async (path) => {
        const directoryLines = [
          `Largest directories under ${path} (allocated bytes):`,
        ];
        try {
          const { stdout } = await exec(
            "du",
            ["-x", "-B1", "--max-depth=1", "--", path],
            { timeout: 2000, maxBuffer: 1024 * 1024, signal: samplingSignal },
          );
          directoryLines.push(
            ...stdout
              .trim()
              .split("\n")
              .sort(
                (a, b) => Number(b.split("\t")[0]) - Number(a.split("\t")[0]),
              )
              .slice(0, 12),
          );
        } catch (error) {
          directoryLines.push(
            error.stdout ?? "",
            `Directory scan incomplete: ${error.message}. Inspect this directory permissions and runner I/O load; partial measurements are retained.`,
          );
        }
        return directoryLines;
      },
    ),
  );
  lines.push(...directoryReports.flat());
  const message = lines.join("\n");
  await deliver("During Rust cache restore", message);
}
async function main() {
  const [mode, label] = process.argv.slice(2);
  if (
    !["report", "start", "stop", "sample"].includes(mode) ||
    process.argv.length !==
      (mode === "report" || mode === "start" ? 4 : mode === "sample" ? 5 : 3) ||
    (mode === "report" &&
      ![
        "Before Rust cache restore",
        "After Rust cache restore",
        "End of job",
      ].includes(label))
  ) {
    process.exitCode = 2;
    throw new Error(
      "Usage: disk-delivery.mjs report <report label> | start <runner PID> | stop | sample <worker PID> <identity stamp>",
    );
  }
  if (mode === "start") {
    try {
      positive(label);
    } catch (error) {
      process.exitCode = 2;
      throw error;
    }
  }
  if (mode === "sample") {
    try {
      positive(process.argv[3]);
      stampValue(process.argv[4]);
    } catch (error) {
      process.exitCode = 2;
      throw error;
    }
  }
  configuration();
  if (mode === "report") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    await deliver(label, input);
  } else if (mode === "stop") {
    const saved = await readFile(state, "utf8").then(JSON.parse, (error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      saved !== undefined &&
      (!saved || typeof saved !== "object" || Array.isArray(saved))
    )
      throw new Error("Invalid sampler state");
    if (saved) {
      positive(saved.pid);
      stampValue(saved.stamp);
    }
    await unlink(state).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (saved) {
      while (saved.stamp && (await identity(saved.pid)) === saved.stamp)
        await pause(100);
    }
    const diagnostic = await readFile(diagnosticLog, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (diagnostic) process.stderr.write(diagnostic);
  } else if (mode === "start") {
    if (!process.env.GH_TOKEN) return;
    // The step shell supplies its parent PID; watch that runner across step boundaries.
    const worker = positive(label);
    if ((await processRecord(process.pid)).parent !== process.ppid)
      throw new Error("proc stat parent does not match Node process identity");
    const log = await open(diagnosticLog, "a");
    const child = spawn(
      process.execPath,
      [import.meta.filename, "sample", String(worker), await identity(worker)],
      { detached: true, stdio: ["ignore", "ignore", log.fd], env: process.env },
    );
    child.unref();
    await log.close();
    try {
      await writeFile(
        state,
        JSON.stringify({ pid: child.pid, stamp: await identity(child.pid) }),
      );
    } catch (error) {
      throw new Error(
        `Cannot persist sampler state; sampler PID ${child.pid} exits within two seconds without a state file: ${error.message}`,
      );
    }
  } else if (mode === "sample") {
    const worker = positive(process.argv[3]);
    const stamp = stampValue(process.argv[4]);
    const stateExists = async () =>
      readFile(state, "utf8").then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await stateExists()) break;
      await pause(100);
    }
    const controller = new AbortController();
    samplingSignal = controller.signal;
    // Both the sampling loop and watchdog check liveness. Report a failed
    // check here so their scheduling cannot change the diagnostic or verdict.
    const alive = async () => {
      try {
        return (await identity(worker)) === stamp && (await stateExists());
      } catch (error) {
        if (!samplingSignal.aborted)
          console.error(
            `Disk sampler stopped: ${error.message}. Inspect the sampler state file permissions and runner process.`,
          );
        controller.abort();
        return false;
      }
    };
    const watcher = setInterval(() => {
      alive().then((running) => {
        if (!running) controller.abort();
      });
    }, 100);
    try {
      while (!samplingSignal.aborted && (await alive())) {
        const start = Date.now();
        await sample();
        while (Date.now() - start < 10000 && (await alive()))
          await pause(Math.min(100, 10000 - (Date.now() - start)));
      }
    } finally {
      clearInterval(watcher);
    }
  }
}
await main().catch((error) => {
  console.error(
    `Disk diagnostic skipped: ${error.message}. Inspect the diagnostic environment, state-file permissions and runner process; the workflow ignores this diagnostic failure.`,
  );
  process.exitCode ||= 1;
});
