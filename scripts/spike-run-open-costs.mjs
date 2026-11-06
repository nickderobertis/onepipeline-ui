#!/usr/bin/env node
/**
 * One measurement of what opening a run costs, over a named runs root.
 *
 *   node scripts/spike-run-open-costs.mjs --runs-root ROOT --measure MEASURE [--run RUN]
 *
 * Starts a fresh `onepipeline-api serve` on a spare loopback port, performs the one
 * request (or browser navigation) MEASURE names, attributes its wall time to named
 * causes from the spans the server wrote (`src/open_trace.rs`), stops that server by
 * the PID it started, and prints one JSON document. Only reads: it never sends a
 * write route, and the only thing a run under the root gains is the derived cache
 * any reader keeps.
 *
 * MEASURE:
 *   status           GET /api/v2/runs/<run>/status
 *   graph            POST /api/v2/subscriptions, the view Graph opens (`detail`)
 *   overall          the same, the view Overall opens (`timeline`, scope run)
 *   node             the same, a node timeline (--node, or the run's first node)
 *   sidebar          the same, no run: the sidebar alone
 *   page-graph, page-overall, page-node
 *                    a real browser opening that view, to history drawn
 *   human-items      GET /api/human-items per filter the page sends, right after the
 *                    journal of a scratch COPY of the root moved by one real record
 *   provider-probe   `oneharness usage --harness <--harness>`, no server at all
 *   cli-status       `<--cli> status <run>` (the installed `onepipeline`, or `just` with
 *                    --cwd on the orchestrator checkout), no server at all, with
 *                    --no-providers when that option is given
 *   cli-unpublished  `onepipeline unpublished --host` (--cli), no server at all, and
 *                    whether it refused with `Argument list too long`
 *   run-facts        a run's journal, no server: its streams, its records by kind, and what
 *                    resolving every transcript reference would read
 *   checkouts        each checkout `onevcs repos` registers: its ref count and the time
 *                    to list them, as counts only, no name
 *
 * Options: --cwd DIR (the server's working directory, where oneharness discovers its
 * configuration), --binary PATH, --ui-dist DIR, --prototype a,b (the branch's
 * ONEPIPELINE_UI_SPIKE switches), --profile (write CPU samples; attaches `hot`),
 * --keep-provider-env (leave this shell's CLAUDE_CONFIG_DIR in place; by default a
 * dispatch's own overrides are removed so the server sees what the host's long-lived
 * server sees), --concurrent N (N simultaneous status reads), --timeout SECONDS,
 * --stub-provider-seconds N (a `claude` on the server's PATH that burns N seconds of CPU
 * and exits, the stand-in a host without Claude Code needs for the sweep to cost what it
 * costs here), --server-path PATH (the server's PATH, so a host with no provider CLI can
 * be stood in for; the stub goes in front of it), --keep-profile PATH (copy the folded
 * stacks out). --concurrent also applies to a subscription, which then attributes nothing.
 *
 * --trace-exec (strace every process the server or `cli-unpublished` starts: counts by
 * program and refusals by E2BIG, so whether a read reaches git or onevcs is measured).
 *
 * `spikes/run-open-costs/matrix.sh` is every measurement the spike's report states.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_BINARY = join(
  REPO,
  "target/spike/release/onepipeline-api-profiled",
);

const VIEWS = {
  graph: (run) => ({ type: "detail", run_id: run }),
  overall: (run) => ({ type: "timeline", run_id: run, scope: "run" }),
  node: (run, node) => ({ type: "timeline", run_id: run, scope: "node", node }),
  sidebar: () => ({ type: "sidebar" }),
};

/** Span or running total → the cause it names, and the library that owns it. */
const CAUSES = {
  "status.present": ["run directory check", "onepipeline-ui"],
  "status.open": ["RunView::open: journal read and fold", "onepipeline"],
  "status.project": ["payload projection", "onepipeline-ui"],
  "open.run_view": ["RunView::open: journal read and fold", "onepipeline"],
  "open.index": ["Indexed::of: per-owner index", "onepipeline-ui"],
  "open.declared_members": [
    "declared members: graph records",
    "onepipeline-ui over oneagentgraph",
  ],
  "open.agents": ["verbs::agents: session list", "onepipeline"],
  "open.telemetry": ["telemetry fold", "onepipeline"],
  "subscribe.first_look": [
    "first_look: every run's metadata and summary",
    "onepipeline-ui over onepipeline",
  ],
  "subscribe.missing_row": ["sidebar row of the opened run", "onepipeline-ui"],
  "subscribe.boundary_locks": [
    "publication boundary lock wait",
    "onepipeline-ui",
  ],
  "subscribe.ensure_second": [
    "second ensure: re-enveloping the held payload",
    "onepipeline-ui",
  ],
  "subscribe.sidebar_snapshot": ["sidebar rows re-parsed", "onepipeline-ui"],
  "subscribe.serialize": ["response serialization", "onepipeline-ui"],
};

/** Thrown, so the `finally` that stops the server this started still runs. */
function fail(message) {
  throw new Error(message);
}

function options() {
  const { values } = parseArgs({
    options: {
      "runs-root": { type: "string" },
      measure: { type: "string" },
      run: { type: "string" },
      node: { type: "string" },
      cwd: { type: "string" },
      binary: { type: "string" },
      "ui-dist": { type: "string" },
      prototype: { type: "string" },
      profile: { type: "boolean", default: false },
      "keep-provider-env": { type: "boolean", default: false },
      concurrent: { type: "string", default: "1" },
      cli: { type: "string", default: "onepipeline" },
      "no-providers": { type: "boolean", default: false },
      harness: { type: "string", default: "claude-code" },
      timeout: { type: "string", default: "580" },
      "stub-provider-seconds": { type: "string" },
      "keep-profile": { type: "string" },
      "server-path": { type: "string" },
      "trace-exec": { type: "boolean", default: false },
    },
  });
  if (!values.measure) fail("--measure names what to measure");
  const known = [
    ...Object.keys(VIEWS),
    "status",
    "page-graph",
    "page-overall",
    "page-node",
    "human-items",
    "provider-probe",
    "cli-status",
    "cli-unpublished",
    "checkouts",
    "run-facts",
  ];
  if (!known.includes(values.measure))
    fail(`no measure ${values.measure}: one of ${known.join(", ")}`);
  if (
    !["provider-probe", "checkouts", "cli-unpublished"].includes(values.measure) &&
    !values["runs-root"]
  )
    fail("--runs-root names the root to serve");
  const runless = [
    "sidebar",
    "human-items",
    "provider-probe",
    "checkouts",
    "cli-unpublished",
  ];
  if (!runless.includes(values.measure) && !values.run)
    fail(`--run names the run ${values.measure} reads`);
  return values;
}

const load = () => loadavg().map((one) => Math.round(one * 100) / 100);

/** This shell's environment without what a dispatch sets for itself. */
function serverEnv(keepProviderEnv) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/^(ONEPIPELINE_|ONEVCS_|ORCHESTRATOR_)/u.test(name)) delete env[name];
  if (!keepProviderEnv) {
    delete env.CLAUDE_CONFIG_DIR;
    delete env.XDG_RUNTIME_DIR;
  }
  return env;
}

class Server {
  constructor(values, root, scratch) {
    const binary = values.binary ?? DEFAULT_BINARY;
    if (!existsSync(binary))
      fail(`no binary at ${binary}: build it with scripts/spike-run-open-costs-build.sh`);
    this.tracePath = join(scratch, "trace.jsonl");
    this.profilePath = join(scratch, "profile.folded");
    const args = [
      "serve",
      "--runs-root",
      root,
      "--bind",
      "127.0.0.1:0",
      "--session",
      `spike-run-open-costs-${process.pid}`,
    ];
    if (values.measure.startsWith("page-")) args.push("--ui");
    // The profiled build's embedded bundle is whatever `dist` held when it compiled.
    const bundle =
      values["ui-dist"] ??
      (values.measure.startsWith("page-") && !values.binary
        ? join(REPO, "apps/dag-ui/dist")
        : undefined);
    if (bundle) args.push("--ui-dist", bundle);
    const env = serverEnv(values["keep-provider-env"]);
    env.ONEPIPELINE_UI_OPEN_TRACE = this.tracePath;
    if (values.prototype) env.ONEPIPELINE_UI_SPIKE = values.prototype;
    if (values.profile) env.ONEPIPELINE_UI_PROFILE = this.profilePath;
    if (values["server-path"]) env.PATH = values["server-path"];
    if (values["stub-provider-seconds"]) {
      const bin = join(scratch, "stub-bin");
      mkdirSync(bin, { recursive: true });
      // Exiting without an answer is what an unauthenticated CLI does; the seconds are
      // on-CPU so the stub behaves as the real start does under load.
      const script = `#!/bin/sh\nend=$(( $(date +%s) + ${Number(values["stub-provider-seconds"])} ))\nwhile [ "$(date +%s)" -lt "$end" ]; do :; done\n`;
      writeFileSync(join(bin, "claude"), script, { mode: 0o755 });
      env.PATH = `${bin}:${env.PATH}`;
    }
    this.tracePid = values["trace-exec"];
    this.execPath = join(scratch, "exec.strace");
    const [program, argv] = this.tracePid
      ? ["strace", ["-f", "-qq", "-e", "trace=execve", "-o", this.execPath, binary, ...args]]
      : [binary, args];
    this.child = spawn(program, argv, {
      cwd: values.cwd ?? dirname(root),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.binary = binary;
    this.exited = new Promise((done) => this.child.once("exit", done));
  }

  /** The address the server announces once it has bound. */
  listening() {
    return new Promise((done, refuse) => {
      let text = "";
      const read = (chunk) => {
        text += chunk;
        const found = /http:\/\/(127\.0\.0\.1:\d+)/u.exec(text);
        if (found) done(`http://${found[1]}`);
      };
      this.child.stdout.on("data", read);
      this.child.stderr.on("data", (chunk) => {
        text += chunk;
      });
      this.child.once("exit", (code) =>
        refuse(new Error(`the server exited ${code}: ${text}`)),
      );
    });
  }

  /** Stop the one process this started. */
  async stop() {
    // Under strace the signal has to reach the server itself.
    if (this.tracePid) {
      const pid = this.child.pid;
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
      for (const child of children.trim().split(/\s+/u).filter(Boolean))
        process.kill(Number(child), "SIGTERM");
    } else this.child.kill("SIGTERM");
    const grace = new Promise((done) => setTimeout(done, 30_000, "late"));
    if ((await Promise.race([this.exited, grace])) === "late")
      this.child.kill("SIGKILL");
    await this.exited;
  }

  residentKb() {
    if (this.tracePid) return null;
    const status = readFileSync(`/proc/${this.child.pid}/status`, "utf8");
    const of = (name) =>
      Number(new RegExp(`${name}:\\s+(\\d+)`, "u").exec(status)?.[1] ?? 0);
    return { rss_kb: of("VmRSS"), peak_kb: of("VmHWM") };
  }

  cpuSeconds() {
    if (this.tracePid) return null;
    const stat = readFileSync(`/proc/${this.child.pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(after[11]) + Number(after[12])) / 100;
  }

  spans() {
    if (!existsSync(this.tracePath)) return [];
    return readFileSync(this.tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

/** Sum the spans with `name`, in seconds. */
const total = (spans, name, field = "wall_ms") =>
  spans
    .filter((span) => span.span === name || span.total === name)
    .reduce((sum, span) => sum + span[field], 0) / 1000;

function causes(wall, measure, spans) {
  const rows = [];
  const add = (cause, owner, seconds, method) => {
    if (seconds > 0)
      rows.push({
        cause,
        owner,
        seconds: Math.round(seconds * 1000) / 1000,
        share: Math.round((seconds / wall) * 1000) / 1000,
        method,
      });
  };
  const named = (name) => spans.filter((span) => span.span === name);
  // A clone inside the second ensure is counted once, as the clone.
  const within = (outer, inner) =>
    named(inner)
      .filter((span) =>
        named(outer).some(
          (held) =>
            span.began_unix_ms >= held.began_unix_ms &&
            span.began_unix_ms <= held.began_unix_ms + held.wall_ms,
        ),
      )
      .reduce((sum, span) => sum + span.wall_ms, 0) / 1000;
  for (const [name, [cause, owner]] of Object.entries(CAUSES)) {
    const seconds =
      name === "subscribe.ensure_second"
        ? total(spans, name) - within(name, "ensure.timeline_clone")
        : total(spans, name);
    add(cause, owner, seconds, `span ${name}`);
  }
  const whole = measure === "status" ? "status" : "subscribe";
  add(
    "the request around the handler: loopback, axum, the blocking pool's hand-off, the client's fetch",
    "onepipeline-ui / this harness's client",
    wall - total(spans, whole) - total(spans, "subscribe.serialize"),
    `harness wall minus span ${whole} and the serialization`,
  );
  if (measure === "status") {
    const shadow = total(spans, "status.shadow_render_without_providers");
    const full = total(spans, "status.render_with_providers");
    add(
      "provider sweep: oneagentgraph::health → oneharness usage --all, starting each provider CLI",
      "onepipeline (asks) / oneagentgraph / oneharness-core",
      full - shadow,
      "span status.render_with_providers minus the same render without providers",
    );
    add(
      "status text without providers",
      "onepipeline",
      shadow,
      "span status.shadow_render_without_providers",
    );
    add(
      "the harness's own extra render, which an untraced read does not pay",
      "this harness",
      shadow,
      "span status.shadow_render_without_providers, paid once more than the read needs",
    );
  } else {
    const transcripts = total(spans, "activity.transcript_read");
    const allReads = total(spans, "transcript.read_all");
    const rowReads = Math.max(0, allReads - transcripts);
    const detail = total(spans, "ensure.detail_build");
    const timeline = total(spans, "ensure.timeline_build");
    add(
      "activity description: a whole session transcript read and parsed per turn-activity record",
      "onepipeline-ui (asks per record) / onepipeline (whole-file resolve)",
      transcripts,
      "running total activity.transcript_read",
    );
    add(
      "transcript read for a timeline row or a conversation's turn",
      "onepipeline-ui (asks per record) / onepipeline (whole-file resolve)",
      rowReads,
      "running total transcript.read_all minus activity.transcript_read",
    );
    // Reads sit inside either build; each build's remainder is what it did besides.
    const inBuilds = transcripts + rowReads;
    const detailReads = Math.min(inBuilds, detail);
    add(
      "detail document apart from those reads",
      "onepipeline-ui",
      detail - detailReads,
      "span ensure.detail_build minus the reads it held",
    );
    add(
      "timeline apart from those reads",
      "onepipeline-ui",
      timeline - Math.min(inBuilds - detailReads, timeline),
      "span ensure.timeline_build minus the reads it held",
    );
    add(
      "timeline re-enveloped",
      "onepipeline-ui",
      total(spans, "ensure.timeline_clone"),
      "span ensure.timeline_clone",
    );
    const held = (outer, parts) =>
      total(spans, outer) -
      parts.reduce((sum, part) => sum + total(spans, part), 0);
    add(
      "LiveRun::open and hub bookkeeping between the named steps",
      "onepipeline-ui",
      held("subscribe.live_run", [
        "open.run_view",
        "open.index",
        "open.declared_members",
        "open.agents",
        "open.telemetry",
      ]),
      "span subscribe.live_run minus the open.* spans it holds",
    );
    add(
      "subscription bookkeeping after the boundary",
      "onepipeline-ui",
      total(spans, "subscribe") -
        [
          "subscribe.live_run",
          "subscribe.ensure_first",
          "subscribe.first_look",
          "subscribe.missing_row",
          "subscribe.boundary_locks",
          "subscribe.ensure_second",
          "subscribe.sidebar_snapshot",
        ].reduce((sum, part) => sum + total(spans, part), 0),
      "span subscribe minus the subscribe.* spans it holds",
    );
  }
  rows.sort((left, right) => right.seconds - left.seconds);
  const attributed = rows.reduce((sum, row) => sum + row.seconds, 0);
  return {
    rows,
    attributed_share: Math.round((attributed / wall) * 1000) / 1000,
    unattributed_seconds: Math.round((wall - attributed) * 1000) / 1000,
  };
}

/** Which library each sampled frame's inclusive CPU belongs to. */
function hotFrames(path) {
  if (!existsSync(path)) return null;
  const inclusive = new Map();
  let samples = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at < 0) continue;
    const count = Number(line.slice(at + 1));
    samples += count;
    const frames = new Set(
      line
        .slice(0, at)
        .split(";")
        .map((frame) => frame.replace(/<.*$/u, "")),
    );
    for (const frame of frames)
      inclusive.set(frame, (inclusive.get(frame) ?? 0) + count);
  }
  const named = [...inclusive]
    .filter(([frame]) =>
      /^(absorb|resolve|read|live_activity_over|whole|from_str|open|fold|of_run|merge_order|owner_turns|detail_document|ensure|build|first_look)$/u.test(
        frame,
      ),
    )
    .sort((left, right) => right[1] - left[1])
    .map(([frame, count]) => ({
      frame,
      share: Math.round((count / samples) * 1000) / 1000,
    }));
  return { samples, inclusive: named };
}

/**
 * One request over `node:http`: `fetch` gives up at 300 s without the response's headers,
 * which is shorter than the reads this measures.
 */
function timed(url, init, seconds) {
  return new Promise((done, refuse) => {
    const started = performance.now();
    const request = httpRequest(
      url,
      { method: init.method ?? "GET", headers: init.headers ?? {} },
      (response) => {
        const firstByte = (performance.now() - started) / 1000;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", refuse);
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          done({
            status: response.statusCode,
            seconds: (performance.now() - started) / 1000,
            first_byte_seconds: firstByte,
            bytes: body.length,
            body: body.toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(seconds * 1000, () =>
      request.destroy(new Error(`no answer from ${url} within ${seconds} s`)),
    );
    request.on("error", refuse);
    request.end(init.body);
  });
}

/** How long the event stream takes to answer, closed as soon as it has. */
function eventsHeader(origin, subscription, seconds) {
  return new Promise((done, refuse) => {
    const started = performance.now();
    const request = httpRequest(
      `${origin}/api/v2/events?subscription=${subscription}`,
      { headers: { accept: "text/event-stream" } },
      (response) => {
        const opened = (performance.now() - started) / 1000;
        response.destroy();
        done({ status: response.statusCode, seconds: opened });
      },
    );
    request.setTimeout(seconds * 1000, () =>
      request.destroy(new Error(`no event stream within ${seconds} s`)),
    );
    request.on("error", refuse);
    request.end();
  });
}

/**
 * The node a reader opens: the last one dispatched. A retried node runs under a new id,
 * so the plan's first task may be nothing the graph shows.
 */
function firstNodeOf(root, run) {
  const lines = readFileSync(join(root, run, "events.jsonl"), "utf8").split("\n");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (!lines[at].includes('"node-dispatched"')) continue;
    const node = JSON.parse(lines[at]).labels?.node;
    if (node) return node;
  }
  return fail(`${run} has dispatched no node to open`);
}

async function subscribeMeasure(values, server, origin, root) {
  const node =
    values.measure === "node"
      ? (values.node ?? firstNodeOf(root, values.run))
      : undefined;
  const view = VIEWS[values.measure](values.run, node);
  const budget = Number(values.timeout);
  const postings = await Promise.all(
    Array.from({ length: Number(values.concurrent) }, () =>
      timed(
        `${origin}/api/v2/subscriptions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ view }),
        },
        budget,
      ),
    ),
  );
  const refused = postings.find((one) => one.status !== 201);
  if (refused) fail(`subscribe: ${refused.status} ${refused.body}`);
  const posted = postings.reduce((slowest, one) =>
    one.seconds > slowest.seconds ? one : slowest,
  );
  const answer = JSON.parse(posted.body);
  const events = await eventsHeader(origin, answer.subscription, budget);
  return {
    view,
    wall_seconds: posted.seconds,
    each_seconds: postings.map((one) => Math.round(one.seconds * 100) / 100),
    response_bytes: posted.bytes,
    events_open_seconds: events.seconds,
    sidebar_rows: answer.initial.snapshot.sidebar.length,
    server: server.residentKb(),
    server_cpu_seconds: server.cpuSeconds(),
  };
}

function cliStatus(values, root) {
  const started = performance.now();
  const env = serverEnv(values["keep-provider-env"]);
  env.ONEPIPELINE_RUNS_DIR = root;
  const args = ["status", values.run];
  if (values["no-providers"]) args.push("--no-providers");
  const read = spawnSync(values.cli, args, {
    cwd: values.cwd ?? dirname(root),
    env,
    encoding: "utf8",
    timeout: Number(values.timeout) * 1000,
    maxBuffer: 1 << 28,
  });
  return {
    wall_seconds: (performance.now() - started) / 1000,
    exit: read.status,
    no_providers: values["no-providers"],
    bytes: Buffer.byteLength(read.stdout ?? ""),
  };
}

/** What an `strace -e execve` log says was started, and what the kernel refused. */
function execCounts(path) {
  if (!existsSync(path)) return null;
  const programs = {};
  let tooLong = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const named = /execve\("([^"]+)"/u.exec(line);
    if (!named) continue;
    if (line.includes("E2BIG")) {
      tooLong += 1;
    }
    if (/= -1 /u.test(line)) continue;
    const name = named[1].split("/").at(-1);
    programs[name] = (programs[name] ?? 0) + 1;
  }
  return { programs, argument_list_too_long: tooLong };
}

function cliUnpublished(values, scratch) {
  const started = performance.now();
  const trace = join(scratch, "exec.strace");
  const [program, prefix] = values["trace-exec"]
    ? ["strace", ["-f", "-qq", "-e", "trace=execve", "-o", trace, values.cli]]
    : [values.cli, []];
  const read = spawnSync(program, [...prefix, "unpublished", "--host"], {
    cwd: values.cwd ?? process.cwd(),
    env: serverEnv(values["keep-provider-env"]),
    encoding: "utf8",
    timeout: Number(values.timeout) * 1000,
    maxBuffer: 1 << 28,
  });
  const stderr = `${read.stderr ?? ""}${read.stdout ?? ""}`;
  return {
    wall_seconds: (performance.now() - started) / 1000,
    exit: read.status,
    timed_out: read.error?.code === "ETIMEDOUT",
    argument_list_too_long: /Argument list too long/u.test(stderr),
    output_lines: stderr.split("\n").filter(Boolean).length,
    execs: execCounts(trace),
  };
}

/** Every registered checkout's ref count and the time to list them: counts only. */
function checkouts(values) {
  const listing = spawnSync("onevcs", ["repos"], {
    cwd: values.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 1 << 26,
  }).stdout;
  const paths = listing
    .split("\n")
    .map((line) => /^\s+\S+\t(\/\S+)/u.exec(line)?.[1])
    .filter((path) => path && existsSync(path));
  const started = performance.now();
  const rows = paths
    .map((cwd) => {
      const at = performance.now();
      const refs = spawnSync("git", ["for-each-ref", "--format=x"], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 << 26,
      }).stdout;
      return {
        refs: (refs ?? "").split("\n").length - 1,
        seconds: (performance.now() - at) / 1000,
      };
    })
    .sort((left, right) => right.refs - left.refs);
  return {
    wall_seconds: (performance.now() - started) / 1000,
    checkouts: rows.length,
    largest: rows.slice(0, 5).map((row) => ({
      refs: row.refs,
      seconds: Math.round(row.seconds * 1000) / 1000,
    })),
    total_refs: rows.reduce((sum, row) => sum + row.refs, 0),
  };
}

function runFactsMeasure(values, root) {
  const started = performance.now();
  const streams = new Map();
  const kinds = new Map();
  const files = new Map();
  let references = 0;
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const text = readFileSync(join(root, values.run, "events.jsonl"), "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    count(streams, record.stream);
    count(kinds, record.kind);
    const reference = record.payload?.transcript;
    if (reference?.history_session) {
      references += 1;
      count(
        files,
        join(
          reference.history_dir ?? "",
          reference.history_project ?? "",
          `${reference.history_session}.jsonl`,
        ),
      );
    }
  }
  let bytes = 0;
  let largest = 0;
  for (const [path, times] of files) {
    const size = existsSync(path) ? statSync(path).size : 0;
    bytes += size * times;
    largest = Math.max(largest, size);
  }
  return {
    wall_seconds: (performance.now() - started) / 1000,
    streams: streams.size,
    records_per_stream: Math.round(
      [...streams.values()].reduce((sum, n) => sum + n, 0) / Math.max(streams.size, 1),
    ),
    kinds: [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 6),
    transcript_references: references,
    session_files: files.size,
    largest_session_mb: Math.round(largest / 1e4) / 100,
    reference_weighted_session_mb:
      Math.round(bytes / Math.max(references, 1) / 1e4) / 100,
    gb_read_if_each_reference_reads_its_file: Math.round(bytes / 1e8) / 10,
  };
}

async function statusMeasure(values, server, origin) {
  const budget = Number(values.timeout);
  const url = `${origin}/api/v2/runs/${values.run}/status`;
  const reads = await Promise.all(
    Array.from({ length: Number(values.concurrent) }, () =>
      timed(url, {}, budget),
    ),
  );
  const refused = reads.find((read) => read.status !== 200);
  if (refused) fail(`status: ${refused.status} ${refused.body}`);
  const rendered = JSON.parse(reads[0].body).rendered ?? "";
  return {
    wall_seconds: Math.max(...reads.map((read) => read.seconds)),
    each_seconds: reads.map((read) => Math.round(read.seconds * 100) / 100),
    response_bytes: reads[0].bytes,
    identities: (rendered.match(/"harness":/gu) ?? []).length,
    server: server.residentKb(),
    server_cpu_seconds: server.cpuSeconds(),
  };
}

/** The real page: navigate, and time until the view shows the run's history. */
async function pageMeasure(values, server, origin, root) {
  const require = createRequire(join(REPO, "apps/dag-ui-e2e/package.json"));
  const { chromium } = require("@playwright/test");
  const view = values.measure.slice("page-".length);
  const node = view === "node" ? (values.node ?? firstNodeOf(root, values.run)) : null;
  const address =
    view === "node"
      ? `/?run=${values.run}&view=graph&node=${node}`
      : `/?run=${values.run}&view=${view}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const started = performance.now();
    const since = () => (performance.now() - started) / 1000;
    let subscribed = null;
    page.on("response", (response) => {
      if (
        subscribed === null &&
        response.url().endsWith("/api/v2/subscriptions") &&
        response.request().method() === "POST"
      )
        subscribed = since();
    });
    await page.goto(`${origin}${address}`);
    const budget = Number(values.timeout) * 1000;
    const shown =
      view === "graph"
        ? page.getByLabel("DAG execution graph").first()
        : view === "overall"
          ? page.getByRole("heading", { name: "Graph timeline" }).first()
          : page.getByRole("region", { name: /^Timeline for / }).first();
    await shown.waitFor({ timeout: budget }).catch(async (error) => {
      const text = await page.locator("body").innerText();
      fail(`no ${view} view within the budget: ${error.message}\n${text.slice(-700)}`);
    });
    const wall = since();
    return {
      address,
      wall_seconds: wall,
      subscribe_answered_seconds: subscribed,
      server: server.residentKb(),
      server_cpu_seconds: server.cpuSeconds(),
    };
  } finally {
    await browser.close();
  }
}

/** What the page's filters send: the default view and each state it offers. */
const HUMAN_ITEM_QUERIES = [
  "",
  "?state=answered",
  "?state=completed",
  "?state=dismissed",
];

function itemsById(body) {
  return new Map(
    JSON.parse(body).items.map((view) => [view.item.id, JSON.stringify(view)]),
  );
}

/**
 * The cost of one human-item write, without writing anything real: a scratch copy of
 * the root's `human-items` directory with its journal cut one record short, read; then
 * that record appended, as the write would, and read again per view. What the second
 * read costs is the query a pushing server would run on a poll where the journal moved,
 * and what differs between the two answers is the patch it would send.
 */
async function humanItemsMeasure(values, scratch) {
  const copy = join(scratch, "root");
  mkdirSync(copy, { recursive: true });
  cpSync(join(values["runs-root"], "human-items"), join(copy, "human-items"), {
    recursive: true,
    filter: (source) => !source.includes("/bus"),
  });
  const journal = join(copy, "human-items", "events.ndjson");
  const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean);
  if (lines.length < 2) fail("the journal holds fewer than two records");
  writeFileSync(journal, `${lines.slice(0, -1).join("\n")}\n`);
  rmSync(join(copy, "human-items", "index.json"), { force: true });
  const server = new Server(values, copy, scratch);
  try {
    const origin = await server.listening();
    const budget = Number(values.timeout);
    const read = async (query) => {
      const answer = await timed(`${origin}/api/human-items${query}`, {}, budget);
      if (answer.status !== 200)
        fail(`human-items${query}: ${answer.status} ${answer.body}`);
      return answer;
    };
    const was = new Map();
    for (const query of HUMAN_ITEM_QUERIES)
      was.set(query, itemsById((await read(query)).body));
    appendFileSync(journal, `${lines.at(-1)}\n`);
    const views = [];
    for (const query of HUMAN_ITEM_QUERIES) {
      const answer = await read(query);
      const now = itemsById(answer.body);
      const before = was.get(query);
      const changed = [...now].filter(([id, item]) => before.get(id) !== item);
      const removed = [...before.keys()].filter((id) => !now.has(id));
      views.push({
        query,
        seconds: answer.seconds,
        list_bytes: answer.bytes,
        items: now.size,
        items_changed: changed.length,
        items_removed: removed.length,
        // What a patch would carry: each changed item whole, and each removed id.
        patch_bytes:
          changed.reduce((sum, [, item]) => sum + item.length, 0) +
          removed.reduce((sum, id) => sum + id.length, 0),
      });
    }
    return {
      journal_records: lines.length,
      journal_bytes: statSync(journal).size,
      index_bytes: existsSync(join(copy, "human-items", "index.json"))
        ? statSync(join(copy, "human-items", "index.json")).size
        : 0,
      views,
      query_seconds_all_views: views.reduce((sum, view) => sum + view.seconds, 0),
      patch_bytes_all_views: views.reduce((sum, view) => sum + view.patch_bytes, 0),
      whole_list_bytes_all_views: views.reduce(
        (sum, view) => sum + view.list_bytes,
        0,
      ),
      wall_seconds: Math.max(...views.map((view) => view.seconds)),
    };
  } finally {
    await server.stop();
  }
}

function providerProbe(values) {
  const started = performance.now();
  const probe = spawnSync(
    "/usr/bin/time",
    [
      "-f",
      "cpu=%U %S rss=%M",
      "oneharness",
      "usage",
      "--harness",
      values.harness,
      "--format",
      "json",
    ],
    {
      cwd: values.cwd ?? process.cwd(),
      env: serverEnv(values["keep-provider-env"]),
      encoding: "utf8",
      timeout: Number(values.timeout) * 1000,
    },
  );
  const usage = /cpu=([\d.]+) ([\d.]+) rss=(\d+)/u.exec(probe.stderr ?? "");
  const wall = (performance.now() - started) / 1000;
  const state = JSON.parse(probe.stdout || '{"identities":[]}').identities.map(
    (identity) => identity.availability.state,
  );
  return {
    harness: values.harness,
    wall_seconds: wall,
    exit: probe.status,
    state,
    cpu_seconds: usage ? Number(usage[1]) + Number(usage[2]) : null,
    peak_rss_kb: usage ? Number(usage[3]) : null,
  };
}

function runFacts(root, run) {
  if (!run) return null;
  const journal = join(root, run, "events.jsonl");
  const bytes = statSync(journal).size;
  const fd = openSync(journal, "r");
  const chunk = Buffer.alloc(1 << 20);
  let records = 0;
  for (let read; (read = readSync(fd, chunk)) > 0; )
    for (let at = 0; at < read; at += 1) if (chunk[at] === 10) records += 1;
  closeSync(fd);
  const plan = JSON.parse(readFileSync(join(root, run, "plan.json"), "utf8"));
  return {
    journal_bytes: bytes,
    records,
    nodes: plan.tasks?.length ?? 0,
    settled: existsSync(join(root, run, "result.json")),
  };
}

async function main() {
  const values = options();
  const scratch = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "run-open-costs-"),
  );
  const root = values["runs-root"] ? resolve(values["runs-root"]) : null;
  const before = load();
  const startedAt = new Date().toISOString();
  let result;
  let spans = [];
  let hot = null;
  try {
    if (values.measure === "provider-probe") result = providerProbe(values);
    else if (values.measure === "cli-status") result = cliStatus(values, root);
    else if (values.measure === "cli-unpublished") result = cliUnpublished(values, scratch);
    else if (values.measure === "run-facts") result = runFactsMeasure(values, root);
    else if (values.measure === "checkouts") result = checkouts(values);
    else if (values.measure === "human-items")
      result = await humanItemsMeasure(values, scratch);
    else {
      const server = new Server(values, root, scratch);
      try {
        const origin = await server.listening();
        // The client's own first-fetch set-up is not the read's cost.
        await fetch(`${origin}/healthz`).then((answer) => answer.text());
        result = values.measure.startsWith("page-")
          ? await pageMeasure(values, server, origin, root)
          : values.measure === "status"
            ? await statusMeasure(values, server, origin)
            : await subscribeMeasure(values, server, origin, root);
      } finally {
        await server.stop();
      }
      spans = server.spans();
      hot = hotFrames(server.profilePath);
      if (values["trace-exec"]) result.execs = execCounts(server.execPath);
    }
    const attribution =
      // A page subscribes more than once, so its spans do not sum to its wall.
      spans.length > 0 && Number(values.concurrent) === 1 && !values.measure.startsWith("page-")
        ? causes(result.wall_seconds, values.measure, spans)
        : null;
    console.log(
      JSON.stringify(
        {
          measure: values.measure,
          run: values.run ?? null,
          run_facts: root ? runFacts(root, values.run) : null,
          runs_root: root,
          runs_under_root: root
            ? spawnSync("ls", [root], { encoding: "utf8" }).stdout.split("\n").length - 1
            : null,
          binary: values.binary ?? DEFAULT_BINARY,
          prototype: values.prototype ?? null,
          profiled: values.profile,
          started_at: startedAt,
          cores: cpus().length,
          load_before: before,
          load_after: load(),
          ...result,
          after_answer: spans.length
            ? {
                poll_refresh_seconds: total(spans, "poll.refresh"),
                poll_timeline_refreshed_seconds: total(
                  spans,
                  "poll.timeline_refreshed",
                ),
              }
            : null,
          memory_steps_kb: spans
            .filter((span) => span.span && span.rss_kb_after - span.rss_kb_before > 20_480)
            .map((span) => ({
              span: span.span,
              grew_kb: span.rss_kb_after - span.rss_kb_before,
              minor_faults: span.minor_faults,
              wall_ms: Math.round(span.wall_ms),
              cpu_ms: Math.round(span.cpu_ms),
              runqueue_ms: Math.round(span.runqueue_ms),
            })),
          attribution,
          hot,
        },
        null,
        2,
      ),
    );
  } finally {
    if (values["keep-profile"] && existsSync(join(scratch, "profile.folded")))
      cpSync(join(scratch, "profile.folded"), values["keep-profile"]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(`spike-run-open-costs: ${error.message}`);
  process.exitCode = 2;
});
