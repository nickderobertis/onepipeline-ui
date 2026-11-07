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
 * - when each `human-items.patch` frame arrived, as a breakdown of that lag.
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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { telemetrySchema } from "./telemetry";
import workload from "./workload.json" with { type: "json" };

const REPO = resolve(import.meta.dirname, "../../..");
const TELEMETRY = join(import.meta.dirname, "telemetry/read-latency.json");
const CORPUS = join(import.meta.dirname, "../load/corpus.mjs");
const WORKLOAD = join(import.meta.dirname, "workload.json");
const ENGINE = join(REPO, ".tools/bin/onepipeline");
/** The session every item here is raised as. */
const OWNER = "read-latency-session";
/** The priority every write in a window is raised at, which the filter selects. */
const WRITTEN_PRIORITY = "high";
/** A guard against a hang: only a page that never renders a write reaches it. */
const NEVER = 120_000;

const run = promisify(execFile);

function releaseBinary(): string {
  const target = process.env.CARGO_TARGET_DIR ?? join(REPO, "target");
  const binary = join(resolve(REPO, target), "release", "onepipeline-api");
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

/** An API or bundle path as a route, ids and query values dropped. */
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

/** Watch the page's list from inside it, so a render is timed as it lands. */
async function observe(page: Page): Promise<void> {
  await page
    .getByRole("list", { name: "Action items" })
    .evaluate((list: Element) => {
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
    const list = page.getByRole("list", { name: "Action items" });
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

test("Action items follows the CLI's writes on the stream it already holds, filtered or not", async ({
  browser,
}) => {
  const world = buildWorld();
  try {
    const grown = await growJournal(world);
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
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
    const telemetry = telemetrySchema.parse({
      schema_version: 1,
      recorded_at: new Date().toISOString(),
      commit: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]) !== "",
      workload: {
        runs: workload.runs,
        write_spacing_s: workload.write_spacing_s,
      },
      human_items,
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
