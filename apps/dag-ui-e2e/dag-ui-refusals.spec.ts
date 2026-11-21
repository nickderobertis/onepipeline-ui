import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { appendRecords } from "./load/journal";

/**
 * The edits a run refused, read as the ordinary events they are, in the browser
 * over the real read API: a run written by `fixtures/runs.mjs`'s
 * `buildRefusalsRuns` in the released engine's record shapes (held to that
 * engine's schema for each kind by `tests/e2e/server.rs`), holding a plan-edit
 * hook's refusal of the planner whose complete refusal runs to several lines, an
 * edit the engine refused the monitor naming a node, a hook refusal whose output
 * ran past the engine's read bound, each beside the reconciler surface it raised,
 * and one refusal in the shape written before the engine summarised them.
 *
 * Its corpus is its own, served by a server this file starts, because a run added
 * to the shared one is counted by every listing journey.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  findings: z.array(z.string().min(1)).min(3),
  hook_line: z.string().min(1),
});

let server: FixtureServer | undefined;
let facts: z.infer<typeof factsSchema>;

test.beforeAll(async () => {
  server = await startFixtureServer("refusals", ["--refusals-corpus"]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server?.stop();
  server = undefined;
});

function origin(): string {
  if (server === undefined) throw new Error("the fixture server is not up");
  return server.origin;
}

/** A row of a list, by the name it is read under. */
const row = (list: Locator, name: string | RegExp): Locator =>
  list.getByRole("article", { name });

const detail = (page: Page): Locator =>
  page.getByRole("region", { name: "Timeline item detail" });

const HOOK_SUMMARY = (): string => `amend of node 'review': ${facts.hook_line}`;
const MONITOR_SUMMARY =
  "cancel: node 'build' has settled and cannot be cancelled";
const CUT_SUMMARY =
  "amend of node 'ship': the reviewer's log ran past what the engine reads";
const SHIP_SUMMARY = "cancel: node 'ship' has settled and cannot be cancelled";
const SHIP_AMEND =
  "amend: node 'ship' has settled done, so nothing would read the amendment";
const OLDER_REASON =
  "refused: decline: node 'build': the reason cannot be blank";

async function openOverall(page: Page): Promise<Locator> {
  await page.goto(`${origin()}/?run=${facts.run}&view=overall`);
  const events = page.getByRole("region", { name: "Run events" });
  await expect(events.getByRole("heading", { name: "Events" })).toBeVisible();
  // An address naming a record reads the run's own records by itself, so the
  // control can leave between being seen and being pressed.
  const load = page.getByRole("button", { name: "Load the run's own records" });
  if (await load.isVisible())
    await load.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(events.getByRole("article").first()).toBeVisible();
  return events;
}

async function openNode(page: Page, node: string): Promise<Locator> {
  await page.goto(`${origin()}/?run=${facts.run}&node=${node}&view=graph`);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  await expect(
    transcript.getByRole("heading", { name: "Events" }),
  ).toBeVisible();
  return transcript;
}

/** Open a row of Overall's list, closing whatever detail covers the list first. */
async function open(page: Page, list: Locator, name: string): Promise<void> {
  const close = page.getByRole("button", { name: "Close detail" });
  if (await close.isVisible()) await close.click();
  await row(list, name).getByRole("button").click();
}

/** The facts the refusal's detail states, term by term. */
async function stated(page: Page): Promise<Record<string, string>> {
  const refusal = detail(page).getByRole("region", { name: "Refused edit" });
  await expect(refusal).toBeVisible();
  // llmlint: ignore-block[e2e_uses_accessible_selectors] each fact is a term and its definition grouped in the list's own row, and a role query would flatten the command's own nested terms into the same list; the pairs are read as the list groups them.
  return refusal
    .locator(":scope > dl > div")
    .evaluateAll((pairs) =>
      Object.fromEntries(
        pairs.map((pair) => [
          pair.querySelector("dt")?.textContent ?? "",
          pair.querySelector("dd")?.textContent ?? "",
        ]),
      ),
    );
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
}

/** The three refusals the journey reads, by row name, and whether each was read. */
const HOOK = () => [`${HOOK_SUMMARY()} · by planner`, "read"] as const;
const MONITOR = () => [`${MONITOR_SUMMARY} · by monitor`, "read"] as const;
const CUT = () => [`${CUT_SUMMARY} · by planner`, "unread"] as const;

/**
 * Each of `refusals` is one row of `list` whose status says whether the planner
 * read the surface the reconciler raised for it, and no surface raised for a
 * refusal is a row of its own: joining the two records keeps the surface's state.
 */
async function readState(
  list: Locator,
  refusals: readonly (() => readonly [string, "read" | "unread"])[] = [
    HOOK,
    MONITOR,
    CUT,
  ],
): Promise<void> {
  for (const refusal of refusals) {
    const [name, state] = refusal();
    const refused = row(list, name);
    await expect(refused).toHaveCount(1);
    await expect(refused).toContainText(`not applied · ${state}`);
  }
  await expect(row(list, /reconciler: rejected/u)).toHaveCount(0);
  await expect(row(list, /^edit-rejected: /u)).toHaveCount(0);
}

test("the graph draws no box of refusals, and Overall lists each refusal once, attributed and not applied", async ({
  page,
}) => {
  await page.goto(`${origin()}/?run=${facts.run}&view=graph`);
  await expect(page.getByRole("list", { name: "DAG nodes" })).toBeAttached();
  await expect(page.getByRole("region", { name: "Refused edits" })).toHaveCount(
    0,
  );
  await expect(page.getByText("Refused edits")).toHaveCount(0);

  const events = await openOverall(page);
  for (const [summary, author] of [
    [HOOK_SUMMARY(), "planner"],
    [MONITOR_SUMMARY, "monitor"],
    [CUT_SUMMARY, "planner"],
  ] as const) {
    const refused = row(events, `${summary} · by ${author}`);
    await expect(refused).toHaveCount(1);
    await expect(refused).toContainText(" · not applied");
  }
  // Each refusal's row carries whether the surface raised for it was read.
  await readState(events);
  // The older-shaped record still reads as it always did.
  await expect(row(events, "edit-rejected · by planner")).toHaveCount(1);
  await expect(row(events, "edit-rejected · by planner")).toContainText(
    " · not applied",
  );
  // All seven under the one existing type — the three sent once `ship` had
  // settled among them — with no type of their own.
  await expect(row(events, `${SHIP_SUMMARY} · by monitor`)).toHaveCount(2);
  await expect(row(events, `${SHIP_AMEND} · by planner`)).toHaveCount(1);
  await expect(
    events.getByRole("article").filter({ hasText: "not applied" }),
  ).toHaveCount(7);
});

test("a node's event list shows the refusal naming it, once, with its surface's read state", async ({
  page,
}) => {
  const build = await openNode(page, "build");
  await expect(row(build, `${MONITOR_SUMMARY} · by monitor`)).toHaveCount(1);
  await readState(build, [MONITOR]);
  const review = await openNode(page, "review");
  await expect(row(review, `${HOOK_SUMMARY()} · by planner`)).toHaveCount(1);
  await expect(row(review, `${MONITOR_SUMMARY} · by monitor`)).toHaveCount(0);
  await readState(review, [HOOK]);
  const ship = await openNode(page, "ship");
  await readState(ship, [CUT]);
});

/**
 * The planner reading the surface the reconciler raised for the refusal summarised
 * `summary`: the engine's `planner-surfaced`, carrying the queued record's own
 * surface fields, appended to the run's journal through the fixture writer.
 */
function readSurfaceOf(summary: string): void {
  if (server === undefined) throw new Error("the fixture server is not up");
  const journal = join(server.workspace, "runs", facts.run, "events.jsonl");
  const records = readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => journalRecord.parse(JSON.parse(line)));
  const refusal = records.find(
    (record) =>
      record.kind === "edit-rejected" && record.payload.summary === summary,
  );
  const queued = records.find(
    (record) =>
      record.kind === "planner-surface-queued" &&
      refusal !== undefined &&
      record.payload.rejection?.stream === refusal.stream &&
      record.payload.rejection.seq === refusal.seq,
  );
  if (queued === undefined)
    throw new Error(`no surface was raised for ${summary}`);
  // The surfaced record carries the surface's own fields, not the link to the
  // refusal the queued one recorded.
  const surface = Object.fromEntries(
    Object.entries(queued.payload).filter(([key]) => key !== "rejection"),
  );
  appendRecords(journal, [
    {
      ...queued,
      // After the record it follows, as a writer appending to a journal stamps
      // it: the corpus is stamped ahead of this host's clock.
      ts: new Date(
        Math.max(Date.now(), Date.parse(records.at(-1)?.ts ?? "") + 1),
      ).toISOString(),
      seq: records.length,
      kind: "planner-surfaced",
      payload: { ...surface, queued_at: queued.ts },
      artifacts: [],
    },
  ]);
}

const journalRecord = z
  .object({
    ts: z.string(),
    stream: z.string(),
    seq: z.number().int(),
    kind: z.string(),
    payload: z
      .object({
        summary: z.string().optional(),
        rejection: z
          .object({ stream: z.string(), seq: z.number().int() })
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

test("each refusal's detail states who, what and where, and the complete refusal fetched through the server, every line kept", async ({
  page,
}) => {
  const events = await openOverall(page);
  const artifacts: string[] = [];
  page.on("response", (response) => {
    if (/\/api\/v2\/runs\/[^/]+\/artifacts\//u.test(response.url()))
      artifacts.push(`${response.status()} ${response.url()}`);
  });

  // The plan-edit hook's refusal: its findings, line by line.
  await open(page, events, `${HOOK_SUMMARY()} · by planner`);
  const hook = await stated(page);
  expect(hook.Author).toBe("planner");
  expect(hook.Summary).toBe(HOOK_SUMMARY());
  expect(hook.Node).toBe("review");
  expect(hook["Command as sent"]).toContain("amend");
  expect(hook["Command as sent"]).toContain("Review the build by reading it.");
  const complete = detail(page).getByRole("figure", {
    name: "Complete refusal",
  });
  await expect(complete).toBeVisible();
  // llmlint: ignore[e2e_uses_accessible_selectors] the figure's preformatted text has no role of its own; what is measured is the text as it is laid out in lines.
  const text = await complete.locator("pre").evaluate(
    // The rendered text as it lies on screen, so lines are lines.
    (pre) => (pre as HTMLElement).innerText,
  );
  expect(text.split("\n")).toEqual(facts.findings);
  await expect(
    detail(page).getByText(/output was cut at the engine's read bound/u),
  ).toHaveCount(0);
  // Read through the read API's own artifact route, by the kept file's name.
  expect(artifacts.some((line) => line.startsWith("200 "))).toBe(true);
  // What the record holds beyond that is listed once, beneath, and never the
  // facts above again nor the kept file's location.
  const rest = detail(page).getByRole("region", { name: "Recorded fields" });
  await expect(rest).toContainText("Envelope");
  for (const repeated of ["Summary", "Full reason", "Author", "Reason"])
    await expect(rest.getByText(repeated, { exact: true })).toHaveCount(0);

  // The engine's own refusal of the monitor, naming the node it concerned.
  await open(page, events, `${MONITOR_SUMMARY} · by monitor`);
  const monitor = await stated(page);
  expect(monitor.Author).toBe("monitor");
  expect(monitor.Summary).toBe(MONITOR_SUMMARY);
  expect(monitor.Node).toBe("build");
  expect(monitor["Command as sent"]).toContain("cancel");
  await expect(
    detail(page).getByRole("figure", { name: "Complete refusal" }),
  ).toContainText(`refused: ${MONITOR_SUMMARY}`);

  // A hook whose output ran past the engine's read bound says it was cut.
  await open(page, events, `${CUT_SUMMARY} · by planner`);
  const cut = await stated(page);
  expect(cut.Node).toBe("ship");
  await expect(
    detail(page).getByText(/output was cut at the engine's read bound/u),
  ).toBeVisible();
  const kept = detail(page).getByRole("figure", { name: "Complete refusal" });
  await expect(kept).toBeVisible();
  // Every line of the kept text, scrolled within the panel rather than cut.
  // llmlint: ignore-block[e2e_uses_accessible_selectors] the figure's preformatted text has no role of its own; what is measured is its lines and whether it scrolls.
  const lines = await kept
    .locator("pre")
    .evaluate((pre) => (pre as HTMLElement).innerText.split("\n").length);
  expect(lines).toBeGreaterThan(800);
  const scrolls = await kept
    .locator("pre")
    .evaluate((pre) => pre.scrollHeight > pre.clientHeight);
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  expect(scrolls).toBe(true);

  // The older shape: a row, and its reason in the detail.
  await open(page, events, "edit-rejected · by planner");
  const older = await stated(page);
  expect(older.Author).toBe("planner");
  expect(older.Summary).toBeUndefined();
  await expect(
    detail(page).getByRole("figure", { name: "Refusal" }),
  ).toHaveText(new RegExp(`Refusal\\s*${OLDER_REASON}`, "u"));
  await expect(
    detail(page).getByRole("figure", { name: "Complete refusal" }),
  ).toHaveCount(0);
});

// Last in the file: it reads the one unread surface, which every journey above
// holds unread.
test("a refusal's row in its node's list turns read when its surface is read, without a reload", async ({
  page,
}) => {
  const ship = await openNode(page, "ship");
  const amend = `${SHIP_AMEND} · by planner`;
  await readState(ship, [CUT, () => [amend, "unread"] as const]);
  // The corpus was written with no append receipt, so the server reads the first
  // record appended after it as a rewritten journal, whole; the second is read as
  // the append it is, which only the record's own refresh can carry to the list.
  readSurfaceOf(SHIP_AMEND);
  await readState(ship, [CUT, () => [amend, "read"] as const]);
  readSurfaceOf(CUT_SUMMARY);
  await readState(ship, [() => [CUT()[0], "read"] as const]);
  const events = await openOverall(page);
  await readState(events, [HOOK, MONITOR, () => [CUT()[0], "read"] as const]);
});
