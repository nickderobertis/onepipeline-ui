/**
 * Pushed changes, end to end: the page subscribes to what it shows, is sent
 * only what changed, and sends nothing of its own to stay current.
 *
 * Every journey here drives the shipped view against the real
 * `onepipeline-api serve --ui` over the load corpus's shapes at the journeys'
 * size (`--live-updates-corpus`), grows journals through the one fixture writer
 * the engine's receipts are held to (`load/journal.ts`), and reads what the
 * page sent off the browser's own requests and what it was sent off the
 * DevTools protocol's record of each server-sent frame. Every wait for a frame
 * is bounded and names the frame it was waiting for.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_V2_PATHS,
  type SubscriptionFrame,
  subscriptionFrameSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { appendRecords } from "./load/journal";

/** How long a journey waits for one frame before naming it missing. */
const FRAME_PATIENCE = 15_000;
/** How long a page is watched for a request it must not send. */
const QUIET_WINDOW = 4_000;

const factsSchema = z.object({
  openLiveRun: z.string().min(1),
  settledRun: z.string().min(1),
  stoppedRun: z.string().min(1),
  otherLiveRuns: z.array(z.string().min(1)).min(1),
  liveNode: z.string().min(1),
});
type Facts = z.infer<typeof factsSchema>;

/**
 * The sidebar row's fields as `docs/contract.md` lists them — read off the
 * contract rather than the schema, so the frame is held to the document that
 * is the source of truth.
 */
function contractRowFields(): string[] {
  const contract = readFileSync(
    join(import.meta.dirname, "../../docs/contract.md"),
    "utf8",
  );
  const sentence = contract.slice(
    contract.indexOf("a row carries exactly the fields the sidebar renders"),
    contract.indexOf("No session id, liveness or run detail rides a row."),
  );
  return [...sentence.matchAll(/\*\*`([a-z_]+)`\*\*/gu)].map(
    (match) => match[1] ?? "",
  );
}

/** What the page sent, and what its streams were sent, as it happened. */
interface Wire {
  readonly requests: {
    readonly at: number;
    readonly method: string;
    readonly path: string;
    readonly search: string;
    readonly body: unknown;
  }[];
  readonly frames: {
    readonly at: number;
    readonly type: string;
    readonly frame: SubscriptionFrame | undefined;
  }[];
}

async function watch(page: Page): Promise<Wire> {
  const wire: Wire = { requests: [], frames: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    wire.requests.push({
      at: Date.now(),
      method: request.method(),
      path: url.pathname,
      search: url.search,
      body: request.method() === "POST" ? request.postDataJSON() : undefined,
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    const parsed = subscriptionFrameSchema.safeParse(JSON.parse(event.data));
    wire.frames.push({
      at: Date.now(),
      type: event.eventName,
      frame: parsed.success ? parsed.data : undefined,
    });
  });
  return wire;
}

/** Wait for a frame `matches` describes, failing by `name` after the patience. */
async function frameArrives(
  wire: Wire,
  name: string,
  matches: (frame: SubscriptionFrame) => boolean,
  since = 0,
): Promise<SubscriptionFrame> {
  await expect
    .poll(
      () =>
        wire.frames.some(
          ({ at, frame }) =>
            at >= since && frame !== undefined && matches(frame),
        ),
      { message: `no ${name} frame arrived`, timeout: FRAME_PATIENCE },
    )
    .toBe(true);
  const found = wire.frames.find(
    ({ at, frame }) => at >= since && frame !== undefined && matches(frame),
  );
  if (found?.frame === undefined) throw new Error(`no ${name} frame arrived`);
  return found.frame;
}

// llmlint: ignore-block[e2e_uses_accessible_selectors] the journal sequence number is the property under test and no accessible surface carries one: a row is identified to a reader by its label, which a run repeats across records, and the number is what says *which* record reached the page. These are the attributes the view writes for exactly this reading — on each node-timeline row, and on the Graph and Overall roots once the change is rendered — and every other assertion in this file goes through roles and names.
/** The node timeline's row for the record numbered `seq`. */
const rowOf = (page: Page, seq: number) =>
  page.locator(`article[data-journal-seq="${seq}"]`);

/** The journal sequence number the Graph or Overall view says it has rendered. */
async function renderedSeq(page: Page, view: string): Promise<number> {
  const root = page.locator(
    view === "graph"
      ? ".graph-wrap[data-journal-seq]"
      : ".overall-view[data-journal-seq]",
  );
  return Number(await root.getAttribute("data-journal-seq"));
}
// llmlint: ignore-end[e2e_uses_accessible_selectors]

/** The journal of `run` in the server's corpus. */
const journalOf = (server: FixtureServer, run: string) =>
  join(server.workspace, "runs", run, "events.jsonl");

/** The sequence number the next record of `run`'s own stream takes. */
function nextSeq(server: FixtureServer, run: string): number {
  return readFileSync(journalOf(server, run), "utf8")
    .split("\n")
    .filter(Boolean).length;
}

/**
 * Append one tool call a node's worker reported to `run`'s own stream, through
 * the fixture writer, and say which sequence number it took.
 */
function recordActivity(
  server: FixtureServer,
  run: string,
  node: string,
  detail: string,
): number {
  const seq = nextSeq(server, run);
  const stream = `a-recording-host-${run}`;
  appendRecords(journalOf(server, run), [
    {
      v: 1,
      ts: new Date().toISOString(),
      stream,
      seq,
      source: "agentgraph",
      kind: "turn-activity",
      labels: {
        run_id: run,
        node,
        member: "worker",
        persona: "worker",
        session: `${stream}-${node}.worker`,
      },
      payload: {
        kind: "tool_call",
        name: "Bash",
        detail,
        truncated: false,
        index: seq,
      },
      artifacts: [],
    },
  ]);
  return seq;
}

/** Keep the other live runs moving, as the rest of a host does, until stopped. */
function moveOtherRuns(server: FixtureServer, facts: Facts): () => void {
  let turn = 0;
  const timer = setInterval(() => {
    for (const run of facts.otherLiveRuns)
      recordActivity(server, run, "work", `elsewhere ${turn}`);
    turn += 1;
  }, 300);
  return () => clearInterval(timer);
}

/** The page has drawn the view the address names. */
async function shown(page: Page, view: string, node: string): Promise<void> {
  if (view === "graph")
    await expect(
      page.getByRole("application", { name: "DAG execution graph" }),
    ).toBeVisible();
  else if (view === "overall")
    await expect(
      page.getByRole("region", { name: "Graph timeline" }),
    ).toBeVisible();
  else if (view === "channel")
    await expect(
      page.getByRole("heading", { name: "Channel queue" }),
    ).toBeVisible();
  else
    await expect(
      page.getByRole("region", { name: `Timeline for ${node}` }),
    ).toBeVisible();
}

/** Move to `view` the way a reader does: by its tab, or a node's card. */
async function switchTo(page: Page, view: string, node: string): Promise<void> {
  if (view === "node") {
    if (
      (await page
        .getByRole("application", { name: "DAG execution graph" })
        .count()) === 0
    )
      await page.getByRole("tab", { name: "Graph" }).click();
    await page.getByRole("article", { name: new RegExp(`^${node}: `) }).click();
  } else if (
    view === "graph" &&
    (await page.getByRole("navigation", { name: "Breadcrumb" }).count()) > 0
  ) {
    // A node's timeline is reached from the graph, and left by its breadcrumb.
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "Graph" })
      .click();
  } else {
    const tab = { graph: "Graph", overall: "Overall", channel: "Channel" }[
      view
    ];
    await page.getByRole("tab", { name: tab }).click();
  }
  await shown(page, view, node);
}

const address = (run: string, view: string, node: string) =>
  view === "node"
    ? `/?run=${run}&view=graph&node=${node}`
    : `/?run=${run}&view=${view}`;

/**
 * Open every collapsed run of the node's transcript, as a reader does to read
 * its middle: a run of same-kind records shows its first and last row and a
 * control for the rest.
 */
async function expandRuns(page: Page): Promise<void> {
  const transcript = page.getByRole("region", { name: "Node transcript" });
  const controls = transcript.getByRole("button", { name: /^Show \d+ more/u });
  while ((await controls.count()) > 0) await controls.first().click();
}

/** The subscription the page is streaming now: its newest stream's. */
const streaming = (wire: Wire): string | undefined => {
  const stream = wire.requests
    .filter(({ path }) => path === API_V2_PATHS.events)
    .at(-1);
  return stream === undefined
    ? undefined
    : (new URLSearchParams(stream.search).get("subscription") ?? undefined);
};

/**
 * Wait until the page streams a subscription other than `previous`, and every
 * subscription it has made has opened its stream — one switch can make two, as
 * a node's timeline is reached through the graph.
 */
async function streamsAnew(wire: Wire, previous: string | undefined) {
  const made = () =>
    wire.requests.filter(
      ({ method, path }) =>
        method === "POST" && path === API_V2_PATHS.subscriptions,
    ).length;
  const streamed = () =>
    new Set(
      wire.requests
        .filter(({ path }) => path === API_V2_PATHS.events)
        .map(({ search }) => new URLSearchParams(search).get("subscription")),
    ).size;
  await expect
    .poll(
      () =>
        streaming(wire) !== undefined &&
        streaming(wire) !== previous &&
        streamed() >= made(),
      {
        message: "the page opened no stream for its new subscription",
        timeout: FRAME_PATIENCE,
      },
    )
    .toBe(true);
}

/** The requests a window of the page made, as `METHOD path`. */
const requestsSince = (wire: Wire, since: number) =>
  wire.requests
    .filter(({ at }) => at >= since)
    .map(({ method, path }) => `${method} ${path}`);

let server: FixtureServer;
let facts: Facts;

test.beforeAll(async () => {
  server = await startFixtureServer("live-updates", ["--live-updates-corpus"]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server?.stop();
});

test("a finished run's pages send no request the page with nothing open does not send, while other runs move", async ({
  page,
}) => {
  const wire = await watch(page);
  const stop = moveOtherRuns(server, facts);
  try {
    // The page with nothing open: the Host page, which subscribes to the
    // sidebar alone and reads its own reports only as it opens.
    await page.goto(`${server.origin}/?page=host`);
    await expect(
      page.getByRole("region", { name: "Host", exact: true }),
    ).toBeVisible();
    await streamsAnew(wire, undefined);
    await frameArrives(
      wire,
      "run.changed",
      (frame) => frame.type === "run.changed",
    );
    const opened = Date.now();
    await page.waitForTimeout(QUIET_WINDOW);
    const baseline = new Set(requestsSince(wire, opened));
    // Other runs really moved while it was watched, and reached it as rows.
    expect(
      wire.frames.filter(
        ({ at, type }) => at >= opened && type === "run.changed",
      ).length,
    ).toBeGreaterThan(0);

    for (const run of [facts.settledRun, facts.stoppedRun])
      for (const view of ["graph", "overall", "node"]) {
        const previous = streaming(wire);
        await page.goto(`${server.origin}${address(run, view, "publish")}`);
        await shown(page, view, "publish");
        await streamsAnew(wire, previous);
        const since = Date.now();
        await frameArrives(
          wire,
          `run.changed for another run while ${run} ${view} is open`,
          (frame) => frame.type === "run.changed" && frame.row.id !== run,
          since,
        );
        await page.waitForTimeout(QUIET_WINDOW);
        const sent = requestsSince(wire, since);
        expect(
          sent.filter((request) => !baseline.has(request)),
          `${run} ${view} sent what the page with nothing open does not`,
        ).toEqual([]);
        // The run's own payloads are not re-read for the changes elsewhere.
        expect(
          wire.frames.filter(
            ({ at, frame }) =>
              at >= since && frame !== undefined && frame.type === "reset",
          ),
        ).toEqual([]);
      }
  } finally {
    stop();
  }
});

test("a record appended to the open live run reaches every view as a patch, with nothing read for it", async ({
  page,
}) => {
  const wire = await watch(page);
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  const fields = contractRowFields();
  expect(fields).toContain("updated_at");

  for (const view of ["graph", "overall", "node"]) {
    await page.goto(`${server.origin}${address(run, view, node)}`);
    await shown(page, view, node);
    const since = Date.now();
    const marker = `live ${view} ${since}`;
    const seq = recordActivity(server, run, node, marker);
    if (view === "node") {
      // The node timeline's row for that record appears, carrying its number.
      await expect(rowOf(page, seq)).toHaveCount(1, {
        timeout: FRAME_PATIENCE,
      });
    } else {
      // The view's root says it has rendered that record's change.
      await expect
        .poll(() => renderedSeq(page, view), {
          message: `the ${view} view never rendered record ${seq}; it was sent ${JSON.stringify(wire.frames.filter(({ at }) => at >= since).map(({ type, frame }) => [type, frame === undefined]))}`,
          timeout: FRAME_PATIENCE,
        })
        .toBeGreaterThanOrEqual(seq);
    }
    // And the header's activity line says what the node just did.
    await expect(
      page.getByRole("button", { name: `${node}: Bash ${marker}` }),
    ).toBeVisible();
    await frameArrives(
      wire,
      "detail.patch",
      (frame) => frame.type === "detail.patch" && frame.run_id === run,
      since,
    );
    if (view !== "graph")
      await frameArrives(
        wire,
        "timeline.patch",
        (frame) => frame.type === "timeline.patch" && frame.run_id === run,
        since,
      );
    // Nothing was read for it, and nothing was re-sent whole.
    expect(
      requestsSince(wire, since).filter((request) =>
        request.startsWith(`GET /api/v2/runs/${run}`),
      ),
    ).toEqual([]);
    expect(
      wire.frames.filter(
        ({ at, type }) =>
          at >= since && (type === "reset" || type === "snapshot"),
      ),
    ).toEqual([]);
  }

  // A change on another run arrives as one trimmed row, carrying exactly the
  // fields the contract lists for one.
  const other = facts.otherLiveRuns[0] ?? "";
  const since = Date.now();
  recordActivity(server, other, "work", `elsewhere once ${since}`);
  const row = await frameArrives(
    wire,
    `run.changed for ${other}`,
    (frame) => frame.type === "run.changed" && frame.row.id === other,
    since,
  );
  await page.waitForTimeout(1_000);
  expect(
    wire.frames.filter(
      ({ at, frame }) =>
        at >= since && frame?.type === "run.changed" && frame.row.id === other,
    ),
  ).toHaveLength(1);
  if (row.type !== "run.changed") throw new Error("not a row frame");
  expect(
    Object.keys(row.row).filter((key) => key !== "started_at"),
  ).toStrictEqual(fields.filter((key) => key !== "started_at"));

  // A surface raised on the live run appears on its Channel tab, and the queue
  // is never read for it.
  await page.goto(`${server.origin}${address(run, "channel", node)}`);
  await shown(page, "channel", node);
  const raisedAt = Date.now();
  const message = `is the channel live ${raisedAt}?`;
  const raised = await page.request.post(
    `${server.origin}/api/v2/runs/${run}/channel/surface`,
    { data: { kind: "question", message } },
  );
  expect(raised.ok()).toBe(true);
  await expect(page.getByText(message).first()).toBeVisible({
    timeout: FRAME_PATIENCE,
  });
  await frameArrives(
    wire,
    "channel.patch",
    (frame) => frame.type === "channel.patch" && frame.run_id === run,
    raisedAt,
  );
  expect(
    requestsSince(wire, raisedAt).filter((request) =>
      request.includes("/channel"),
    ),
  ).toEqual([]);
});

test("no run-list snapshot follows the first read, on connection or after a reconnect, and a view switch replaces the subscription", async ({
  page,
}) => {
  const wire = await watch(page);
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  await page.goto(`${server.origin}${address(run, "graph", node)}`);
  await shown(page, "graph", node);
  const firstStream = wire.requests.filter(
    ({ path }) => path === API_V2_PATHS.events,
  );
  expect(firstStream).toHaveLength(1);
  // The stream opens after the snapshot the subscription answered with.
  const opened = Date.now();
  recordActivity(server, run, node, `before the reconnect ${opened}`);
  await frameArrives(
    wire,
    "detail.patch",
    (frame) => frame.type === "detail.patch",
    opened,
  );

  // The stream is made to reconnect: the browser goes offline and back.
  await page.context().setOffline(true);
  await page.waitForTimeout(500);
  await page.context().setOffline(false);
  await expect
    .poll(
      () =>
        wire.requests.filter(({ path }) => path === API_V2_PATHS.events).length,
      { message: "the stream never reconnected", timeout: FRAME_PATIENCE },
    )
    .toBeGreaterThan(1);
  const reconnected = Date.now();
  recordActivity(server, run, node, `after the reconnect ${reconnected}`);
  await frameArrives(
    wire,
    "detail.patch after the reconnect",
    (frame) => frame.type === "detail.patch",
    reconnected,
  );
  // Neither connection was sent the list again: no snapshot frame, no reset.
  expect(
    wire.frames.filter(({ type }) => type === "snapshot" || type === "reset"),
  ).toEqual([]);

  // Moving among Graph, Channel and a node's timeline replaces the
  // subscription, naming the one it replaces, and the view left behind is
  // neither subscribed nor read.
  for (const view of ["channel", "node", "graph"]) {
    const before = streaming(wire);
    const since = Date.now();
    await switchTo(page, view, node);
    await streamsAnew(wire, before);
    // The first subscription the switch made named the one it replaces (a
    // node's timeline is reached through the graph, which subscribes too).
    expect(
      wire.requests.find(
        ({ at, path, method }) =>
          at >= since &&
          method === "POST" &&
          path === API_V2_PATHS.subscriptions,
      ),
    ).toMatchObject({ body: { replaces: before } });
    const left = await page.request.get(
      `${server.origin}/api/v2/events?subscription=${before}`,
    );
    expect(left.status(), `the subscription ${view} left behind`).toBe(410);
    expect(
      requestsSince(wire, since).filter((request) =>
        /\/(timeline|channel)$|\/runs\/[^/]+$/u.test(request),
      ),
    ).toEqual([]);
  }
});

test("a dropped stream resumes from its last frame, and every change made meanwhile appears exactly once", async ({
  page,
}) => {
  const wire = await watch(page);
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  await page.goto(`${server.origin}${address(run, "node", node)}`);
  await shown(page, "node", node);
  const warm = recordActivity(
    server,
    run,
    node,
    `before the drop ${Date.now()}`,
  );
  await expect(rowOf(page, warm)).toHaveCount(1, {
    timeout: FRAME_PATIENCE,
  });
  const lastFrame = wire.frames.at(-1)?.frame?.id;
  expect(lastFrame).toBeDefined();

  // The stream drops; records keep arriving while nothing is connected.
  await page.context().setOffline(true);
  const away = [1, 2, 3].map((n) =>
    recordActivity(server, run, node, `while away ${n} ${Date.now()}`),
  );
  await page.waitForTimeout(1_500);
  const streamsBefore = wire.requests.filter(
    ({ path }) => path === API_V2_PATHS.events,
  ).length;
  await page.context().setOffline(false);

  // It reconnects from the last frame it applied …
  await expect
    .poll(
      () =>
        wire.requests.filter(({ path }) => path === API_V2_PATHS.events).length,
      { message: "the stream never reconnected", timeout: FRAME_PATIENCE },
    )
    .toBeGreaterThan(streamsBefore);
  const resumed = wire.requests
    .filter(({ path }) => path === API_V2_PATHS.events)
    .at(-1);
  expect(new URLSearchParams(resumed?.search).get("after")).toBe(lastFrame);
  // … and each record made meanwhile is on the timeline exactly once.
  await expect(rowOf(page, away.at(-1) ?? -1)).toHaveCount(1, {
    timeout: FRAME_PATIENCE,
  });
  await expandRuns(page);
  for (const seq of away)
    await expect(rowOf(page, seq)).toHaveCount(1, { timeout: FRAME_PATIENCE });
  await page.waitForTimeout(1_000);
  for (const seq of [warm, ...away])
    await expect(rowOf(page, seq)).toHaveCount(1);
  expect(
    wire.frames.filter(({ type }) => type === "snapshot" || type === "reset"),
  ).toEqual([]);

  // Every view the page moves among leaves the one it left unsubscribed and
  // unread: its subscription is gone, and nothing reads its payload.
  for (const view of ["graph", "overall", "channel", "node"]) {
    const before = streaming(wire);
    const since = Date.now();
    await switchTo(page, view, node);
    await streamsAnew(wire, before);
    expect(
      (
        await page.request.get(
          `${server.origin}/api/v2/events?subscription=${before}`,
        )
      ).status(),
    ).toBe(410);
    recordActivity(server, run, node, `on ${view} ${since}`);
    await page.waitForTimeout(1_000);
    expect(
      requestsSince(wire, since).filter((request) =>
        request.startsWith("GET /api/v2/runs/"),
      ),
    ).toEqual([]);
    // Only the view on screen is patched: a hidden timeline or channel is not.
    const patched = new Set(
      wire.frames
        .filter(({ at }) => at >= since)
        .map(({ frame }) => frame?.type)
        .filter((type) => type?.endsWith(".patch")),
    );
    if (view === "graph" || view === "channel")
      expect(patched.has("timeline.patch")).toBe(false);
    if (view !== "channel") expect(patched.has("channel.patch")).toBe(false);
  }
});

test("a page that goes away retires its subscription rather than leaving it to expire", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const wire = await watch(page);
  await page.goto(
    `${server.origin}${address(facts.openLiveRun, "graph", facts.liveNode)}`,
  );
  await shown(page, "graph", facts.liveNode);
  await streamsAnew(wire, undefined);
  const subscription = streaming(wire);
  await page.close({ runBeforeUnload: true });
  // Retired as the page went, within seconds — not left recording for the
  // two minutes a dropped connection is kept, which would answer `expired`.
  await expect
    .poll(
      async () =>
        (
          await fetch(
            `${server.origin}/api/v2/events?subscription=${subscription}`,
          )
        ).status,
      {
        message: "the closed page's subscription was not retired",
        timeout: FRAME_PATIENCE,
      },
    )
    .toBe(410);
  const gone = await fetch(
    `${server.origin}/api/v2/events?subscription=${subscription}`,
  );
  expect(await gone.json()).toStrictEqual({
    code: "subscription-unavailable",
    reason: "unknown",
  });
  await context.close();
});
