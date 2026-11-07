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
 *   content-graph, content-overall, content-node, content-status
 *                    the same read from a server with --baseline-prototype and one with
 *                    --prototype, the two answers compared field by field. `equal` says
 *                    whether they agree; `differences` groups what does not by path.
 *                    Only `observed_at` is ignored, and only a run that is not changing
 *                    gives a meaningful answer.
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
 *   first-graph, first-overall, first-node
 *                    one first-screen measurement: a real browser, from navigation start to
 *                    the rendered mark, split into navigation to POST start, the POST, and
 *                    the answer to the mark. --client today|trimmed (default trimmed),
 *                    --cache warm|cold (default warm: the bundle already in the HTTP cache),
 *                    --server warm|fresh (default warm: one sidebar read answered).
 *   first-answer-graph, first-answer-overall, first-answer-node
 *                    that first answer alone, at the API: its seconds, bytes and steps.
 *   first-content-graph, first-content-overall, first-content-node
 *                    every value of that view's first answer against the complete read, in
 *                    three groups: equal, marked loading, different. --first-query adds to
 *                    the first answer's query (`whole=1`, `no_stream_ends=1`, `checkpoint=1`).
 *   first-rest       the first answer, then the complete read, with one page of a span's
 *                    events and one node's rows read during it and after it.
 *   first-open-current  what `RunView::open_current` spends on this run, step by step.
 *   first-kinds      a run's journal: records and bytes by kind, no server.
 *
 * `spikes/run-open-costs/matrix.sh` is every measurement the run-open-costs report states,
 * and `spikes/first-screen/matrix.sh` every one the first-screen report states.
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
import { gzipSync } from "node:zlib";

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

const FIRST_PAGE_MEASURES = ["first-graph", "first-overall", "first-node"];
/** The switches a first answer's server runs with; the complete read beside it too. */
const FIRST_PROTOTYPES = "first-screen,session-index,heap-merge,lazy-activity";

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
      "baseline-prototype": { type: "string" },
      client: { type: "string", default: "trimmed" },
      cache: { type: "string", default: "warm" },
      server: { type: "string", default: "warm" },
      "first-query": { type: "string", default: "" },
      "keep-answers": { type: "string" },
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
    "content-graph",
    "content-overall",
    "content-node",
    "content-status",
    "first-graph",
    "first-overall",
    "first-node",
    "first-answer-graph",
    "first-answer-overall",
    "first-answer-node",
    "first-content-graph",
    "first-content-overall",
    "first-content-node",
    "first-rest",
    "first-open-current",
    "first-kinds",
  ];
  if (!["trimmed", "today"].includes(values.client))
    fail(`--client is today or trimmed, not ${values.client}`);
  if (!["warm", "cold"].includes(values.cache))
    fail(`--cache is warm or cold, not ${values.cache}`);
  if (!["warm", "fresh"].includes(values.server))
    fail(`--server is warm or fresh, not ${values.server}`);
  if (!known.includes(values.measure))
    fail(`no measure ${values.measure}: one of ${known.join(", ")}`);
  if (
    !["provider-probe", "checkouts", "cli-unpublished"].includes(
      values.measure,
    ) &&
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
      fail(
        `no binary at ${binary}: build it with scripts/spike-run-open-costs-build.sh`,
      );
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
    const firstPage = FIRST_PAGE_MEASURES.includes(values.measure);
    if (values.measure.startsWith("page-") || firstPage) args.push("--ui");
    // The profiled build's embedded bundle is whatever `dist` held when it compiled.
    const bundle =
      values["ui-dist"] ??
      (firstPage
        ? join(
            REPO,
            values.client === "today"
              ? "apps/dag-ui/dist"
              : "target/spike/first-dist",
          )
        : values.measure.startsWith("page-") && !values.binary
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
      ? [
          "strace",
          [
            "-f",
            "-qq",
            "-e",
            "trace=execve",
            "-o",
            this.execPath,
            binary,
            ...args,
          ],
        ]
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
      const children = readFileSync(
        `/proc/${pid}/task/${pid}/children`,
        "utf8",
      );
      for (const child of children.trim().split(/\s+/u).filter(Boolean))
        process.kill(Number(child), "SIGTERM");
    } else this.child.kill("SIGTERM");
    let timer;
    const grace = new Promise((done) => {
      timer = setTimeout(done, 30_000, "late");
    });
    if ((await Promise.race([this.exited, grace])) === "late")
      this.child.kill("SIGKILL");
    await this.exited;
    // A timer left running would hold this process open for the rest of the 30 s.
    clearTimeout(timer);
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
      {
        method: init.method ?? "GET",
        headers: init.headers ?? {},
        agent: false,
      },
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
  const lines = readFileSync(join(root, run, "events.jsonl"), "utf8").split(
    "\n",
  );
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
      [...streams.values()].reduce((sum, n) => sum + n, 0) /
        Math.max(streams.size, 1),
    ),
    kinds: [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 6),
    transcript_references: references,
    session_files: files.size,
    largest_session_mb: Math.round(largest / 1e4) / 100,
    reference_weighted_session_mb:
      Math.round(bytes / Math.max(references, 1) / 1e4) / 100,
    gb_read_if_each_reference_reads_its_file: Math.round(bytes / 1e8) / 10,
    checkpoint_bytes: existsSync(join(root, values.run, "checkpoint.json"))
      ? statSync(join(root, values.run, "checkpoint.json")).size
      : 0,
  };
}

/** Dynamic keys (node ids, sessions) and array positions fold into one path. */
const pathStep = (key) =>
  typeof key === "number"
    ? "[]"
    : /^[a-z][a-z_]*$/u.test(key)
      ? `.${key}`
      : ".*";

/** Every place two JSON values disagree, by path: missing, extra or changed. */
function compareValues(baseline, other, path, groups) {
  const note = (kind) => {
    const name = `${kind} ${path || "."}`;
    groups.set(name, (groups.get(name) ?? 0) + 1);
  };
  if (baseline === other) return;
  if (
    typeof baseline !== "object" ||
    typeof other !== "object" ||
    baseline === null ||
    other === null ||
    Array.isArray(baseline) !== Array.isArray(other)
  ) {
    note("changed");
    return;
  }
  if (Array.isArray(baseline)) {
    for (let at = 0; at < Math.max(baseline.length, other.length); at += 1) {
      if (at >= other.length) note(`missing ${pathStep(at)}`);
      else if (at >= baseline.length) note(`extra ${pathStep(at)}`);
      else compareValues(baseline[at], other[at], path + pathStep(at), groups);
    }
    return;
  }
  for (const key of new Set([
    ...Object.keys(baseline),
    ...Object.keys(other),
  ])) {
    if (key === "observed_at") continue;
    const step = path + pathStep(key);
    if (!(key in other)) {
      const name = `missing ${step}`;
      groups.set(name, (groups.get(name) ?? 0) + 1);
    } else if (!(key in baseline)) {
      const name = `extra ${step}`;
      groups.set(name, (groups.get(name) ?? 0) + 1);
    } else compareValues(baseline[key], other[key], step, groups);
  }
}

/** The answer one server gives, with its prototype switches. */
async function contentRead(values, root, scratch, prototype, name) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const view = values.measure.slice("content-".length);
  const server = new Server({ ...values, prototype }, root, dir);
  const budget = Number(values.timeout);
  try {
    const origin = await server.listening();
    if (view === "status") {
      const read = await timed(
        `${origin}/api/v2/runs/${values.run}/status`,
        {},
        budget,
      );
      if (read.status !== 200) fail(`status: ${read.status} ${read.body}`);
      return { seconds: read.seconds, value: JSON.parse(read.body) };
    }
    const node =
      view === "node"
        ? (values.node ?? firstNodeOf(root, values.run))
        : undefined;
    const posted = await timed(
      `${origin}/api/v2/subscriptions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ view: VIEWS[view](values.run, node) }),
      },
      budget,
    );
    if (posted.status !== 201)
      fail(`subscribe: ${posted.status} ${posted.body}`);
    return {
      seconds: posted.seconds,
      value: JSON.parse(posted.body).initial.snapshot.visible,
    };
  } finally {
    await server.stop();
  }
}

async function contentMeasure(values, root, scratch) {
  const baselineRead = await contentRead(
    values,
    root,
    scratch,
    values["baseline-prototype"],
    "baseline",
  );
  const otherRead = await contentRead(
    values,
    root,
    scratch,
    values.prototype,
    "prototype",
  );
  const groups = new Map();
  compareValues(baselineRead.value, otherRead.value, "", groups);
  return {
    wall_seconds: baselineRead.seconds + otherRead.seconds,
    baseline_prototype: values["baseline-prototype"] ?? null,
    baseline_seconds: baselineRead.seconds,
    prototype_seconds: otherRead.seconds,
    baseline_bytes: JSON.stringify(baselineRead.value).length,
    prototype_bytes: JSON.stringify(otherRead.value).length,
    equal: groups.size === 0,
    differences: [...groups]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 60)
      .map(([path, count]) => ({ path, count })),
    difference_groups: groups.size,
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
  const node =
    view === "node" ? (values.node ?? firstNodeOf(root, values.run)) : null;
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
      fail(
        `no ${view} view within the budget: ${error.message}\n${text.slice(-700)}`,
      );
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

/**
 * Runs in the page: resolves `window.__firstMark` the moment the rendered DOM shows the
 * view's first screen, on both clients. A hidden card is not a card: the flow canvas lays
 * its nodes out invisibly until it has measured them.
 */
function installMark({ view, run, cards }) {
  const visible = (element) => {
    for (let at = element; at; at = at.parentElement)
      if (getComputedStyle(at).visibility === "hidden") return false;
    return true;
  };
  const header = () =>
    document.querySelector('[aria-label="Run header"] h2')?.textContent === run;
  const checks = {
    graph: () => {
      const shown = [...document.querySelectorAll("article.dag-node")].filter(
        visible,
      );
      return (
        header() &&
        shown.length >= cards &&
        shown.every((card) => card.querySelector(".node-status")?.textContent)
      );
    },
    overall: () => {
      const metrics = document.querySelector('[aria-label="Run metrics"]');
      return (
        document.querySelector(".overall-hero h2")?.textContent === run &&
        ["Status", "Nodes", "Wall time", "Turns"].every((name) =>
          metrics?.textContent?.includes(name),
        ) &&
        Boolean(
          document.querySelector(
            ".graph-timeline [data-first-plot], .graph-timeline svg, .graph-timeline button",
          ),
        )
      );
    },
    node: () => {
      const section = document.querySelector('[aria-label^="Timeline for "]');
      return (
        Boolean(section?.querySelector(".node-view-state")?.textContent) &&
        Boolean(
          document.querySelector(
            '[aria-label="Node timeline"] svg, [aria-label="Node timeline"] button',
          ),
        ) &&
        Boolean(
          document.querySelector(
            '[aria-label="Node transcript"] .transcript-item',
          ),
        )
      );
    },
  };
  const check = checks[view];
  const look = () => {
    if (window.__firstMark !== undefined || !check()) return;
    window.__firstMark = performance.now();
    window.__cardsAtMark = document.querySelectorAll("article.dag-node").length;
    observer.disconnect();
  };
  const observer = new MutationObserver(look);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  const tick = () => {
    look();
    if (window.__firstMark === undefined) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** What the mark's page shows, so a figure names the DOM state it timed. */
function shownAtMark({ view }) {
  const words = (selector) =>
    [...document.querySelectorAll(selector)].map((one) =>
      one.textContent.trim(),
    );
  if (view === "graph")
    return {
      cards: [...document.querySelectorAll("article.dag-node")].map((card) => ({
        name: card.getAttribute("aria-label"),
        reason: card.querySelector(".node-reason")?.textContent,
        awaits: card.querySelector(".node-awaits")?.textContent,
      })).length,
      reasons: words(".node-reason").length,
      awaits: words(".node-awaits").length,
    };
  if (view === "overall")
    return {
      metrics: document
        .querySelector('[aria-label="Run metrics"]')
        ?.textContent?.slice(0, 200),
      plot_elements: document.querySelectorAll(
        ".graph-timeline rect, .graph-timeline button",
      ).length,
    };
  return {
    state: document.querySelector(".node-view-state")?.textContent,
    transcript_rows: document.querySelectorAll(
      '[aria-label="Node transcript"] .transcript-item',
    ).length,
    plot_elements: document.querySelectorAll(
      '[aria-label="Node timeline"] rect, [aria-label="Node timeline"] button',
    ).length,
  };
}

/** One first-screen measurement: navigation start to the mark, in a real browser. */
async function firstPageMeasure(values, server, origin, root) {
  const require = createRequire(join(REPO, "apps/dag-ui-e2e/package.json"));
  const { chromium } = require("@playwright/test");
  const view = values.measure.slice("first-".length);
  const node =
    view === "node" ? (values.node ?? firstNodeOf(root, values.run)) : null;
  const address =
    view === "node"
      ? `/?run=${values.run}&view=graph&node=${node}`
      : `/?run=${values.run}&view=${view}`;
  // A floor for the mark: how many cards the graph really holds is asked after it.
  const planPath = join(root, values.run, "plan.json");
  const cards = existsSync(planPath)
    ? (JSON.parse(readFileSync(planPath, "utf8")).tasks?.length ?? 0)
    : 1;
  const budget = Number(values.timeout) * 1000;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // The bundle into the HTTP cache and one sidebar read into the server, from a page
    // that opens no run: the Action items page on today's client, no run on the trimmed.
    const warmedBy = values.client === "today" ? "/human-items" : "/";
    if (values.server === "warm") {
      const warming =
        values.cache === "warm"
          ? await context.newPage()
          : await (await browser.newContext()).newPage();
      const sidebar = warming.waitForResponse(
        (response) => response.url().endsWith("/api/v2/subscriptions"),
        { timeout: budget },
      );
      await warming.goto(`${origin}${warmedBy}`);
      await sidebar;
      await warming.waitForLoadState("load");
      await warming.close();
    } else if (values.cache === "warm") {
      // The bundle into the cache with nothing asked of the server: fetched, not run.
      const warming = await context.newPage();
      await warming.goto(`${origin}/healthz`);
      await warming.evaluate(async () => {
        const index = await (await fetch("/")).text();
        const assets = [...index.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)];
        await Promise.all(assets.map(([, asset]) => fetch(asset)));
      });
      await warming.close();
    }
    const page = await context.newPage();
    await page.addInitScript(installMark, { view, run: values.run, cards });
    const started = performance.now();
    await page.goto(`${origin}${address}`, { waitUntil: "commit" });
    await page
      .waitForFunction(() => window.__firstMark !== undefined, null, {
        timeout: budget,
        polling: 50,
      })
      .catch(async (error) => {
        const text = await page.locator("body").innerText();
        fail(`no ${view} mark: ${error.message}\n${text.slice(-500)}`);
      });
    const walled = (performance.now() - started) / 1000;
    const timing = await page.evaluate(() => {
      const reads = performance
        .getEntriesByType("resource")
        .filter(
          (entry) =>
            entry.name.includes("/api/v2/subscriptions") ||
            entry.name.includes("/api/v2/spike/first-screen"),
        )
        .map((entry) => ({
          start: entry.startTime,
          end: entry.responseEnd,
          transfer: entry.transferSize,
          decoded: entry.decodedBodySize,
        }));
      const assets = performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/assets/"))
        .map((entry) => ({
          name: entry.name.split("/").at(-1),
          transfer: entry.transferSize,
          decoded: entry.decodedBodySize,
          duration: Math.round(entry.duration),
        }));
      return {
        mark: window.__firstMark,
        cards_at_mark: window.__cardsAtMark,
        reads,
        assets,
      };
    });
    const answered = timing.reads
      .filter((read) => read.end <= timing.mark)
      .at(-1);
    if (!answered) fail("the mark was reached with no answer read");
    const first = timing.reads[0];
    const seconds = (ms) => Math.round(ms) / 1000;
    const shown = await page.evaluate(shownAtMark, { view });
    // How many cards the graph holds, asked of the first answer after the mark so the
    // asking times nothing: a plan's file names fewer than a run that replanned.
    let graphCards = null;
    if (view === "graph") {
      const held = await firstAnswer(origin, values, "graph", null, budget);
      const { detail } = JSON.parse(held.body);
      graphCards = detail.graph.plan.tasks.filter(
        (task) => detail.graph.node_status[task.id] !== undefined,
      ).length;
      if (timing.cards_at_mark !== graphCards)
        fail(`the mark drew ${timing.cards_at_mark} of ${graphCards} cards`);
    }
    return {
      address,
      client: values.client,
      cache: values.cache,
      server_state: values.server,
      wall_seconds: seconds(timing.mark),
      navigation_to_post_start_seconds: seconds(first.start),
      post_seconds: seconds(answered.end - first.start),
      answer_to_mark_seconds: seconds(timing.mark - answered.end),
      harness_wall_seconds: Math.round(walled * 1000) / 1000,
      reads: timing.reads.length,
      answer_transfer_bytes: answered.transfer,
      answer_decoded_bytes: answered.decoded,
      assets: timing.assets,
      cards_at_mark: timing.cards_at_mark,
      graph_cards: graphCards,
      shown,
      server: server.residentKb(),
      server_cpu_seconds: server.cpuSeconds(),
    };
  } finally {
    await browser.close();
  }
}

/** A path with every array index and record key that varies written as `[]`. */
const FIRST_IGNORED = new Set(["observed_at", "timings"]);

/** Classify every value of `first` against `complete`; absent from `first` is not a value. */
function classifyFirst(first, complete, path, tally) {
  const note = (group, value) => {
    const entry = tally[group].get(path) ?? { count: 0 };
    entry.count += 1;
    if (value !== undefined && entry.sample === undefined) entry.sample = value;
    tally[group].set(path, entry);
  };
  if (
    first !== null &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    first.loading === true
  ) {
    note("loading", JSON.stringify(complete)?.slice(0, 120));
    return;
  }
  if (first === complete) {
    tally.equal += 1;
    return;
  }
  if (
    typeof first !== "object" ||
    typeof complete !== "object" ||
    first === null ||
    complete === null ||
    Array.isArray(first) !== Array.isArray(complete)
  ) {
    note(
      "different",
      `first answer ${JSON.stringify(first)?.slice(0, 120)}; complete read ${JSON.stringify(complete)?.slice(0, 120)}`,
    );
    return;
  }
  if (Array.isArray(first)) {
    for (let at = 0; at < Math.max(first.length, complete.length); at += 1) {
      const step = `${path}[]`;
      if (at >= first.length) {
        const entry = tally.absent.get(step) ?? { count: 0 };
        entry.count += 1;
        tally.absent.set(step, entry);
      } else if (at >= complete.length)
        classifyFirst(first[at], undefined, step, tally);
      else classifyFirst(first[at], complete[at], step, tally);
    }
    return;
  }
  for (const key of new Set([...Object.keys(first), ...Object.keys(complete)])) {
    if (FIRST_IGNORED.has(key)) continue;
    const dynamic = path.endsWith(".node_status") || path.endsWith(".node_results") ||
      path.endsWith(".node_gated_by") || path.endsWith(".node_details") ||
      path.endsWith(".node_control");
    const step = `${path}.${dynamic ? "*" : key}`;
    if (!(key in first)) {
      const entry = tally.absent.get(step) ?? { count: 0 };
      entry.count += 1;
      tally.absent.set(step, entry);
    } else classifyFirst(first[key], complete[key], step, tally);
  }
}

function newTally() {
  return { equal: 0, loading: new Map(), different: new Map(), absent: new Map() };
}

/** Spans by id, because a first answer may hold them in another order or fewer of them. */
function classifySpans(first, complete, tally, { eventsWindow }) {
  const byId = new Map((complete ?? []).map((span) => [span.id, span]));
  const seen = new Set();
  for (const span of first ?? []) {
    const other = byId.get(span.id);
    if (other === undefined) {
      const entry = tally.different.get(".timeline.spans[] (only in the first answer)") ?? { count: 0 };
      entry.count += 1;
      entry.sample ??= `${span.id} ${span.kind} ${span.started_at} .. ${span.ended_at}`;
      tally.different.set(".timeline.spans[] (only in the first answer)", entry);
      continue;
    }
    seen.add(span.id);
    const { events: firstEvents, ...ownFirst } = span;
    const { events: completeEvents, ...ownComplete } = other;
    classifyFirst(ownFirst, ownComplete, ".timeline.spans[]", tally);
    if (eventsWindow && firstEvents?.length) {
      // By place in the store: a turn's records share one `id`.
      const held = new Map(
        (completeEvents ?? []).map((one) => [one.journal_order, one]),
      );
      const tail = (completeEvents ?? []).slice(-firstEvents.length);
      firstEvents.forEach((event, at) => {
        const same = held.get(event.journal_order);
        if (same === undefined) {
          const entry = tally.different.get(".timeline.spans[].events[] (id not in the complete read)") ?? { count: 0 };
          entry.count += 1;
          entry.sample ??= `${event.id} ${event.kind}`;
          tally.different.set(".timeline.spans[].events[] (id not in the complete read)", entry);
        } else {
          if (tail[at]?.journal_order !== event.journal_order) {
            const entry = tally.different.get(".timeline.spans[].events[] (not the latest rows)") ?? { count: 0 };
            entry.count += 1;
            tally.different.set(".timeline.spans[].events[] (not the latest rows)", entry);
          }
          classifyFirst(event, same, ".timeline.spans[].events[]", tally);
        }
      });
    } else if (completeEvents?.length) {
      const entry = tally.absent.get(".timeline.spans[].events[]") ?? { count: 0 };
      entry.count += completeEvents.length;
      tally.absent.set(".timeline.spans[].events[]", entry);
    }
  }
  for (const span of complete ?? [])
    if (!seen.has(span.id)) {
      const entry = tally.absent.get(".timeline.spans[] (only in the complete read)") ?? { count: 0, kinds: {} };
      entry.count += 1;
      entry.kinds[span.kind] = (entry.kinds[span.kind] ?? 0) + 1;
      entry.sample ??= `${span.id} ${span.kind} ${span.started_at} .. ${span.ended_at}`;
      tally.absent.set(".timeline.spans[] (only in the complete read)", entry);
    }
}

const sortedGroups = (groups) =>
  [...groups]
    .sort((left, right) => right[1].count - left[1].count)
    .map(([path, entry]) => ({ path, ...entry }));

/** A first answer read over a server's route, by itself. */
async function firstAnswer(origin, values, view, node, budget) {
  const query = values["first-query"] ? `&${values["first-query"]}` : "";
  const read = await timed(
    `${origin}/api/v2/spike/first-screen?run=${encodeURIComponent(values.run)}${query}`,
    {
      method: "POST",
      body: view === "node" ? node : view,
    },
    budget,
  );
  if (read.status !== 200) fail(`first answer: ${read.status} ${read.body}`);
  return read;
}

async function completeRead(origin, view, node, run, budget) {
  const posted = await timed(
    `${origin}/api/v2/subscriptions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: VIEWS[view](run, node) }),
    },
    budget,
  );
  if (posted.status !== 201) fail(`subscribe: ${posted.status} ${posted.body}`);
  return posted;
}

/** Every value of a first answer against the complete read, field by field. */
async function firstContentMeasure(values, server, origin, root) {
  const view = values.measure.slice("first-content-".length);
  const node =
    view === "node" ? (values.node ?? firstNodeOf(root, values.run)) : undefined;
  const budget = Number(values.timeout);
  const firstRead = await firstAnswer(origin, values, view, node, budget);
  const first = JSON.parse(firstRead.body);
  const completeReading = await completeRead(origin, view, node, values.run, budget);
  const visible = JSON.parse(completeReading.body).initial.snapshot.visible;
  if (values["keep-answers"]) {
    writeFileSync(`${values["keep-answers"]}.first.json`, firstRead.body);
    writeFileSync(
      `${values["keep-answers"]}.complete.json`,
      JSON.stringify(visible),
    );
  }
  const tally = newTally();
  classifyFirst(first.detail, visible.detail?.payload ?? visible.detail, ".detail", tally);
  if (view !== "graph")
    classifySpans(
      first.timeline?.spans,
      (visible.timeline?.payload ?? visible.timeline)?.spans,
      tally,
      { eventsWindow: view === "node" },
    );
  const { timings, ...served } = first;
  const raw = Buffer.from(JSON.stringify(served));
  return {
    view,
    node: node ?? null,
    wall_seconds: firstRead.seconds + completeReading.seconds,
    first_answer_seconds: firstRead.seconds,
    complete_read_seconds: completeReading.seconds,
    first_answer_timings: timings,
    first_answer_bytes: raw.length,
    first_answer_gzip_bytes: gzipSync(raw).length,
    complete_answer_bytes: completeReading.bytes,
    declared_loading: first.loading,
    equal: tally.equal,
    loading: sortedGroups(tally.loading),
    different: sortedGroups(tally.different).slice(0, 120),
    different_groups: tally.different.size,
    not_on_first_answer: sortedGroups(tally.absent).slice(0, 120),
    server: server.residentKb(),
  };
}

/** The first answer alone, at the API. */
async function firstAnswerMeasure(values, server, origin, root) {
  const view = values.measure.slice("first-answer-".length);
  const node =
    view === "node" ? (values.node ?? firstNodeOf(root, values.run)) : undefined;
  const read = await firstAnswer(origin, values, view, node, Number(values.timeout));
  const { timings, ...served } = JSON.parse(read.body);
  const raw = Buffer.from(JSON.stringify(served));
  return {
    view,
    node: node ?? null,
    wall_seconds: read.seconds,
    timings,
    bytes: raw.length,
    gzip_bytes: gzipSync(raw).length,
    server: server.residentKb(),
  };
}

/** The complete read's arrival after the first answer, and what a page reads either side of it. */
async function firstRestMeasure(values, server, origin, root) {
  const budget = Number(values.timeout);
  const node = values.node ?? firstNodeOf(root, values.run);
  const first = await firstAnswer(origin, values, "overall", undefined, budget);
  const { timeline } = JSON.parse(first.body);
  const nodeSpans = timeline.spans.filter((span) => span.node_id === node);
  const span = (nodeSpans.find((one) => one.kind === "node") ?? nodeSpans[0])?.id;
  const page = async (query) => {
    const read = await timed(
      `${origin}/api/v2/spike/page?run=${encodeURIComponent(values.run)}&node=${encodeURIComponent(node)}&${query}`,
      {},
      budget,
    );
    if (read.status !== 200) fail(`page: ${read.status} ${read.body}`);
    const answer = JSON.parse(read.body);
    return {
      seconds: read.seconds,
      source: answer.source,
      rows: answer.rows.length,
      bytes: read.bytes,
      ids: answer.rows.map((row) => row.id),
      answer_rows: answer.rows,
    };
  };
  const spanQuery = `span=${encodeURIComponent(span)}&offset=0&limit=50`;
  const started = performance.now();
  const complete = completeRead(origin, "overall", undefined, values.run, budget);
  const before = {
    span_page: await page(spanQuery),
    node_rows: await page("limit=50"),
  };
  const finished = await complete;
  const completeSeconds = (performance.now() - started) / 1000;
  const after = {
    span_page: await page(spanQuery),
    node_rows: await page("limit=50"),
  };
  const same = (one, other) => {
    const groups = new Map();
    compareValues(one.answer_rows, other.answer_rows, "", groups);
    return { equal: groups.size === 0, differences: [...groups].slice(0, 20) };
  };
  const brief = ({ ids, answer_rows: _rows, ...rest }) => rest;
  return {
    node,
    span,
    wall_seconds: first.seconds + completeSeconds,
    first_answer_seconds: first.seconds,
    complete_read_seconds_after_first_answer: completeSeconds,
    complete_answer_bytes: finished.bytes,
    before: { span_page: brief(before.span_page), node_rows: brief(before.node_rows) },
    after: { span_page: brief(after.span_page), node_rows: brief(after.node_rows) },
    span_page_same_rows: same(before.span_page, after.span_page),
    node_rows_same_rows: same(before.node_rows, after.node_rows),
    server: server.residentKb(),
  };
}

/** What `open_current` spends on this run, and what its checkpoint is made of. */
async function firstOpenCurrentMeasure(values, server, origin, root) {
  const read = await timed(
    `${origin}/api/v2/spike/open-current?run=${encodeURIComponent(values.run)}`,
    {},
    Number(values.timeout),
  );
  if (read.status !== 200) fail(`open-current: ${read.status} ${read.body}`);
  const checkpoint = JSON.parse(
    readFileSync(join(root, values.run, "checkpoint.json"), "utf8"),
  );
  const sizes = (value) =>
    Object.fromEntries(
      Object.entries(value)
        .map(([key, one]) => [key, JSON.stringify(one)?.length ?? 0])
        .sort((left, right) => right[1] - left[1]),
    );
  return {
    wall_seconds: read.seconds,
    steps: JSON.parse(read.body),
    document_bytes: sizes(checkpoint),
    state_bytes: sizes(checkpoint.state ?? {}),
  };
}

/** A journal's records and bytes by kind, and its streams. */
function firstKinds(values, root) {
  const kinds = {};
  const streams = new Set();
  const text = readFileSync(join(root, values.run, "events.jsonl"), "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const kind = /"kind":"([^"]+)"/u.exec(line)?.[1] ?? "unknown";
    const stream = /"stream":"([^"]+)"/u.exec(line)?.[1];
    streams.add(stream);
    kinds[kind] ??= { records: 0, bytes: 0 };
    kinds[kind].records += 1;
    kinds[kind].bytes += line.length + 1;
  }
  return {
    wall_seconds: 0,
    streams: streams.size,
    kinds: Object.fromEntries(
      Object.entries(kinds).sort((left, right) => right[1].bytes - left[1].bytes),
    ),
  };
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
      const answer = await timed(
        `${origin}/api/human-items${query}`,
        {},
        budget,
      );
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
      query_seconds_all_views: views.reduce(
        (sum, view) => sum + view.seconds,
        0,
      ),
      patch_bytes_all_views: views.reduce(
        (sum, view) => sum + view.patch_bytes,
        0,
      ),
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
  let read = readSync(fd, chunk);
  while (read > 0) {
    for (let at = 0; at < read; at += 1) if (chunk[at] === 10) records += 1;
    read = readSync(fd, chunk);
  }
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
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(),
      "run-open-costs-",
    ),
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
    else if (values.measure === "cli-unpublished")
      result = cliUnpublished(values, scratch);
    else if (values.measure.startsWith("content-"))
      result = await contentMeasure(values, root, scratch);
    else if (values.measure === "run-facts")
      result = runFactsMeasure(values, root);
    else if (values.measure === "checkouts") result = checkouts(values);
    else if (values.measure === "human-items")
      result = await humanItemsMeasure(values, scratch);
    else if (values.measure === "first-kinds")
      result = firstKinds(values, root);
    else {
      const firstMeasure = values.measure.startsWith("first-");
      const trimmed = firstMeasure && values.client !== "today";
      // Today's client on the unmodified read: only the prototype's routes are added,
      // for the card count asked after its mark.
      const server = new Server(
        trimmed && !values.prototype
          ? { ...values, prototype: FIRST_PROTOTYPES }
          : firstMeasure && !values.prototype
            ? { ...values, prototype: "first-screen" }
            : values,
        root,
        scratch,
      );
      try {
        const origin = await server.listening();
        // The client's own first-fetch set-up is not the read's cost.
        await fetch(`${origin}/healthz`).then((answer) => answer.text());
        result = FIRST_PAGE_MEASURES.includes(values.measure)
          ? await firstPageMeasure(values, server, origin, root)
          : values.measure.startsWith("first-answer-")
            ? await firstAnswerMeasure(values, server, origin, root)
          : values.measure.startsWith("first-content-")
            ? await firstContentMeasure(values, server, origin, root)
            : values.measure === "first-rest"
              ? await firstRestMeasure(values, server, origin, root)
              : values.measure === "first-open-current"
                ? await firstOpenCurrentMeasure(values, server, origin, root)
                : values.measure.startsWith("page-")
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
      spans.length > 0 &&
      Number(values.concurrent) === 1 &&
      !values.measure.startsWith("page-") &&
      !values.measure.startsWith("first-")
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
            ? spawnSync("ls", [root], { encoding: "utf8" }).stdout.split("\n")
                .length - 1
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
            .filter(
              (span) =>
                span.span && span.rss_kb_after - span.rss_kb_before > 20_480,
            )
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
