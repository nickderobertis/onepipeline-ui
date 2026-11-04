// Real Nx and the pinned sidecar; GitHub's cache and metadata HTTP are doubled.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { parse } from "yaml";
import { OP_NX_COMMIT } from "../../../scripts/nx-remote-cache.mjs";
import { interpolate } from "../../workflow-graph.mjs";

export const run = promisify(execFile);
export const json = (path) => JSON.parse(readFileSync(path, "utf8"));
export class GithubCache {
  entries = new Map();
  uploads = new Map();
  bases = new Map();
  metadata = new Map();
  calls = [];
  mode = "live";
  async start() {
    this.server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const url = new URL(req.url, this.url);
      const scope = req.headers.authorization?.replace(/^Bearer /, "");
      this.calls.push({ method: req.method, path: req.url, scope });
      const reply = (value, status = 200) => {
        const body = Buffer.isBuffer(value)
          ? value
          : Buffer.from(JSON.stringify(value));
        res
          .writeHead(status, {
            "content-length": body.length,
            "content-type": Buffer.isBuffer(value)
              ? "application/octet-stream"
              : "application/json",
          })
          .end(body);
      };
      if (req.method === "POST") {
        const body = JSON.parse(bytes);
        const method = url.pathname.split("/").at(-1);
        const key = `${body.key}:${body.version}`;
        if (this.mode === "fault")
          return reply({ code: "internal", msg: "store unavailable" }, 500);
        if (method === "GetCacheEntryDownloadURL") {
          const found =
            this.entries.get(`${scope}:${key}`) ??
            this.entries.get(
              `${this.bases.get(scope) || "refs/heads/main"}:${key}`,
            );
          if (!found)
            return reply({ ok: false, signedDownloadUrl: "", matchedKey: "" });
          const token = String(this.uploads.size);
          this.uploads.set(token, found);
          return reply({
            ok: true,
            signedDownloadUrl: `${this.url}/download/${token}`,
            matchedKey: body.key,
          });
        }
        if (method === "CreateCacheEntry") {
          if (this.mode === "throttled")
            return reply(
              { code: "resource_exhausted", msg: "rate limited" },
              429,
            );
          const token = String(this.uploads.size);
          this.uploads.set(token, { scope, key, blocks: new Map() });
          return reply({
            ok: true,
            signedUploadUrl: `${this.url}/upload/${token}`,
          });
        }
        if (method === "FinalizeCacheEntryUpload") {
          const upload = [...this.uploads.values()].find(
            (u) => u.scope === scope && u.key === key,
          );
          this.entries.set(`${scope}:${key}`, upload.body);
          return reply({ ok: true, entryId: "1" });
        }
      }
      if (req.method === "PUT") {
        const upload = this.uploads.get(url.pathname.split("/").at(-1));
        if (url.searchParams.get("comp") === "block")
          upload.blocks.set(url.searchParams.get("blockid"), bytes);
        else if (url.searchParams.get("comp") === "blocklist")
          upload.body = Buffer.concat(
            [...bytes.toString().matchAll(/<Latest>(.*?)<\/Latest>/g)].map(
              (m) => upload.blocks.get(m[1]),
            ),
          );
        else upload.body = bytes;
        return reply(Buffer.alloc(0), 201);
      }
      if (req.method === "GET") {
        if (url.pathname.startsWith("/repos/")) {
          const query = new URLSearchParams(url.searchParams);
          query.delete("per_page");
          query.delete("page");
          const selected = url.pathname + (query.size ? `?${query}` : "");
          let value =
            this.metadata.get(req.url) ??
            this.metadata.get(selected) ??
            this.metadata.get(url.pathname);
          if (value === undefined)
            return reply({ message: `No fixture route: ${req.url}` }, 404);
          const page = Number(url.searchParams.get("page") || 1);
          const size = Number(url.searchParams.get("per_page") || 100);
          const slice = (v) =>
            Array.isArray(v) ? v.slice((page - 1) * size, page * size) : v;
          if (!this.metadata.has(req.url) && url.searchParams.has("page"))
            value = Array.isArray(value)
              ? slice(value)
              : Object.fromEntries(
                  Object.entries(value).map(([k, v]) => [k, slice(v)]),
                );
          return reply(value);
        }
        const found = this.uploads.get(url.pathname.split("/").at(-1));
        return found ? reply(found) : reply({}, 404);
      }
      return reply({}, 405);
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise((done) => this.server.close(done));
  }
}

export async function sidecarCheckout() {
  const action = resolve(".tools/op-nx-cache", OP_NX_COMMIT);
  if (!existsSync(join(action, ".git"))) {
    mkdirSync(action, { recursive: true });
    await run("git", [
      "clone",
      "--quiet",
      "https://github.com/op-nx/github-cache.git",
      action,
    ]);
    await run("git", ["checkout", "--quiet", OP_NX_COMMIT], { cwd: action });
  }
  assert.equal(
    (await run("git", ["rev-parse", "HEAD"], { cwd: action })).stdout.trim(),
    OP_NX_COMMIT,
  );
  return action;
}
export async function cacheSession(
  cwd,
  cache,
  temp,
  payload,
  extra = {},
  workflow = "ci",
  job = "test-linux",
) {
  mkdirSync(temp, { recursive: true });
  const document = parse(
    readFileSync(`.github/workflows/${workflow}.yml`, "utf8"),
  );
  const steps = document.jobs[job].steps;
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    ...Object.fromEntries(
      Object.entries({ ...document.env, ...document.jobs[job].env }).map(
        ([key, value]) => [
          key,
          String(interpolate(value, { github: { event: payload } })),
        ],
      ),
    ),
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "nickderobertis/onepipeline-ui",
    GITHUB_REF: "refs/pull/1/merge",
    GITHUB_SHA: "3".repeat(40),
    GITHUB_EVENT_PATH: join(temp, "event.json"),
    GITHUB_JOB: job,
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKSPACE: cwd,
    GITHUB_TOKEN: "test-token",
    GH_TOKEN: "test-token",
    GITHUB_API_URL: cache.url,
    ACTIONS_CACHE_SERVICE_V2: "true",
    ACTIONS_RESULTS_URL: `${cache.url}/`,
    RUNNER_TEMP: temp,
    GITHUB_ENV: join(temp, "env"),
    GITHUB_OUTPUT: join(temp, "outputs"),
    GITHUB_STEP_SUMMARY: join(temp, "summary"),
    NX_DAEMON: "false",
    NX_ISOLATE_PLUGINS: "false",
    ...extra,
  };
  env.ACTIONS_RUNTIME_TOKEN = env.GITHUB_REF;
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
  const execute = (command) =>
    run("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
      cwd,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
  await execute(steps.find((s) => s.id === "nx-cache-trust").run);
  const outputs = Object.fromEntries(
    readFileSync(env.GITHUB_OUTPUT, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  const context = {
    steps: { "nx-cache-trust": { outputs } },
    github: { token: "test-token" },
  };
  const sidecarStep = steps.find((s) => s.id === "nx-cache");
  for (const [key, value] of Object.entries(sidecarStep.env))
    env[key] = String(interpolate(value, context));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  env.INPUT_PORT = String(port);
  env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [join(await sidecarCheckout(), "start-cache-server/index.js")],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (s) => {
    log += s;
  });
  child.stderr.on("data", (s) => {
    log += s;
  });
  const exit = once(child, "exit");
  try {
    await execute(
      steps.find((s) => s.run?.includes("nx-remote-cache.mjs ready")).run,
    );
    assert.ok(existsSync(env.GITHUB_ENV), log);
    Object.assign(
      env,
      Object.fromEntries(
        readFileSync(env.GITHUB_ENV, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      ),
    );
  } catch (error) {
    child.kill();
    await exit;
    throw error;
  }
  return {
    env,
    outputs,
    steps,
    execute,
    temp,
    nx: (args = ["run", "timeline-categories:test"]) =>
      run(
        process.execPath,
        ["node_modules/nx/dist/bin/nx.js", ...args, "--output-style=static"],
        { cwd, env, maxBuffer: 16 * 1024 * 1024 },
      ),
    async close() {
      try {
        const report = steps.find((s) =>
          s.run?.includes("nx-remote-cache.mjs report"),
        );
        if (report) {
          const result = await execute(report.run);
          assert.ok(
            existsSync(join(temp, "nx-cache-report/executions.json")),
            result.stdout + result.stderr,
          );
        } else
          await execute(
            'node scripts/nx-remote-cache.mjs report --job "$GITHUB_JOB" --out "$RUNNER_TEMP/nx-cache-report"',
          );
      } finally {
        child.kill();
        await exit;
        writeFileSync(join(temp, "sidecar.log"), log);
      }
    },
  };
}

// GitHub serves report artifacts as ZIPs, with the original report bytes.
export function reportZip(path) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const name of readdirSync(path)) {
    const body = readFileSync(join(path, name));
    const filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(body), 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, filename, body);
    central.push(record, filename);
    offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export function sourceMetadata(
  cache,
  report,
  {
    runId = 1,
    prNumber = 1,
    head = "1".repeat(40),
    base = "2".repeat(40),
    merge = "4".repeat(40),
  } = {},
) {
  const repo = "nickderobertis/onepipeline-ui";
  const repository = { id: 1, full_name: repo };
  const now = new Date().toISOString();
  const pr = {
    number: prNumber,
    head: { sha: head, ref: `change-${prNumber}`, repo: repository },
    base: { sha: base, ref: "main", repo: repository },
    user: { login: "maintainer" },
    merged_at: now,
    merge_commit_sha: merge,
  };
  const execution = json(join(report, "executions.json"));
  const source = {
    id: runId,
    run_attempt: 1,
    head_sha: head,
    head_branch: `change-${prNumber}`,
    event: "pull_request",
    head_repository: repository,
    pull_requests: [pr],
    status: "completed",
    conclusion: "success",
    run_started_at: execution.tasks.map((t) => t.started_at).sort()[0],
    updated_at: now,
  };
  const artifact = {
    id: runId * 100 + 1,
    name: "nx-cache-entries-test-linux",
    expired: false,
    created_at: now,
    workflow_run: { id: runId, head_sha: head, head_repository_id: 1 },
  };
  cache.metadata.set(`/repos/${repo}/commits/${merge}/pulls`, [pr]);
  cache.metadata.set(`/repos/${repo}/pulls/${prNumber}`, pr);
  const listingPath = `/repos/${repo}/actions/workflows/ci.yml/runs`;
  const listing = cache.metadata.get(listingPath) ?? { workflow_runs: [] };
  listing.workflow_runs = listing.workflow_runs.filter(
    (run) => run.id !== runId,
  );
  listing.workflow_runs.push(source);
  cache.metadata.set(listingPath, listing);
  cache.metadata.set(`/repos/${repo}/actions/runs/${runId}/attempts/1`, source);
  cache.metadata.set(`/repos/${repo}/actions/runs/${runId}/attempts/1/jobs`, {
    jobs: [
      { name: "test-linux", conclusion: "success", labels: ["ubuntu-latest"] },
    ],
  });
  cache.metadata.set(`/repos/${repo}/actions/runs/${runId}/artifacts`, {
    artifacts: [artifact],
  });
  cache.metadata.set(
    `/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    reportZip(report),
  );
  return { pr, source, artifact };
}
