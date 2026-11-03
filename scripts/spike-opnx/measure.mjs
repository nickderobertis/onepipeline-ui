#!/usr/bin/env node
// Spike `spike-opnx-audit` (plan ci-release-test-cache): one measurement of
// op-nx/github-cache with one command. It starts the sidecar the way the plan
// would, runs one Nx task through it, and reports what crossed the wire, the
// entry's bytes, the Actions-cache entries the run created, and the GitHub REST
// requests one listing of the store cost.
//
//   node scripts/spike-opnx/measure.mjs [--task <project:target>]
//     [--sidecar start|external|none] [--action <dir>] [--nx-token <token>]
//     [--store live|down|fault|full] [--label <name>] [--out <file.json>]
//
// --task     the Nx task to run (default dag-model:test: a real test target that
//            declares no outputs, so its entry is terminal output only).
// --sidecar  start (default): run the action's committed bundle,
//            `start-cache-server/index.js`, as the runner runs a `uses:` node
//            action — `node index.js` from the workspace root with INPUT_PORT —
//            and stop it by its PID afterwards. external: a sidecar the workflow
//            started as a background step is already at
//            NX_SELF_HOSTED_REMOTE_CACHE_SERVER. none: start nothing, so Nx
//            meets a sidecar that failed to start.
// --action   the op-nx/github-cache checkout whose bundle --sidecar start runs;
//            default .tools/op-nx-github-cache, cloned at PINNED_COMMIT if absent.
// --nx-token the bearer token Nx presents, when it must differ from the
//            sidecar's (a 401).
// --store    live (default): the environment's own Actions cache. down, fault,
//            full: stand the sidecar in a write-trusted Actions context whose
//            cache service is, respectively, a closed port, a stub answering 500,
//            or a stub that misses every read and refuses every write as a full
//            cache would. Those three are local cases; they replace the cache
//            service variables only.
//
// Nx runs with a fresh local cache directory, so whatever it replays came from
// the remote. Every request Nx sends passes through a logging proxy, which is
// how a replay (GET 200) and a write (PUT and its status) are told apart without
// reading Nx's own output. When a token and repository are known (GITHUB_TOKEN /
// GH_TOKEN or `gh auth token`; GITHUB_REPOSITORY or the origin remote) it lists
// the repository's Actions caches, 100 a page, and counts the requests.
//
// Exit: Nx's own status (0 when the task passed), 2 on a usage error, 1 when the
// sidecar did not become ready under --sidecar start.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// op-nx/github-cache's `v0` tag on 2026-11-03: the v0.0.2 release merge.
const PINNED_COMMIT = "91839c24885842cac86567c30e23b37fb85f7e33";
const ROOT = resolve(import.meta.dirname, "../..");

const usage = (message) => {
  console.error(`measure: ${message}`);
  console.error(
    "ACTION: run 'node scripts/spike-opnx/measure.mjs [--task <project:target>] [--sidecar start|external|none] [--action <dir>] [--nx-token <t>] [--store live|down|fault|full] [--label <name>] [--out <file>]'",
  );
  process.exit(2);
};

const options = {
  task: "dag-model:test",
  sidecar: "start",
  action: join(ROOT, ".tools/op-nx-github-cache"),
  nxToken: undefined,
  store: "live",
  label: undefined,
  out: undefined,
};
const flags = {
  "--task": "task",
  "--sidecar": "sidecar",
  "--action": "action",
  "--nx-token": "nxToken",
  "--store": "store",
  "--label": "label",
  "--out": "out",
};
const argv = process.argv.slice(2);
for (let at = 0; at < argv.length; at += 2) {
  const key = Object.hasOwn(flags, argv[at]) ? flags[argv[at]] : undefined;
  if (!key) usage(`unknown argument '${argv[at]}'`);
  if (argv[at + 1] === undefined) usage(`${argv[at]} needs a value`);
  options[key] = argv[at + 1];
}
if (!["start", "external", "none"].includes(options.sidecar))
  usage(`'${options.sidecar}' is not start, external or none`);
if (!["live", "down", "fault", "full"].includes(options.store))
  usage(`'${options.store}' is not live, down, fault or full`);
if (
  !/^[A-Za-z0-9@][A-Za-z0-9@._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
    options.task,
  )
)
  usage(`'${options.task}' is not a <project:target> task`);
if (options.store !== "live" && options.sidecar !== "start")
  usage("--store other than live needs --sidecar start");

const started = new Date();
const listen = (server) =>
  new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done(server.address().port)),
  );

// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] a deliberate stand-in for GitHub's cache service, whose only definition is the @actions/cache 6.2.0 client bundled in the action at PINNED_COMMIT; nothing importable exists, and ensureAction refuses any other commit, so the bundle these answers were written against is the one that reads them.
// A stand-in for the Actions cache service (twirp v2) that faults or is full.
async function startStore(mode) {
  if (mode === "down") {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((done) => probe.close(done));
    return { url: `http://127.0.0.1:${port}/`, calls: [], close() {} };
  }
  const calls = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const method = req.url.split("/").pop();
      calls.push(method);
      if (mode === "fault") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"code":"internal","msg":"injected store fault"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        method === "CreateCacheEntry"
          ? '{"ok":false,"signedUploadUrl":"","message":"cache storage is full (injected)"}'
          : '{"ok":false,"signedDownloadUrl":"","matchedKey":""}',
      );
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    calls,
    close: () => server.close(),
  };
}
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

const fail = (message, action) => {
  console.error(`measure: ${message}`);
  console.error(`ACTION: ${action}`);
  process.exit(1);
};

const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(
      `git ${args.join(" ")} failed in ${dir}: ${error.stderr || error.message}`,
      "check network access to github.com and that the directory is a git checkout, or pass --action with a checkout at the pinned commit",
    );
  }
};

// The figures name PINNED_COMMIT, so the bundle that runs must be that
// commit's, unmodified: any other commit, or a changed working tree, is refused
// rather than measured under that name.
function ensureAction(dir) {
  if (!existsSync(join(dir, "start-cache-server/index.js"))) {
    git(
      ".",
      "clone",
      "--quiet",
      "https://github.com/op-nx/github-cache.git",
      dir,
    );
    git(dir, "checkout", "--quiet", PINNED_COMMIT);
  }
  const head = git(dir, "rev-parse", "HEAD");
  if (head !== PINNED_COMMIT)
    fail(
      `${dir} is at ${head}, not op-nx/github-cache ${PINNED_COMMIT}`,
      `run 'git -C ${dir} checkout ${PINNED_COMMIT}', or pass --action with a checkout at that commit`,
    );
  const changed = git(dir, "status", "--porcelain", "--untracked-files=no");
  if (changed)
    fail(
      `${dir} has changes to tracked files, so its bundle is not ${PINNED_COMMIT}'s: ${changed.split("\n")[0]}`,
      `run 'git -C ${dir} checkout -- .' to restore the pinned bundle`,
    );
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] the two names this harness reads the sidecar and the store by: Nx's self-hosted cache route, and op-nx/github-cache's `cacheKeyFor` (packages/github-cache/src/lib/cache-key.ts). Both are TypeScript or Rust in projects this repository does not build, and ensureAction pins the one commit whose key these figures describe; a different key would show as entries the listing never finds.
const cacheRoute = (hash) => `/v1/cache/${hash}`;
const cacheKey = (hash) => `nx-cache-${hash}`;
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

// The status of a GET on an unknown hash: unauthenticated it is answered 401
// before the store is touched (liveness); authenticated it reaches the store.
async function status(url, token, timeoutMs = 10_000) {
  try {
    const res = await fetch(`${url}${cacheRoute("deadbeef")}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch {
    return 0;
  }
}

// Liveness first, so a store that faults cannot read as a sidecar that is
// down; then one authenticated probe, recorded rather than required: it proves
// the token matches when it answers 404 or 200, and its latency is what a
// readiness step that demands those would wait on.
async function ready(url, token) {
  let live = 0;
  for (let attempt = 0; attempt < 30 && live !== 401; attempt += 1) {
    live = await status(url, undefined);
    if (live !== 401) await sleep(1000);
  }
  if (live !== 401) return { live };
  const begun = Date.now();
  const authed = await status(url, token, 120_000);
  return { live, authed, authedMs: Date.now() - begun };
}

// Nx's own output names neither the hash it asked for nor the status it got,
// so a replay and a write are told apart here, on the wire.
async function startProxy(target, log) {
  const server = createServer((req, res) => {
    const begun = Date.now();
    const entry = {
      method: req.method,
      hash: req.url.split("/").pop(),
      requestBytes: 0,
      responseBytes: 0,
    };
    const upstream = request(
      `${target}${req.url}`,
      { method: req.method, headers: req.headers },
      (answer) => {
        entry.status = answer.statusCode;
        res.writeHead(answer.statusCode, answer.headers);
        answer.on("data", (chunk) => {
          entry.responseBytes += chunk.length;
        });
        answer.pipe(res);
        answer.on("end", () => {
          entry.ms = Date.now() - begun;
          log.push(entry);
        });
      },
    );
    upstream.on("error", (error) => {
      entry.status = 0;
      entry.error = error.code ?? error.message;
      entry.ms = Date.now() - begun;
      log.push(entry);
      res.destroy();
    });
    req.on("data", (chunk) => {
      entry.requestBytes += chunk.length;
    });
    req.pipe(upstream);
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) return token;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

// owner/name, as GitHub spells it; anything else is not interpolated into a URL.
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
function repository() {
  let named = process.env.GITHUB_REPOSITORY;
  if (!named) {
    try {
      const url = execFileSync(
        "git",
        ["-C", ROOT, "remote", "get-url", "origin"],
        { encoding: "utf8" },
      ).trim();
      named = url.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
    } catch {
      return undefined;
    }
  }
  return named && REPOSITORY.test(named) ? named : undefined;
}

// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] GitHub's REST schema for "List GitHub Actions caches for a repository", which this repository has no generated types for; the check below is the gate: a response that drifts from the fields read here is reported as a listing error rather than counted.
const isCacheEntry = (e) =>
  e !== null &&
  typeof e === "object" &&
  Number.isInteger(e.id) &&
  typeof e.key === "string" &&
  typeof e.ref === "string" &&
  Number.isInteger(e.size_in_bytes) &&
  typeof e.created_at === "string" &&
  !Number.isNaN(Date.parse(e.created_at));
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

// GITHUB_API_URL is the runner's own name for the REST base (GHES included).
const API = process.env.GITHUB_API_URL || "https://api.github.com";

async function listStore(repo, token) {
  const entries = [];
  let requests = 0;
  let total;
  for (let page = 1; ; page += 1) {
    requests += 1;
    let res;
    let body;
    try {
      res = await fetch(
        `${API}/repos/${repo}/actions/caches?per_page=100&page=${page}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) return { error: `HTTP ${res.status}`, requests };
      body = await res.json();
    } catch (error) {
      return {
        error: `the listing request failed: ${error.message}`,
        requests,
      };
    }
    if (
      !Number.isInteger(body?.total_count) ||
      !Array.isArray(body.actions_caches) ||
      !body.actions_caches.every(isCacheEntry)
    )
      return {
        error: "the listing did not have the documented shape",
        requests,
      };
    total = body.total_count;
    entries.push(...body.actions_caches);
    if (body.actions_caches.length < 100 || entries.length >= total) break;
  }
  return { requests, total, entries };
}

const log = [];
const sidecarToken = randomBytes(32).toString("hex");
let sidecarUrl = process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER;
let token = process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN;
let sidecar;
let store;
let readiness;
const sidecarLog = mkdtempSync(join(tmpdir(), "spike-opnx-sidecar-"));
if (options.sidecar === "external") {
  if (!sidecarUrl || !token)
    usage(
      "--sidecar external needs NX_SELF_HOSTED_REMOTE_CACHE_SERVER and _ACCESS_TOKEN",
    );
  // The bearer token is forwarded to this URL, so only a loopback sidecar is accepted.
  const port = Number(
    sidecarUrl.match(/^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})$/)?.[1],
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    usage(
      `NX_SELF_HOSTED_REMOTE_CACHE_SERVER is '${sidecarUrl}', not a loopback http://127.0.0.1:<port>`,
    );
}
if (options.sidecar === "start") {
  ensureAction(options.action);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  sidecarUrl = `http://127.0.0.1:${port}`;
  token = sidecarToken;
  const env = {
    ...process.env,
    INPUT_PORT: String(port),
    NX_SELF_HOSTED_REMOTE_CACHE_SERVER: sidecarUrl,
    NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: token,
  };
  if (options.store !== "live") {
    store = await startStore(options.store);
    Object.assign(env, {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: env.GITHUB_EVENT_NAME || "push",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: env.GITHUB_REPOSITORY || repository(),
      GITHUB_WORKSPACE: ROOT,
      RUNNER_TEMP:
        env.RUNNER_TEMP || mkdtempSync(join(tmpdir(), "spike-opnx-runner-")),
      GITHUB_TOKEN: env.GITHUB_TOKEN || "injected-store-case",
      ACTIONS_CACHE_SERVICE_V2: "true",
      ACTIONS_RESULTS_URL: store.url,
      ACTIONS_RUNTIME_TOKEN: "injected-store-case",
    });
  }
  const out = join(sidecarLog, "sidecar.log");
  writeFileSync(out, "");
  sidecar = spawn(
    process.execPath,
    [join(options.action, "start-cache-server/index.js")],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  sidecar.stdout.on("data", (chunk) => appendFileSync(out, chunk));
  sidecar.stderr.on("data", (chunk) => appendFileSync(out, chunk));
  readiness = await ready(sidecarUrl, token);
  if (readiness.live !== 401) {
    console.error(
      `measure: the sidecar never answered (last ${readiness.live}); its log is ${out}`,
    );
    console.error(
      "ACTION: read the sidecar log; --sidecar none measures a sidecar that is down",
    );
    console.error(readFileSync(out, "utf8"));
    sidecar.kill("SIGTERM");
    store?.close();
    process.exit(1);
  }
}
if (options.sidecar === "external") readiness = await ready(sidecarUrl, token);
if (options.sidecar === "none") {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  sidecarUrl = `http://127.0.0.1:${port}`;
  token = sidecarToken;
}

const proxyUrl = await startProxy(sidecarUrl, log);
const nxCache = mkdtempSync(join(tmpdir(), "spike-opnx-nx-cache-"));
const nxBegun = Date.now();
const nx = spawn(
  process.execPath,
  [
    join(ROOT, "node_modules/nx/dist/bin/nx.js"),
    "run",
    options.task,
    "--outputStyle=static",
  ],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NX_SELF_HOSTED_REMOTE_CACHE_SERVER: proxyUrl,
      NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: options.nxToken ?? token,
      NX_CACHE_DIRECTORY: join(nxCache, "cache"),
      NX_WORKSPACE_DATA_DIRECTORY: join(nxCache, "workspace-data"),
      NX_DAEMON: "false",
      NX_NO_CLOUD: "true",
    },
  },
);
let nxOutput = "";
// Without --out the JSON record is this command's stdout, so Nx's own output
// goes to stderr then and stdout stays one parseable document.
nx.stdout.on("data", (chunk) => {
  nxOutput += chunk;
  (options.out ? process.stdout : process.stderr).write(chunk);
});
nx.stderr.on("data", (chunk) => {
  nxOutput += chunk;
  process.stderr.write(chunk);
});
const nxExit = await new Promise((done) => nx.on("close", done));
const nxMs = Date.now() - nxBegun;

if (sidecar) {
  const exited = new Promise((done) => sidecar.on("close", done));
  sidecar.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
}
store?.close();

const puts = log.filter((entry) => entry.method === "PUT");
const gets = log.filter((entry) => entry.method === "GET");
const result = {
  label: options.label,
  task: options.task,
  sidecar: options.sidecar,
  store: options.store,
  readiness,
  pinnedCommit: PINNED_COMMIT,
  context: {
    os: process.platform,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    workspace: process.env.GITHUB_WORKSPACE,
    cwd: ROOT,
    cacheMode: process.env.ACTIONS_CACHE_MODE,
    readOnly: process.env.CACHE_READ_ONLY,
  },
  nx: {
    exit: nxExit,
    ms: nxMs,
    replayedFromRemote: /remote cache\]/.test(nxOutput),
  },
  requests: log,
  replayed: gets.filter((entry) => entry.status === 200).map((e) => e.hash),
  written: puts
    .filter((entry) => entry.status === 200)
    .map((entry) => ({ hash: entry.hash, bytes: entry.requestBytes })),
  storeCalls: store?.calls,
};

const repo = repository();
const ghToken = githubToken();
if (options.store === "live" && repo && ghToken) {
  let listing = await listStore(repo, ghToken);
  const wanted = new Set(result.written.map((entry) => cacheKey(entry.hash)));
  for (let tries = 0; tries < 3 && !listing.error; tries += 1) {
    if ([...wanted].every((key) => listing.entries.some((e) => e.key === key)))
      break;
    await sleep(5000);
    listing = await listStore(repo, ghToken);
  }
  if (listing.error) result.store_listing = listing;
  else {
    const nxEntries = listing.entries.filter((e) =>
      e.key.startsWith(cacheKey("")),
    );
    result.store_listing = {
      requests: listing.requests,
      entries: listing.total,
      bytes: listing.entries.reduce((sum, e) => sum + e.size_in_bytes, 0),
      nxEntries: nxEntries.length,
      nxBytes: nxEntries.reduce((sum, e) => sum + e.size_in_bytes, 0),
      // An entry under a key this run's PUT stored (200), created after this
      // run started, in this run's ref when the run has one: the Actions cache
      // records no producer, so this is the closest attribution it allows.
      storedByThisRun: nxEntries
        .filter(
          (e) =>
            wanted.has(e.key) &&
            new Date(e.created_at) >= started &&
            (!process.env.GITHUB_REF || e.ref === process.env.GITHUB_REF),
        )
        .map((e) => ({
          id: e.id,
          key: e.key,
          ref: e.ref,
          bytes: e.size_in_bytes,
          created_at: e.created_at,
        })),
      thisTask: nxEntries
        .filter((e) => log.some((entry) => e.key === cacheKey(entry.hash)))
        .map((e) => ({
          id: e.id,
          key: e.key,
          ref: e.ref,
          bytes: e.size_in_bytes,
        })),
    };
  }
}
if (sidecar) result.sidecarLog = join(sidecarLog, "sidecar.log");
rmSync(nxCache, { recursive: true, force: true });

const json = `${JSON.stringify(result, null, 2)}\n`;
const count = (list, code) => list.filter((e) => e.status === code).length;
const summary = `measure: ${options.label ?? options.task}: Nx exit ${nxExit} in ${nxMs} ms; GET 200 x${count(gets, 200)}, GET 404 x${count(gets, 404)}; PUT ${puts.map((e) => e.status).join(",") || "none"}; ${result.written.map((e) => `${e.hash} ${e.bytes} B`).join(", ") || "nothing written"}; listing ${result.store_listing?.requests ?? "not taken"} request(s)`;
if (options.out) {
  try {
    writeFileSync(options.out, json);
  } catch (error) {
    fail(
      `cannot write ${options.out}: ${error.message}`,
      "pass --out a path in a writable directory",
    );
  }
  console.log(`${summary}; record ${options.out}`);
} else {
  console.error(summary);
  process.stdout.write(json);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = log
    .map(
      (e) =>
        `| ${e.method} | ${e.hash} | ${e.status} | ${e.requestBytes} | ${e.responseBytes} | ${e.ms} |`,
    )
    .join("\n");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### measure ${options.label ?? options.task}\n\nNx exit ${nxExit} in ${nxMs} ms; listing cost ${result.store_listing?.requests ?? "n/a"} request(s).\n\n| method | hash | status | request bytes | response bytes | ms |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\n`,
  );
}
process.exit(nxExit ?? 1);
