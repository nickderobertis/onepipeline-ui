/**
 * How fast Action items follows what is written, and what that costs the browser
 * — recorded into `telemetry/read-latency.json` for the budgets in
 * `budgets.yaml` to read.
 *
 * One corpus at this host's scale (`../load/corpus.mjs`, sized by `workload.json`)
 * and a human-item journal grown through the real CLI to this host's size serve
 * both pages. Each page then starts from that journal and a fresh
 * `onepipeline-api serve --ui`, the release build that embeds the built bundle.
 * While the page is open, the real `onepipeline human-items` CLI raises, answers,
 * completes and dismisses one write every few seconds, and this records:
 *
 * - every request the browser sends (`page.on("request")`);
 * - per write, the lag from its commit — the journal's own modification time —
 *   to the page's list rendering the change, seen by a DOM observer in the page;
 * - when each `human-items.patch` frame arrived, as a breakdown of that lag;
 * - for one 50-answer batch sent from the page, from the send bar's press to each
 *   of two open tabs' list no longer holding any of the 50.
 *
 * Apart from those, one large run's first useful screens, the rest arriving, its
 * history pages and its status read are recorded into
 * `telemetry/read-latency-large.json` for `large-run/budgets.yaml`, by a test of
 * their own that `dag-ui-read-latency:test-large` runs.
 *
 * This asserts behaviour only, and holds no time bound beyond a guard against a
 * hang: every threshold is the budgets file's.
 */

import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  liveRunDetailSchema,
  type Progress,
  patchOpSchema,
  progressSchema,
  runTimelineSchema,
} from "@onepipeline-ui/dag-model";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { z } from "zod";
import { visibleOf } from "./journey-world";
import largeWorkload from "./large-run-workload.json" with { type: "json" };
import {
  checkAnswer,
  checkScreen,
  SCREEN_OBSERVER,
  type ScreenState,
  screenStateSchema,
  type Visible,
} from "./mark";
import {
  FIRST_VIEWS,
  firstViewSchema,
  type LargeRun,
  largeTelemetrySchema,
  type Reading,
  telemetrySchema,
} from "./telemetry";
import workload from "./workload.json" with { type: "json" };

const HISTORY_LOADING = "The rest of this run's history is still loading";

const REPO = resolve(import.meta.dirname, "../../..");
const TELEMETRY = join(import.meta.dirname, "telemetry/read-latency.json");
const LARGE_TELEMETRY = join(
  import.meta.dirname,
  "telemetry/read-latency-large.json",
);
const CORPUS = join(import.meta.dirname, "../load/corpus.mjs");
const WORKLOAD = join(import.meta.dirname, "workload.json");
const LARGE_WORKLOAD = join(import.meta.dirname, "large-run-workload.json");
/**
 * `measure-run-load-on-host`'s root, served as it stands: this harness writes no run
 * there, and the server it starts writes only what its own reads of a run write.
 */
const HOST_RUNS_ROOT = process.env.READ_LATENCY_RUNS_ROOT;
const HOST_OUTPUT = process.env.READ_LATENCY_OUTPUT;
const HOST_RUN = process.env.READ_LATENCY_RUN;
const HOST_NODE = process.env.READ_LATENCY_NODE;
const ENGINE = join(REPO, ".tools/bin/onepipeline");
/** The session every item here is raised as. */
const OWNER = "read-latency-session";
/** The priority every write in a window is raised at, which the filter selects. */
const WRITTEN_PRIORITY = "high";
/** A guard against a hang: only a page that never renders a write reaches it. */
const NEVER = 120_000;

const run = promisify(execFile);

/**
 * The server `compile-release-server` builds: the release's own Linux build, in
 * the cargo target directory `scripts/build-linux-wheel.sh` gives that target.
 */
function releaseBinary(): string {
  const triple = "x86_64-unknown-linux-gnu";
  const binary = join(
    REPO,
    "target",
    `wheel-${triple}`,
    triple,
    "release",
    "onepipeline-api",
  );
  if (!existsSync(binary))
    throw new Error(
      `no ${binary}: run 'npx nx run dag-ui-read-latency:test', which builds it after the bundle`,
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

/** Where this tier's corpus lives, and the environment everything here runs in. */
interface World {
  readonly workspace: string;
  readonly runsRoot: string;
  readonly work: string;
  readonly env: NodeJS.ProcessEnv;
  readonly journal: string;
}

/** The corpus and a host whose configuration enables human items. */
function buildWorld(): World {
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-read-latency-"));
  const runsRoot = join(workspace, "runs");
  execFileSync(process.execPath, [CORPUS, runsRoot, WORKLOAD], {
    encoding: "utf8",
    maxBuffer: 1 << 20,
  });
  const config = join(workspace, "config/onepipeline");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.yaml"), "human_items:\n  enabled: true\n");
  const work = join(workspace, "work");
  mkdirSync(work);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(workspace, "config"),
    XDG_STATE_HOME: join(workspace, "state"),
    XDG_CACHE_HOME: join(workspace, "cache"),
    ONEAGENTGRAPH_STATE_DIR: join(workspace, "oneagentgraph"),
    ONEVCS_HOME: join(workspace, "onevcs-home"),
    ONEPIPELINE_PROJECT_DIR: join(workspace, "overrides"),
    ONEPIPELINE_RUNS_DIR: runsRoot,
  };
  for (const name of Object.keys(env))
    if (name.startsWith("ONETASKGRAPH_")) delete env[name];
  for (const name of [
    "ONEPIPELINE_CONFIG",
    "ONEPIPELINE_LAUNCHER_SESSION",
    "ONEPIPELINE_WAKE_BUDGET",
    "ONEPIPELINE_UI_LIVE_TRACE",
  ])
    delete env[name];
  return {
    workspace,
    runsRoot,
    work,
    env,
    journal: join(runsRoot, "human-items/events.ndjson"),
  };
}

const receiptSchema = z.object({
  item: z.object({ item: z.object({ id: z.string().min(1) }) }),
});

/** `onepipeline human-items ARGS…` in this world, as the real CLI answers it. */
async function humanItems(world: World, args: string[]): Promise<string> {
  const { stdout } = await run(ENGINE, ["human-items", ...args], {
    cwd: world.work,
    env: world.env,
    maxBuffer: 1 << 24,
  });
  return stdout;
}

/** Raise an item that blocks nothing, as its owner; answers its id. */
async function raise(
  world: World,
  key: string,
  kind: "question" | "task",
  priority: string,
  body: string,
  choices: readonly object[] = [],
): Promise<string> {
  const input = join(world.work, `raise-${key}.json`);
  writeFileSync(
    input,
    JSON.stringify({
      schema_version: 1,
      approval: null,
      dedup_key: key,
      kind,
      title: titleOf(key),
      body,
      ...(choices.length === 0 ? {} : { choices }),
      priority,
      owner: { session: OWNER, run: null, plan: null },
      block: { scope: "nothing" },
    }),
  );
  const { stdout } = await run(
    ENGINE,
    ["human-items", "raise", "--input", input],
    {
      cwd: world.work,
      env: { ...world.env, ONEPIPELINE_LAUNCHER_SESSION: OWNER },
      maxBuffer: 1 << 24,
    },
  );
  return receiptSchema.parse(JSON.parse(stdout)).item.item.id;
}

const titleOf = (key: string) => `Read latency item ${key}`;

function journalSize(world: World) {
  const text = readFileSync(world.journal, "utf8");
  return {
    events: text.split("\n").filter((line) => line.trim() !== "").length,
    bytes: Buffer.byteLength(text),
  };
}

/**
 * The journal this host's real one measures: so many events and so many bytes,
 * every one written by the real CLI. The items that get resolved are written
 * first, and then each remaining raise's body is sized from what is left and from
 * what the last raise's record took beyond its body, so the journal lands on its
 * size without this knowing a record's shape.
 */
async function growJournal(world: World): Promise<string> {
  const raises = workload.human_item_raises_at_start;
  const resolutions = workload.human_item_events_at_start - raises;
  const priorities = ["urgent", "medium", "low", "high"];
  const SENTENCE = "A body as long as a real item's. ";
  const raiseSeed = async (index: number, sentences: number) => {
    const kind = index % 2 === 0 ? "question" : "task";
    const priority = priorities[index % priorities.length] ?? "low";
    const body = SENTENCE.repeat(sentences);
    const id = await raise(world, `seed-${index}`, kind, priority, body);
    return { id, kind };
  };
  for (let index = 0; index < resolutions; index += 1) {
    const { id, kind } = await raiseSeed(index, 10);
    if (index % 3 === 2)
      await humanItems(world, ["dismiss", id, "--reason", "not needed"]);
    else if (kind === "question")
      await humanItems(world, ["answer", id, "--text", "Yes"]);
    else await humanItems(world, ["complete", id]);
  }
  let overhead = 1000;
  for (let index = resolutions; index < raises; index += 1) {
    const before = journalSize(world).bytes;
    const left = workload.human_item_bytes_at_start - before;
    const sentences = Math.max(
      1,
      Math.round((left / (raises - index) - overhead) / SENTENCE.length),
    );
    await raiseSeed(index, sentences);
    overhead = journalSize(world).bytes - before - sentences * SENTENCE.length;
  }
  const grown = join(world.workspace, "human-items.grown");
  cpSync(join(world.runsRoot, "human-items"), grown, { recursive: true });
  return grown;
}

/** A fresh server over the world, from the journal `grown` holds. */
async function serveFresh(world: World, grown: string, name: string) {
  rmSync(join(world.runsRoot, "human-items"), { recursive: true, force: true });
  cpSync(grown, join(world.runsRoot, "human-items"), { recursive: true });
  const bin = join(world.workspace, `bin-${name}`);
  mkdirSync(bin);
  const staged = join(bin, "onepipeline-api");
  copyFileSync(releaseBinary(), staged, constants.COPYFILE_FICLONE);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // The server's own default poll interval: this measures the shipped cadence.
  const server: ChildProcess = spawn(
    staged,
    [
      "serve",
      "--runs-root",
      world.runsRoot,
      "--bind",
      `127.0.0.1:${port}`,
      "--session",
      OWNER,
      "--ui",
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: world.env,
      cwd: world.work,
    },
  );
  const deadline = Date.now() + NEVER;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`the ${name} server exited ${server.exitCode}`);
    const up = await fetch(`${origin}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return { origin, server };
    if (Date.now() > deadline)
      throw new Error(`the ${name} server never answered`);
    await new Promise((wake) => setTimeout(wake, 100));
  }
}

async function stopServing(server: ChildProcess): Promise<void> {
  server.kill("SIGTERM");
  if (server.exitCode === null)
    await new Promise((wake) => server.once("exit", wake));
}

const hostLoad = () => {
  const [load_1m = 0, load_5m = 0, load_15m = 0] = loadavg();
  return { load_1m, load_5m, load_15m, cores: availableParallelism() };
};

/** An API or bundle path as a route: a subscription's id and the query dropped. */
function routeOf(method: string, url: URL): string {
  const path = url.pathname.replace(
    /^\/api\/v2\/subscriptions\/[^/]+/u,
    "/api/v2/subscriptions/:id",
  );
  return `${method} ${path}`;
}

/** Every title in the list, and when each first appeared and left. */
const renderedSchema = z.object({
  shown: z.record(z.string(), z.number()),
  gone: z.record(z.string(), z.number()),
});
type Rendered = z.infer<typeof renderedSchema>;

declare global {
  interface Window {
    readLatencyRendered?: Rendered;
  }
}

/**
 * The page's card list: one list per group heading under it while the cards are
 * grouped, as they are by Priority from the start, so the region rather than any
 * one list is what holds every card.
 */
const actionItemList = (page: Page) =>
  page.getByRole("region", { name: "Action item list" });

/** Watch the page's list from inside it, so a render is timed as it lands. */
async function observe(page: Page): Promise<void> {
  await actionItemList(page).evaluate((list: Element) => {
    const rendered: Rendered = { shown: {}, gone: {} };
    const look = () => {
      const at = Date.now();
      const titles = new Set(
        // llmlint: ignore[e2e_uses_accessible_selectors] this runs inside the page on every mutation to timestamp a render as it lands, where Playwright's role engine does not exist; the list itself was located by role above, and awaiting a locator per write from outside would time the round trip rather than the render.
        [...list.querySelectorAll("h3")].map((title) => title.textContent),
      );
      for (const title of titles) rendered.shown[title] ??= at;
      for (const title of Object.keys(rendered.shown))
        if (!titles.has(title)) rendered.gone[title] ??= at;
    };
    look();
    new MutationObserver(look).observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.readLatencyRendered = rendered;
  });
}

async function renderedOn(page: Page): Promise<Rendered> {
  return renderedSchema.parse(
    await page.evaluate(() => window.readLatencyRendered),
  );
}

const WRITE_CYCLE = [
  "raise-question",
  "answer",
  "raise-task",
  "complete",
  "raise-dismissed",
  "dismiss",
] as const;

interface Written {
  readonly at: number;
  readonly title: string;
  readonly leaves: boolean;
  readonly kind: "raise" | "answer" | "complete" | "dismiss";
}

/**
 * The window's writes through the real CLI, one every few seconds from the same
 * clock, each stamped with when its record reached the journal.
 */
async function writeWindow(world: World, page: string): Promise<Written[]> {
  const written: Written[] = [];
  const started = Date.now();
  let last = "";
  for (let index = 0; index < workload.writes; index += 1) {
    const due = started + index * workload.write_spacing_s * 1000;
    await new Promise((wake) =>
      setTimeout(wake, Math.max(0, due - Date.now())),
    );
    const step = WRITE_CYCLE[index % WRITE_CYCLE.length] ?? "raise-task";
    const key = `${page}-${Math.floor(index / 2)}`;
    const body = "What this write asks of a person.";
    let kind: Written["kind"] = "raise";
    if (step === "raise-question")
      last = await raise(world, key, "question", WRITTEN_PRIORITY, body);
    else if (step === "raise-task" || step === "raise-dismissed")
      last = await raise(world, key, "task", WRITTEN_PRIORITY, body);
    else if (step === "answer") {
      kind = "answer";
      await humanItems(world, ["answer", last, "--text", "Yes"]);
    } else if (step === "complete") {
      kind = "complete";
      await humanItems(world, ["complete", last]);
    } else {
      kind = "dismiss";
      await humanItems(world, ["dismiss", last, "--reason", "not needed"]);
    }
    written.push({
      at: statSync(world.journal).mtimeMs,
      title: titleOf(key),
      leaves: kind !== "raise",
      kind,
    });
  }
  return written;
}

const seconds = (ms: number) => Math.round(ms) / 1000;

/** The `p`th percentile, nearest rank, or `null` for no values. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[rank] ?? null;
}

/** One page's window, measured from the moment it has loaded. */
async function measurePage(
  page: Page,
  world: World,
  grown: string,
  name: "unfiltered" | "filtered",
) {
  const { origin, server } = await serveFresh(world, grown, name);
  try {
    const journal_at_start = journalSize(world);
    await page.goto(`${origin}/human-items`);
    const list = actionItemList(page);
    await expect(list.getByRole("listitem").first()).toBeVisible({
      timeout: NEVER,
    });
    const filter = name === "filtered" ? { priority: WRITTEN_PRIORITY } : {};
    if (name === "filtered") {
      const before = await list.getByRole("article").count();
      await page
        .getByRole("group", { name: "Filter action items" })
        .getByLabel("Priority", { exact: true })
        .selectOption(WRITTEN_PRIORITY);
      await expect
        .poll(() => list.getByRole("article").count(), { timeout: NEVER })
        .toBeLessThan(before);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const frames: { at: number }[] = [];
    cdp.on("Network.eventSourceMessageReceived", (event) => {
      if (event.eventName === "human-items.patch")
        frames.push({ at: Date.now() });
    });
    await observe(page);
    const requests: string[] = [];
    let connections = 0;
    const heard = (request: { method(): string; url(): string }) => {
      const route = routeOf(request.method(), new URL(request.url()));
      requests.push(route);
      if (route === "GET /api/v2/events") connections += 1;
    };
    page.on("request", heard);
    const start = hostLoad();
    const opened = Date.now();
    const written = await writeWindow(world, name);
    const showsEverything = (rendered: Rendered) =>
      written.every(({ title, leaves }) =>
        leaves ? rendered.gone[title] : rendered.shown[title],
      );
    await expect
      .poll(async () => showsEverything(await renderedOn(page)), {
        timeout: NEVER,
      })
      .toBe(true);
    const window_s = (Date.now() - opened) / 1000;
    page.off("request", heard);
    const rendered = await renderedOn(page);
    const lags = written.flatMap(({ at, title, leaves }) => {
      const landed = leaves ? rendered.gone[title] : rendered.shown[title];
      return landed === undefined ? [] : [seconds(landed - at)];
    });
    // For each write, how long until the first frame arrived after its commit.
    const arrivals = written.flatMap(({ at }) => {
      const first = frames.find((frame) => frame.at >= at);
      return first === undefined ? [] : [seconds(first.at - at)];
    });
    const count = (kind: Written["kind"]) =>
      written.filter((write) => write.kind === kind).length;
    return {
      filter,
      window_s,
      writes_by_kind: {
        raise: count("raise"),
        answer: count("answer"),
        complete: count("complete"),
        dismiss: count("dismiss"),
      },
      journal_at_start,
      requests: requests.length,
      requests_per_min: (requests.length / window_s) * 60,
      requests_by_route: Object.fromEntries(
        [...new Set(requests)].map((route) => [
          route,
          requests.filter((held) => held === route).length,
        ]),
      ),
      connections_opened: connections,
      lag: {
        writes: written.length,
        shown: lags.length,
        never_shown: written.length - lags.length,
        p50_s: percentile(lags, 50),
        p95_s: percentile(lags, 95),
        max_s: lags.length === 0 ? null : Math.max(...lags),
        frame_arrival: {
          p50_s: percentile(arrivals, 50),
          p95_s: percentile(arrivals, 95),
          max_s: arrivals.length === 0 ? null : Math.max(...arrivals),
        },
      },
      host_load: { start, end: hostLoad() },
    };
  } finally {
    await stopServing(server);
  }
}

/** The large run's world: its corpus, the sibling-written checkpoint, the stand-in. */
interface LargeWorld {
  readonly workspace: string;
  readonly runsRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run: string;
  readonly busiestNode: string;
  readonly smallRun: string;
  readonly facts: z.infer<typeof largeFactsSchema> | undefined;
  readonly standInLog: string;
  readonly writer: ChildProcess | undefined;
}

const largeFactsSchema = z.object({
  openLiveRun: z.string(),
  otherLiveRuns: z.array(z.string()),
  smallRun: z.string(),
  large: z.object({
    busiestNode: z.string(),
    offGraphNode: z.string(),
    gatedNode: z.string(),
    heldNode: z.string(),
    failedNode: z.string(),
    crossRunConsumer: z.string(),
    historyStore: z.string(),
    sessions: z.number().int(),
  }),
});

const hostEnv = (workspace: string, runsRoot: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
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
};

/**
 * A `claude` on PATH that takes 20 s and records each start: a status read that
 * asked the host for its provider report would wait on it and leave a line.
 */
// llmlint: ignore[e2e_not_mocked] the task's status budget is stated over exactly this: a `claude` on PATH that takes 20 s and records each start, so a status read that started the provider sweep would wait on it and leave a line; the server, its status route and the checkpoint it reads are real.
function writeStandIn(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "claude-starts.log");
  const stand = join(dir, "claude");
  writeFileSync(
    stand,
    `#!/bin/sh\necho "$(date +%s)" >> "${log}"\nsleep 20\n`,
    { mode: 0o755 },
  );
  return log;
}

/** What the driver figures read of each journal record. */
const journalRecordSchema = z.looseObject({
  ts: z.string(),
  stream: z.string(),
  kind: z.string(),
  labels: z.looseObject({ node: z.string().optional() }).optional(),
  payload: z
    .looseObject({
      transcript: z
        .looseObject({ history_id: z.string().optional() })
        .optional(),
    })
    .optional(),
});

/** The driver figures read off the corpus itself, never off the corpus's word. */
function readCorpusDrivers(
  world: LargeWorld,
  complete: {
    graph: unknown;
    spans: readonly Record<string, unknown>[];
    firstAnswerBytes: number;
  },
) {
  const journal = readFileSync(
    join(world.runsRoot, world.run, "events.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim() !== "");
  const records = journal.map((line) =>
    journalRecordSchema.parse(JSON.parse(line)),
  );
  const facts = world.facts;
  const nodeOf = (record: { labels?: { node?: string } }) =>
    record.labels?.node;
  const dropped = new Set(
    records
      .filter((record) =>
        ["member-heartbeat", "turn-activity"].includes(record.kind),
      )
      .map((record) => record.ts),
  );
  const ordinary = complete.spans.filter((span) => !span.harness_scope);
  const graph = z
    .object({
      node_gated_by: z.record(z.string(), z.array(z.string())).default({}),
      node_results: z
        .record(
          z.string(),
          z.looseObject({ awaiting: z.array(z.unknown()).optional() }),
        )
        .default({}),
      plan: z
        .looseObject({
          tasks: z.array(
            z.looseObject({
              id: z.string(),
              deps: z.array(z.string()).default([]),
            }),
          ),
        })
        .optional(),
    })
    .parse(complete.graph);
  // A consumer whose dependency names a run that is in this root, as `run:<id>#<node>`.
  const crossRunConsumers = (graph.plan?.tasks ?? []).filter((task) =>
    task.deps.some((dep) => {
      const named = /^run:([^#]+)#/u.exec(dep)?.[1];
      return named !== undefined && existsSync(join(world.runsRoot, named));
    }),
  );
  // The stand-in counts only where an executable `claude` is on the path it records.
  const standIn = join(dirname(world.standInLog), "claude");
  return {
    records: records.length,
    journal_bytes: Buffer.byteLength(journal.join("\n")) + journal.length,
    streams: new Set(records.map((record) => record.stream)).size,
    checkpoint_bytes: statSync(
      join(world.runsRoot, world.run, "checkpoint.json"),
    ).size,
    ordinary_spans: ordinary.length,
    harness_spans: complete.spans.length - ordinary.length,
    busiest_node_records: records.filter(
      (record) => nodeOf(record) === world.busiestNode,
    ).length,
    off_graph_node_records: records.filter(
      (record) => nodeOf(record) === facts?.large.offGraphNode,
    ).length,
    run_directories: readdirSync(world.runsRoot).length,
    other_live_runs: facts?.otherLiveRuns.length ?? 0,
    overall_first_answer_bytes: complete.firstAnswerBytes,
    // A UUID v7 reference, as the session store's history id spells one.
    session_references: records.filter((record) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        record.payload?.transcript?.history_id ?? "",
      ),
    ).length,
    spans_resting_on_dropped_records: ordinary.filter(
      (span) =>
        dropped.has(span.started_at as string) ||
        dropped.has(span.ended_at as string),
    ).length,
    reasons: Object.keys(graph.node_gated_by).length,
    awaits: Object.values(graph.node_results).filter(
      (result) => (result.awaiting ?? []).length > 0,
    ).length,
    cross_run_settled_consumers: crossRunConsumers.length,
    stand_in_provider:
      existsSync(standIn) && (statSync(standIn).mode & 0o111) !== 0 ? 1 : 0,
  };
}

function buildLargeWorld(): LargeWorld {
  if (HOST_RUNS_ROOT !== undefined) {
    const workspace = mkdtempSync(join(tmpdir(), "dag-ui-read-latency-host-"));
    if (HOST_RUN === undefined)
      throw new Error("--runs-root needs --run to name the opened run");
    return {
      workspace,
      runsRoot: HOST_RUNS_ROOT,
      env: hostEnv(workspace, HOST_RUNS_ROOT),
      run: HOST_RUN,
      busiestNode: HOST_NODE ?? "",
      smallRun: "",
      facts: undefined,
      standInLog: join(workspace, "no-stand-in"),
      writer: undefined,
    };
  }
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-read-latency-large-"));
  const runsRoot = join(workspace, "runs");
  const facts = largeFactsSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, [CORPUS, runsRoot, LARGE_WORKLOAD], {
        encoding: "utf8",
        maxBuffer: 1 << 24,
      }),
    ),
  );
  const providerBin = join(workspace, "provider-bin");
  const standInLog = writeStandIn(providerBin);
  const env = hostEnv(workspace, runsRoot);
  env.PATH = `${providerBin}:${process.env.PATH ?? ""}`;
  // The engine writes its own fold into `checkpoint.json` on a read: the checkpoint
  // every reader then opens is the real one, of the real size.
  execFileSync(ENGINE, ["status", facts.openLiveRun], { env, stdio: "ignore" });
  const log = join(workspace, "appended.jsonl");
  writeFileSync(log, "");
  const runs = facts.otherLiveRuns.map((liveRun) => ({
    run: liveRun,
    node: "work",
  }));
  const writer = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../load/writer.mjs"),
      JSON.stringify({
        root: runsRoot,
        log,
        durationMs: 3_600_000,
        rate: largeWorkload.records_per_minute_per_live_run,
        runs,
        burst: 0,
        burstRun: runs[0]?.run,
        burstAt: 0,
        openRun: facts.otherLiveRuns[0],
      }),
    ],
    { stdio: "ignore" },
  );
  return {
    workspace,
    runsRoot,
    env,
    run: facts.openLiveRun,
    busiestNode: facts.large.busiestNode,
    smallRun: facts.smallRun,
    facts,
    standInLog,
    writer,
  };
}

/** One fresh release server over `world`, on `port`, that has answered one sidebar read. */
async function serveLarge(world: LargeWorld, port: number) {
  const server: ChildProcess = spawn(
    releaseBinary(),
    [
      "serve",
      "--runs-root",
      world.runsRoot,
      "--bind",
      `127.0.0.1:${port}`,
      "--session",
      OWNER,
      "--ui",
    ],
    { stdio: "ignore", env: world.env, cwd: world.workspace },
  );
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + NEVER;
  for (;;) {
    const up = await fetch(`${origin}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error("the large run's server never answered");
    await new Promise((wake) => setTimeout(wake, 100));
  }
  // The budget's "fresh server that has answered one sidebar read".
  await fetch(`${origin}/api/v2/runs`);
  return { origin, server };
}

/** The first answer, pared to what a mark and the complete comparison read. */
interface Answer {
  readonly initial: { readonly snapshot: { readonly visible: Visible } };
}

type Json = Record<string, unknown>;
interface Complete {
  readonly detail: Json;
  readonly timeline: { readonly spans: readonly Json[] };
  readonly nodeTimeline: { readonly spans: readonly Json[] };
}

const urlOf = (
  run: string,
  view: (typeof FIRST_VIEWS)[number],
  node: string,
) =>
  view === "node"
    ? `/?run=${encodeURIComponent(run)}&view=graph&node=${encodeURIComponent(node)}`
    : `/?run=${encodeURIComponent(run)}&view=${view}`;

async function firstViewReading(
  browser: Browser,
  world: LargeWorld,
  port: number,
  view: (typeof FIRST_VIEWS)[number],
  complete: Complete,
  cachedContext?: BrowserContext,
  run = world.run,
): Promise<{
  reading: Reading;
  state: ScreenState | undefined;
  context: BrowserContext;
  page: Page;
  server: ChildProcess;
}> {
  const { origin, server } = await serveLarge(world, port);
  const context =
    cachedContext ??
    (await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  const page = await context.newPage();
  await page.addInitScript(SCREEN_OBSERVER);
  let posted: { at: number; done: number; body: string } | undefined;
  const postStart = new Map<string, number>();
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/v2/subscriptions" &&
      request.method() === "POST"
    )
      postStart.set(request.url(), Date.now());
  });
  page.on("response", async (response) => {
    if (
      new URL(response.url()).pathname === "/api/v2/subscriptions" &&
      response.request().method() === "POST"
    ) {
      posted = {
        at: postStart.get(response.url()) ?? Date.now(),
        done: Date.now(),
        body: "",
      };
    }
  });
  await page.goto(`${origin}${urlOf(run, view, world.busiestNode)}`, {
    waitUntil: "commit",
  });
  const deadline = Date.now() + NEVER;
  let mark: ScreenState | undefined;
  let answer: Answer | undefined;
  while (Date.now() < deadline) {
    if (posted !== undefined && answer === undefined) {
      const text = await page.evaluate("window.__firstAnswer");
      if (typeof text === "string") {
        posted.body = text;
        answer = {
          initial: { snapshot: { visible: visibleOf(JSON.parse(text)) } },
        };
      }
    }
    if (answer !== undefined) {
      const { visible } = answer.initial.snapshot;
      const states = z
        .array(screenStateSchema)
        .parse(await page.evaluate("window.__firstScreen ?? []"));
      mark = states.find(
        (state) =>
          checkScreen(view, visible, state, world.busiestNode).length === 0,
      );
      if (mark !== undefined) break;
    }
    await page.waitForTimeout(50);
  }
  const navStart = await page.evaluate("performance.timeOrigin");
  const posted2 = posted;
  const body = posted2?.body ?? "";
  const load = hostLoad();
  const reading: Reading = {
    seconds: mark === undefined ? null : mark.at / 1000,
    navigation_to_post_s:
      posted2 === undefined ? null : (posted2.at - Number(navStart)) / 1000,
    post_s: posted2 === undefined ? null : (posted2.done - posted2.at) / 1000,
    answer_to_mark_s:
      mark === undefined || posted2 === undefined
        ? null
        : mark.at / 1000 - (posted2.done - Number(navStart)) / 1000,
    first_answer_bytes: Buffer.byteLength(body),
    first_answer_gzipped: gzipSync(body).length,
    checked: {
      screen_against_answer: mark !== undefined && answer !== undefined,
      answer_against_complete:
        answer !== undefined &&
        checkAnswer(
          answer.initial.snapshot.visible,
          view === "node"
            ? { detail: complete.detail, timeline: complete.nodeTimeline }
            : { detail: complete.detail, timeline: complete.timeline },
          view === "overall" ? "run" : view === "node" ? "node" : undefined,
        ).length === 0,
    },
    host_load: load,
  };
  return { reading, state: mark, context, page, server };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** The server's peak resident set, from the kernel's own accounting. */
function peakRssMb(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /VmHWM:\s+(\d+) kB/u.exec(status);
  return match === null ? 0 : Number(match[1]) / 1024;
}

const completeSchema = z.looseObject({
  run: z.looseObject({ state: z.string() }),
  graph: z.looseObject({ node_status: z.record(z.string(), z.string()) }),
});
const timelineSchema = z.looseObject({
  spans: z.array(z.record(z.string(), z.unknown())),
});

/** The complete documents, read once by their own server before any timing. */
async function readComplete(world: LargeWorld, port: number) {
  const { origin, server } = await serveLarge(world, port);
  try {
    const root = `${origin}/api/v2/runs/${encodeURIComponent(world.run)}`;
    const read = async (path: string): Promise<unknown> =>
      (await fetch(`${root}${path}`)).json();
    // Each document is its own whole read, and nothing here is timed, so the
    // three are taken together: 59 s one after another and 32 s at once here.
    const [detail, timeline, nodeTimeline] = await Promise.all([
      read("").then((body) => {
        // The contract's own schema holds every member the comparisons read.
        liveRunDetailSchema.parse(body);
        return completeSchema.parse(body);
      }),
      read("/timeline?scope=run").then((body) => {
        runTimelineSchema.parse(body);
        return timelineSchema.parse(body);
      }),
      world.busiestNode === ""
        ? Promise.resolve({ spans: [] })
        : read(
            `/timeline?scope=node&node=${encodeURIComponent(world.busiestNode)}`,
          ).then((body) => {
            runTimelineSchema.parse(body);
            return timelineSchema.parse(body);
          }),
    ]);
    return { detail, timeline, nodeTimeline, spans: timeline.spans };
  } finally {
    await stopServing(server);
  }
}

async function restArrived(
  world: LargeWorld,
  port: number,
  browser: Browser,
  complete: Complete,
) {
  const measure = async (
    view: (typeof FIRST_VIEWS)[number],
    pages?: HistoryPages,
  ) => {
    const opened = await firstViewReading(browser, world, port, view, complete);
    let framesBytes = 0;
    // The detail's `progress` as the server last published it, read off the
    // patches the page applied: the page saying nothing is loading is only the
    // rest arriving when the server also said `complete` and named no failure.
    let served: Progress | undefined;
    const cdp = await opened.context.newCDPSession(opened.page);
    await cdp.send("Network.enable");
    cdp.on("Network.eventSourceMessageReceived", (event) => {
      if (
        event.eventName === "detail.patch" ||
        event.eventName === "timeline.patch"
      )
        framesBytes += Buffer.byteLength(event.data);
      if (event.eventName === "detail.patch")
        served = progressPatched(served, event.data);
    });
    // The mark is taken; the observer that found it, which reads the whole screen
    // on every change, is stopped so it does not slow the page it times.
    await opened.page.evaluate("window.__firstScreenStop?.()");
    // The history page before the rest is published is read on this opening,
    // which a fourth whole read of the run would otherwise be spent on.
    if (pages !== undefined) await pages.before(opened.page);
    // The rest has arrived once the page no longer says it is loading any of it:
    // no quiet line, and no Turns tile still reading Loading….
    const arrivedAt = async (): Promise<number | null> =>
      z
        .number()
        .nullable()
        .parse(
          // llmlint: ignore-block[e2e_uses_accessible_selectors] this runs inside the page to stamp the moment the last loading value is gone with the page's own clock, where Playwright's role engine does not exist; the status line and the `Turns` group are read by the role and name the app gives them, and a locator awaited from outside would time the round trip rather than the render.
          await opened.page.evaluate(() => {
            const quiet = [
              ...document.querySelectorAll('[role="status"]'),
            ].some((element) =>
              element.textContent?.includes(
                "The rest of this run's history is still loading",
              ),
            );
            const turns = [...document.querySelectorAll('[role="group"]')].find(
              (group) => group.getAttribute("aria-label") === "Turns",
            );
            const turnsLoading =
              turns?.querySelector("strong")?.textContent === "Loading…";
            return quiet || turnsLoading ? null : performance.now();
          }),
        );
    // llmlint: ignore-end[e2e_uses_accessible_selectors]
    let at: number | null = null;
    const deadline = Date.now() + 600_000;
    while (at === null && Date.now() < deadline) {
      at = await arrivedAt();
      if (at === null) await opened.page.waitForTimeout(100);
    }
    if (
      at !== null &&
      (served?.complete !== true || served.failed !== undefined)
    )
      throw new Error(
        `${view} drew no loading value, but the server's progress was ${JSON.stringify(served)}`,
      );
    const seconds =
      opened.state === undefined || at === null
        ? null
        : (at - opened.state.at) / 1000;
    if (pages !== undefined && at !== null) await pages.after(opened.page);
    const peak = peakRssMb(opened.server.pid ?? 0);
    await opened.context.close();
    await stopServing(opened.server);
    return { seconds, framesBytes, peak };
  };
  const overall = await measure("overall");
  if (overall.seconds === null)
    throw new Error("Overall's loading values never arrived");
  const graph = await measure("graph");
  const pages = historyPages(world, port, complete);
  const node = await measure("node", pages);
  return {
    rest: {
      overall_s: overall.seconds,
      graph_s: graph.seconds,
      node_s: node.seconds,
      patch_frame_bytes: overall.framesBytes,
      server_peak_rss_mb: Math.max(overall.peak, graph.peak, node.peak),
      complete: true as const,
    },
    history: pages.result(),
  };
}

/**
 * `progress` after one `detail.patch` frame's ops: the whole member where an op
 * sets it, one of its fields where an op sets that.
 */
function progressPatched(
  progress: Progress | undefined,
  frame: string,
): Progress | undefined {
  const ops = z
    .object({ ops: z.array(patchOpSchema) })
    .parse(JSON.parse(frame)).ops;
  let next = progress;
  for (const op of ops) {
    const [member, field] = op.p;
    if (member !== "progress" || "a" in op) continue;
    if (field === undefined) {
      next = "v" in op ? progressSchema.parse(op.v) : undefined;
      continue;
    }
    if (typeof field !== "string") continue;
    // The first answer's progress came with the snapshot; a field patched over it
    // is read over "nothing known" rather than skipped.
    const kept: Record<string, unknown> = {
      ...(next ?? { complete: false, loading: [] }),
    };
    if ("v" in op) kept[field] = op.v;
    else delete kept[field];
    next = progressSchema.parse(kept);
  }
  return next;
}

interface HistoryPages {
  /** Asks for earlier rows while the rest is still loading. */
  readonly before: (page: Page) => Promise<void>;
  /** Asks again once the rest has arrived. */
  readonly after: (page: Page) => Promise<void>;
  readonly result: () => {
    /** `null` only on a host's run whose rest arrived before a page was asked for. */
    node_before_rest_s: number | null;
    node_after_rest_s: number;
    overall_span_page_s: number | null;
    slowest_s: number;
    rows_shown_after: number;
  };
}

/**
 * The busiest node's history pages, asked for by the page's own control on the
 * node opening the rest-arrived reading holds: one page before the rest is
 * published and one after, then Overall's span page as the client asks for it.
 * The corpus is sized so its rest is still loading when the first page is asked
 * for, and a corpus whose rest was not is refused. A host's run may be small
 * enough that its rest arrives first; that run has no page before the rest.
 */
function historyPages(
  world: LargeWorld,
  port: number,
  complete: Complete,
): HistoryPages {
  const generated = world.facts !== undefined;
  let before: number | null | undefined;
  let after: number | undefined;
  let rowsAfter = 0;
  let overallSpan: number | null = null;
  const pageRead = async (page: Page) => {
    const transcript = page.getByRole("region", { name: "Node transcript" });
    const rows = transcript.getByRole("article");
    const loadEarlier = page.getByRole("button", { name: "Load earlier rows" });
    await loadEarlier.waitFor({ timeout: NEVER });
    const shown = await rows.count();
    const asked = Date.now();
    await loadEarlier.click();
    await expect
      .poll(() => rows.count(), { timeout: NEVER })
      .toBeGreaterThan(shown);
    return { seconds: (Date.now() - asked) / 1000, rows: await rows.count() };
  };
  return {
    async before(page) {
      // The "before" reading is only that while the rest is still loading.
      if ((await page.getByText(HISTORY_LOADING).count()) === 0) {
        if (generated)
          throw new Error(
            "the rest of the run arrived before the first page was asked for",
          );
        before = null;
        return;
      }
      before = (await pageRead(page)).seconds;
    },
    async after(page) {
      await expect(page.getByText(HISTORY_LOADING)).toHaveCount(0, {
        timeout: 600_000,
      });
      const read = await pageRead(page);
      after = read.seconds;
      rowsAfter = read.rows;
      // Overall's span page, as the client's own request reads it, from the
      // server this opening holds the rest on.
      const dispatch = complete.timeline.spans.find(
        (span) => span.kind === "node",
      );
      if (dispatch !== undefined) {
        const root = `http://127.0.0.1:${port}/api/v2/runs/${encodeURIComponent(world.run)}`;
        const asked = Date.now();
        const answer = await fetch(
          `${root}/timeline/events?scope=run&node=${encodeURIComponent(String(dispatch.node_id))}&span=${encodeURIComponent(String(dispatch.id))}&limit=100`,
        );
        await answer.text();
        overallSpan = (Date.now() - asked) / 1000;
      }
    },
    result() {
      if (before === undefined || after === undefined)
        throw new Error("the busiest node's history pages were never read");
      return {
        node_before_rest_s: before,
        node_after_rest_s: after,
        overall_span_page_s: overallSpan,
        slowest_s: Math.max(before ?? after, after),
        rows_shown_after: rowsAfter,
      };
    },
  };
}

async function statusRead(world: LargeWorld, port: number) {
  const { origin, server } = await serveLarge(world, port);
  try {
    const timed = async (run: string) => {
      const started = Date.now();
      const response = await fetch(
        `${origin}/api/v2/runs/${encodeURIComponent(run)}/status`,
      );
      await response.text();
      expect(response.ok, `status of ${run}`).toBe(true);
      return (Date.now() - started) / 1000;
    };
    // A host's root names no small run of its own, so only its run is read.
    const small = world.smallRun === "" ? null : await timed(world.smallRun);
    const large = await timed(world.run);
    const starts = existsSync(world.standInLog)
      ? readFileSync(world.standInLog, "utf8").split("\n").filter(Boolean)
          .length
      : 0;
    return {
      small_s: small,
      large_s: large,
      slowest_s: Math.max(small ?? large, large),
      checkpoint_bytes: statSync(
        join(world.runsRoot, world.run, "checkpoint.json"),
      ).size,
      stand_in_starts: starts,
    };
  } finally {
    await stopServing(server);
  }
}

/**
 * What one measurement holds. A generated corpus fills every figure, which the
 * large-run telemetry's schema requires; a host's run may leave the two this
 * names `null`, as `historyPages` and `statusRead` say.
 */
type Measured = Omit<LargeRun, "history_page" | "status"> & {
  readonly history_page: Omit<
    LargeRun["history_page"],
    "node_before_rest_s"
  > & {
    readonly node_before_rest_s: number | null;
  };
  readonly status: Omit<LargeRun["status"], "small_s"> & {
    readonly small_s: number | null;
  };
};

async function measureLargeRun(browser: Browser): Promise<Measured> {
  const world = buildLargeWorld();
  const port = await freePort();
  try {
    const hostStart = hostLoad();
    const complete = await readComplete(world, port);
    const first: Partial<
      Record<(typeof FIRST_VIEWS)[number], LargeRun["first_view"]["graph"]>
    > = {};
    let overallBytes = 0;
    for (const view of FIRST_VIEWS) {
      // A primer that leaves the bundle in this context's HTTP cache. It is a
      // new context on a fresh server, so its reading is the cold-cache one.
      const primer = await firstViewReading(
        browser,
        world,
        port,
        view,
        complete,
      );
      await primer.page.close();
      await stopServing(primer.server);
      const readings: Reading[] = [];
      for (let index = 0; index < 3; index += 1) {
        const taken = await firstViewReading(
          browser,
          world,
          port,
          view,
          complete,
          primer.context,
        );
        readings.push(taken.reading);
        await taken.page.close();
        await stopServing(taken.server);
      }
      let small: number | null = null;
      if (world.smallRun !== "" && view !== "node") {
        const tiny = await firstViewReading(
          browser,
          world,
          port,
          view,
          complete,
          primer.context,
          world.smallRun,
        );
        small = tiny.reading.seconds;
        await tiny.page.close();
        await stopServing(tiny.server);
      }
      await primer.context.close();
      const taken = readings.flatMap((reading) =>
        reading.seconds === null ? [] : [reading.seconds],
      );
      first[view] = {
        readings,
        median_s: taken.length === 3 ? median(taken) : null,
        cold_cache: primer.reading,
        // Every reading is taken on a fresh server with the bundle cached, so
        // the first of the three is that reading rather than a fourth like it.
        fresh_server: readings[0] ?? primer.reading,
        small_run_s: small,
      };
      if (view === "overall")
        overallBytes = readings[0]?.first_answer_bytes ?? 0;
    }
    const taken = (view: (typeof FIRST_VIEWS)[number]) => {
      const measured = first[view];
      if (measured === undefined) throw new Error(`no ${view} view was read`);
      return measured;
    };
    const medians = FIRST_VIEWS.map((view) => taken(view).median_s ?? Infinity);
    const slowestIndex = medians.indexOf(Math.max(...medians));
    const firstView: LargeRun["first_view"] = {
      graph: taken("graph"),
      overall: taken("overall"),
      node: taken("node"),
      slowest_view: FIRST_VIEWS[slowestIndex] ?? "graph",
      slowest_s: medians[slowestIndex] ?? 0,
    };
    const { rest, history } = await restArrived(world, port, browser, complete);
    const status = await statusRead(world, port);
    const unread: Record<string, number> = {};
    const corpus =
      world.facts === undefined
        ? unread
        : readCorpusDrivers(world, {
            graph: complete.detail.graph,
            spans: complete.spans,
            firstAnswerBytes: overallBytes,
          });
    return {
      corpus,
      first_view: firstView,
      rest_arrived: rest,
      history_page: history,
      status,
      host_load: { start: hostStart, end: hostLoad() },
    };
  } finally {
    world.writer?.kill("SIGTERM");
    rmSync(world.workspace, { recursive: true, force: true });
  }
}

if (HOST_RUNS_ROOT !== undefined)
  test("one run's first screens, as this host holds them", async ({
    browser,
  }) => {
    // `measure-run.mjs` names the file and prints it, so the runner's own
    // report never shares a stream with the figures.
    if (HOST_OUTPUT === undefined)
      throw new Error(
        "a host measurement needs READ_LATENCY_OUTPUT to write to",
      );
    const measured = await measureLargeRun(browser);
    writeFileSync(
      HOST_OUTPUT,
      `${JSON.stringify({ run: HOST_RUN, node: HOST_NODE, ...measured }, null, 2)}\n`,
    );
    // Written first, so a run whose screens went wrong still leaves its figures to
    // read; it is a failure all the same.
    firstViewSchema.parse(measured.first_view);
  });

const BATCH_BODY = "What this batched question asks of a person.";

/** One choice a batched question offers, by position. */
const choiceFor = (at: number) => ({
  id: `option-${at}`,
  title: `Option ${at}`,
  description: `Why option ${at} would do.`,
});

/** One batch sent from a filtered tab, watched in it and in an unfiltered one. */
async function measureBatch(browser: Browser, world: World, grown: string) {
  const { origin, server } = await serveFresh(world, grown, "batch");
  const context = await browser.newContext();
  try {
    const titles: string[] = [];
    const ids: string[] = [];
    for (let index = 0; index < workload.batch_questions; index += 1) {
      const key = `batch-${index}`;
      const choices =
        index < workload.batch_with_choices
          ? Array.from({ length: workload.batch_choices_each }, (_, at) =>
              choiceFor(at),
            )
          : [];
      ids.push(
        await raise(
          world,
          key,
          "question",
          WRITTEN_PRIORITY,
          BATCH_BODY,
          choices,
        ),
      );
      titles.push(titleOf(key));
    }
    const last = titles.at(-1) ?? "";
    const openTab = async (filtered: boolean) => {
      const tab = await context.newPage();
      await tab.goto(`${origin}/human-items`);
      const list = actionItemList(tab);
      await expect(
        list.getByRole("article", { name: last, exact: true }),
      ).toBeVisible({
        timeout: NEVER,
      });
      if (filtered) {
        await tab
          .getByRole("group", { name: "Filter action items" })
          .getByLabel("Priority", { exact: true })
          .selectOption(WRITTEN_PRIORITY);
        await expect(
          list.getByRole("heading", { name: "Critical" }),
        ).toHaveCount(0, { timeout: NEVER });
      }
      return tab;
    };
    const unfiltered = await openTab(false);
    const filtered = await openTab(true);
    await observe(unfiltered);
    await observe(filtered);
    const heard: Record<"unfiltered" | "filtered", number> = {
      unfiltered: 0,
      filtered: 0,
    };
    unfiltered.on("request", () => {
      heard.unfiltered += 1;
    });
    filtered.on("request", () => {
      heard.filtered += 1;
    });
    const batches: unknown[] = [];
    filtered.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/human-items/answers")
        batches.push(request.postDataJSON());
    });

    const list = actionItemList(filtered);
    for (const [index, title] of titles.entries()) {
      const shown = list.getByRole("article", { name: title, exact: true });
      if (index < workload.batch_with_choices)
        await shown
          .getByRole("button", {
            name: choiceFor(index % 3).title,
            exact: true,
          })
          .click();
      else
        await shown
          .getByRole("textbox", { name: `Answer: ${title}`, exact: true })
          .fill(`Typed answer ${index}`);
    }
    const bar = filtered.getByRole("button", {
      name: `Send ${workload.batch_questions} answers`,
    });
    await expect(bar).toBeEnabled({ timeout: NEVER });
    const start = hostLoad();
    const responded = filtered.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/human-items/answers",
    );
    const pressed_at_ms = Date.now();
    await bar.click();
    await responded;
    const response_s = seconds(Date.now() - pressed_at_ms);
    const leftOf = (rendered: Rendered) =>
      titles.map((title) => rendered.gone[title]);
    const emptied = (rendered: Rendered) =>
      leftOf(rendered).every((at) => at !== undefined);
    for (const tab of [unfiltered, filtered])
      await expect
        .poll(async () => emptied(await renderedOn(tab)), { timeout: NEVER })
        .toBe(true);
    const committed_at_ms = statSync(world.journal).mtimeMs;
    const end = hostLoad();

    // Behaviour: one request, every answer as drafted, neither list holds any.
    expect(batches).toHaveLength(1);
    const { answers } = z
      .object({
        answers: z.array(
          z.object({
            id: z.string(),
            choice: z.string().optional(),
            text: z.string().optional(),
          }),
        ),
      })
      .parse(batches[0]);
    expect(answers).toHaveLength(workload.batch_questions);
    let answered = 0;
    for (const [index, id] of ids.entries()) {
      const shown = z
        .object({
          item: z.object({
            state: z.string(),
            resolution: z.object({
              choice: z.string().nullable().optional(),
              text: z.string().nullable(),
            }),
          }),
        })
        .parse(JSON.parse(await humanItems(world, ["show", id, "--json"])));
      expect(shown.item.state).toBe("answered");
      if (index < workload.batch_with_choices)
        expect(shown.item.resolution.choice).toBe(`option-${index % 3}`);
      else expect(shown.item.resolution.text).toBe(`Typed answer ${index}`);
      answered += 1;
    }
    const tabOf = async (tab: Page, name: "unfiltered" | "filtered") => {
      const rendered = await renderedOn(tab);
      const left_at_ms = Math.max(
        ...leftOf(rendered).map((at) => at ?? Number.POSITIVE_INFINITY),
      );
      const stillListed = await actionItemList(tab)
        .getByRole("heading", { level: 3 })
        .allTextContents();
      return {
        lag_s: (left_at_ms - pressed_at_ms) / 1000,
        left_at_ms,
        requests: heard[name],
        still_listed: stillListed.filter((title) => titles.includes(title))
          .length,
      };
    };
    const tabs = {
      unfiltered: await tabOf(unfiltered, "unfiltered"),
      filtered: await tabOf(filtered, "filtered"),
    };
    expect(tabs.unfiltered.requests).toBe(0);
    for (const name of ["unfiltered", "filtered"] as const)
      expect(tabs[name].still_listed).toBe(0);
    return {
      questions: workload.batch_questions,
      with_choices: workload.batch_with_choices,
      choices_each: workload.batch_choices_each,
      requests: batches.length,
      answers_in_request: answers.length,
      answered,
      pressed_at_ms,
      committed_at_ms,
      response_s,
      tabs,
      host_load: { start, end },
    };
  } finally {
    await context.close();
    await stopServing(server);
  }
}

/**
 * The large run's figures, which `dag-ui-read-latency:test-large` records apart
 * from Action items', for `budgets-large` to read.
 */
test("a large run's first screens, the rest, its history and its status, at real size", async ({
  browser,
}) => {
  test.skip(HOST_RUNS_ROOT !== undefined, "a host measurement reads one run");
  const large_run = await measureLargeRun(browser);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  const telemetry = largeTelemetrySchema.parse({
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    commit: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain"]) !== "",
    large_run,
  });
  mkdirSync(join(import.meta.dirname, "telemetry"), { recursive: true });
  writeFileSync(LARGE_TELEMETRY, `${JSON.stringify(telemetry, null, 2)}\n`);
});

test("Action items follows the CLI's writes on the stream it already holds, filtered or not", async ({
  browser,
}) => {
  test.skip(HOST_RUNS_ROOT !== undefined, "a host measurement reads one run");
  const world = buildWorld();
  try {
    const grown = await growJournal(world);
    // The workload's runs are warmed: one sidebar read writes each run's summary
    // cache, which a server over a fresh copy of them otherwise spends its first
    // answer on, past the client's deadline on a loaded host.
    {
      const warm = await serveFresh(world, grown, "warm");
      const read = await fetch(`${warm.origin}/api/v2/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ view: { type: "sidebar" } }),
      });
      if (!read.ok) throw new Error(`the warming read answered ${read.status}`);
      await stopServing(warm.server);
    }
    const measureOn = async (name: "unfiltered" | "filtered") => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const measured = await measurePage(page, world, grown, name);
      await context.close();
      return measured;
    };
    const human_items = {
      unfiltered: await measureOn("unfiltered"),
      filtered: await measureOn("filtered"),
    };
    const batch = await measureBatch(browser, world, grown);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
    const telemetry = telemetrySchema.parse({
      schema_version: 2,
      recorded_at: new Date().toISOString(),
      commit: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]) !== "",
      workload: {
        runs: workload.runs,
        write_spacing_s: workload.write_spacing_s,
      },
      human_items,
      batch,
    });
    mkdirSync(join(import.meta.dirname, "telemetry"), { recursive: true });
    writeFileSync(TELEMETRY, `${JSON.stringify(telemetry, null, 2)}\n`);
    // Every write rendered with no reload and no click, on the one stream.
    for (const name of ["unfiltered", "filtered"] as const) {
      expect(human_items[name].lag.never_shown).toBe(0);
      expect(human_items[name].connections_opened).toBe(0);
    }
  } finally {
    rmSync(world.workspace, { recursive: true, force: true });
  }
});
