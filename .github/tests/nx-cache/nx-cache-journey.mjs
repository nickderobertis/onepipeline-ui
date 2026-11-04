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
// Scalar fields this double consumes/returns; the protocol test reconciles them
// with @actions/cache's generated Cache V2 messages in the pinned sidecar.
export const CACHE_RPC_FIELDS = {
  CreateCacheEntry: {
    request: { key: "string", version: "string" },
    response: { ok: "boolean", signedUploadUrl: "string" },
  },
  FinalizeCacheEntryUpload: {
    request: { key: "string", version: "string" },
    response: { ok: "boolean", entryId: "int64" },
  },
  GetCacheEntryDownloadURL: {
    request: { key: "string", version: "string" },
    response: {
      ok: "boolean",
      signedDownloadUrl: "string",
      matchedKey: "string",
    },
  },
};
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
      const scope = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null;
      this.calls.push({ method: req.method, path: req.url, scope });
      const reply = (value, status = 200) => {
        if (req.method === "POST" && status === 200) {
          const fields =
            CACHE_RPC_FIELDS[url.pathname.split("/").at(-1)]?.response;
          const valid =
            fields &&
            Object.entries(value).every(([key, child]) =>
              fields[key] === "int64"
                ? typeof child === "string" && /^\d+$/.test(child)
                : fields[key] === typeof child,
            ) &&
            Object.keys(fields).every((key) => key in value);
          if (!valid) {
            status = 500;
            value = {
              message:
                "Cache double returned a field outside its drift-gated protocol",
            };
          }
        }
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
        let body;
        try {
          body = JSON.parse(bytes);
        } catch {
          return reply({ message: "Malformed JSON" }, 400);
        }
        const text = (value) =>
          typeof value === "string" &&
          value.length > 0 &&
          Array.from(value).every(
            (character) => character.codePointAt(0) >= 32,
          );
        if (!text(scope) || scope.includes(":"))
          return reply({ message: "A bearer scope is required" }, 401);
        if (
          !body ||
          Array.isArray(body) ||
          !text(body.key) ||
          !text(body.version)
        )
          return reply(
            { message: "key and version must be nonempty strings" },
            400,
          );
        const method = url.pathname.split("/").at(-1);
        if (!Object.hasOwn(CACHE_RPC_FIELDS, method))
          return reply({ message: "Unknown cache RPC" }, 404);
        const key = JSON.stringify([body.key, body.version]);
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
          if (!upload) return reply({ message: "Unknown upload" }, 404);
          if (!Buffer.isBuffer(upload.body))
            return reply({ message: "Upload is incomplete" }, 409);
          this.entries.set(`${scope}:${key}`, upload.body);
          return reply({ ok: true, entryId: "1" });
        }
      }
      if (req.method === "PUT") {
        const token = url.pathname.split("/").at(-1);
        const upload = /^\d+$/.test(token) && this.uploads.get(token);
        if (!upload || !(upload.blocks instanceof Map))
          return reply({ message: "Unknown upload" }, 404);
        const operation = url.searchParams.get("comp");
        if (operation === "block") {
          const id = url.searchParams.get("blockid");
          if (!id || !/^[A-Za-z0-9+/=]+$/.test(id))
            return reply({ message: "Invalid block identifier" }, 400);
          upload.blocks.set(id, bytes);
        } else if (operation === "blocklist") {
          const envelope = bytes
            .toString()
            .trim()
            .match(
              /^(?:<\?xml[^>]*>\s*)?<BlockList(?:\s+xmlns="[^"<>]*")?>([\s\S]*)<\/BlockList>$/,
            );
          const contents = envelope?.[1];
          if (
            !contents ||
            !/^(?:\s*<Latest>[A-Za-z0-9+/=]+<\/Latest>\s*)+$/.test(contents)
          )
            return reply({ message: "Invalid block list" }, 400);
          const ids = [...contents.matchAll(/<Latest>(.*?)<\/Latest>/g)].map(
            (m) => m[1],
          );
          if (ids.some((id) => !upload.blocks.has(id)))
            return reply({ message: "Unknown block" }, 400);
          upload.body = Buffer.concat(ids.map((id) => upload.blocks.get(id)));
        } else if (operation === null) upload.body = bytes;
        else return reply({ message: "Unknown upload operation" }, 400);
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
          const rawPage = url.searchParams.get("page") ?? "1";
          const rawSize = url.searchParams.get("per_page") ?? "100";
          const page = Number(rawPage);
          const size = Number(rawSize);
          if (
            !/^[1-9]\d*$/.test(rawPage) ||
            !/^[1-9]\d*$/.test(rawSize) ||
            !Number.isSafeInteger(page) ||
            !Number.isSafeInteger(size) ||
            size > 100 ||
            !Number.isSafeInteger(page * size)
          )
            return reply({ message: "Invalid pagination" }, 400);
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
        return Buffer.isBuffer(found) ? reply(found) : reply({}, 404);
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

export async function sidecarCheckout(root = process.cwd()) {
  const action = resolve(root, ".tools/op-nx-cache", OP_NX_COMMIT);
  if (!existsSync(join(action, ".git")))
    throw new Error(
      "Pinned cache sidecar is not provisioned\nACTION: run just nx run github-workflows-nx-cache:bootstrap",
    );
  assert.equal(
    (await run("git", ["rev-parse", "HEAD"], { cwd: action })).stdout.trim(),
    OP_NX_COMMIT,
    "Cache sidecar commit differs\nACTION: run just nx run github-workflows-nx-cache:bootstrap",
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
    GITHUB_REPOSITORY:
      payload.repository?.full_name || "nickderobertis/onepipeline-ui",
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
          writeFileSync(
            join(temp, "report.log"),
            result.stdout + result.stderr,
          );
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
// Shapes are recorded API answers. Selection overrides are enumerated in
// github-rest/selection.json; local task executions and report bytes stay real.
export function recordedREST(name) {
  if (
    ![
      "run",
      "runs",
      "jobs",
      "artifacts",
      "release",
      "commit",
      "compare",
    ].includes(name)
  )
    throw new Error(`Unknown recorded REST response: ${name}`);
  return structuredClone(
    json(new URL(`./github-rest/${name}.json`, import.meta.url)).response,
  );
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
  const pr = structuredClone(
    json(new URL("./events/maintainer.json", import.meta.url)).pull_request,
  );
  const repository = pr.base.repo;
  const now = new Date().toISOString();
  Object.assign(pr, {
    number: prNumber,
    merged_at: now,
    merge_commit_sha: merge,
  });
  Object.assign(pr.head, {
    sha: head,
    ref: `change-${prNumber}`,
    repo: repository,
  });
  Object.assign(pr.base, { sha: base, ref: "main", repo: repository });
  const execution = json(join(report, "executions.json"));
  const source = recordedREST("run");
  const association = structuredClone(source.pull_requests[0]);
  association.number = prNumber;
  Object.assign(association.head, { sha: head, ref: pr.head.ref });
  Object.assign(association.base, { sha: base, ref: pr.base.ref });
  Object.assign(source, {
    id: runId,
    run_attempt: 1,
    head_sha: head,
    head_branch: pr.head.ref,
    event: "pull_request",
    head_repository: repository,
    pull_requests: [association],
    status: "completed",
    conclusion: "success",
    run_started_at: execution.tasks.map((t) => t.started_at).sort()[0],
    updated_at: now,
  });
  source.head_commit.id = head;
  const artifact = recordedREST("artifacts").artifacts[0];
  const zip = reportZip(report);
  Object.assign(artifact, {
    id: runId * 100 + 1,
    name: "nx-cache-entries-test-linux",
    expired: false,
    created_at: now,
    size_in_bytes: zip.length,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  Object.assign(artifact.workflow_run, {
    id: runId,
    head_sha: head,
    head_repository_id: repository.id,
    head_branch: pr.head.ref,
  });
  cache.metadata.set(`/repos/${repo}/commits/${merge}/pulls`, [pr]);
  cache.metadata.set(`/repos/${repo}/commits/${head}/pulls`, [pr]);
  for (const tip of [head, encodeURIComponent(pr.base.ref)])
    cache.metadata.set(`/repos/${repo}/compare/${base}...${tip}`, {
      ...recordedREST("compare"),
      status: "ahead",
    });
  cache.metadata.set(`/repos/${repo}/pulls/${prNumber}`, pr);
  for (const [sha, parent] of [
    [head, base],
    [merge, base],
  ]) {
    const commit = recordedREST("commit");
    commit.sha = sha;
    commit.parents = [{ ...commit.parents[0], sha: parent }];
    cache.metadata.set(`/repos/${repo}/commits/${sha}`, commit);
  }

  const listingPath = `/repos/${repo}/actions/workflows/ci.yml/runs`;
  const listing = cache.metadata.get(listingPath) ?? {
    ...recordedREST("runs"),
    workflow_runs: [],
  };
  listing.workflow_runs = listing.workflow_runs.filter(
    (run) => run.id !== runId,
  );
  listing.workflow_runs.push(source);
  listing.total_count = listing.workflow_runs.length;
  cache.metadata.set(listingPath, listing);
  cache.metadata.set(`/repos/${repo}/actions/runs/${runId}/attempts/1`, source);
  const jobs = recordedREST("jobs");
  const label = {
    linux: "ubuntu-latest",
    darwin: "macos-latest",
    win32: "windows-latest",
  }[execution.os];
  const job = jobs.jobs.find((job) => job.labels.includes(label));
  Object.assign(job, {
    id: runId * 1000 + 1,
    run_id: runId,
    name: "test-linux",
    conclusion: "success",
    started_at: source.run_started_at,
    completed_at: now,
  });
  Object.assign(jobs, { jobs: [job], total_count: 1 });
  cache.metadata.set(
    `/repos/${repo}/actions/runs/${runId}/attempts/1/jobs`,
    jobs,
  );
  const artifacts = recordedREST("artifacts");
  Object.assign(artifacts, { artifacts: [artifact], total_count: 1 });
  cache.metadata.set(
    `/repos/${repo}/actions/runs/${runId}/artifacts`,
    artifacts,
  );
  cache.metadata.set(
    `/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    zip,
  );
  return { pr, source, artifact };
}
