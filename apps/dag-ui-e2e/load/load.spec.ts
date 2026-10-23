/**
 * What the DAG Observatory's browser costs the server and the host, and how
 * long a new record takes to show, in every page state — recorded into
 * `telemetry/request-load.json` for the budgets in `../budgets.yaml` to read.
 *
 * Every measured variant — one page state, or one live view at one or two tabs
 * — starts from a freshly generated corpus at this host's scale
 * (`corpus.mjs`) and a fresh `onepipeline-api serve --ui` (the release build,
 * which embeds the built bundle), so no variant inherits a server or journals
 * grown by the one before it. Once the page has loaded, one window of
 * `LOAD_WINDOW_S` seconds (120 by default) records, while `writer.mjs` grows the
 * host's live runs:
 *
 * - every request the page sends, by route (`page.on("request")`);
 * - every byte it receives, by route and stream, and every server-sent frame
 *   with its type and size (the DevTools protocol's Network domain);
 * - for every record appended to the open live run, the lag from its append to
 *   the page rendering it: on a node's timeline the appearance of that record's
 *   row (`article[data-journal-seq]`), and on Graph, Overall and Channel the view
 *   root's `data-journal-seq` reaching its number, both seen by a DOM observer;
 *   frame arrival is recorded beside it as a breakdown;
 * - the server process tree's CPU seconds (`/proc`), browser and writer apart.
 *
 * After the window the stream is made to reconnect, so the repeated-snapshot
 * figures cover load and a reconnect. The journeys behind this assert behaviour
 * only; every threshold is the budgets file's.
 *
 * Knobs: LOAD_WINDOW_S, LOAD_ONLY (comma-separated variant names).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { z } from "zod";
import harnessBinaries from "../fixtures/harness-binaries.json" with {
  type: "json",
};
import { treeCpuSeconds } from "./cpu";
import {
  type Measured,
  telemetrySchema,
  VARIANTS,
  type Variant,
  variantSchema,
} from "./telemetry";

const REPO = resolve(import.meta.dirname, "../../..");
const WRITER = join(import.meta.dirname, "writer.mjs");
const TELEMETRY = join(import.meta.dirname, "../telemetry/request-load.json");
const CORPUS = join(import.meta.dirname, "corpus.mjs");
/** How long each variant is watched once loaded: whole seconds, 120 by default. */
const WINDOW_MS =
  z.coerce
    .number()
    .int()
    .positive()
    .parse(process.env.LOAD_WINDOW_S ?? "120") * 1000;
/** Records per minute on every live run: the p90 active-minute rate of this host. */
const RATE = 50;
const BURST = 400;

/** A developer's look at some variants: each name one of the variants above. */
const ONLY = process.env.LOAD_ONLY?.split(",").map((name) =>
  z
    .string()
    .refine((asked) => VARIANTS.some((variant) => variant.name === asked), {
      message: `LOAD_ONLY names a variant there is none of: ${name}`,
    })
    .parse(name),
);

function releaseBinary(): string {
  const target = process.env.CARGO_TARGET_DIR ?? join(REPO, "target");
  const binary = join(resolve(REPO, target), "release", "onepipeline-api");
  if (!existsSync(binary))
    throw new Error(
      `no ${binary}: run 'npx nx run dag-ui-e2e:test-load', which builds it after the bundle`,
    );
  return binary;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("the kernel named no port")),
      );
    });
  });
}

/** What `corpus.mjs` says about the corpus it wrote. */
const corpusSchema = z.object({
  runs: z.number().int().positive(),
  projects: z.number().int().positive(),
  openLiveRun: z.string().min(1),
  openLiveRecords: z.number().int().positive(),
  settledRun: z.string().min(1),
  stoppedRun: z.string().min(1),
  otherLiveRuns: z.array(z.string().min(1)).min(1),
  liveNode: z.string().min(1),
});

/** What the corpora measured over said of themselves: one workload for all. */
let workload: z.infer<typeof corpusSchema> | undefined;

/** The executables a server here must never find on its PATH. */
const HARNESSES = z.array(z.string().min(1)).parse(harnessBinaries);

interface Served {
  readonly origin: string;
  readonly runsRoot: string;
  readonly workspace: string;
  readonly server: ChildProcess;
  readonly facts: z.infer<typeof corpusSchema>;
}

/** A fresh corpus and a fresh server over it, isolated as the fixtures are. */
async function serveFresh(name: string): Promise<Served> {
  const workspace = mkdtempSync(join(tmpdir(), `dag-ui-e2e-load-${name}-`));
  const runsRoot = join(workspace, "runs");
  // Written by its own command, the way the fixture server writes the
  // journeys' corpus, and read back through the shape it states.
  const facts = corpusSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, [CORPUS, runsRoot, "host"], {
        encoding: "utf8",
        maxBuffer: 1 << 20,
      }),
    ),
  );
  workload = facts;
  const bin = join(workspace, "bin");
  mkdirSync(bin);
  const staged = join(bin, "onepipeline-api");
  copyFileSync(releaseBinary(), staged, constants.COPYFILE_FICLONE);
  const utilityBin = join(workspace, "utility-bin");
  mkdirSync(utilityBin);
  symlinkSync(process.execPath, join(utilityBin, "node"));
  const providerConfig = join(workspace, "provider-config.toml");
  writeFileSync(providerConfig, "");
  mkdirSync(join(workspace, "onevcs-home"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [
      utilityBin,
      ...(process.env.PATH ?? "")
        .split(delimiter)
        .filter(
          (dir) => !HARNESSES.some((binary) => existsSync(join(dir, binary))),
        ),
    ].join(delimiter),
    ONEHARNESS_CONFIG: providerConfig,
    ONEAGENTGRAPH_STATE_DIR: join(workspace, "oneagentgraph"),
    ONEVCS_HOME: join(workspace, "onevcs-home"),
    ONEPIPELINE_PROJECT_DIR: join(workspace, "overrides"),
    XDG_STATE_HOME: join(workspace, "state"),
    XDG_CACHE_HOME: join(workspace, "cache"),
  };
  for (const variable of [
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ONEPIPELINE_WAKE_BUDGET",
    "ONEPIPELINE_LAUNCHER_SESSION",
    "ONEPIPELINE_UI_LIVE_TRACE",
    "ONEPIPELINE_UI_TELEMETRY_REFOLD_MS",
  ])
    delete env[variable];
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // The server's own default poll interval: this measures the shipped cadence.
  const server = spawn(
    staged,
    [
      "serve",
      "--runs-root",
      runsRoot,
      "--bind",
      `127.0.0.1:${port}`,
      "--session",
      "load-session",
      "--ui",
    ],
    { stdio: ["ignore", "inherit", "inherit"], env },
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`the ${name} server exited ${server.exitCode}`);
    if (
      await fetch(`${origin}/healthz`).then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    if (Date.now() > deadline)
      throw new Error(`the ${name} server never answered`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return { origin, runsRoot, workspace, server, facts };
}

async function stopServing(served: Served): Promise<void> {
  served.server.kill("SIGTERM");
  if (served.server.exitCode === null)
    await new Promise((resolveExit) => served.server.once("exit", resolveExit));
  rmSync(served.workspace, { recursive: true, force: true });
}

/** An API path as a route: ids replaced, query keys kept, values dropped. */
function routeOf(method: string, url: URL): string {
  const path = url.pathname
    .replace(/^\/api\/v2\/runs\/[^/]+/u, "/api/v2/runs/:run")
    .replace(/^\/api\/v2\/projects\/[^/]+/u, "/api/v2/projects/:project")
    .replace(/^\/api\/v2\/subscriptions\/[^/]+/u, "/api/v2/subscriptions/:id")
    .replace(/\/conversations\/[^/]+/u, "/conversations/:id")
    .replace(/\/artifacts\/[^/]+/u, "/artifacts/:id")
    .replace(/\/nodes\/[^/]+/u, "/nodes/:node");
  const keys = [...url.searchParams.keys()].sort();
  return `${method} ${keys.length === 0 ? path : `${path}?${keys.join("&")}`}`;
}

/** The frames a reading restates whole, which a healthy stream never sends. */
const FULL_RESEND = new Set(["snapshot", "reset"]);

interface Recorder {
  requests: { at: number; route: string }[];
  bytes: { at: number; bytes: number; route: string }[];
  frames: { at: number; type: string; bytes: number }[];
  routes: Map<string, string>;
}

async function record(page: Page): Promise<Recorder> {
  const recorder: Recorder = {
    requests: [],
    bytes: [],
    frames: [],
    routes: new Map(),
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    recorder.requests.push({
      at: Date.now(),
      route: routeOf(request.method(), url),
    });
  });
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (event) => {
    const url = new URL(event.request.url);
    recorder.routes.set(
      event.requestId,
      url.pathname.startsWith("/api/")
        ? routeOf(event.request.method, url)
        : "the bundle",
    );
  });
  cdp.on("Network.dataReceived", (event) => {
    recorder.bytes.push({
      at: Date.now(),
      bytes: event.encodedDataLength || event.dataLength,
      route: recorder.routes.get(event.requestId) ?? "other",
    });
  });
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    recorder.frames.push({
      at: Date.now(),
      type: event.eventName,
      bytes: Buffer.byteLength(event.data),
    });
  });
  return recorder;
}

// llmlint: ignore-block[e2e_uses_accessible_selectors] this is a passive DOM observer, not a locator: it times the moment each record's change is in the document, which is the measurement the budget is stated over, and the `data-journal-seq` attribute is the one the view writes for exactly that reading — no role or name carries a journal sequence number. Everything the harness *does* to the page goes through roles and names (`keepRunsOpen`, `loaded`).
/**
 * Watch the page for each record the writer appends to the open run: when the
 * node timeline's row for a record appears, and when a view root's
 * `data-journal-seq` reaches a number. It only watches; opening a collapsed run
 * of rows, as a reader does to read its middle, is {@link keepRunsOpen}'s.
 */
const OBSERVER = `
(() => {
  const seen = { rows: {}, roots: [] };
  window.__journal = seen;
  let top = -1;
  const now = () => Date.now();
  const look = (node) => {
    if (!(node instanceof Element)) return;
    const elements = [node, ...node.querySelectorAll("[data-journal-seq]")];
    for (const element of elements) {
      const value = element.getAttribute("data-journal-seq");
      if (value === null) continue;
      const seq = Number(value);
      if (element.tagName === "ARTICLE") {
        if (seen.rows[seq] === undefined) seen.rows[seq] = now();
      } else if (seq > top) {
        top = seq;
        seen.roots.push([seq, now()]);
      }
    }
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") look(mutation.target);
      else for (const node of mutation.addedNodes) look(node);
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-journal-seq"],
  });
})();
`;
// llmlint: ignore-end[e2e_uses_accessible_selectors]

/**
 * Open the node transcript's newest collapsed run whenever one forms, through
 * its own control, as a reader does to read the rows it stands for — the run
 * the appended records join — until `until` says to stop.
 */
async function keepRunsOpen(page: Page, until: () => boolean): Promise<void> {
  const control = page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("button", { name: /^Show \d+ more/u })
    .last();
  while (!until()) {
    if ((await control.count()) > 0)
      await control.click().catch(() => undefined);
    await page.waitForTimeout(200);
  }
}

/** The page has finished loading: its view drawn, and two quiet seconds after. */
async function loaded(page: Page, variant: Variant): Promise<number> {
  const started = Date.now();
  const view =
    variant.kind === "nothing-open" || variant.kind === "host"
      ? page.getByRole("region", { name: "Host", exact: true })
      : variant.view === "graph"
        ? page.getByRole("application", { name: "DAG execution graph" })
        : variant.view === "overall"
          ? page.getByRole("region", { name: "Graph timeline" })
          : variant.view === "channel"
            ? page.getByRole("heading", { name: "Channel queue" })
            : page.getByRole("region", { name: /^Timeline for / });
  await view.waitFor({ timeout: 300_000 });
  // The Host page has finished loading once its own listing has been read.
  if (variant.kind === "nothing-open" || variant.kind === "host")
    await page
      .getByRole("region", { name: "Runs on the host" })
      .getByText(/^load-/)
      .first()
      .waitFor({ timeout: 300_000 });
  await page.waitForTimeout(2_000);
  return (Date.now() - started) / 1000;
}

const perMinute = (amount: number) => (amount * 60_000) / WINDOW_MS;
const round = (value: number, places = 3) =>
  Math.round(value * 10 ** places) / 10 ** places;

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ] ?? null
  );
}

function stats(lags: readonly number[], records: number) {
  return {
    records,
    shown: lags.length,
    never_shown: records - lags.length,
    p50_s: percentile(lags, 50),
    p95_s: percentile(lags, 95),
    max_s: lags.length === 0 ? null : Math.max(...lags),
  };
}

function address(served: Served, variant: Variant): string {
  const { settledRun, stoppedRun, openLiveRun, liveNode } = served.facts;
  if (variant.kind === "nothing-open" || variant.kind === "host")
    return "/?page=host";
  const run =
    variant.kind === "settled"
      ? settledRun
      : variant.kind === "stopped"
        ? stoppedRun
        : openLiveRun;
  const node = variant.kind === "live" ? liveNode : "publish";
  return variant.view === "node"
    ? `/?run=${run}&view=graph&node=${node}`
    : `/?run=${run}&view=${variant.view}`;
}

/** What the observer recorded: each row's first appearance, each root's rise. */
const observedSchema = z.object({
  rows: z.record(z.string(), z.number()),
  roots: z.array(z.tuple([z.number(), z.number()])),
});
/** One record `writer.mjs` appended to the open run, as it logged it. */
const appendedSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number().int().positive(),
  burst: z.boolean(),
});

async function measure(browser: Browser, variant: Variant): Promise<Measured> {
  const served = await serveFresh(variant.name);
  const contexts: BrowserContext[] = [];
  try {
    const pages: Page[] = [];
    const recorders: Recorder[] = [];
    const loads: number[] = [];
    for (let tab = 0; tab < variant.tabs; tab += 1) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      contexts.push(context);
      const page = await context.newPage();
      await page.addInitScript(OBSERVER);
      const recorder = await record(page);
      recorders.push(recorder);
      const subscribed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v2/subscriptions" &&
          response.request().method() === "POST",
      );
      await page.goto(`${served.origin}${address(served, variant)}`);
      loads.push(await loaded(page, variant));
      pages.push(page);
      // The byte accounting held to a response of known size: what the
      // recorder counted for the page's subscription is that answer's body,
      // give or take its chunk framing.
      const body = (await (await subscribed).body()).length;
      const counted = recorder.bytes
        .filter(({ route }) => route === "POST /api/v2/subscriptions")
        .reduce((sum, { bytes: count }) => sum + count, 0);
      expect(
        counted,
        "bytes counted for the subscription",
      ).toBeGreaterThanOrEqual(body);
      expect(counted, "bytes counted for the subscription").toBeLessThan(
        body + 4_096,
      );
    }
    const [page, recorder] = [pages[0], recorders[0]];
    if (page === undefined || recorder === undefined)
      throw new Error("no tab was opened");

    const { openLiveRun, otherLiveRuns, liveNode } = served.facts;
    const log = join(served.workspace, "appended.jsonl");
    writeFileSync(log, "");
    const growing = variant.kind === "live";
    const runs = otherLiveRuns.map((run) => ({ run, node: "work" }));
    if (growing) runs.push({ run: openLiveRun, node: liveNode });
    const pid = served.server.pid ?? 0;
    const start = Date.now();
    const cpuStart = treeCpuSeconds(pid);
    const writer = spawn(
      process.execPath,
      [
        WRITER,
        JSON.stringify({
          root: served.runsRoot,
          log,
          durationMs: WINDOW_MS,
          rate: RATE,
          runs,
          burst: BURST,
          // The burst lands on the open run when it is growing, so the lag
          // during a burst is the open run's own; on another live run otherwise.
          burstRun: growing ? openLiveRun : otherLiveRuns[0],
          burstAt: WINDOW_MS / 2,
          openRun: openLiveRun,
        }),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    // The Host page's own refresh control, pressed once in its window: the
    // reads it takes are the Host page's, which no other state sends.
    if (variant.kind === "host") {
      await page.waitForTimeout(WINDOW_MS / 4);
      await page.getByRole("button", { name: "Refresh host" }).click();
    }
    let watching = true;
    const opening =
      variant.view === "node"
        ? Promise.all(pages.map((tab) => keepRunsOpen(tab, () => !watching)))
        : Promise.resolve([]);
    const [code, signal] = await new Promise<[number | null, string | null]>(
      (resolveExit) =>
        writer.once("exit", (exited, killed) => resolveExit([exited, killed])),
    );
    // A workload that did not run to its end is no measurement of it.
    if (code !== 0)
      throw new Error(
        `the workload writer for ${variant.name} ended ${signal ?? `with ${code}`}`,
      );
    const end = Math.max(Date.now(), start + WINDOW_MS);
    const cpu = treeCpuSeconds(pid) - cpuStart;
    // A moment for what was appended at the very end to land.
    await page.waitForTimeout(3_000);
    watching = false;
    await opening;
    const observed = observedSchema.parse(
      await page.evaluate("window.__journal"),
    );

    // The stream is made to reconnect: whatever it re-sends whole is counted.
    const beforeReconnect = Date.now();
    await page.context().setOffline(true);
    await page.waitForTimeout(1_000);
    await page.context().setOffline(false);
    await page.waitForTimeout(3_000);

    const inWindow = <T extends { at: number }>(items: readonly T[]) =>
      items.filter(({ at }) => at >= start && at <= end);
    const requests = inWindow(recorder.requests);
    const requestsByRoute: Record<string, number> = {};
    for (const { route } of requests)
      requestsByRoute[route] = round(
        (requestsByRoute[route] ?? 0) + perMinute(1),
      );
    const bytes = inWindow(recorder.bytes);
    const bytesByRoute: Record<string, number> = {};
    for (const { route, bytes: count } of bytes)
      bytesByRoute[route] = Math.round(
        (bytesByRoute[route] ?? 0) + perMinute(count),
      );
    const frames = inWindow(recorder.frames);
    const framesByType: Record<
      string,
      { frames_per_min: number; bytes_per_min: number }
    > = {};
    for (const frame of frames) {
      const entry = framesByType[frame.type] ?? {
        frames_per_min: 0,
        bytes_per_min: 0,
      };
      framesByType[frame.type] = entry;
      entry.frames_per_min = round(entry.frames_per_min + perMinute(1));
      entry.bytes_per_min = Math.round(
        entry.bytes_per_min + perMinute(frame.bytes),
      );
    }
    const repeated = (items: Recorder["frames"]) => ({
      frames: items.filter(({ type }) => FULL_RESEND.has(type)).length,
      bytes: items
        .filter(({ type }) => FULL_RESEND.has(type))
        .reduce((sum, { bytes: count }) => sum + count, 0),
    });
    const loadPhase = recorder.frames.filter(({ at }) => at < start);
    const reconnectPhase = recorder.frames.filter(
      ({ at }) => at >= beforeReconnect,
    );

    let lag: Record<string, unknown> | undefined;
    if (growing) {
      const appended = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => appendedSchema.parse(JSON.parse(line)));
      const renderedAt = (seq: number): number | undefined =>
        variant.view === "node"
          ? observed.rows[String(seq)]
          : observed.roots.find(([shown]) => shown >= seq)?.[1];
      const lagOf = (items: typeof appended) =>
        items.flatMap(({ seq, at }) => {
          const shown = renderedAt(seq);
          return shown === undefined ? [] : [round((shown - at) / 1000)];
        });
      // Frame arrival, beside it: the first frame after each append.
      const arrivals = appended.flatMap(({ at }) => {
        const first = recorder.frames.find((frame) => frame.at >= at);
        return first === undefined ? [] : [round((first.at - at) / 1000)];
      });
      const burst = appended.filter((item) => item.burst);
      lag = {
        measured_as:
          variant.view === "node"
            ? "the record's row appearing on the node timeline"
            : "the view root's data-journal-seq reaching the record's number",
        ...stats(lagOf(appended), appended.length),
        during_burst: stats(lagOf(burst), burst.length),
        frame_arrival: {
          p50_s: percentile(arrivals, 50),
          p95_s: percentile(arrivals, 95),
          max_s: arrivals.length === 0 ? null : Math.max(...arrivals),
        },
      };
    }
    const received = bytes.reduce((sum, { bytes: count }) => sum + count, 0);
    return variantSchema.parse({
      kind: variant.kind,
      ...(variant.view === undefined ? {} : { view: variant.view }),
      tabs: variant.tabs,
      load_s: loads.map((value) => round(value, 2)),
      requests_per_min: round(perMinute(requests.length)),
      requests_per_min_by_route: requestsByRoute,
      mb_per_min: round(perMinute(received) / 1_000_000, 4),
      bytes_per_min_by_route: bytesByRoute,
      frames_per_min: round(perMinute(frames.length)),
      frames_by_type: framesByType,
      repeated_snapshot: {
        in_window: repeated(frames),
        at_load: repeated(loadPhase),
        after_reconnect: repeated(reconnectPhase),
      },
      server_cpu: {
        seconds: round(cpu, 2),
        window_s: WINDOW_MS / 1000,
        cores: round(cpu / (WINDOW_MS / 1000), 4),
        cores_per_tab: round(cpu / (WINDOW_MS / 1000) / variant.tabs, 4),
      },
      ...(lag === undefined ? {} : { lag }),
    });
  } finally {
    for (const context of contexts) await context.close();
    await stopServing(served);
  }
}

test("request load, frames, lag and server CPU in every page state", async ({
  browser,
}) => {
  const results: Record<string, Measured> = {};
  for (const variant of VARIANTS) {
    if (ONLY !== undefined && !ONLY.includes(variant.name)) continue;
    const measured = await measure(browser, variant);
    results[variant.name] = measured;
    console.log(`${variant.name} ${JSON.stringify(measured)}`);
    // What every page state does, whatever it costs: a healthy stream re-sends
    // nothing whole, and every record appended to the open live run reaches the
    // view showing it. The figures themselves are the budgets' to judge.
    expect(measured.repeated_snapshot.in_window.frames, variant.name).toBe(0);
    if (measured.lag !== undefined)
      expect(measured.lag.never_shown, `${variant.name} never showed`).toBe(0);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO,
      encoding: "utf8",
    }).trim() !== "";
  // A partial run is a developer's look, never the recorded telemetry.
  if (ONLY !== undefined) return;
  mkdirSync(join(import.meta.dirname, "../telemetry"), { recursive: true });
  const document = telemetrySchema.parse({
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    commit,
    dirty,
    window_s: WINDOW_MS / 1000,
    // What the generated corpus said it holds, so the recorded workload is
    // the one measured over rather than a second statement of it.
    workload: {
      runs: workload?.runs,
      projects: workload?.projects,
      other_live_runs: workload?.otherLiveRuns.length,
      records_per_minute_per_live_run: RATE,
      burst_records: BURST,
      open_live_run_records_at_start: workload?.openLiveRecords,
      fresh_server_and_corpus_per_variant: true,
    },
    variants: results,
  });
  writeFileSync(TELEMETRY, `${JSON.stringify(document, null, 2)}\n`);
});
