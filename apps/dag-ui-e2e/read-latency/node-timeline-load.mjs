#!/usr/bin/env node
/**
 * Spike `spike-node-timeline-load`: how long a node's timeline takes to load
 * completely in the browser view, by one read shape, on one node of one runs root.
 *
 *   node apps/dag-ui-e2e/read-latency/node-timeline-load.mjs \
 *     --runs-root <path> --run <run> --node <node> \
 *     [--read today|untouched|pages:<n>|concurrent:<k>:<n>|one|stream] \
 *     [--readings <n>] [--binary <onepipeline-api>] [--output <file>]
 *
 *   node apps/dag-ui-e2e/read-latency/node-timeline-load.mjs \
 *     --large-world <dir> [--read ...] [--readings <n>] ...
 *
 * One reading: a fresh release `onepipeline-api serve --ui` over the root, which
 * has answered one sidebar read; a real Chromium whose HTTP cache already holds
 * the bundle; navigation to the node's Timeline tab; then seconds from navigation
 * start until the chart and the event list hold every row of the node and no
 * loading mark remains: "No earlier history remains" shown, and no "Still loading"
 * hatch, Load earlier control, failure, loading state or run-level history
 * banner: the reading's `seconds`. `node_complete_s` is the same less the banner.
 * A reading counts only if, at that mark, both the chart's data and the event list
 * held every row of the node: the view's probe (`NodeTimelineView.tsx`) reports
 * after each commit which rows each holds, the observer keeps the report of the
 * commit it marks on, and the records expected are read afterwards off the node's
 * complete timeline document. The rows the reads carried are also checked off the
 * wire.
 *
 * `--read`:
 * - `today` drives today's view to its start by its own Load earlier control,
 *   clicked from inside the page the moment it is enabled;
 * - `untouched` opens today's view and leaves it, reporting where it stops;
 * - `pages:<n>`, `concurrent:<k>:<n>` and `one` are the prototype's read shapes
 *   (`?spike-read=`, `useTimelineHistory`): sequential pages of `n` rows, the
 *   newest page then `k` stretches of time at once in pages of `n`, every row in
 *   one buffered request, and `stream`, the node-scoped stream
 *   (`GET .../timeline/node-stream`): the run's heads, the node's records fetched
 *   by handle, its rows sent as newline-delimited lines the view takes as each
 *   arrives.
 *
 * `--large-world <dir>` builds `dag-ui-read-latency:test-large`'s world there once
 * (the corpus from `large-run-workload.json` and the engine's own checkpoint),
 * then measures its busiest node with the other live runs written to throughout,
 * as `test-large` does.
 *
 * The figures go to `--output`, or else to stdout; progress goes to stderr.
 * Exits 2 on a usage error, 1 when a reading did not complete or its chart or
 * event list lacked a row at its mark.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const CORPUS = join(HERE, "../load/corpus.mjs");
const WRITER = join(HERE, "../load/writer.mjs");
const LARGE_WORKLOAD = join(HERE, "large-run-workload.json");
const ENGINE = join(REPO, ".tools/bin/onepipeline");
const DEFAULT_BINARY = join(REPO, "target/spike/release/onepipeline-api");
/** A reading that has not completed by now is reported as not completing. */
const GIVE_UP_MS = 900_000;
/** `untouched`: the view is taken to have stopped after this long without a page. */
const QUIET_MS = 10_000;

const usage = (message) => {
  console.error(`node-timeline-load: ${message}`);
  process.exit(2);
};

let values;
try {
  ({ values } = parseArgs({
    options: {
      "runs-root": { type: "string" },
      run: { type: "string" },
      node: { type: "string" },
      "large-world": { type: "string" },
      read: { type: "string", default: "today" },
      readings: { type: "string", default: "1" },
      binary: { type: "string", default: DEFAULT_BINARY },
      output: { type: "string" },
    },
  }));
} catch (error) {
  usage(error.message);
}
const READ = values.read;
if (
  !/^(today|untouched|one|stream|pages:[1-9]\d*|concurrent:[1-9]\d*:[1-9]\d*)$/u.test(
    READ,
  )
)
  usage(`--read ${JSON.stringify(READ)} is not a read shape`);
const READINGS = Number(values.readings);
if (!Number.isInteger(READINGS) || READINGS < 1)
  usage("--readings must be a positive integer");
if (!existsSync(values.binary))
  usage(
    `no server at ${values.binary}: build it with 'npx vite build' in apps/dag-ui, then 'cargo build --release --features bundled-ui --bin onepipeline-api --target-dir target/spike'`,
  );
if (values["large-world"] === undefined) {
  for (const name of ["runs-root", "run", "node"])
    if (values[name] === undefined)
      usage(`--${name} is required without --large-world`);
}

const hostLoad = () => {
  const [load_1m, load_5m, load_15m] = loadavg();
  return { load_1m, load_5m, load_15m, cores: availableParallelism() };
};

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** The environment a server over `runsRoot` runs in, its own state under `workspace`. */
function hostEnv(workspace, runsRoot) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(workspace, "config"),
    XDG_STATE_HOME: join(workspace, "state"),
    XDG_CACHE_HOME: join(workspace, "cache"),
    ONEVCS_HOME: join(workspace, "onevcs-home"),
    ONEPIPELINE_PROJECT_DIR: join(workspace, "overrides"),
    ONEPIPELINE_RUNS_DIR: runsRoot,
  };
  for (const name of [
    "ONEPIPELINE_LAUNCHER_SESSION",
    "ONEPIPELINE_WAKE_BUDGET",
    "ONEPIPELINE_UI_LIVE_TRACE",
  ])
    delete env[name];
  return env;
}

/** `test-large`'s world under `dir`, built once; its run and busiest node. */
function largeWorld(dir) {
  const facts = join(dir, "facts.json");
  const runsRoot = join(dir, "runs");
  if (!existsSync(facts)) {
    mkdirSync(dir, { recursive: true });
    console.error(`node-timeline-load: building the large-run world in ${dir}`);
    const written = execFileSync(
      process.execPath,
      [CORPUS, runsRoot, LARGE_WORKLOAD],
      { encoding: "utf8", maxBuffer: 1 << 24 },
    );
    const parsed = JSON.parse(written);
    // The engine writes its own fold into `checkpoint.json` on a read, as the
    // large world's builder has it do.
    execFileSync(ENGINE, ["status", parsed.openLiveRun], {
      env: hostEnv(dir, runsRoot),
      stdio: "ignore",
    });
    writeFileSync(facts, written);
  }
  const parsed = JSON.parse(readFileSync(facts, "utf8"));
  return {
    runsRoot,
    run: parsed.openLiveRun,
    node: parsed.large.busiestNode,
    otherLiveRuns: parsed.otherLiveRuns,
  };
}

/** `test-large`'s writer: 50 records a minute into each other live run. */
function startWriter(dir, world) {
  const workload = JSON.parse(readFileSync(LARGE_WORKLOAD, "utf8"));
  const log = join(dir, `appended-${process.pid}.jsonl`);
  writeFileSync(log, "");
  const runs = world.otherLiveRuns.map((run) => ({ run, node: "work" }));
  return spawn(
    process.execPath,
    [
      WRITER,
      JSON.stringify({
        root: world.runsRoot,
        log,
        durationMs: 3_600_000,
        rate: workload.records_per_minute_per_live_run,
        runs,
        burst: 0,
        burstRun: runs[0]?.run,
        burstAt: 0,
        openRun: world.otherLiveRuns[0],
      }),
    ],
    { stdio: "ignore" },
  );
}

async function serve(runsRoot, workspace, port) {
  const server = spawn(
    values.binary,
    [
      "serve",
      "--runs-root",
      runsRoot,
      "--bind",
      `127.0.0.1:${port}`,
      "--session",
      "node-timeline-load",
      "--ui",
    ],
    { stdio: "ignore", env: hostEnv(workspace, runsRoot), cwd: workspace },
  );
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const up = await fetch(`${origin}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error("the server never answered");
    await new Promise((wake) => setTimeout(wake, 100));
  }
  // A fresh server that has answered one sidebar read, as `test-large`'s are.
  await fetch(`${origin}/api/v2/runs`).then((response) => response.text());
  return { origin, server };
}

async function stop(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise((wake) => server.once("exit", wake));
  server.kill("SIGTERM");
  await exited;
}

/**
 * Taken in the page from its first script on: when the node's view first draws a
 * row, when it holds every row with no loading mark, and, for `today`, a click on
 * Load earlier the moment it is enabled.
 */
const OBSERVER = (drive) => {
  const marks = {
    first_render: null,
    node_complete: null,
    complete: null,
    held_at_first_render: null,
    held_at_node_complete: null,
    held_at_complete: null,
  };
  window.__nodeLoad = marks;
  // Each page's answer, teed and kept unread until the measurement is over, so the
  // check of its rows costs the reading nothing.
  const copies = [];
  window.__nodeLoadCopies = copies;
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (
      url.includes("/timeline/events") ||
      url.includes("/timeline/node-stream")
    )
      copies.push(response.clone());
    return response;
  };
  // What the chart's data and the event list hold after each commit, as the view's
  // probe reports it from a layout effect: the same commit the DOM below is of.
  let held = { chart: [], list: [] };
  window.__nodeLoadProbe = (now) => {
    held = now;
  };
  window.__nodeLoadHeldNow = () => held;
  const none = (selector) => document.querySelector(selector) === null;
  const look = () => {
    const now = performance.now();
    if (
      marks.first_render === null &&
      document.querySelector(
        '[aria-label="Node transcript"] article, [data-testid="node-timeline"] [aria-label^="Timeline plot"]',
      ) !== null
    ) {
      marks.first_render = now;
      marks.held_at_first_render = held;
    }
    const nodeDone =
      document.querySelector(".history-start") !== null &&
      none(".history-hatch") &&
      none("button.load-earlier") &&
      none(".page-failed") &&
      none(".node-timeline-panel .loading-state");
    if (marks.node_complete === null && nodeDone) {
      marks.node_complete = now;
      marks.held_at_node_complete = held;
    }
    if (marks.complete === null && nodeDone && none(".history-loading")) {
      marks.complete = now;
      marks.held_at_complete = held;
    }
    if (drive && marks.complete === null) {
      const button = document.querySelector("button.load-earlier");
      if (button !== null && !button.disabled) button.click();
    }
  };
  const start = () => {
    new MutationObserver(look).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    setInterval(look, 50);
    look();
  };
  if (document.documentElement === null)
    document.addEventListener("DOMContentLoaded", start);
  else start();
};

const isTimelineRead = (entry) =>
  entry.route.endsWith("/timeline/events") ||
  entry.route.endsWith("/timeline/node-stream");

/**
 * The node's every record, as the view keys a record's row (`record_id ?? id`), off
 * the node's complete timeline document (`GET .../timeline?scope=node`), read after
 * the reading whatever shape was measured. Not off the paged route: a page keeps one
 * row per row `id`, and two records of one turn share one. `total` is the paged
 * route's count of rows, for comparison.
 */
async function expectedRows(origin, world) {
  const root = `${origin}/api/v2/runs/${encodeURIComponent(world.run)}`;
  const node = encodeURIComponent(world.node);
  const whole = await fetch(`${root}/timeline?scope=node&node=${node}`).then(
    (response) => response.json(),
  );
  const ids = new Set();
  for (const span of whole.spans)
    for (const event of span.events) ids.add(event.record_id ?? event.id);
  const counted = await fetch(
    `${root}/timeline/events?scope=node&node=${node}&limit=1`,
  ).then((response) => response.json());
  return { ids: [...ids], total: counted.total };
}

const seconds = (ms) => (ms === null ? null : Math.round(ms) / 1000);

async function reading(context, world, port, workspace, index) {
  const { origin, server } = await serve(world.runsRoot, workspace, port);
  try {
    return await measure(context, world, origin, index);
  } finally {
    await stop(server);
  }
}

async function measure(context, world, origin, index) {
  const page = await context.newPage();
  const requests = [];
  const pending = [];
  page.on("requestfinished", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    pending.push(
      (async () => {
        const response = await request.response();
        const timing = request.timing();
        const entry = {
          route: url.pathname.replace(/\/runs\/[^/]+/u, "/runs/:run"),
          query: url.search,
          status: response?.status() ?? null,
          // When the request was sent, wall clock: entries are pushed as their
          // handling finishes, so concurrent requests are put back in send order by it.
          sent_at: timing.startTime,
          // From the request sent to its answer's first byte: the server's time, on loopback.
          server_ms:
            timing.responseStart >= 0 && timing.requestStart >= 0
              ? Math.round(timing.responseStart - timing.requestStart)
              : null,
          total_ms:
            timing.responseEnd >= 0 && timing.requestStart >= 0
              ? Math.round(timing.responseEnd - timing.requestStart)
              : null,
          bytes:
            (await request.sizes().catch(() => null))?.responseBodySize ?? null,
        };
        requests.push(entry);
      })(),
    );
  });
  const drive = READ === "today";
  await page.addInitScript(OBSERVER, drive);
  const spike =
    READ.startsWith("pages:") ||
    READ.startsWith("concurrent:") ||
    READ === "one" ||
    READ === "stream"
      ? `&spike-read=${encodeURIComponent(READ)}`
      : "";
  const load_before = hostLoad();
  await page.goto(
    `${origin}/?run=${encodeURIComponent(world.run)}&view=graph&node=${encodeURIComponent(world.node)}${spike}`,
    { waitUntil: "commit" },
  );
  const deadline = Date.now() + GIVE_UP_MS;
  let marks;
  let lastPageAt = Date.now();
  let pagesSeen = 0;
  for (;;) {
    // The marks alone: the rows held at each are read once the reading is over.
    marks = await page.evaluate(() => {
      const taken = window.__nodeLoad;
      return taken === undefined
        ? null
        : {
            first_render: taken.first_render,
            node_complete: taken.node_complete,
            complete: taken.complete,
          };
    });
    if (marks?.complete !== null && marks?.complete !== undefined) break;
    const pagesNow = requests.filter(isTimelineRead).length;
    if (pagesNow !== pagesSeen) {
      pagesSeen = pagesNow;
      lastPageAt = Date.now();
    }
    if (
      READ === "untouched" &&
      marks?.first_render !== null &&
      marks?.first_render !== undefined &&
      Date.now() - lastPageAt > QUIET_MS
    )
      break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(100);
  }
  const load_after = hostLoad();
  await page.waitForTimeout(250);
  await Promise.all(pending);
  // What today's view shows when it stops, for `untouched`.
  const shown = await page.evaluate(() => ({
    still_loading_hatches: document.querySelectorAll(".history-hatch").length,
    load_earlier_control:
      document.querySelector("button.load-earlier") !== null,
    history_start: document.querySelector(".history-start") !== null,
    run_history_loading: document.querySelector(".history-loading") !== null,
    transcript_articles: document.querySelectorAll(
      '[aria-label="Node transcript"] article',
    ).length,
  }));
  // The node's every record, read after the reading off its complete timeline
  // whatever shape was measured, keyed as the view keys a record's row.
  const expected = await expectedRows(origin, world);
  const total = expected.total;
  const pages = requests
    .filter(isTimelineRead)
    .sort((a, b) => a.sent_at - b.sent_at);
  // What the pages or the stream carried, off the copies the page kept.
  const read = await page.evaluate(async () => {
    const ids = [];
    let bytes = 0;
    let split = null;
    for (const copy of window.__nodeLoadCopies) {
      const text = await copy.text();
      bytes += new TextEncoder().encode(text).length;
      const answers = copy.url.includes("/node-stream")
        ? text
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line))
        : [JSON.parse(text)];
      for (const answer of answers) {
        if (answer.server !== undefined) split = answer.server;
        for (const row of answer.rows ?? []) ids.push(row.record_id ?? row.id);
      }
    }
    return { ids, bytes, split };
  });
  const held = new Set(read.ids);
  // Whether the chart's data and the event list held every expected row at each
  // mark, as the view's probe reported them in the commit the mark was taken on.
  const heldAt = await page.evaluate(() => ({
    first_render: window.__nodeLoad?.held_at_first_render ?? null,
    end: window.__nodeLoadHeldNow?.() ?? null,
    node_complete: window.__nodeLoad?.held_at_node_complete ?? null,
    complete: window.__nodeLoad?.held_at_complete ?? null,
  }));
  const missing = (snapshot) => {
    if (snapshot === null) return null;
    const chart = new Set(snapshot.chart);
    const list = new Set(snapshot.list);
    const notInChart = expected.ids.filter((id) => !chart.has(id));
    const notInList = expected.ids.filter((id) => !list.has(id));
    return {
      chart: notInChart.length,
      list: notInList.length,
      // The first few missing rows' ids, to find what the view left out.
      chart_missing_ids: notInChart.slice(0, 5),
      list_missing_ids: notInList.slice(0, 5),
      chart_rows: chart.size,
      list_rows: list.size,
    };
  };
  const missingAtComplete = missing(heldAt.complete);
  // The same check where the view is known not to hold the node yet: that it finds
  // rows missing there is what shows it can fail.
  const missingAtFirstRender = missing(heldAt.first_render);
  const missingAtNodeComplete = missing(heldAt.node_complete);
  const wholeAt = (counted) =>
    counted !== null && counted.chart === 0 && counted.list === 0;

  await page.close();
  const result = {
    reading: index + 1,
    read: READ,
    seconds: seconds(marks?.complete ?? null),
    node_complete_s: seconds(marks?.node_complete ?? null),
    first_render_s: seconds(marks?.first_render ?? null),
    rows_total: total,
    rows_expected: expected.ids.length,
    rows_read: held.size,
    every_row_read: expected.ids.every((id) => held.has(id)),
    // Both the chart's data and the event list held every expected row when each
    // mark was taken: what makes the mark a complete load rather than a CSS state.
    held_at_first_render: missingAtFirstRender,
    held_at_end: missing(heldAt.end),
    held_at_complete: missingAtComplete,
    every_row_held_at_complete: wholeAt(missingAtComplete),
    held_at_node_complete: missingAtNodeComplete,
    every_row_held_at_node_complete: wholeAt(missingAtNodeComplete),
    timeline_requests: pages.length,
    api_requests: requests.length,
    timeline_bytes: read.bytes,
    timeline_bytes_on_wire: pages.reduce(
      (sum, entry) => sum + (entry.bytes ?? 0),
      0,
    ),
    // Each timeline request's server time, in the order the requests were sent.
    timeline_server_ms: pages.map((entry) => entry.server_ms),
    // Each one's send time, in ms after the first timeline request's.
    timeline_sent_ms: pages.map((entry) =>
      Math.round(entry.sent_at - (pages[0]?.sent_at ?? entry.sent_at)),
    ),
    timeline_server_ms_sum: pages.reduce(
      (sum, entry) => sum + (entry.server_ms ?? 0),
      0,
    ),
    // The stream's own split of its server time, off its first line.
    stream_server_split: read.split,
    failed_requests: requests.filter(
      (entry) => entry.status === null || entry.status >= 400,
    ).length,
    shown_at_end: shown,
    host_load_before: load_before,
    host_load_after: load_after,
  };
  console.error(
    `node-timeline-load: ${world.run}/${world.node} ${READ} #${index + 1}: ${result.seconds ?? "incomplete"} s, first render ${result.first_render_s} s, ${result.timeline_requests} pages, ${result.rows_read}/${total} rows, load ${load_before.load_1m.toFixed(2)}`,
  );
  return result;
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const workspace = mkdtempSync(join(tmpdir(), "node-timeline-load-"));
let world;
let writer;
if (values["large-world"] !== undefined) {
  const dir = resolve(values["large-world"]);
  world = largeWorld(dir);
  writer = startWriter(dir, world);
} else {
  const root = resolve(values["runs-root"]);
  world = { runsRoot: root, run: values.run, node: values.node };
}

const port = await freePort();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
let failed = false;
const readings = [];
try {
  // The bundle into the context's HTTP cache, off a server of its own: every
  // reading's origin is the same, so each finds it there.
  {
    const { origin, server } = await serve(world.runsRoot, workspace, port);
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`, { waitUntil: "networkidle" });
      await page.close();
    } finally {
      await stop(server);
    }
  }
  for (let index = 0; index < READINGS; index += 1)
    readings.push(await reading(context, world, port, workspace, index));
} finally {
  await browser.close();
  if (writer !== undefined) writer.kill("SIGTERM");
}
const completed = readings.filter((entry) => entry.seconds !== null);
failed =
  READ !== "untouched" &&
  (completed.length !== readings.length ||
    readings.some(
      (entry) => !entry.every_row_read || !entry.every_row_held_at_complete,
    ));
const figures = completed.map((entry) => entry.seconds);
const summary = {
  run: world.run,
  node: world.node,
  read: READ,
  readings,
  median_s: figures.length === 0 ? null : median(figures),
  min_s: figures.length === 0 ? null : Math.min(...figures),
  max_s: figures.length === 0 ? null : Math.max(...figures),
  binary: values.binary,
};
const text = `${JSON.stringify(summary, null, 2)}\n`;
if (values.output === undefined) process.stdout.write(text);
else writeFileSync(values.output, text);
process.exit(failed ? 1 : 0);
