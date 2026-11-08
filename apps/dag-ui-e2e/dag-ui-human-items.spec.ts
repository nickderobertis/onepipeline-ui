import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Request,
  test,
} from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

/**
 * The action-items page, driven in a real browser against the real read API
 * serving the engine's live human-item runtime.
 *
 * Each journey starts a server of its own over a world `human-items-world.mjs`
 * built for it: runs launched and items raised by the provisioned `onepipeline`
 * CLI of the release the server links, plans and projected tasks on a loopback
 * GitHub board, and a configured approval authority for design reviews. What
 * the page writes is checked against what the engine's journal holds, read back
 * through that same CLI — `human-items show` and `list` — and what the owning
 * session's watch was told, through `human-items watch`. A connection failure
 * is the server really stopping; a journal the server cannot read is that
 * journal really moved; a request held on its way is a delayed receipt,
 * released untouched.
 */

const SUPERVISOR = "claude-code-supervising-session";
const OTHER = "other-session";

const factsSchema = z.object({
  ids: z.record(z.string(), z.string()),
  runs: z.record(z.string(), z.string()),
  plans: z.record(z.string(), z.string()),
  sessions: z.array(z.string()).optional(),
  engine: z.string(),
  cwd: z.string(),
  environment: z.record(z.string(), z.string()),
  removed: z.array(z.string()),
  approvals: z.string(),
  journal: z.string(),
  acting: z.string(),
});
type Facts = z.infer<typeof factsSchema>;

const storedSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  kind: z.string(),
  state: z.string(),
  owner: z.object({ session: z.string() }),
  approval: z.object({ board_copy: z.string(), key: z.string() }).nullable(),
  tracker: z.object({ task: z.string(), url: z.string() }).nullable(),
  resolution: z
    .object({
      actor: z.string(),
      on_behalf_of: z.string().nullable(),
      text: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
});
const viewSchema = z.object({
  item: storedSchema,
  blocked: z.object({ total: z.number() }),
});
const detailSchema = z.object({
  item: storedSchema,
  nodes: z.array(
    z.object({ run: z.string(), node: z.string(), title: z.string() }),
  ),
});
const deliveredSchema = z.object({
  kind: z.string(),
  payload: z.object({ item_id: z.string() }),
});
const approvalSchema = z.object({
  board_copy: z.string(),
  key: z.string(),
  actor: z.string(),
  on_behalf_of: z.string().nullable(),
});
const subscribeBodySchema = z.object({
  view: z.object({
    type: z.string(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
});
const receiptSchema = z.object({
  item: z.object({ item: z.object({ id: z.string() }) }),
});
const listSchema = z.object({
  items: z.array(
    z.object({ item: z.object({ title: z.string(), priority: z.string() }) }),
  ),
});

/** The open items of the queue world, in the engine's order. */
const DECLARED = [
  {
    key: "build",
    title: "Restore the build service",
    kind: "Task",
    priority: "Critical",
    wire: "urgent",
    blocks: "blocks all work on this host",
    source: "Source: host",
  },
  {
    key: "region",
    title: "Which region should the canary run in?",
    kind: "Question",
    priority: "High",
    wire: "high",
    blocks: "blocks 5 steps in board:plan-a: build, test, lint +2 more",
    source: "Source: plan board:plan-a / run plan-a",
  },
  {
    key: "export",
    title: "Keep the legacy export format?",
    kind: "Question",
    priority: "Low",
    wire: "low",
    blocks: "blocks all of board:plan-b",
    source: "Source: plan board:plan-b",
  },
  {
    key: "cache",
    title: "Should retries reuse the warm cache?",
    kind: "Question",
    priority: "Critical",
    wire: "urgent",
    blocks: undefined,
    source: `Source: session ${SUPERVISOR}`,
  },
  {
    key: "other",
    title: "Rotate the deploy credentials",
    kind: "Task",
    priority: "Critical",
    wire: "urgent",
    blocks: undefined,
    source: `Source: session ${OTHER}`,
  },
  {
    key: "design",
    title: "Review the action-items design",
    kind: "Task",
    priority: "High",
    wire: "high",
    blocks: undefined,
    source: "Source: plan board:plan-a / run plan-a",
  },
  {
    key: "dashboard",
    title: "Review the dashboard layout",
    kind: "Task",
    priority: "High",
    wire: "high",
    blocks: undefined,
    source: "Source: plan board:plan-b",
  },
] as const;

const QUESTIONS = DECLARED.filter(({ kind }) => kind === "Question").map(
  ({ title }) => title,
);
const LAST_QUESTION = "Should retries reuse the warm cache?";

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test.use({ viewport: { width: 1440, height: 900 } });

async function serveWorld(name: string): Promise<FixtureServer> {
  server = await startFixtureServer(`human-items-${name}`, [
    "--human-items-world",
    name,
  ]);
  return server;
}

function factsOf(served: FixtureServer): Facts {
  return factsSchema.parse(served.facts);
}

function idOf(served: FixtureServer, key: string): string {
  const id = factsOf(served).ids[key];
  if (id === undefined) throw new Error(`the world raised no ${key}`);
  return id;
}

/** `onepipeline ARGS…` in the served world, as `session` when one is named. */
function cli(served: FixtureServer, args: string[], session?: string): string {
  const facts = factsOf(served);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of facts.removed) delete env[name];
  Object.assign(env, facts.environment);
  if (session !== undefined) env.ONEPIPELINE_LAUNCHER_SESSION = session;
  return execFileSync(facts.engine, args, {
    cwd: facts.cwd,
    env,
    encoding: "utf8",
  });
}

/** The item `id` as the engine's journal now holds it. */
function stored(served: FixtureServer, id: string) {
  return detailSchema.parse(
    JSON.parse(cli(served, ["human-items", "show", id, "--json"])),
  ).item;
}

/** Every item `human-items list --json ARGS…` selects. */
function listed(served: FixtureServer, args: string[] = []) {
  return z
    .array(viewSchema)
    .parse(JSON.parse(cli(served, ["human-items", "list", "--json", ...args])));
}

/** The item events delivered to `session` that its watch had not printed. */
function watch(served: FixtureServer, session: string) {
  let printed: string;
  try {
    printed = cli(served, ["human-items", "watch", "--session", session]);
  } catch (refused) {
    // Nothing pending is the watch's own "elapsed" exit, and is no failure.
    if ((refused as { status?: number }).status !== 5) throw refused;
    printed = (refused as { stdout?: string }).stdout ?? "";
  }
  return printed
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const { kind, payload } = deliveredSchema.parse(JSON.parse(line));
      return [kind, payload.item_id] as const;
    });
}

/** Every approval record the approval authority wrote. */
function approvals(served: FixtureServer) {
  let text = "";
  try {
    text = readFileSync(factsOf(served).approvals, "utf8");
  } catch {
    // None written yet.
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => approvalSchema.parse(JSON.parse(line)));
}

/** The engine's journal file, as bytes, for "nothing was written". */
function journal(served: FixtureServer): string {
  return readFileSync(join(factsOf(served).journal, "events.ndjson"), "utf8");
}

/**
 * Make the journal unreadable to the server — its directory moved away and a
 * plain file left where it was — and answer how to put it back.
 */
function breakJournal(served: FixtureServer): () => void {
  const dir = factsOf(served).journal;
  renameSync(dir, `${dir}.away`);
  writeFileSync(dir, "not a directory");
  return () => {
    rmSync(dir);
    renameSync(`${dir}.away`, dir);
  };
}

/** Restart the server acting as `session`, over the same journal. */
async function actAs(served: FixtureServer, session: string): Promise<void> {
  await served.stopServing();
  writeFileSync(factsOf(served).acting, session);
  await served.serveRebuilt();
}

/**
 * The page, opened at its own address on the server's origin, and its list.
 *
 * A journey about the engine's own order reads the list as one flat list, so it
 * chooses Group by None as a reader would — through the Filters button first
 * where a phone folds the control behind it. `groupBy: null` leaves the page
 * grouped as it opens, for the journeys about grouping itself.
 */
async function open(
  page: Page,
  served: FixtureServer,
  { groupBy = "none" }: { readonly groupBy?: string | null } = {},
): Promise<Locator> {
  await page.goto(`${served.origin}/human-items`);
  const list = listRegion(page);
  await expect(list.getByRole("listitem").first()).toBeVisible();
  if (groupBy !== null) {
    const toggle = page.getByRole("button", { name: /^Filters/u });
    const folded = await toggle.isVisible();
    if (folded) await toggle.click();
    await page
      .getByRole("combobox", { name: "Group by" })
      .selectOption(groupBy);
    if (folded) await toggle.click();
  }
  return list;
}

/**
 * Follow `link` and read where the new tab asked to go: the request it made,
 * observed rather than answered — and made with the browser offline, so it
 * never leaves this host for GitHub. The page's own reads are done by then, and
 * it is put back online.
 */
async function followed(
  context: BrowserContext,
  link: () => Promise<void>,
  url: string,
): Promise<void> {
  await context.setOffline(true);
  try {
    const [tab, request] = await Promise.all([
      context.waitForEvent("page"),
      context.waitForEvent("request", (sent) => sent.url() === url),
      link(),
    ]);
    expect(request.url()).toBe(url);
    await tab.close();
  } finally {
    await context.setOffline(false);
  }
}

/** The accessible name the page gives `id`'s tracker link, and where it goes. */
function trackerOf(served: FixtureServer, id: string) {
  const { tracker } = stored(served, id);
  if (tracker === null) throw new Error(`${id} was projected nowhere`);
  return { name: `Open GitHub issue ${tracker.task}`, url: tracker.url };
}

function card(page: Page, title: string): Locator {
  return page.getByRole("article", { name: title });
}

function answerBox(page: Page, title: string): Locator {
  return page.getByRole("textbox", { name: `Answer: ${title}`, exact: true });
}

/** The toast the last write leaves. */
function toast(page: Page): Locator {
  return page.getByRole("region", { name: "Action result" });
}

/** What the toast says, whether it went through or failed. */
function outcome(page: Page): Locator {
  return toast(page).getByRole("status").or(toast(page).getByRole("alert"));
}

function detailPane(page: Page): Locator {
  return page.getByRole("complementary", { name: "Action item detail" });
}

function listRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Action item list" });
}

async function titles(list: Locator): Promise<string[]> {
  return list.getByRole("heading", { level: 3 }).allTextContents();
}

/** Every request the page makes to a human-item write route. */
function writes(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/api/human-items")
    )
      seen.push(request);
  });
  return seen;
}

/** The human-item selectors a subscription request names, `{}` for none. */
function selectorsOf(request: Request): Record<string, unknown> | undefined {
  if (
    request.method() !== "POST" ||
    new URL(request.url()).pathname !== "/api/v2/subscriptions"
  )
    return undefined;
  const { view } = subscribeBodySchema.parse(request.postDataJSON());
  return view.type === "human-items" ? (view.filter ?? {}) : undefined;
}

/** The page asking for the human-items view that selects by `selectors`. */
function subscribedTo(page: Page, selectors: Record<string, unknown>) {
  return page.waitForRequest(
    (request) =>
      JSON.stringify(selectorsOf(request)) === JSON.stringify(selectors),
  );
}

/**
 * Every request the page sends to the API, and the event streams it holds open:
 * a stream ends in the browser's eyes when it finishes or the page closes it.
 */
function recordRequests(page: Page) {
  const requests: { readonly method: string; readonly path: string }[] = [];
  const streams = new Set<Request>();
  const isStream = (request: Request) =>
    new URL(request.url()).pathname === "/api/v2/events";
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    requests.push({ method: request.method(), path: url.pathname });
    if (isStream(request)) streams.add(request);
  });
  const ended = (request: Request) => {
    streams.delete(request);
  };
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return {
    requests,
    streams,
    /** Every `GET` the page sent to a human-item route. */
    humanItemReads: () =>
      requests.filter(
        ({ method, path }) =>
          method === "GET" && path.startsWith("/api/human-items"),
      ),
  };
}

/** What `human-items raise` takes, of an item that blocks nothing. */
function raise(served: FixtureServer, title: string, kind: string): string {
  const facts = factsOf(served);
  const input = join(facts.cwd, `raise-${title.replaceAll(" ", "-")}.json`);
  writeFileSync(
    input,
    JSON.stringify({
      schema_version: 1,
      dedup_key: title.replaceAll(" ", "-"),
      kind,
      title,
      body: `What ${title} needs from a person.`,
      priority: "medium",
      owner: { session: SUPERVISOR, run: null, plan: null },
      block: { scope: "nothing" },
      approval: null,
    }),
  );
  const receipt = receiptSchema.parse(
    JSON.parse(
      cli(served, ["human-items", "raise", "--input", input], SUPERVISOR),
    ),
  );
  return receipt.item.item.id;
}

/** A rendered element's height and its one-line resting height. */
function heights(element: HTMLElement) {
  const style = getComputedStyle(element);
  const line = Number.parseFloat(style.lineHeight);
  const chrome =
    Number.parseFloat(style.paddingTop) +
    Number.parseFloat(style.paddingBottom) +
    Number.parseFloat(style.borderTopWidth) +
    Number.parseFloat(style.borderBottomWidth);
  return {
    height: element.getBoundingClientRect().height,
    oneLine: line + chrome,
  };
}

test("opens Action items from its own navigation entry and leaves the Host page as it was", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await page.goto(served.origin);
  const nav = page.getByRole("navigation", { name: "Projects" });
  await nav.getByRole("button", { name: "Action items" }).click();
  await expect(page).toHaveURL(`${served.origin}/human-items`);
  await expect(
    nav.getByRole("button", { name: "Action items" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Action items" }),
  ).toBeVisible();
  const list = listRegion(page);
  await expect(list.getByRole("listitem")).toHaveCount(DECLARED.length);

  await nav.getByRole("button", { name: "Host" }).click();
  await expect(page).toHaveURL(/\/\?page=host$/u);
  const host = page.getByRole("region", { name: "Host" });
  await expect(host.getByRole("heading", { name: /This host/u })).toBeVisible();
  await expect(
    host.getByRole("button", { name: "Refresh host" }),
  ).toBeVisible();
  // The Host page carries none of the action items: no list, no card, no title.
  await expect(listRegion(page)).toHaveCount(0);
  for (const { title } of DECLARED)
    await expect(page.getByText(title)).toHaveCount(0);

  // The address opens the page directly, back where it was — with a trailing
  // slash too — and a path that merely ends in the word is not the page.
  await page.goBack();
  await expect(page).toHaveURL(`${served.origin}/human-items`);
  await expect(list.getByRole("listitem")).toHaveCount(DECLARED.length);
  await page.goto(`${served.origin}/human-items/`);
  await expect(list.getByRole("listitem")).toHaveCount(DECLARED.length);
  await page.goto(`${served.origin}/not-human-items`);
  await expect(listRegion(page)).toHaveCount(0);
});

test("the sidebar's kinds stay on Action items and a run selected from it leaves for the run", async ({
  page,
}) => {
  // A host's live root with runs and run kinds.
  server = await startFixtureServer("human-items-kinds", [
    "--project-centric-corpus",
  ]);
  await page.goto(`${server.origin}/?page=host`);
  const nav = page.getByRole("navigation", { name: "Projects" });
  const kinds = nav.getByRole("group", { name: "Run kinds", exact: true });
  await nav.getByText(/^Run kinds:/).click();
  // A kind hidden before the page opens is still hidden on it.
  await kinds.getByRole("checkbox", { name: "planning" }).uncheck();
  await nav.getByRole("button", { name: "Action items" }).click();
  await expect(page).toHaveURL(
    `${server.origin}/human-items?hide-kind=planning`,
  );
  await expect(
    kinds.getByRole("checkbox", { name: "planning" }),
  ).not.toBeChecked();
  await kinds.getByRole("checkbox", { name: "spikes" }).uncheck();
  await expect(page).toHaveURL(
    `${server.origin}/human-items?hide-kind=planning&hide-kind=spikes`,
  );
  await expect(
    page.getByRole("heading", { name: "Action items" }),
  ).toBeVisible();
  await nav
    .getByRole("button", { name: /shown runs$/ })
    .first()
    .click();
  await expect(page).not.toHaveURL(/human-items/u);
  await expect(page.getByRole("heading", { name: "Action items" })).toHaveCount(
    0,
  );
  const run = new URL(page.url()).searchParams.get("run");
  if (run === null) throw new Error(`no run selected at ${page.url()}`);
  await expect(page.getByRole("region", { name: "Run header" })).toBeVisible();

  // The path names the page whatever the query selects: a host page, that run
  // and one of its nodes are all set aside, and none of the run's controls show.
  await page.goto(
    `${server.origin}/human-items?page=host&run=${encodeURIComponent(run)}&node=dashboard`,
  );
  await expect(
    page.getByRole("heading", { name: "Action items" }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Action items" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    nav.getByRole("button", { name: "Host", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Host", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Run header" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Workspace header" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Stop/u })).toHaveCount(0);
});

test("lists every open item of the host in the engine's order, as compact full-width cards", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  expect(await titles(list)).toEqual(DECLARED.map(({ title }) => title));
  // The engine's own order, as its CLI lists the same journal.
  expect(listed(served).map(({ item }) => item.title)).toEqual(
    DECLARED.map(({ title }) => title),
  );

  const wire = listSchema.parse(
    await (await page.request.get(`${served.origin}/api/human-items`)).json(),
  );
  for (const [index, expected] of DECLARED.entries()) {
    const shown = card(page, expected.title);
    await expect(
      shown.getByText(expected.priority, { exact: true }),
    ).toBeVisible();
    await expect(shown.getByText(expected.kind, { exact: true })).toBeVisible();
    await expect(
      shown.getByText(expected.source, { exact: true }),
    ).toBeVisible();
    await expect(shown.getByText(/^blocks /u)).toHaveCount(
      expected.blocks === undefined ? 0 : 1,
    );
    if (expected.blocks !== undefined)
      await expect(
        shown.getByText(expected.blocks, { exact: true }),
      ).toBeVisible();
    await expect(
      shown.getByText(stored(served, idOf(served, expected.key)).body, {
        exact: true,
      }),
    ).toBeVisible();
    // Critical is a label: the record says urgent.
    expect(wire.items[index]?.item).toEqual({
      title: expected.title,
      priority: expected.wire,
    });
  }
  // Every task carries the tracker issue the engine projected it to; no
  // question has one.
  const tasks = DECLARED.filter(({ kind }) => kind === "Task");
  await expect(list.getByRole("link")).toHaveCount(tasks.length);
  for (const task of tasks) {
    const { name, url } = trackerOf(served, idOf(served, task.key));
    expect(url).toMatch(/^https:\/\/github\.com\/generic\/approval\/issues\//u);
    await expect(
      card(page, task.title).getByRole("link", { name }),
    ).toHaveAttribute("href", url);
  }

  await expect(card(page, "Rotate the deploy credentials")).toBeVisible();
  // No P-labels, no owner-ended anything, no scope, no approval control.
  const text = await page.getByRole("main").innerText();
  expect(text).not.toMatch(/\bP[0-3]\b/u);
  expect(text.toLowerCase()).not.toContain("owner-ended");
  expect(text.toLowerCase()).not.toContain("owner ended");
  expect(text.toLowerCase()).not.toContain("scope");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /approve/iu })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /board|key/iu })).toHaveCount(
    0,
  );
  const filters = page.getByRole("group", { name: "Filter action items" });
  await expect(filters.getByRole("combobox")).toHaveCount(6);
  for (const name of [
    "Group by",
    "Kind",
    "Blocking",
    "Priority",
    "State",
    "Source",
  ])
    await expect(
      filters.getByRole("combobox", { name, exact: true }),
    ).toBeVisible();
  await expect(filters.getByLabel("Priority").getByRole("option")).toHaveText([
    "Any priority",
    "Critical",
    "High",
    "Medium",
    "Low",
  ]);
  await expect(filters.getByLabel("State").getByRole("option")).toHaveText([
    "Open",
    "Answered",
    "Completed",
    "Dismissed",
  ]);
  await expect(filters.getByLabel("Blocking").getByRole("option")).toHaveText([
    "Any",
    "Yes",
    "No",
  ]);
  await expect(filters.getByLabel("Group by").getByRole("option")).toHaveText([
    "Priority",
    "Kind",
    "Source",
    "Blocking",
    "None",
  ]);
});

test("a tracker link opens its issue without selecting the card", async ({
  page,
  context,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const title = "Review the action-items design";
  const { name, url } = trackerOf(served, idOf(served, "design"));
  const link = card(page, title).getByRole("link", { name });
  await expect(link).toHaveAttribute("href", url);
  await followed(context, () => link.click(), url);
  await expect(detailPane(page)).toHaveCount(0);
  await expect(card(page, title)).toHaveAttribute("data-selected", "false");
});

test("at 1440×900 six complete cards and all their controls fit the list unscrolled, and selection opens detail beside it", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  // Grouped as a reader first finds it — by Priority — with its headings showing.
  const list = await open(page, served, { groupBy: null });
  // The original density target is six cards; select that same six-item corpus.
  await page
    .getByRole("combobox", { name: "Source", exact: true })
    .selectOption("session");
  await page
    .getByRole("searchbox", { name: "Source identifier", exact: true })
    .fill(SUPERVISOR);
  await expect(list.getByRole("article")).toHaveCount(6);
  await expect(list.getByRole("heading", { level: 2 })).toHaveText([
    "Critical (2)",
    "High (3)",
    "Low (1)",
  ]);
  for (const heading of await list.getByRole("heading", { level: 2 }).all())
    await expect(heading).toBeInViewport({ ratio: 1 });
  const region = listRegion(page);
  const box = await region.boundingBox();
  if (box === null) throw new Error("the list has no box");
  const cards = list.getByRole("article");
  await expect(cards).toHaveCount(6);
  const unscrolled = await region.evaluate((element) => ({
    top: element.scrollTop,
    fits: element.scrollHeight <= element.clientHeight + 1,
  }));
  expect(unscrolled).toEqual({ top: 0, fits: true });
  // Three tasks and three open questions, every body 80–160 characters.
  for (const kind of ["Task", "Question"])
    await expect(list.getByText(kind, { exact: true })).toHaveCount(3);
  await expect(list.getByRole("textbox")).toHaveCount(3);
  for (const { title, key } of DECLARED.filter(({ key }) => key !== "other")) {
    const shown = card(page, title);
    const cardBox = await shown.boundingBox();
    if (cardBox === null) throw new Error("a card has no box");
    expect(cardBox.y).toBeGreaterThanOrEqual(box.y);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(box.y + box.height);
    // Full width: the card spans the list rather than a column of it.
    expect(cardBox.width).toBeGreaterThan(box.width * 0.9);
    const text = stored(served, idOf(served, key)).body;
    expect(text.length).toBeGreaterThanOrEqual(80);
    expect(text.length).toBeLessThanOrEqual(160);
    // Complete: nothing of the body is clipped.
    const body = shown.getByText(text, { exact: true });
    await expect(body).toBeInViewport({ ratio: 1 });
    expect(
      await body.evaluate(
        (element) => element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    for (const role of ["button", "link", "textbox"] as const)
      for (const control of await shown.getByRole(role).all())
        await expect(control).toBeInViewport({ ratio: 1 });
  }
  // Each answer box rests one line tall.
  for (const title of QUESTIONS) {
    const rest = await answerBox(page, title).evaluate(heights);
    expect(rest.height).toBeLessThanOrEqual(rest.oneLine + 1);
  }

  await card(page, "Review the action-items design")
    .getByText("Source: plan board:plan-a / run plan-a", { exact: true })
    .click();
  const detail = detailPane(page);
  await expect(detail).toBeVisible();
  const detailBox = await detail.boundingBox();
  const narrowed = await region.boundingBox();
  if (detailBox === null || narrowed === null)
    throw new Error("the panes have no box");
  // Beside the list, which narrows and stays on screen.
  expect(detailBox.x).toBeGreaterThanOrEqual(narrowed.x + narrowed.width - 1);
  expect(narrowed.width).toBeLessThan(box.width);
  await expect(cards.first()).toBeInViewport();

  // Closing the detail gives the list its whole width back.
  await detail.getByRole("button", { name: "Close detail" }).click();
  await expect(detail).toHaveCount(0);
  expect((await region.boundingBox())?.width).toBe(box.width);
});

test("the detail enumerates every blocked step the engine derived, and an open host item is blocking in list and detail", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const title = "Which region should the canary run in?";
  await card(page, title)
    .getByRole("button", { name: `Details: ${title}` })
    .click();
  const steps = detailPane(page).getByRole("region", { name: "Blocked steps" });
  await expect(
    steps.getByRole("heading", { name: "blocks 5 steps in board:plan-a" }),
  ).toBeVisible();
  const derived = (id: string) =>
    detailSchema
      .parse(JSON.parse(cli(served, ["human-items", "show", id, "--json"])))
      .nodes.map(({ run, node, title }) => `${run} / ${node}: ${title}`);
  expect(derived(idOf(served, "region"))).toEqual([
    "plan-a / build: Build the release binaries",
    "plan-a / test: Run the release journeys",
    "plan-a / lint: Lint the changed files",
    "plan-a / package: Package the wheels",
    "plan-a / publish: Publish to the registries",
  ]);
  await expect(steps.getByRole("listitem")).toHaveText(
    derived(idOf(served, "region")),
  );

  const host = card(page, "Restore the build service");
  await expect(
    host.getByText("blocks all work on this host", { exact: true }),
  ).toBeVisible();
  await host
    .getByRole("button", { name: "Details: Restore the build service" })
    .click();
  // The detail says it twice by design: once in the item's meta line, and once
  // as the heading over the steps that hold enumerates.
  await expect(
    detailPane(page)
      .getByRole("paragraph")
      .filter({ hasText: /^blocks all work on this host$/ }),
  ).toBeVisible();
  await expect(
    steps.getByRole("heading", {
      name: "blocks all work on this host",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    detailPane(page).getByText("Critical", { exact: true }),
  ).toBeVisible();
  // Every undispatched step on the host, as the engine enumerates it.
  await expect(steps.getByRole("listitem")).toHaveText(
    derived(idOf(served, "build")),
  );
  await expect(steps.getByRole("listitem")).toHaveCount(6);
});

test("every filter narrows the list on its own, on the wire's vocabulary", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  const filters = page.getByRole("group", { name: "Filter action items" });
  const choose = async (
    label: string,
    value: string,
    selector: Record<string, unknown>,
  ) => {
    const asked = subscribedTo(page, selector);
    await filters.getByLabel(label, { exact: true }).selectOption(value);
    await asked;
  };
  const reset = async (label: string, value: string) =>
    choose(label, value, {});
  /** What the engine's CLI selects across the host. */
  const selected = (args: string[]) =>
    listed(served, args).map(({ item }) => item.title);

  await choose("Kind", "question", { kind: "question" });
  await expect.poll(() => titles(list)).toEqual(QUESTIONS);
  expect(selected(["--kind", "question"])).toEqual(QUESTIONS);
  await reset("Kind", "");

  await choose("Blocking", "yes", { blocking: true });
  await expect
    .poll(() => titles(list))
    .toEqual(DECLARED.slice(0, 3).map(({ title }) => title));
  expect(selected(["--blocking", "yes"])).toEqual(await titles(list));
  await choose("Blocking", "no", { blocking: false });
  await expect
    .poll(() => titles(list))
    .toEqual(DECLARED.slice(3).map(({ title }) => title));
  expect(selected(["--blocking", "no"])).toEqual(await titles(list));
  await reset("Blocking", "");

  // Critical on the page is urgent on the wire.
  await choose("Priority", "urgent", { priority: "urgent" });
  await expect
    .poll(() => titles(list))
    .toEqual([
      "Restore the build service",
      "Should retries reuse the warm cache?",
      "Rotate the deploy credentials",
    ]);
  expect(selected(["--priority", "Critical"])).toEqual(await titles(list));
  await expect(list.getByText("Critical", { exact: true })).toHaveCount(3);
  await reset("Priority", "");

  await choose("State", "answered", { state: "answered" });
  await expect
    .poll(() => titles(list))
    .toEqual(["Which changelog section holds the fix?"]);
  await choose("State", "dismissed", { state: "dismissed" });
  await expect
    .poll(() => titles(list))
    .toEqual(["Re-run the flaky screenshot job"]);
  // A state nothing is in is an empty list, said so.
  await choose("State", "completed", { state: "completed" });
  await expect(
    listRegion(page).getByRole("status").filter({
      hasText: "No action items match these filters.",
    }),
  ).toBeVisible();
  await choose("State", "open", {});

  await choose("Source", "host", { host: true });
  await expect.poll(() => titles(list)).toEqual(["Restore the build service"]);
  await reset("Source", "");

  for (const [source, id, expected] of [
    [
      "run",
      "plan-a",
      [
        "Which region should the canary run in?",
        "Review the action-items design",
      ],
    ],
    [
      "plan",
      "board:plan-b",
      ["Keep the legacy export format?", "Review the dashboard layout"],
    ],
    [
      "session",
      SUPERVISOR,
      DECLARED.filter(({ key }) => key !== "other").map(({ title }) => title),
    ],
  ] as const) {
    await filters.getByLabel("Source", { exact: true }).selectOption(source);
    const asked = subscribedTo(page, { [source]: id });
    await filters.getByLabel("Source identifier").fill(id);
    await asked;
    await expect.poll(() => titles(list)).toEqual([...expected]);
    expect(selected([`--${source}`, id])).toEqual([...expected]);
  }
});

test("Tab moves straight between answer boxes, Enter answers in place, Shift+Enter is a new line", async ({
  page,
  context,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const sent = writes(page);
  watch(served, SUPERVISOR);
  watch(served, OTHER);

  // From the last filter, Tab reaches each open question's answer box in turn
  // and nothing else on the way.
  await page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("Source", { exact: true })
    .focus();
  for (const title of QUESTIONS) {
    await page.keyboard.press("Tab");
    await expect(answerBox(page, title)).toBeFocused();
  }

  // Enter on an empty box sends nothing.
  await page.keyboard.press("Enter");
  // Shift+Enter writes a new line and sends nothing; the box grows with it.
  const resting = await answerBox(page, LAST_QUESTION).evaluate(heights);
  await page.keyboard.type("Reuse it");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("for one more release");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("then start cold");
  await expect(answerBox(page, LAST_QUESTION)).toHaveValue(
    "Reuse it\nfor one more release\nthen start cold",
  );
  const grown = await answerBox(page, LAST_QUESTION).evaluate(heights);
  expect(grown.height).toBeGreaterThan(resting.height + resting.oneLine);
  expect(sent).toHaveLength(0);

  // Enter answers the focused question, without opening detail — and the
  // answer is the journal's, delivered to the owning session's watch alone.
  const first = QUESTIONS[0] ?? "";
  await answerBox(page, first).focus();
  await page.keyboard.type("eu-west, matching the incident report");
  await page.keyboard.press("Enter");
  await expect(outcome(page)).toHaveText(`Answered: ${first}`);
  await expect(card(page, first)).toHaveCount(0);
  await expect(detailPane(page)).toHaveCount(0);
  expect(sent.map((request) => request.postData())).toEqual([
    JSON.stringify({ text: "eu-west, matching the incident report" }),
  ]);
  const region = idOf(served, "region");
  expect(stored(served, region)).toMatchObject({
    state: "answered",
    resolution: {
      actor: `browser:session:${SUPERVISOR}`,
      on_behalf_of: null,
      text: "eu-west, matching the incident report",
    },
  });
  expect(watch(served, SUPERVISOR)).toEqual([["human-item-answered", region]]);
  expect(watch(served, OTHER)).toEqual([]);
  // The other draft is still there, unsent.
  await expect(answerBox(page, LAST_QUESTION)).toHaveValue(
    "Reuse it\nfor one more release\nthen start cold",
  );

  // An input method's composition, through the browser's own input layer:
  // Enter while the words are still being composed sends nothing, and Enter
  // once they are committed sends the answer.
  const composing = "Keep the legacy export format?";
  await answerBox(page, composing).click();
  await page.keyboard.type("Keep it ");
  const ime = await context.newCDPSession(page);
  await ime.send("Input.imeSetComposition", {
    text: "にほん",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await page.keyboard.press("Enter");
  await expect(card(page, composing).getByRole("status")).toHaveCount(0);
  expect(sent).toHaveLength(1);
  await ime.send("Input.insertText", { text: "にほん" });
  await page.keyboard.press("Enter");
  await expect(outcome(page)).toHaveText(`Answered: ${composing}`);
  expect(sent).toHaveLength(2);
  expect(stored(served, idOf(served, "export")).resolution?.text).toContain(
    "Keep it にほん",
  );
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-answered", idOf(served, "export")],
  ]);
});

test("card actions are a focus group of their own after the answer boxes, operable by keyboard", async ({
  page,
  context,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  await answerBox(page, LAST_QUESTION).focus();
  // After the last answer box, Tab enters the group at the first card action.
  await page.keyboard.press("Tab");
  const build = trackerOf(served, idOf(served, "build"));
  const tracker = card(page, "Restore the build service").getByRole("link", {
    name: build.name,
  });
  await expect(tracker).toBeFocused();
  // Enter follows a link; arrow keys move through the actions.
  await followed(context, () => page.keyboard.press("Enter"), build.url);
  await tracker.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "Details: Restore the build service" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "Dismiss: Restore the build service" }),
  ).toBeFocused();
  // Dismiss, from the keyboard alone, in one press.
  await page.keyboard.press("Enter");
  await expect(outcome(page)).toHaveText(
    "Dismissed: Restore the build service",
  );
  await expect(card(page, "Restore the build service")).toHaveCount(0);
  expect(stored(served, idOf(served, "build"))).toMatchObject({
    state: "dismissed",
    resolution: { actor: `browser:session:${SUPERVISOR}`, reason: null },
  });

  // Complete, from the keyboard. The group now opens on the first card left —
  // a question, whose actions are Details and Dismiss — and the arrows walk on
  // into the next card's; End and Home reach the ends of the group.
  const region = "Which region should the canary run in?";
  const last = "Review the dashboard layout";
  await answerBox(page, LAST_QUESTION).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: `Details: ${region}` }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("button", { name: `Dismiss: ${last}` }),
  ).toBeFocused();
  // At either end of the group the arrows hold focus there.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: `Dismiss: ${last}` }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("button", { name: `Details: ${region}` }),
  ).toBeFocused();
  const design = trackerOf(served, idOf(served, "design"));
  const other = trackerOf(served, idOf(served, "other"));
  for (const [role, name] of [
    ["button", `Dismiss: ${region}`],
    ["button", "Details: Keep the legacy export format?"],
    ["button", "Dismiss: Keep the legacy export format?"],
    ["button", `Details: ${LAST_QUESTION}`],
    ["button", `Dismiss: ${LAST_QUESTION}`],
    ["link", other.name],
    ["button", "Details: Rotate the deploy credentials"],
    ["button", "Complete: Rotate the deploy credentials"],
    ["button", "Dismiss: Rotate the deploy credentials"],
    ["link", design.name],
    ["button", "Details: Review the action-items design"],
    ["button", "Complete: Review the action-items design"],
  ] as const) {
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole(role, { name })).toBeFocused();
  }
  // Left and Up walk back, Right and Down forward again.
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("button", {
      name: "Details: Review the action-items design",
    }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("link", { name: design.name })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", {
      name: "Complete: Review the action-items design",
    }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(outcome(page)).toHaveText(
    "Completed: Review the action-items design",
  );
  expect(stored(served, idOf(served, "design")).state).toBe("completed");
});

test("a design review completes with the ordinary Complete, and a changed document is refused and replaced", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  const sent = writes(page);
  watch(served, SUPERVISOR);

  await page
    .getByRole("button", { name: "Complete: Review the action-items design" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Completed: Review the action-items design",
  );
  await expect(card(page, "Review the action-items design")).toHaveCount(0);
  expect(sent.map((request) => request.postData())).toEqual(["{}"]);
  // The approval the configured authority recorded before the task completed:
  // the version stored when the review was raised, as the acting session, on
  // nobody's behalf — no key was asked of anyone.
  expect(approvals(served)).toEqual([
    {
      board_copy: "docs/design/action-items.md",
      key: "sha256:5d1c0a",
      actor: `browser:session:${SUPERVISOR}`,
      on_behalf_of: null,
    },
  ]);
  expect(stored(served, idOf(served, "design")).state).toBe("completed");

  // The dashboard document moved on since its review was raised.
  const obsolete = idOf(served, "dashboard");
  await page
    .getByRole("button", { name: "Complete: Review the dashboard layout" })
    .click();
  await expect(outcome(page)).toHaveText(
    /^Not completed: Review the dashboard layout\. .*Re-read the current document/u,
  );
  await expect(toast(page)).toHaveAttribute("data-tone", "failure");
  // No stale approval; the obsolete task is dismissed and exactly one
  // replacement, for the new version, is open in its place.
  expect(approvals(served)).toHaveLength(1);
  expect(stored(served, obsolete).state).toBe("dismissed");
  const replacements = listed(served).filter(
    ({ item }) => item.approval?.board_copy === "docs/design/dashboard.md",
  );
  expect(replacements).toHaveLength(1);
  expect(replacements[0]?.item.approval?.key).toBe("sha256:c4e2f9");
  expect(replacements[0]?.item.id).not.toBe(obsolete);
  await expect(card(page, "Review the dashboard layout")).toHaveCount(1);
  expect(await titles(list)).toContain("Review the dashboard layout");
  // The replacement is current, so the same Complete now completes it.
  await page
    .getByRole("button", { name: "Complete: Review the dashboard layout" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Completed: Review the dashboard layout",
  );
  expect(approvals(served)[1]).toEqual({
    board_copy: "docs/design/dashboard.md",
    key: "sha256:c4e2f9",
    actor: `browser:session:${SUPERVISOR}`,
    on_behalf_of: null,
  });
  const told = watch(served, SUPERVISOR).map(([kind]) => kind);
  expect(told).toContain("human-item-completed");
});

test("a dismissal is one press, and a reason is sent only when one is written", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const sent = writes(page);
  watch(served, SUPERVISOR);
  watch(served, OTHER);

  await page
    .getByRole("button", { name: "Dismiss: Keep the legacy export format?" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Dismissed: Keep the legacy export format?",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await toast(page).getByRole("button", { name: "Add reason" }).click();
  await toast(page)
    .getByRole("textbox", { name: "Reason" })
    .fill("the export stays");
  await toast(page).getByRole("textbox", { name: "Reason" }).press("Enter");
  await expect(outcome(page)).toHaveText(
    "Reason saved: Keep the legacy export format?",
  );
  expect(stored(served, idOf(served, "export")).resolution?.reason).toBe(
    "the export stays",
  );

  await page
    .getByRole("button", { name: "Dismiss: Review the dashboard layout" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Dismissed: Review the dashboard layout",
  );
  await expect
    .poll(() => stored(served, idOf(served, "dashboard")).state)
    .toBe("dismissed");
  expect(stored(served, idOf(served, "dashboard")).resolution?.reason).toBe(
    null,
  );
  expect(
    sent.map((request) => [
      new URL(request.url()).pathname.split("/").at(-1),
      request.postData(),
    ]),
  ).toEqual([
    ["dismiss", "{}"],
    ["note", JSON.stringify({ text: "the export stays" })],
    ["dismiss", "{}"],
  ]);
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-dismissed", idOf(served, "export")],
    ["human-item-noted", idOf(served, "export")],
    ["human-item-dismissed", idOf(served, "dashboard")],
  ]);
  expect(watch(served, OTHER)).toEqual([]);

  // Closing the toast sends nothing more.
  await toast(page).getByRole("button", { name: "Close" }).click();
  await expect(toast(page)).toHaveCount(0);
  expect(sent).toHaveLength(3);
  await expect(card(page, "Restore the build service")).toBeVisible();
});

test("the detail pane answers, completes, dismisses and follows the tracker as the card does", async ({
  page,
  context,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const pane = detailPane(page);

  await page
    .getByRole("button", {
      name: "Details: Should retries reuse the warm cache?",
    })
    .click();
  const answer = pane.getByRole("textbox", {
    name: "Answer in detail: Should retries reuse the warm cache?",
  });
  await answer.fill("Reuse it, and check the artifact digest");
  await answer.press("Enter");
  await expect(outcome(page)).toHaveText(
    "Answered: Should retries reuse the warm cache?",
  );
  // An answer leaves the pane on the item, now answered.
  await expect(pane.getByText("Question · Answered")).toBeVisible();
  expect(stored(served, idOf(served, "cache")).resolution?.text).toBe(
    "Reuse it, and check the artifact digest",
  );

  await page
    .getByRole("button", { name: "Details: Review the action-items design" })
    .click();
  const design = trackerOf(served, idOf(served, "design"));
  await followed(
    context,
    () => pane.getByRole("link", { name: design.name }).click(),
    design.url,
  );
  await pane.getByRole("button", { name: "Complete" }).click();
  await expect(outcome(page)).toHaveText(
    "Completed: Review the action-items design",
  );
  // Completing the item it shows closes the pane with its card.
  await expect(pane).toHaveCount(0);
  await expect(card(page, "Review the action-items design")).toHaveCount(0);

  await page
    .getByRole("button", { name: "Details: Review the dashboard layout" })
    .click();
  await pane.getByRole("button", { name: "Dismiss" }).click();
  await expect(outcome(page)).toHaveText(
    "Dismissed: Review the dashboard layout",
  );
  await expect(pane).toHaveCount(0);
  await toast(page).getByRole("button", { name: "Add reason" }).click();
  await toast(page).getByRole("textbox", { name: "Reason" }).fill("superseded");
  await toast(page).getByRole("button", { name: "Send" }).click();
  await expect(outcome(page)).toHaveText(
    "Reason saved: Review the dashboard layout",
  );
  expect(stored(served, idOf(served, "dashboard")).resolution?.reason).toBe(
    "superseded",
  );
});

test("a pending receipt keeps the item open, repeats send nothing, and a failure keeps the draft", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const sent = writes(page);
  const title = "Should retries reuse the warm cache?";
  const cache = idOf(served, "cache");

  // The receipt is held on its way back: the item stays, marked as sending,
  // and every further Enter is refused rather than sent.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/human-items/*/answer", async (route) => {
    await held;
    await route.continue();
  });
  await answerBox(page, title).fill("Reuse it, and check the artifact digest");
  await answerBox(page, title).press("Enter");
  await expect(card(page, title).getByRole("status")).toHaveText("Sending…");
  await answerBox(page, title).press("Enter");
  await answerBox(page, title).press("Enter");
  await expect(card(page, title)).toBeVisible();
  await expect(answerBox(page, title)).toHaveAttribute("readonly", "");
  expect(sent).toHaveLength(1);
  release();
  await expect(outcome(page)).toHaveText(`Answered: ${title}`);
  await expect(card(page, title)).toHaveCount(0);
  expect(sent).toHaveLength(1);
  await page.unroute("**/api/human-items/*/answer");
  // One durable write: the journal records the answer once.
  expect(
    journal(served)
      .split("\n")
      .filter(
        (line) =>
          line.includes('"human-item-answered"') && line.includes(cache),
      ),
  ).toHaveLength(1);

  // A task's Complete is one write too: the card leaves on the press, so there
  // is nothing left to press again while its receipt is out.
  let releaseTask: () => void = () => {};
  const heldTask = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const designId = idOf(served, "design");
  await page.route(`**/api/human-items/${designId}/complete`, async (route) => {
    await heldTask;
    await route.continue();
  });
  const design = "Review the action-items design";
  await page.getByRole("button", { name: `Complete: ${design}` }).click();
  await expect(card(page, design)).toHaveCount(0);
  await expect(outcome(page)).toHaveText(`Completing: ${design}…`);
  expect(sent).toHaveLength(2);
  releaseTask();
  await expect(outcome(page)).toHaveText(`Completed: ${design}`);
  expect(sent).toHaveLength(2);
  expect(stored(served, designId).state).toBe("completed");
  await page.unroute(`**/api/human-items/${designId}/complete`);

  // The server cannot reach its journal: the write fails in the engine's
  // words, nothing is written, the list keeps what it last read, and the draft
  // stays for a retry that then succeeds.
  const question = "Keep the legacy export format?";
  const restore = breakJournal(served);
  await answerBox(page, question).fill("Keep it one more release");
  await answerBox(page, question).press("Enter");
  await expect(card(page, question).getByRole("alert")).toContainText(
    "human-items",
  );
  await expect(answerBox(page, question)).toHaveValue(
    "Keep it one more release",
  );
  await expect(card(page, question)).toBeVisible();
  restore();
  expect(stored(served, idOf(served, "export")).state).toBe("open");
  await answerBox(page, question).press("Enter");
  await expect(outcome(page)).toHaveText(`Answered: ${question}`);
  expect(stored(served, idOf(served, "export")).resolution?.text).toBe(
    "Keep it one more release",
  );

  // The server stops answering at all: the write's connection fails, the card
  // comes back where it was with the reason, and once a server is back over the
  // same journal the same action succeeds.
  await served.stopServing();
  await page
    .getByRole("button", { name: "Complete: Restore the build service" })
    .click();
  await expect(
    card(page, "Restore the build service").getByRole("alert"),
  ).toHaveText("Telemetry request failed");
  await expect(card(page, "Restore the build service")).toBeVisible();
  await served.serveRebuilt();
  await page
    .getByRole("button", { name: "Complete: Restore the build service" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Completed: Restore the build service",
  );
  expect(stored(served, idOf(served, "build")).state).toBe("completed");
});

test("the visual queue includes nine stored items across two foreign owners", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const served = await serveWorld("queue");
  await actAs(served, "visual-browser-server");
  const list = await open(page, served);
  expect(await titles(list)).toEqual(DECLARED.map(({ title }) => title));
  const all = Object.values(factsOf(served).ids).map((id) =>
    stored(served, id),
  );
  expect(all).toHaveLength(9);
  expect(new Set(all.map((item) => item.owner.session))).toEqual(
    new Set([SUPERVISOR, OTHER]),
  );
  expect(all.filter((item) => item.state === "open")).toHaveLength(7);
  expect(all.filter((item) => item.state === "answered")).toHaveLength(1);
  expect(all.filter((item) => item.state === "dismissed")).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("host-wide-queue.png") });
});

for (const acting of ["browser-owns-nothing", SUPERVISOR, ""]) {
  test(`host-wide resolutions with server session ${acting || "unattributed"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const served = await serveWorld("hostwide");
    await actAs(served, acting);
    const owners = [SUPERVISOR, OTHER, "third-owner"];
    for (const owner of owners) watch(served, owner);
    const list = await open(page, served);
    const all = listed(served);
    expect(all).toHaveLength(7);
    expect(all.filter(({ item }) => item.kind === "question")).toHaveLength(3);
    expect(all.filter(({ item }) => item.kind === "task")).toHaveLength(4);
    expect(all.filter(({ item }) => item.approval !== null)).toHaveLength(2);
    expect(new Set(all.map(({ item }) => item.owner.session))).toEqual(
      new Set(owners),
    );
    expect(await titles(list)).toEqual(all.map(({ item }) => item.title));
    // CLI defaults remain session-scoped even though HTTP defaults are host-wide.
    const report = cli(served, ["human-items", "report"], SUPERVISOR);
    expect(report).toContain("Restore the build service");
    expect(report).not.toContain("Should retries reuse the warm cache?");
    expect(report).not.toContain("Rotate the deploy credentials");
    const actor = acting ? `browser:session:${acting}` : "browser";
    for (const [key, verb, event] of [
      ["cache", "answer", "human-item-answered"],
      ["other", "complete", "human-item-completed"],
      ["export", "dismiss", "human-item-dismissed"],
      ["design", "complete", "human-item-completed"],
    ] as const) {
      const id = idOf(served, key);
      const before = stored(served, id);
      await page
        .getByRole("button", { name: `Details: ${before.title}` })
        .click();
      const pane = detailPane(page);
      await expect(
        pane.getByRole("heading", { name: before.title }),
      ).toBeVisible();
      if (verb === "answer") {
        await pane.getByRole("textbox", { name: /answer/i }).fill("Reuse it");
        await pane.getByRole("textbox", { name: /answer/i }).press("Enter");
      } else if (verb === "dismiss") {
        await pane.getByRole("button", { name: /^Dismiss/ }).click();
      } else {
        await pane.getByRole("button", { name: /^Complete/ }).click();
      }
      await expect(card(page, before.title)).toHaveCount(0);
      await expect(outcome(page)).toHaveText(
        /^(Answered|Completed|Dismissed): /u,
      );
      const after = stored(served, id);
      expect(after.owner).toEqual(before.owner);
      expect(after.resolution).toMatchObject({ actor, on_behalf_of: null });
      for (const owner of owners)
        expect(watch(served, owner)).toEqual(
          owner === before.owner.session ? [[event, id]] : [],
        );
      if (verb === "answer")
        await pane.getByRole("button", { name: "Close detail" }).click();
      await expect(pane).toHaveCount(0);
    }
    expect(approvals(served)).toContainEqual({
      board_copy: "docs/design/action-items.md",
      key: "sha256:5d1c0a",
      actor,
      on_behalf_of: null,
    });
  });
}

test("a detail that cannot be read says why, and another item's opens once the server can read again", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const restore = breakJournal(served);
  await page
    .getByRole("button", { name: "Details: Review the dashboard layout" })
    .click();
  const pane = detailPane(page);
  await expect(pane.getByRole("alert")).toContainText("human-items");
  // What the list already read of the item is still shown beside the refusal.
  await expect(
    pane.getByRole("heading", { name: "Review the dashboard layout" }),
  ).toBeVisible();
  restore();
  await page
    .getByRole("button", {
      name: "Details: Which region should the canary run in?",
    })
    .click();
  await expect(
    pane.getByRole("region", { name: "Blocked steps" }).getByRole("listitem"),
  ).toHaveCount(5);
  await expect(pane.getByRole("alert")).toHaveCount(0);
});

test("an open detail whose reread fails drops what it read, and shows it again once it can be read", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const region = "Which region should the canary run in?";
  const refresh = () => page.getByRole("button", { name: "Refresh" }).click();
  const pane = detailPane(page);
  const steps = pane
    .getByRole("region", { name: "Blocked steps" })
    .getByRole("listitem");
  await page.getByRole("button", { name: `Details: ${region}` }).click();
  await expect(steps).toHaveCount(5);

  // The server cannot reach its journal: the reread fails, the steps only the
  // detail served go with it, and the pane keeps what the list last read
  // beside the refusal.
  const restore = breakJournal(served);
  await refresh();
  await expect(pane.getByRole("alert")).toContainText("human-items");
  await expect(steps).toHaveCount(0);
  await expect(pane.getByRole("heading", { name: region })).toBeVisible();
  restore();
  await refresh();
  await expect(steps).toHaveCount(5);
  await expect(pane.getByRole("alert")).toHaveCount(0);

  // Changing the acting session leaves foreign detail and actions available.
  await actAs(served, OTHER);
  await refresh();
  await expect(card(page, region)).toBeVisible();
  await expect(pane.getByRole("heading", { name: region })).toBeVisible();
  await expect(steps).toHaveCount(5);
  await expect(pane.getByRole("alert")).toHaveCount(0);
  await pane.getByRole("button", { name: "Close detail" }).click();
  await expect(pane).toHaveCount(0);
});

test("the list says it is reading until the first read lands", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v2/subscriptions", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${served.origin}/human-items`);
  await expect(
    listRegion(page)
      .getByRole("status")
      .filter({ hasText: "Reading action items…" }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  release();
  await expect(page.getByRole("article")).toHaveCount(DECLARED.length);
  await expect(
    listRegion(page)
      .getByRole("status")
      .filter({ hasText: "Reading action items…" }),
  ).toHaveCount(0);
});

test("ending its run retires the items holding that run's work, and leaves host holds and a manager's own question", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  watch(served, SUPERVISOR);
  const facts = factsOf(served);
  const run = facts.runs.a ?? "";
  cli(served, ["stop", run], SUPERVISOR);
  // The run's own question, which held its work, is retired; the host hold,
  // the plan hold on a plan it never ran, and the manager's question raised
  // outside any run all survive it.
  await expect
    .poll(() => titles(list))
    .toEqual(
      DECLARED.map(({ title }) => title).filter(
        (title) => title !== "Which region should the canary run in?",
      ),
    );
  const region = idOf(served, "region");
  expect(stored(served, region)).toMatchObject({
    state: "dismissed",
    resolution: { actor: "engine", reason: "the run ended" },
  });
  expect(watch(served, SUPERVISOR)).toContainEqual([
    "human-item-auto-resolved",
    region,
  ]);
  await expect(
    card(page, "Restore the build service").getByText(
      "blocks all work on this host",
      { exact: true },
    ),
  ).toBeVisible();
  // The question raised outside any run waits for its answer, which reaches
  // that session's next watch.
  await answerBox(page, LAST_QUESTION).fill("Reuse it");
  await answerBox(page, LAST_QUESTION).press("Enter");
  await expect(outcome(page)).toHaveText(`Answered: ${LAST_QUESTION}`);
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-answered", idOf(served, "cache")],
  ]);
  // The retired question is there for whoever looks for dismissed items.
  await page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("State", { exact: true })
    .selectOption("dismissed");
  await expect(
    card(page, "Which region should the canary run in?"),
  ).toBeVisible();
});

test("ten sessions see the host queue, and each answer reaches only its owner's watch", async ({
  page,
}) => {
  const served = await serveWorld("sessions");
  const facts = factsOf(served);
  const sessions = facts.sessions ?? [];
  expect(sessions).toHaveLength(10);
  for (const session of sessions) watch(served, session);
  for (const session of sessions) {
    await actAs(served, session);
    const list = await open(page, served);
    const own = listed(served, ["--session", session]).map(
      ({ item }) => item.title,
    );
    expect(own).toHaveLength(2);
    await expect
      .poll(() => titles(list))
      .toEqual(listed(served).map(({ item }) => item.title));
    const question = `Which day should ${session} ship?`;
    await answerBox(page, question).fill("Thursday");
    await answerBox(page, question).press("Enter");
    await expect(outcome(page)).toHaveText(`Answered: ${question}`);
    const id = idOf(served, `${session}-question`);
    expect(stored(served, id).resolution).toEqual({
      actor: `browser:session:${session}`,
      on_behalf_of: null,
      text: "Thursday",
      reason: null,
    });
    for (const other of sessions)
      expect(watch(served, other)).toEqual(
        other === session ? [["human-item-answered", id]] : [],
      );
  }
});

test("an item whose body is longer than four lines shows four on its card and all of it in a pane that scrolls on its own", async ({
  page,
}) => {
  const served = await serveWorld("long");
  const list = await open(page, served);
  const longTitle = "Work through the release review follow-ups";
  const longText = stored(served, idOf(served, "long")).body;
  const long = card(page, longTitle);
  // The body is the shared package's rendered markdown, clamped as a whole.
  const body = long.getByText(longText, { exact: true });
  // The clamp is the computed style of the box the package renders the body in
  // — the text's own container — which no role or name exposes.
  // llmlint: ignore[e2e_uses_accessible_selectors] a body's four-line clamp is the computed style and geometry of the box the shared package renders it in, which no accessible role or name exposes; it is reached as the located text's own container, never by a class.
  const clamp = await body.evaluate((text) => {
    const element = text.parentElement;
    if (element === null) throw new Error("the body's text has no container");
    const style = getComputedStyle(element);
    return {
      line: Number.parseFloat(style.lineHeight),
      height: element.clientHeight,
      overflows: element.scrollHeight > element.clientHeight,
      clamp: style.getPropertyValue("-webkit-line-clamp"),
    };
  });
  // Exactly four rendered lines, more beneath them, and the clamp that ends
  // the fourth with an ellipsis; the text itself is the whole body.
  expect(clamp.clamp).toBe("4");
  expect(Math.round(clamp.height / clamp.line)).toBe(4);
  expect(clamp.overflows).toBe(true);
  expect(
    longText.endsWith("The final words are: ship the reviewed release."),
  ).toBe(true);
  // Short bodies show whole, unclipped.
  for (const key of ["short", "region", "export"]) {
    const { title, body: text } = stored(served, idOf(served, key));
    const short = card(page, title).getByText(text, { exact: true });
    expect(
      // llmlint: ignore[e2e_uses_accessible_selectors] as above: whether a body is clipped is the geometry of the box it is rendered in, reached as the located text's own container.
      await short.evaluate((text) => {
        const element = text.parentElement;
        if (element === null)
          throw new Error("the body's text has no container");
        return {
          clipped: element.scrollHeight > element.clientHeight,
          lines: Math.round(
            element.clientHeight /
              Number.parseFloat(getComputedStyle(element).lineHeight),
          ),
        };
      }),
    ).toEqual({ clipped: false, lines: 1 });
  }
  // The long card is held to four body lines, so the cards after it sit where
  // a four-line card puts them.
  const boxes = await list
    .getByRole("article")
    .evaluateAll((cards) =>
      cards.map((element) => element.getBoundingClientRect().toJSON()),
    );
  const shortHeight =
    (await card(page, "Restore the build service").boundingBox())?.height ?? 0;
  const longHeight = (await long.boundingBox())?.height ?? 0;
  expect(Math.abs(longHeight - shortHeight - 3 * clamp.line)).toBeLessThan(2);
  for (const [index, box] of boxes.entries())
    if (index > 0)
      expect(
        Math.abs(box.top - (boxes[index - 1]?.bottom ?? 0) - 5),
      ).toBeLessThan(1);

  await long.getByRole("button", { name: `Details: ${longTitle}` }).click();
  const pane = detailPane(page);
  const full = pane.getByRole("region", { name: "Full body" });
  await expect(full).toHaveText(longText);
  const region = listRegion(page);
  const positions = () =>
    list
      .getByRole("article")
      .evaluateAll((cards) =>
        cards.map((element) => element.getBoundingClientRect().top),
      );
  const before = {
    list: await region.evaluate((element) => element.scrollTop),
    cards: await positions(),
    heading: (await pane.getByRole("heading", { level: 2 }).boundingBox())?.y,
  };
  expect(
    await full.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  // A reader scrolls the body from the keyboard: focus it, press End.
  await full.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      full.evaluate(
        (element) =>
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  // The final words are in view inside the pane, and nothing else moved.
  const fullBox = await full.boundingBox();
  if (fullBox === null) throw new Error("the full body has no box");
  const shown = await full
    .getByRole("paragraph")
    .last()
    .evaluate((paragraph, box) => {
      const text = paragraph.firstChild;
      if (text === null) throw new Error("the body holds no text");
      const range = document.createRange();
      const words = "ship the reviewed release.";
      const at = (text.textContent ?? "").lastIndexOf(words);
      range.setStart(text, at);
      range.setEnd(text, at + words.length);
      const word = range.getBoundingClientRect();
      return word.top >= box.y && word.bottom <= box.y + box.height + 1;
    }, fullBox);
  expect(shown).toBe(true);
  expect(await region.evaluate((element) => element.scrollTop)).toBe(
    before.list,
  );
  expect(await positions()).toEqual(before.cards);
  expect((await pane.getByRole("heading", { level: 2 }).boundingBox())?.y).toBe(
    before.heading,
  );
  // The CLI's list and report give a brief line by default and print the same
  // body whole under `--full`.
  for (const verb of ["list", "report"]) {
    const brief = cli(served, ["human-items", verb]);
    expect(brief).toContain(longTitle);
    expect(brief).not.toContain(longText);
    expect(cli(served, ["human-items", verb, "--full"])).toContain(longText);
  }
});

test("an item raised in a plan alone or a run alone names it as its source, and its tracker link is the issue the engine filed", async ({
  page,
  context,
}) => {
  const served = await serveWorld("long");
  await open(page, served);
  await expect(
    card(page, "Which plan owns the shared fixtures?").getByText(
      "Source: plan board:plan-c",
      { exact: true },
    ),
  ).toBeVisible();
  const runOnly = card(page, "File the flaky-runner report");
  await expect(
    runOnly.getByText("Source: run plan-a", { exact: true }),
  ).toBeVisible();
  const { name, url } = trackerOf(served, idOf(served, "runOnly"));
  const link = runOnly.getByRole("link", { name });
  await expect(link).toHaveAttribute("href", url);
  await followed(context, () => link.click(), url);
});

test("a hold of one step says so, and a plan hold lists the steps it reaches", async ({
  page,
}) => {
  const served = await serveWorld("long");
  await open(page, served);
  const one = card(page, "Pick the release branch's base");
  await expect(
    one.getByText("blocks 1 step in board:plan-a: retag", { exact: true }),
  ).toBeVisible();
  await one
    .getByRole("button", { name: "Details: Pick the release branch's base" })
    .click();
  const steps = detailPane(page).getByRole("region", { name: "Blocked steps" });
  await expect(
    steps.getByRole("heading", { name: "blocks 1 step in board:plan-a" }),
  ).toBeVisible();
  await expect(steps.getByRole("listitem")).toHaveText([
    "plan-a / retag: Retag the release",
  ]);

  const plan = card(page, "Work through the release review follow-ups");
  await expect(
    plan.getByText("blocks all of board:plan-a", { exact: true }),
  ).toBeVisible();
  await plan
    .getByRole("button", {
      name: "Details: Work through the release review follow-ups",
    })
    .click();
  await expect(
    steps.getByRole("heading", { name: "blocks all of board:plan-a" }),
  ).toBeVisible();
  const nodes = detailSchema
    .parse(
      JSON.parse(
        cli(served, ["human-items", "show", idOf(served, "long"), "--json"]),
      ),
    )
    .nodes.map(({ run, node, title }) => `${run} / ${node}: ${title}`);
  expect(nodes.length).toBeGreaterThan(1);
  await expect(steps.getByRole("listitem")).toHaveText(nodes);
});

test("a subscription overtaken by a newer one never replaces what the newer one showed", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  const filters = page.getByRole("group", { name: "Filter action items" });

  // The list: the subscription for tasks is held while the one for questions
  // lands; when the tasks' answer finally arrives it is dropped and retired.
  let releaseTasks: () => void = () => {};
  const tasksHeld = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });
  await page.route("**/api/v2/subscriptions", async (route) => {
    if (selectorsOf(route.request())?.kind === "task") await tasksHeld;
    await route.continue();
  });
  const tasksAsked = subscribedTo(page, { kind: "task" });
  await filters.getByLabel("Kind", { exact: true }).selectOption("task");
  await tasksAsked;
  await filters.getByLabel("Kind", { exact: true }).selectOption("question");
  await expect.poll(() => titles(list)).toEqual(QUESTIONS);
  const tasksAnswered = page.waitForResponse(
    (response) => selectorsOf(response.request())?.kind === "task",
  );
  const overtakenRetired = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" &&
      new URL(request.url()).pathname.startsWith("/api/v2/subscriptions/"),
  );
  releaseTasks();
  await tasksAnswered;
  await overtakenRetired;
  await expect(list.getByRole("article")).toHaveCount(QUESTIONS.length);
  expect(await titles(list)).toEqual(QUESTIONS);
  await page.unroute("**/api/v2/subscriptions");

  // The detail: the first item's subscription is held while the second item
  // opens; its late answer does not take the pane back.
  const region = idOf(served, "region");
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const namesRegion = (request: Request) =>
    selectorsOf(request) !== undefined &&
    JSON.stringify(request.postDataJSON()).includes(region);
  await page.route("**/api/v2/subscriptions", async (route) => {
    if (namesRegion(route.request())) await firstHeld;
    await route.continue();
  });
  const regionAsked = page.waitForRequest(namesRegion);
  await page
    .getByRole("button", {
      name: "Details: Which region should the canary run in?",
    })
    .click();
  await regionAsked;
  await page.getByRole("button", { name: `Details: ${LAST_QUESTION}` }).click();
  const pane = detailPane(page);
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(
    LAST_QUESTION,
  );
  const firstAnswered = page.waitForResponse((response) =>
    namesRegion(response.request()),
  );
  releaseFirst();
  await firstAnswered;
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(
    LAST_QUESTION,
  );
  await expect(pane.getByRole("region", { name: "Blocked steps" })).toHaveCount(
    0,
  );
});

test("an open page follows what the CLI writes, reads nothing to do it, and holds one stream", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const seen = recordRequests(page);
  const list = await open(page, served);
  const filters = page.getByRole("group", { name: "Filter action items" });
  // The opening: what the page asked for once it stood on its stream.
  await expect.poll(() => seen.streams.size).toBe(1);
  const opening = seen.requests.length;

  // Unfiltered: raised, answered, completed and dismissed elsewhere, each seen
  // with no reload and no click, on the one stream the page already holds.
  const asked = "Should the CLI's question appear?";
  const askedId = raise(served, asked, "question");
  await expect(card(page, asked)).toBeVisible();
  cli(served, ["human-items", "answer", askedId, "--text", "It did"]);
  await expect(card(page, asked)).toHaveCount(0);
  const done = "Finish the CLI's task";
  const doneId = raise(served, done, "task");
  await expect(card(page, done)).toBeVisible();
  cli(served, ["human-items", "complete", doneId]);
  await expect(card(page, done)).toHaveCount(0);
  const dropped = "Drop the CLI's task";
  const droppedId = raise(served, dropped, "task");
  await expect(card(page, dropped)).toBeVisible();
  cli(served, ["human-items", "dismiss", droppedId, "--reason", "not needed"]);
  await expect(card(page, dropped)).toHaveCount(0);
  expect(seen.requests.slice(opening)).toEqual([]);
  expect(seen.streams.size).toBe(1);

  // A change of filter replaces the subscription; the page holds one stream on
  // it, and shows what that filter selects of what is written next.
  const replaced = subscribedTo(page, { kind: "question" });
  await filters.getByLabel("Kind", { exact: true }).selectOption("question");
  await replaced;
  await expect.poll(() => titles(list)).toEqual(QUESTIONS);
  await expect.poll(() => seen.streams.size).toBe(1);
  const filtered = seen.requests.length;
  const excluded = "A task this filter excludes";
  const excludedId = raise(served, excluded, "task");
  const included = "A question this filter selects";
  const includedId = raise(served, included, "question");
  await expect(card(page, included)).toBeVisible();
  await expect(card(page, excluded)).toHaveCount(0);
  cli(served, ["human-items", "answer", includedId, "--text", "Selected"]);
  await expect(card(page, included)).toHaveCount(0);
  expect(seen.requests.slice(filtered)).toEqual([]);
  expect(seen.streams.size).toBe(1);

  // An item open in the pane that another client resolves reads as resolved,
  // not as a failure, and offers nothing more to do.
  const resolvedElsewhere = "Resolved by someone else";
  const resolvedId = raise(served, resolvedElsewhere, "question");
  await page
    .getByRole("button", { name: `Details: ${resolvedElsewhere}` })
    .click();
  const pane = detailPane(page);
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(
    resolvedElsewhere,
  );
  await expect.poll(() => seen.streams.size).toBe(1);
  const detailed = seen.requests.length;
  cli(served, ["human-items", "answer", resolvedId, "--text", "Handled"]);
  await expect(pane).toContainText("Question · Answered");
  await expect(card(page, resolvedElsewhere)).toHaveCount(0);
  await expect(pane.getByRole("alert")).toHaveCount(0);
  await expect(pane.getByRole("textbox")).toHaveCount(0);
  await expect(pane.getByRole("button", { name: /^Dismiss/u })).toHaveCount(0);
  expect(seen.requests.slice(detailed)).toEqual([]);
  await pane.getByRole("button", { name: "Close detail" }).click();
  await expect(pane).toHaveCount(0);

  // A write from this page: its one POST, and its result arrives on the stream.
  await expect.poll(() => seen.streams.size).toBe(1);
  const beforeWrite = seen.requests.length;
  await answerBox(page, LAST_QUESTION).fill("Reuse it");
  await answerBox(page, LAST_QUESTION).press("Enter");
  await expect(outcome(page)).toHaveText(`Answered: ${LAST_QUESTION}`);
  await expect(card(page, LAST_QUESTION)).toHaveCount(0);
  expect(seen.requests.slice(beforeWrite)).toEqual([
    {
      method: "POST",
      path: `/api/human-items/${idOf(served, "cache")}/answer`,
    },
  ]);

  // The header's Refresh, a person's explicit press, re-creates the
  // subscription, and that reads no item route either.
  const beforeRefresh = seen.requests.length;
  const recreated = subscribedTo(page, { kind: "question" });
  await page.getByRole("button", { name: "Refresh" }).click();
  await recreated;
  await expect.poll(() => seen.streams.size).toBe(1);
  await expect
    .poll(() => seen.requests.slice(beforeRefresh).map(({ method }) => method))
    .toEqual(expect.arrayContaining(["POST", "GET"]));

  // The excluded task was there all along: the filter shaped what was shown.
  expect(stored(served, excludedId).state).toBe("open");
  expect(seen.humanItemReads()).toEqual([]);
});

test("an item whose patch beats its receipt stays where it was until the receipt lands", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  const order = await titles(list);
  // The write is made and committed; only its receipt is held on its way back,
  // so the stream carries the change before the page hears its own answer.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed: () => void = () => {};
  const made = new Promise<void>((resolve) => {
    committed = resolve;
  });
  await page.route("**/api/human-items/*/answer", async (route) => {
    const response = await route.fetch();
    committed();
    await held;
    await route.fulfill({ response });
  });
  await answerBox(page, LAST_QUESTION).fill("Reuse it");
  await answerBox(page, LAST_QUESTION).press("Enter");
  await made;
  expect(stored(served, idOf(served, "cache")).state).toBe("answered");
  // A later change reaching the page proves the stream got past the commit,
  // and the answered card holds its place, still sending, beside it.
  const later = "Raised after the answer was committed";
  raise(served, later, "task");
  await expect(card(page, later)).toBeVisible();
  await expect(card(page, LAST_QUESTION).getByRole("status")).toHaveText(
    "Sending…",
  );
  expect((await titles(list)).filter((title) => title !== later)).toEqual(
    order,
  );
  release();
  await expect(outcome(page)).toHaveText(`Answered: ${LAST_QUESTION}`);
  await expect(card(page, LAST_QUESTION)).toHaveCount(0);
  await expect(card(page, later)).toBeVisible();
});

test("an open item that vanishes reads as resolved rather than as a load error", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const seen = recordRequests(page);
  const region = "Which region should the canary run in?";
  await page.getByRole("button", { name: `Details: ${region}` }).click();
  const pane = detailPane(page);
  await expect(
    pane.getByRole("region", { name: "Blocked steps" }).getByRole("listitem"),
  ).toHaveCount(5);
  // Every item goes from under the server: its journal moved aside, leaving a
  // host with none — which the engine reads, as it reads a fresh host.
  const dir = factsOf(served).journal;
  renameSync(dir, `${dir}.gone`);
  await expect(pane.getByRole("status")).toHaveText(
    "Resolved: this item needs nothing more from you.",
  );
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(region);
  await expect(pane.getByRole("alert")).toHaveCount(0);
  await expect(pane.getByRole("textbox")).toHaveCount(0);
  await expect(
    listRegion(page).getByRole("status").filter({
      hasText: "No action items match these filters.",
    }),
  ).toBeVisible();
  expect(seen.humanItemReads()).toEqual([]);
});

test("a host that has not enabled human items says so on the page", async ({
  page,
}) => {
  // The shared corpus's server: a runs root with runs, on a host whose
  // configuration enables no human items.
  await page.goto("/human-items");
  await expect(listRegion(page).getByRole("alert")).toHaveText(
    "human-items unavailable against live state",
  );
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("a world name the fixture does not define is refused before anything is built", () => {
  // A name every object answers for — inherited, not one of the worlds — is a
  // usage error like any other, and leaves the workspace as it found it.
  for (const name of ["constructor", "__proto__", "toString", "nowhere"]) {
    const workspace = mkdtempSync(join(tmpdir(), "dag-ui-e2e-world-"));
    try {
      const refused = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "fixtures/serve-fixture.mjs"),
          "--workspace",
          workspace,
          // A valid port this never binds: the name is refused first.
          "--port",
          "1",
          "--human-items-world",
          name,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(refused.status, `${name}: ${refused.stderr}`).toBe(2);
      expect(refused.stderr).toContain(
        `serve-fixture: '${name}' is not a human-items world; name one of sessions, queue, hostwide, long`,
      );
      expect(existsSync(join(workspace, "runs")), name).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

/** How long the page shows a toast nothing is holding: its configured duration. */
const TOAST_SECONDS = 15;

/**
 * Hold every request to `path` on its way to the server until the answer is
 * called: the browser has sent it, and no response comes until then.
 */
async function holdRequests(page: Page, path: string): Promise<() => void> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${path}`, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

/**
 * Every alert the page shows from here on, however briefly: a message that
 * appears and is gone before any assertion could look is still a message a
 * reader saw, so it is recorded in the page as it happens.
 */
async function recordAlerts(page: Page): Promise<() => Promise<string[]>> {
  // llmlint: ignore[e2e_uses_accessible_selectors] a locator can only ask what is on the page now; a transient alert has to be noticed by an observer inside the page as it appears, and `[role="alert"]` is the accessible role itself, read where no locator reaches.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __alerts: seen });
    new MutationObserver(() => {
      for (const element of document.querySelectorAll('[role="alert"]')) {
        const text = element.textContent ?? "";
        if (!seen.includes(text)) seen.push(text);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  return async () =>
    z
      .array(z.string())
      .parse(await page.evaluate(() => Reflect.get(window, "__alerts") ?? []));
}

/** The write routes the page sent to, by the verb each names, in order. */
function verbs(sent: readonly Request[]): string[] {
  return sent.map(
    (request) => new URL(request.url()).pathname.split("/").at(-1) ?? "",
  );
}

/** A CSS colour's channels, for "which hue dominates". */
async function backgroundOf(locator: Locator) {
  const colour = await locator.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/gu) ?? []).map(
    Number,
  );
  return { r, g, b };
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("no box: the element is not rendered");
  return found;
}

for (const { from, verb, key, title } of [
  {
    from: "card",
    verb: "Complete",
    key: "build",
    title: "Restore the build service",
  },
  {
    from: "card",
    verb: "Dismiss",
    key: "export",
    title: "Keep the legacy export format?",
  },
  {
    from: "detail",
    verb: "Complete",
    key: "design",
    title: "Review the action-items design",
  },
  {
    from: "detail",
    verb: "Dismiss",
    key: "other",
    title: "Rotate the deploy credentials",
  },
] as const)
  test(`${verb} from the ${from} is one press: the card leaves and the toast shows before the receipt, and it stays gone`, async ({
    page,
  }) => {
    const served = await serveWorld("queue");
    const alerts = await recordAlerts(page);
    await open(page, served, { groupBy: null });
    const id = idOf(served, key);
    const sent = writes(page);
    if (from === "detail") {
      await card(page, title)
        .getByRole("button", { name: `Details: ${title}` })
        .click();
      await expect(
        detailPane(page).getByRole("heading", { name: title }),
      ).toBeVisible();
    }
    const release = await holdRequests(
      page,
      `/api/human-items/${id}/${verb.toLowerCase()}`,
    );
    const button =
      from === "card"
        ? card(page, title).getByRole("button", { name: `${verb}: ${title}` })
        : detailPane(page).getByRole("button", { name: verb, exact: true });
    await button.click();
    // With the receipt still held: the write is out, the card is gone, the
    // detail showing it closed, and the toast already says what is happening —
    // with no dialog, no confirmation and nothing else to press.
    await expect.poll(() => verbs(sent)).toEqual([verb.toLowerCase()]);
    await expect(card(page, title)).toHaveCount(0);
    await expect(detailPane(page)).toHaveCount(0);
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toHaveAttribute("data-phase", "sending");
    await expect(outcome(page)).toHaveText(
      `${verb === "Complete" ? "Completing" : "Dismissing"}: ${title}…`,
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(stored(served, id).state).toBe("open");
    release();
    await expect(outcome(page)).toHaveText(
      `${verb === "Complete" ? "Completed" : "Dismissed"}: ${title}`,
    );
    const resolved = verb === "Complete" ? "completed" : "dismissed";
    expect(stored(served, id).state).toBe(resolved);
    expect(verbs(sent)).toEqual([verb.toLowerCase()]);
    await page.unroute(`**/api/human-items/${id}/${verb.toLowerCase()}`);
    // The stream catches up, the card stays gone, and a reload shows the same.
    await page.waitForTimeout(1_000);
    await expect(card(page, title)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("article").first()).toBeVisible();
    await expect(card(page, title)).toHaveCount(0);
    expect(stored(served, id).state).toBe(resolved);
    // Nothing said, at any point, that the item could not be read.
    expect(await alerts()).toEqual([]);
  });

test("the toast leaves after its duration, stays while hovered or focused, and leaves once that ends", async ({
  page,
}) => {
  await page.clock.install();
  const served = await serveWorld("queue");
  await open(page, served);
  // From here the page's time moves only when this journey moves it, so no wait
  // below can stand in for the toast's own duration.
  await page.clock.pauseAt(Date.now() + 1_000);
  const complete = async (title: string) => {
    await page.getByRole("button", { name: `Complete: ${title}` }).click();
    await expect(outcome(page)).toHaveText(`Completed: ${title}`);
  };

  // Left alone, it shows for its duration and then leaves.
  await complete("Restore the build service");
  await page.clock.runFor((TOAST_SECONDS - 1) * 1_000);
  await expect(toast(page)).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(toast(page)).toHaveCount(0);

  // Hovered, it stays past its duration, and leaves when the pointer does.
  await complete("Rotate the deploy credentials");
  await toast(page).hover();
  await page.clock.runFor((TOAST_SECONDS + 5) * 1_000);
  await expect(toast(page)).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(toast(page)).toHaveCount(0);

  // Focused, the same, and it leaves when focus does.
  await complete("Review the action-items design");
  await toast(page).getByRole("button", { name: "Close" }).focus();
  await page.clock.runFor((TOAST_SECONDS + 5) * 1_000);
  await expect(toast(page)).toBeVisible();
  await answerBox(page, LAST_QUESTION).focus();
  await expect(toast(page)).toHaveCount(0);

  // A receipt slow to come: what it says is shown for the whole duration from
  // when it lands, however long the toast had already been up.
  const slow = "Review the dashboard layout";
  const dashboard = idOf(served, "dashboard");
  const release = await holdRequests(
    page,
    `/api/human-items/${dashboard}/dismiss`,
  );
  await page.getByRole("button", { name: `Dismiss: ${slow}` }).click();
  await expect(outcome(page)).toHaveText(`Dismissing: ${slow}…`);
  await page.clock.runFor(10_000);
  release();
  await expect(outcome(page)).toHaveText(`Dismissed: ${slow}`);
  await page.clock.runFor((TOAST_SECONDS - 1) * 1_000);
  await expect(toast(page)).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(toast(page)).toHaveCount(0);
  await page.unroute(`**/api/human-items/${dashboard}/dismiss`);

  // A refusal slow to come, the same: red for the whole duration once it lands.
  const refused = "Keep the legacy export format?";
  const exportId = idOf(served, "export");
  const releaseRefusal = await holdRequests(
    page,
    `/api/human-items/${exportId}/dismiss`,
  );
  await page.getByRole("button", { name: `Dismiss: ${refused}` }).click();
  await page.clock.runFor(10_000);
  await served.stopServing();
  releaseRefusal();
  await expect(toast(page)).toHaveAttribute("data-tone", "failure");
  await page.clock.runFor((TOAST_SECONDS - 1) * 1_000);
  await expect(toast(page)).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(toast(page)).toHaveCount(0);
});

for (const width of [1440, 390] as const)
  test(`at ${width} wide the toast sits where it should, stands out in green or red, and leaves room to reach every card`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const served = await serveWorld("queue");
    await open(page, served);
    await page
      .getByRole("button", { name: "Complete: Restore the build service" })
      .click();
    await expect(outcome(page)).toHaveText(
      "Completed: Restore the build service",
    );
    const placed = await box(toast(page));
    if (width === 1440) {
      // Anchored bottom right, under half the width.
      expect(Math.abs(placed.x + placed.width - width)).toBeLessThanOrEqual(24);
      expect(placed.width).toBeLessThan(width / 2);
    } else {
      // Across the bottom.
      expect(placed.x).toBeLessThanOrEqual(1);
      expect(placed.width).toBeGreaterThanOrEqual(width - 1);
    }
    expect(placed.y + placed.height).toBeGreaterThanOrEqual(
      (page.viewportSize()?.height ?? 0) - 24,
    );
    const success = await backgroundOf(toast(page));
    expect(success.g).toBeGreaterThan(success.r);
    expect(success.g).toBeGreaterThan(success.b);

    // With the toast showing, the last card scrolls clear of it, actions and all.
    const list = listRegion(page);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const last = list.getByRole("article").last();
    for (const action of await last.getByRole("button").all()) {
      const at = await box(action);
      expect(at.y + at.height).toBeLessThanOrEqual(placed.y);
    }

    // A failure turns it red.
    await served.stopServing();
    await page
      .getByRole("button", { name: "Complete: Rotate the deploy credentials" })
      .click();
    await expect(toast(page)).toHaveAttribute("data-tone", "failure");
    const failure = await backgroundOf(toast(page));
    expect(failure.r).toBeGreaterThan(failure.g);
    expect(failure.r).toBeGreaterThan(failure.b);
    // The card it was about comes back, with its reason and its actions above
    // the toast.
    const returned = card(page, "Rotate the deploy credentials");
    await expect(returned.getByRole("alert")).toHaveText(
      "Telemetry request failed",
    );
    const top = (await box(toast(page))).y;
    for (const part of [
      returned.getByRole("alert"),
      ...(await returned.getByRole("button").all()),
    ]) {
      const at = await box(part);
      expect(at.y + at.height).toBeLessThanOrEqual(top);
    }
  });

test("Restore and Reopen after the receipt bring the card back, and a reason or comment is saved", async ({
  page,
}) => {
  const served = await serveWorld("undo");
  await open(page, served);
  watch(served, SUPERVISOR);
  const sent = writes(page);
  const restore = "Rotate the staging certificate";
  const reopen = "File the flaky-runner report";

  await page.getByRole("button", { name: `Dismiss: ${restore}` }).click();
  await expect(outcome(page)).toHaveText(`Dismissed: ${restore}`);
  await toast(page).getByRole("button", { name: "Restore" }).click();
  await expect(outcome(page)).toHaveText(`Restored: ${restore}`);
  await expect(card(page, restore)).toBeVisible();
  expect(stored(served, idOf(served, "certificate"))).toMatchObject({
    state: "open",
    resolution: null,
  });

  await page.getByRole("button", { name: `Complete: ${reopen}` }).click();
  await expect(outcome(page)).toHaveText(`Completed: ${reopen}`);
  await toast(page).getByRole("button", { name: "Reopen" }).click();
  await expect(outcome(page)).toHaveText(`Reopened: ${reopen}`);
  await expect(card(page, reopen)).toBeVisible();
  expect(stored(served, idOf(served, "plain")).state).toBe("open");

  // A reason after Dismiss, a comment after Complete.
  await page.getByRole("button", { name: `Dismiss: ${restore}` }).click();
  await expect(outcome(page)).toHaveText(`Dismissed: ${restore}`);
  await toast(page).getByRole("button", { name: "Add reason" }).click();
  await toast(page)
    .getByRole("textbox", { name: "Reason" })
    .fill("Rotated with the production one");
  await toast(page).getByRole("textbox", { name: "Reason" }).press("Enter");
  await expect(outcome(page)).toHaveText(`Reason saved: ${restore}`);
  await page.getByRole("button", { name: `Complete: ${reopen}` }).click();
  await expect(outcome(page)).toHaveText(`Completed: ${reopen}`);
  await toast(page).getByRole("button", { name: "Add comment" }).click();
  await toast(page)
    .getByRole("textbox", { name: "Comment" })
    .fill("Filed as INFRA-212");
  await toast(page).getByRole("button", { name: "Send" }).click();
  await expect(outcome(page)).toHaveText(`Comment saved: ${reopen}`);

  const certificate = idOf(served, "certificate");
  const plain = idOf(served, "plain");
  expect(stored(served, certificate)).toMatchObject({
    state: "dismissed",
    resolution: {
      actor: `browser:session:${SUPERVISOR}`,
      reason: "Rotated with the production one",
    },
  });
  expect(stored(served, plain)).toMatchObject({
    state: "completed",
    resolution: {
      actor: `browser:session:${SUPERVISOR}`,
      text: "Filed as INFRA-212",
    },
  });
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-dismissed", certificate],
    ["human-item-reopened", certificate],
    ["human-item-completed", plain],
    ["human-item-reopened", plain],
    ["human-item-dismissed", certificate],
    ["human-item-noted", certificate],
    ["human-item-completed", plain],
    ["human-item-noted", plain],
  ]);
  expect(verbs(sent)).toEqual([
    "dismiss",
    "reopen",
    "complete",
    "reopen",
    "dismiss",
    "note",
    "complete",
    "note",
  ]);
});

for (const { verb, undo, key, title } of [
  {
    verb: "Dismiss",
    undo: "Restore",
    key: "certificate",
    title: "Rotate the staging certificate",
  },
  {
    verb: "Complete",
    undo: "Reopen",
    key: "plain",
    title: "File the flaky-runner report",
  },
] as const)
  test(`${undo} pressed before ${verb}'s receipt is sent after it, in order`, async ({
    page,
  }) => {
    const served = await serveWorld("undo");
    await open(page, served);
    watch(served, SUPERVISOR);
    const sent = writes(page);
    const id = idOf(served, key);
    const release = await holdRequests(
      page,
      `/api/human-items/${id}/${verb.toLowerCase()}`,
    );
    await page.getByRole("button", { name: `${verb}: ${title}` }).click();
    await expect(toast(page)).toHaveAttribute("data-phase", "sending");
    await toast(page).getByRole("button", { name: undo }).click();
    // However long the receipt takes, the undo waits behind it.
    await page.waitForTimeout(1_000);
    expect(verbs(sent)).toEqual([verb.toLowerCase()]);
    expect(stored(served, id).state).toBe("open");
    release();
    await expect(outcome(page)).toHaveText(
      `${undo === "Restore" ? "Restored" : "Reopened"}: ${title}`,
    );
    expect(verbs(sent)).toEqual([verb.toLowerCase(), "reopen"]);
    expect(watch(served, SUPERVISOR)).toEqual([
      [`human-item-${verb === "Dismiss" ? "dismissed" : "completed"}`, id],
      ["human-item-reopened", id],
    ]);
    expect(stored(served, id)).toMatchObject({
      state: "open",
      resolution: null,
    });
    await expect(card(page, title)).toBeVisible();
  });

for (const failure of ["the server stopped", "the engine refused"] as const)
  test(`a write that fails because ${failure} leaves the item as it was and says why`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    const served = await serveWorld("undo");
    await open(page, served);
    const fail = async (): Promise<() => Promise<void>> => {
      if (failure === "the server stopped") {
        await served.stopServing();
        return () => served.serveRebuilt();
      }
      const restore = breakJournal(served);
      return async () => restore();
    };

    // A failed Complete and a failed Dismiss: the item stays open, its card is
    // back in its place with the reason, clear of the toast.
    for (const [verb, key, title] of [
      ["Complete", "plain", "File the flaky-runner report"],
      ["Dismiss", "certificate", "Rotate the staging certificate"],
    ] as const) {
      const order = await titles(listRegion(page));
      const recover = await fail();
      await card(page, title)
        .getByRole("button", { name: `${verb}: ${title}` })
        .click();
      await expect(toast(page)).toHaveAttribute("data-tone", "failure");
      const reason = card(page, title).getByRole("alert");
      await expect(reason).toBeVisible();
      await expect(outcome(page)).toContainText(
        (await reason.textContent()) ?? "",
      );
      expect(await titles(listRegion(page))).toEqual(order);
      const top = (await box(toast(page))).y;
      for (const part of [
        reason,
        ...(await card(page, title).getByRole("button").all()),
      ]) {
        await expect(part).toBeInViewport();
        const at = await box(part);
        expect(at.y + at.height).toBeLessThanOrEqual(top);
      }
      await recover();
      expect(stored(served, idOf(served, key)).state).toBe("open");
      await toast(page).getByRole("button", { name: "Close" }).click();
    }

    // A failed Restore, Reopen and note: the item stays resolved as it was, no
    // card returns, and the toast stays — past its duration — with the reason
    // and the words typed, until it is sent again once the server is back.
    for (const [verb, follow, key, title] of [
      ["Dismiss", "Restore", "certificate", "Rotate the staging certificate"],
      ["Complete", "Reopen", "plain", "File the flaky-runner report"],
      ["Complete", "Add comment", "design", "Review the action-items design"],
    ] as const) {
      await card(page, title)
        .getByRole("button", { name: `${verb}: ${title}` })
        .click();
      await expect(outcome(page)).toHaveText(
        `${verb === "Dismiss" ? "Dismissed" : "Completed"}: ${title}`,
      );
      const before = stored(served, idOf(served, key));
      const recover = await fail();
      if (follow === "Add comment") {
        await toast(page).getByRole("button", { name: follow }).click();
        await toast(page)
          .getByRole("textbox", { name: "Comment" })
          .fill("Looks right on a phone too");
        await toast(page).getByRole("button", { name: "Send" }).click();
      } else await toast(page).getByRole("button", { name: follow }).click();
      await expect(toast(page)).toHaveAttribute("data-tone", "failure");
      await expect(toast(page)).toHaveAttribute("data-phase", "failed");
      // Nothing holds it — no pointer, no focus — and still it stays.
      await page.mouse.move(1, 1);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
      });
      await page.clock.runFor((TOAST_SECONDS + 5) * 1_000);
      await expect(toast(page)).toBeVisible();
      await expect(outcome(page)).toContainText(/\S/u);
      if (follow === "Add comment")
        await expect(
          toast(page).getByRole("textbox", { name: "Comment" }),
        ).toHaveValue("Looks right on a phone too");
      await expect(card(page, title)).toHaveCount(0);
      await recover();
      expect(stored(served, idOf(served, key))).toEqual(before);
      // Sent again once the server is back, it goes through.
      await toast(page)
        .getByRole("button", {
          name: follow === "Add comment" ? "Send again" : follow,
        })
        .click();
      await expect(toast(page)).toHaveAttribute("data-tone", "success");
      if (follow === "Add comment") {
        await expect(outcome(page)).toHaveText(`Comment saved: ${title}`);
        expect(stored(served, idOf(served, key)).resolution?.text).toBe(
          "Looks right on a phone too",
        );
      } else {
        await expect(card(page, title)).toBeVisible();
        expect(stored(served, idOf(served, key)).state).toBe("open");
      }
    }
  });

test("Reopen says why it cannot be offered, by hover and by its question mark, and an undo runs through the approval authority", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const served = await serveWorld("undo");
  await open(page, served);
  const unavailable = toast(page).getByRole("group", {
    name: /\(unavailable\)$/u,
  });
  const why = (label: string) =>
    toast(page).getByRole("button", { name: `Why ${label} is unavailable` });
  const tip = toast(page).getByRole("tooltip");

  for (const [verb, label, key, title] of [
    // A design review whose approval authority declares no undo.
    ["Complete", "Reopen", "final", "Approve the final release notes"],
    // A run's human step, completed and dismissed.
    ["Complete", "Reopen", "step", "Sign off the release notes"],
  ] as const) {
    await page.getByRole("button", { name: `${verb}: ${title}` }).click();
    await expect(outcome(page)).toHaveText(`Completed: ${title}`);
    const { reopen } = z
      .object({
        reopen: z.object({ available: z.boolean(), reason: z.string() }),
      })
      .parse(
        JSON.parse(
          cli(served, ["human-items", "show", idOf(served, key), "--json"]),
        ),
      );
    expect(reopen.available).toBe(false);
    await expect(
      toast(page).getByRole("button", { name: label, exact: true }),
    ).toBeDisabled();
    // On hover the engine's reason shows.
    await expect(tip).toBeHidden();
    await unavailable.hover();
    await expect(tip).toHaveText(reopen.reason);
    await page.mouse.move(1, 1);
    await expect(tip).toBeHidden();
    // And on a press of the question mark, which a phone has.
    await why(label).click();
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(reopen.reason);
    await expect(why(label)).toHaveAttribute("aria-expanded", "true");
    // The mark sits within the greyed control, is at least 24 px square, and
    // keeps clear of Add comment beside it.
    const control = await box(unavailable);
    const mark = await box(why(label));
    expect(mark.x).toBeGreaterThanOrEqual(control.x);
    expect(mark.y).toBeGreaterThanOrEqual(control.y);
    expect(mark.x + mark.width).toBeLessThanOrEqual(control.x + control.width);
    expect(mark.y + mark.height).toBeLessThanOrEqual(
      control.y + control.height,
    );
    expect(mark.width).toBeGreaterThanOrEqual(24);
    expect(mark.height).toBeGreaterThanOrEqual(24);
    const comment = await box(
      toast(page).getByRole("button", { name: "Add comment" }),
    );
    const overlaps =
      mark.x < comment.x + comment.width &&
      comment.x < mark.x + mark.width &&
      mark.y < comment.y + comment.height &&
      comment.y < mark.y + mark.height;
    expect(overlaps).toBe(false);
    await toast(page).getByRole("button", { name: "Close" }).click();
  }

  // A plain task's Reopen is offered.
  await page
    .getByRole("button", { name: "Complete: File the flaky-runner report" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Completed: File the flaky-runner report",
  );
  await expect(
    toast(page).getByRole("button", { name: "Reopen", exact: true }),
  ).toBeEnabled();
  await expect(unavailable).toHaveCount(0);
  await toast(page).getByRole("button", { name: "Close" }).click();

  // A design review whose authority declares an undo: Reopen runs it, and the
  // approval it recorded is gone; an undo with nothing to take back refuses,
  // in the script's own words, and the task stays completed.
  const design = "Review the action-items design";
  const designId = idOf(served, "design");
  // The authority's records of this review alone; the other review shares the log.
  const recorded = () =>
    approvals(served).filter(
      ({ board_copy }) => board_copy === "docs/design/action-items.md",
    );
  await page.getByRole("button", { name: `Complete: ${design}` }).click();
  await expect(outcome(page)).toHaveText(`Completed: ${design}`);
  expect(recorded()).toHaveLength(1);
  await toast(page)
    .getByRole("button", { name: "Reopen", exact: true })
    .click();
  await expect(outcome(page)).toHaveText(`Reopened: ${design}`);
  expect(recorded()).toEqual([]);
  expect(stored(served, designId).state).toBe("open");
  await card(page, design)
    .getByRole("button", { name: `Complete: ${design}` })
    .click();
  await expect(outcome(page)).toHaveText(`Completed: ${design}`);
  expect(recorded()).toHaveLength(1);
  writeFileSync(factsOf(served).approvals, "");
  await toast(page)
    .getByRole("button", { name: "Reopen", exact: true })
    .click();
  await expect(toast(page)).toHaveAttribute("data-tone", "failure");
  await expect(outcome(page)).toContainText("nothing to take back");
  expect(stored(served, designId).state).toBe("completed");
});

test("Restore follows the same rule: a dismissed human step says why it cannot be restored", async ({
  page,
}) => {
  const served = await serveWorld("undo");
  await open(page, served);
  await page
    .getByRole("button", { name: "Dismiss: Sign off the release notes" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Dismissed: Sign off the release notes",
  );
  await expect(
    toast(page).getByRole("button", { name: "Restore", exact: true }),
  ).toBeDisabled();
  await toast(page)
    .getByRole("button", { name: "Why Restore is unavailable" })
    .click();
  await expect(toast(page).getByRole("tooltip")).toContainText("human step");
  expect(stored(served, idOf(served, "step")).state).toBe("dismissed");
});

test("a press in the browser is recorded as the browser's, beside the same action through the CLI", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  await page
    .getByRole("button", { name: "Complete: Restore the build service" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Completed: Restore the build service",
  );
  cli(served, ["human-items", "complete", idOf(served, "other")], SUPERVISOR);
  const show = (key: string) =>
    z
      .object({
        item: z.object({
          resolution: z.object({
            actor: z.string(),
            on_behalf_of: z.string().nullable(),
          }),
        }),
      })
      .parse(
        JSON.parse(
          cli(served, ["human-items", "show", idOf(served, key), "--json"]),
        ),
      ).item.resolution;
  expect(show("build")).toEqual({
    actor: `browser:session:${SUPERVISOR}`,
    on_behalf_of: null,
  });
  expect(show("other").actor).toBe(`session:${SUPERVISOR}`);

  // A server that acts as no session records the press as the browser's alone.
  await actAs(served, "");
  await page.reload();
  await page
    .getByRole("button", { name: "Dismiss: Keep the legacy export format?" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Dismissed: Keep the legacy export format?",
  );
  expect(show("export")).toEqual({ actor: "browser", on_behalf_of: null });
});

test("a task's markdown renders through the shared package on card, in detail and on the node timeline, and nothing in it runs or fetches", async ({
  page,
}) => {
  const served = await serveWorld("markdown");
  const images: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith("example.org"))
      images.push(request.url());
  });
  const title = "Publish the release notes";
  await open(page, served);
  // The app's own font-synthesis is what bold has to show through.
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSynthesis,
    ),
  ).toBe("none");

  const shown = card(page, title);
  await expect(shown).toHaveClass(/\botg-card\b/u);
  await expect(shown).toHaveAttribute(
    "aria-labelledby",
    (await shown.getByRole("heading", { name: title }).getAttribute("id")) ??
      "missing",
  );
  const surfaces: [string, Locator][] = [["card", shown]];
  await shown.getByRole("button", { name: `Details: ${title}` }).click();
  surfaces.push([
    "detail",
    detailPane(page).getByRole("region", { name: "Full body" }),
  ]);
  await expect(surfaces[1]?.[1] ?? shown).toBeVisible();
  const check = async (where: string, root: Locator, visible: boolean) => {
    // llmlint: ignore[e2e_uses_accessible_selectors] what is asserted is that the body is the shared package's rendering, which only the package's own `otg-` class names; no role or name tells one markdown renderer from another.
    const body = root.locator(".otg-markdown").first();
    await expect(body, where).toBeAttached();
    for (const [name, href] of [
      ["release checklist", "https://example.org/checklist"],
      ["https://example.org/runbook", "https://example.org/runbook"],
      // An image is never fetched: it is a link to its source.
      ["the rollout diagram", "https://images.example.org/diagram.png"],
    ] as const) {
      // A card's clamp hides what lies past its last lines; it is still there.
      const links = body.getByRole("link", {
        name,
        exact: true,
        includeHidden: !visible,
      });
      await expect(links.first(), `${where}: ${name}`).toBeAttached();
      for (const link of await links.all()) {
        await expect(link, `${where}: ${name}`).toHaveAttribute("href", href);
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        await expect(link).toHaveAttribute("target", "_blank");
      }
    }
    await expect(
      body.getByRole("table", { includeHidden: !visible }).first(),
      where,
    ).toBeAttached();
    const strong = body
      .getByText("Ship the reviewed release", { exact: true })
      .first();
    expect(
      await strong.evaluate((element) =>
        Number(getComputedStyle(element).fontWeight),
      ),
      where,
    ).toBeGreaterThanOrEqual(700);
    // Raw HTML is text, never markup; a `javascript:` link is no link.
    // llmlint: ignore[e2e_uses_accessible_selectors] the property is that no script element, image or `onerror` attribute exists in the DOM at all; none of the three has a role a locator could ask for, so the elements and attribute are named as such.
    await expect(body.locator("script, img, [onerror]"), where).toHaveCount(0);
    await expect(
      body.getByRole("link", { name: "Run the cleanup" }),
      where,
    ).toHaveCount(0);
    await expect(
      body.getByText(/<script>window\.__otgScript/u).first(),
    ).toBeAttached();
    if (!visible) return;
    // Bold is visibly bold: the same words in cells of one size differ.
    const cells = body
      .getByRole("table")
      .first()
      .getByRole("cell", { name: "Ship it", exact: true });
    await expect(cells).toHaveCount(2);
    const regular = await cells.nth(0).screenshot();
    const bold = await cells.nth(1).screenshot();
    expect(Buffer.compare(regular, bold), where).not.toBe(0);
  };
  await check("card", shown, false);
  await check("detail", surfaces[1]?.[1] ?? shown, true);

  // The tracker link on the card and in detail is the shared package's too.
  const { name, url } = trackerOf(served, idOf(served, "notes"));
  for (const [where, link] of [
    ["card", shown.getByRole("link", { name, exact: true })],
    ["detail", detailPane(page).getByRole("link", { name, exact: true })],
  ] as const) {
    await expect(link, where).toHaveClass(/\botg-source-link\b/u);
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  const cardLink = shown.getByRole("link", { name, exact: true });
  await expect(cardLink).toHaveAttribute("tabindex", "-1");
  await expect(cardLink).toHaveAttribute("data-card-action", "");

  // The node timeline's task prose and acceptance criteria, the same way.
  const run = factsOf(served).runs.a ?? "";
  for (const [tab, panel] of [
    ["task", "Task"],
    ["criteria", "Acceptance criteria"],
  ] as const) {
    await page.goto(
      `${served.origin}/?run=${encodeURIComponent(run)}&node=notes&tab=${tab}`,
    );
    const root = page.getByRole("tabpanel", { name: panel });
    await expect(root.getByRole("paragraph").first()).toBeVisible();
    await check(`timeline ${tab}`, root, true);
  }
  // The criteria tab shows the section, not the prose above its heading.
  await expect(
    page
      .getByRole("tabpanel", { name: "Acceptance criteria" })
      .getByText("Acceptance criteria", { exact: true }),
  ).toHaveCount(0);

  expect(
    await page.evaluate(() => ({
      script: Reflect.get(window, "__otgScript"),
      onerror: Reflect.get(window, "__otgOnerror"),
      link: Reflect.get(window, "__otgLink"),
    })),
  ).toEqual({ script: undefined, onerror: undefined, link: undefined });
  expect(images).toEqual([]);
});

/** Whether `inner` lies wholly inside `outer`, to a pixel. */
function inside(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
) {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return (
    a.x < b.x + b.width - 0.5 &&
    b.x < a.x + a.width - 0.5 &&
    a.y < b.y + b.height - 0.5 &&
    b.y < a.y + a.height - 0.5
  );
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`at ${width} wide long realistic items stay inside their cards, with badges and actions in their places`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const served = await serveWorld("realistic");
    const list = await open(page, served);
    const cards = list.getByRole("article");
    await expect(cards).toHaveCount(6);
    const main = await box(listRegion(page));
    const actionRows: { edge: number }[] = [];
    for (const shown of await cards.all()) {
      await shown.scrollIntoViewIfNeeded();
      const outer = await box(shown);
      if (width === 390)
        // The card has the main area's width: no navigation column beside it.
        expect(outer.width).toBeGreaterThan(main.width - 24);
      // Nothing of the card — title, source, body, a long URL — leaves it: what
      // shows of each part, after whatever clips it inside the card.
      // llmlint: ignore[e2e_uses_accessible_selectors] "nothing leaves its card" is a property of every rendered box inside it, text runs and inline code included, most of which carry no role; the walk reads each one's geometry, never selects by a class.
      const parts = await shown.evaluate((card) =>
        [...card.querySelectorAll("*")].flatMap((part) => {
          if (part.getClientRects().length === 0) return [];
          let { left, top, right, bottom } = part.getBoundingClientRect();
          for (
            let clip = part.parentElement;
            clip !== null && clip !== card;
            clip = clip.parentElement
          ) {
            const style = getComputedStyle(clip);
            if (style.overflowX === "visible" && style.overflowY === "visible")
              continue;
            const edge = clip.getBoundingClientRect();
            left = Math.max(left, edge.left);
            top = Math.max(top, edge.top);
            right = Math.min(right, edge.right);
            bottom = Math.min(bottom, edge.bottom);
          }
          if (right <= left || bottom <= top) return [];
          return [
            {
              what: `${part.tagName} ${(part.textContent ?? "").slice(0, 40)}`,
              x: left,
              y: top,
              width: right - left,
              height: bottom - top,
            },
          ];
        }),
      );
      for (const part of parts)
        expect(inside(part, outer), part.what).toBe(true);
      // Badges share one row, and so do actions, each never over another.
      const badges = await shown
        .getByText(/^(Critical|High|Medium|Low|Task|Question|Blocking)$/u)
        .evaluateAll((all) =>
          all.map((b) => b.getBoundingClientRect().toJSON()),
        );
      expect(badges.length).toBeGreaterThan(0);
      expect(new Set(badges.map(({ top }) => Math.round(top))).size).toBe(1);
      const actions = await shown
        .getByRole("button")
        .evaluateAll((all) =>
          all.map((a) => a.getBoundingClientRect().toJSON()),
        );
      expect(actions.length).toBeGreaterThan(0);
      for (const [index, action] of actions.entries()) {
        for (const other of actions.slice(index + 1))
          expect(overlap(action, other)).toBe(false);
        for (const badge of badges) expect(overlap(action, badge)).toBe(false);
        if (width === 390) expect(action.height).toBeGreaterThanOrEqual(44);
      }
      const last = actions.at(-1);
      if (last)
        actionRows.push({
          // Right-aligned beside the title on a wide screen; a row of their own,
          // starting at the card's left, on a phone.
          edge: width === 390 ? (actions[0]?.left ?? 0) : last.right,
        });
      if (width === 390) {
        // On a phone the actions have a row of their own, below the title.
        const title = await box(shown.getByRole("heading", { level: 3 }));
        for (const action of actions)
          expect(action.top).toBeGreaterThanOrEqual(title.y + title.height - 1);
      }
    }
    // Every card's actions line up on one edge.
    expect(
      new Set(actionRows.map(({ edge }) => Math.round(edge / 2))).size,
    ).toBe(1);

    // The toast's actions on a phone are as tall, and overlap nothing.
    await page
      .getByRole("button", { name: /^Complete: Rotate PYPI_TOKEN/u })
      .click();
    await expect(toast(page)).toHaveAttribute("data-phase", "done");
    const toastActions = await toast(page)
      .getByRole("button")
      .evaluateAll((all) => all.map((a) => a.getBoundingClientRect().toJSON()));
    for (const [index, action] of toastActions.entries()) {
      if (width === 390) expect(action.height).toBeGreaterThanOrEqual(44);
      for (const other of toastActions.slice(index + 1))
        expect(overlap(action, other)).toBe(false);
    }
  });

test("the list groups by a remembered field, Priority first, with headings, counts and no repeated badge", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served, { groupBy: null });
  const headings = list.getByRole("heading", { level: 2 });
  const groupBy = page.getByRole("combobox", { name: "Group by" });
  await expect(groupBy).toHaveValue("priority");
  const expected = {
    priority: ["Critical (3)", "High (3)", "Low (1)"],
    kind: ["Task (4)", "Question (3)"],
    blocking: ["Blocking (3)", "Not blocking (4)"],
    source: [
      "Source: host (1)",
      "Source: plan board:plan-a / run plan-a (2)",
      "Source: plan board:plan-b (2)",
      `Source: session ${SUPERVISOR} (1)`,
      `Source: session ${OTHER} (1)`,
    ],
  } as const;
  // Each field as a card says it: inside the cards, never the headings.
  const cards = list.getByRole("article");
  const badge = {
    priority: () => cards.getByText(/^(Critical|High|Medium|Low)$/u),
    kind: () => cards.getByText(/^(Task|Question)$/u),
    blocking: () => cards.getByText("Blocking", { exact: true }),
    source: () => cards.getByText(/^Source: /u),
  } as const;
  for (const field of ["priority", "kind", "blocking", "source"] as const) {
    await groupBy.selectOption(field);
    await expect(headings).toHaveText([...expected[field]]);
    // The field the list is grouped by is said once, by its heading.
    await expect(badge[field]()).toHaveCount(0);
    // Every card is still there, each under the heading it belongs to.
    await expect(list.getByRole("article")).toHaveCount(DECLARED.length);
  }
  // Grouped by Priority, each card sits under its own priority's heading.
  await groupBy.selectOption("priority");
  for (const { title, priority } of DECLARED)
    await expect(
      list
        .getByRole("region", { name: new RegExp(`^${priority} `, "u") })
        .getByRole("article", { name: title }),
    ).toHaveCount(1);
  // None is one flat list in the engine's order, every badge back.
  await groupBy.selectOption("none");
  await expect(headings).toHaveCount(0);
  expect(await titles(list)).toEqual(DECLARED.map(({ title }) => title));
  await expect(badge.priority()).toHaveCount(DECLARED.length);
  // The choice is this browser's, and survives a reload.
  await groupBy.selectOption("kind");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Group by" })).toHaveValue(
    "kind",
  );
  await expect(headings).toHaveText([...expected.kind]);
});

test("at phone width the filters and Group by fold behind Filters, which counts what changed and still narrows the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const served = await serveWorld("queue");
  const list = await open(page, served, { groupBy: null });
  const toggle = page.getByRole("button", { name: /^Filters/u });
  const groupBy = page.getByRole("combobox", { name: "Group by" });
  const kind = page.getByRole("combobox", { name: "Kind", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Filters");
  await expect(groupBy).toBeHidden();
  await expect(kind).toBeHidden();
  // Folded, the list starts right under the button.
  const below = await box(toggle);
  const first = await box(list.getByRole("article").first());
  expect(first.y - (below.y + below.height)).toBeLessThan(60);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(groupBy).toBeVisible();
  await kind.selectOption("question");
  await expect
    .poll(() => titles(list))
    .toEqual(
      // Grouped by priority: Critical, High, Low.
      [
        LAST_QUESTION,
        "Which region should the canary run in?",
        "Keep the legacy export format?",
      ],
    );
  await groupBy.selectOption("none");
  await expect(toggle).toHaveAccessibleName("Filters, 2 changed");
  await toggle.click();
  await expect(kind).toBeHidden();
  await expect(toggle).toHaveAccessibleName("Filters, 2 changed");
  await expect(list.getByRole("article")).toHaveCount(QUESTIONS.length);
});

test("what is asked of a toast before its receipt waits for it, and is dropped when the receipt refuses it or never comes", async ({
  page,
}) => {
  const served = await serveWorld("undo");
  await open(page, served);
  watch(served, SUPERVISOR);
  const sent = writes(page);

  // Reopen pressed before a receipt that says it cannot be: nothing is sent,
  // and Reopen shows why.
  const final = "Approve the final release notes";
  const finalId = idOf(served, "final");
  const releaseFinal = await holdRequests(
    page,
    `/api/human-items/${finalId}/complete`,
  );
  await page.getByRole("button", { name: `Complete: ${final}` }).click();
  await toast(page).getByRole("button", { name: "Reopen" }).click();
  releaseFinal();
  await expect(outcome(page)).toHaveText(`Completed: ${final}`);
  await expect(
    toast(page).getByRole("button", { name: "Reopen", exact: true }),
  ).toBeDisabled();
  await toast(page)
    .getByRole("button", { name: "Why Reopen is unavailable" })
    .click();
  await expect(toast(page).getByRole("tooltip")).toContainText(
    "declares no undo",
  );
  expect(verbs(sent)).toEqual(["complete"]);
  expect(stored(served, finalId).state).toBe("completed");

  // Reopen pressed before a write that then fails: nothing is taken back, and
  // the card returns with the reason.
  const plain = "File the flaky-runner report";
  const plainId = idOf(served, "plain");
  // The write is held on its way, the server stops, and then the write goes on
  // to a server that is no longer there.
  const releasePlain = await holdRequests(
    page,
    `/api/human-items/${plainId}/complete`,
  );
  await page.getByRole("button", { name: `Complete: ${plain}` }).click();
  await toast(page).getByRole("button", { name: "Reopen" }).click();
  await served.stopServing();
  releasePlain();
  await expect(toast(page)).toHaveAttribute("data-tone", "failure");
  await expect(card(page, plain).getByRole("alert")).toHaveText(
    "Telemetry request failed",
  );
  await page.waitForTimeout(500);
  expect(verbs(sent)).toEqual(["complete", "complete"]);
  await page.unroute(`**/api/human-items/${plainId}/complete`);
  await served.serveRebuilt();
  expect(stored(served, plainId).state).toBe("open");

  // A reason written and sent before Dismiss's receipt goes after it.
  const certificate = "Rotate the staging certificate";
  const certificateId = idOf(served, "certificate");
  const releaseDismiss = await holdRequests(
    page,
    `/api/human-items/${certificateId}/dismiss`,
  );
  await page.getByRole("button", { name: `Dismiss: ${certificate}` }).click();
  await toast(page).getByRole("button", { name: "Add reason" }).click();
  await toast(page)
    .getByRole("textbox", { name: "Reason" })
    .fill("Rotated with production");
  await toast(page).getByRole("textbox", { name: "Reason" }).press("Enter");
  await page.waitForTimeout(500);
  expect(verbs(sent)).toEqual(["complete", "complete", "dismiss"]);
  releaseDismiss();
  await expect(outcome(page)).toHaveText(`Reason saved: ${certificate}`);
  expect(verbs(sent)).toEqual(["complete", "complete", "dismiss", "note"]);
  expect(stored(served, certificateId).resolution?.reason).toBe(
    "Rotated with production",
  );
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-completed", finalId],
    ["human-item-dismissed", certificateId],
    ["human-item-noted", certificateId],
  ]);
});

test("a grouping this page does not know, or storage the browser refuses, groups by Priority and still groups as chosen", async ({
  browser,
}) => {
  const served = await serveWorld("queue");
  const headings = (page: Page) =>
    listRegion(page).getByRole("heading", { level: 2 });

  // A choice another release of the page remembered, which this one does not
  // offer, is no choice: the list groups by Priority.
  const remembered = await browser.newContext();
  await remembered.addInitScript(() =>
    window.localStorage.setItem(
      "onepipeline-ui.human-items.group-by",
      "assignee",
    ),
  );
  const first = await remembered.newPage();
  await open(first, served, { groupBy: null });
  await expect(first.getByRole("combobox", { name: "Group by" })).toHaveValue(
    "priority",
  );
  await expect(headings(first)).toHaveText([
    "Critical (3)",
    "High (3)",
    "Low (1)",
  ]);
  await remembered.close();

  // A browser that refuses this page its storage — as one blocking site data
  // does, throwing on every access — still groups this visit as asked.
  const refusing = await browser.newContext();
  // llmlint: ignore[e2e_not_mocked] the browser is the environment here, not the layer under test: Chromium refuses a page its storage only under a profile content setting or an opaque origin this harness cannot give a page served by the real read API, so the access is made to throw the SecurityError such a browser throws; the bundle, the server and the engine journal stay real.
  await refusing.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  const second = await refusing.newPage();
  await open(second, served, { groupBy: null });
  await expect(headings(second)).toHaveText([
    "Critical (3)",
    "High (3)",
    "Low (1)",
  ]);
  await second.getByRole("combobox", { name: "Group by" }).selectOption("kind");
  await expect(headings(second)).toHaveText(["Task (4)", "Question (3)"]);
  await refusing.close();
});

test("a new write's toast starts afresh, with no editor open and nothing typed from the last", async ({
  page,
}) => {
  const served = await serveWorld("undo");
  await open(page, served);
  const certificate = "Rotate the staging certificate";
  await page.getByRole("button", { name: `Dismiss: ${certificate}` }).click();
  await expect(outcome(page)).toHaveText(`Dismissed: ${certificate}`);
  await toast(page).getByRole("button", { name: "Add reason" }).click();
  await toast(page)
    .getByRole("textbox", { name: "Reason" })
    .fill("half a thought");
  // Another write while the reason is half written: its toast replaces this one.
  const plain = "File the flaky-runner report";
  await page.getByRole("button", { name: `Complete: ${plain}` }).click();
  await expect(outcome(page)).toHaveText(`Completed: ${plain}`);
  await expect(toast(page).getByRole("textbox")).toHaveCount(0);
  await toast(page).getByRole("button", { name: "Add comment" }).click();
  const comment = toast(page).getByRole("textbox", { name: "Comment" });
  await expect(comment).toHaveValue("");
  // Nothing of the abandoned reason was sent.
  expect(stored(served, idOf(served, "certificate")).resolution?.reason).toBe(
    null,
  );
  // A blank comment is no comment: nothing is sent, and the editor stays to
  // write one.
  const sent = writes(page);
  await comment.fill("   ");
  await comment.press("Enter");
  await toast(page).getByRole("button", { name: "Send" }).click();
  await page.waitForTimeout(500);
  expect(sent).toHaveLength(0);
  await expect(comment).toBeVisible();
  await comment.fill("Filed as INFRA-212");
  await comment.press("Enter");
  await expect(outcome(page)).toHaveText(`Comment saved: ${plain}`);
  expect(verbs(sent)).toEqual(["note"]);
});

test("a filter chosen while the page is ahead of the stream shows only what the filter selects", async ({
  page,
}) => {
  const served = await serveWorld("undo");
  await open(page, served);
  // Changes wait for the reader: the stream's news of what this page does is held.
  await page
    .getByRole("combobox", { name: "Main area updates" })
    .selectOption({ label: "Off" });
  const plain = "File the flaky-runner report";
  await page.getByRole("button", { name: `Complete: ${plain}` }).click();
  await expect(outcome(page)).toHaveText(`Completed: ${plain}`);
  await toast(page).getByRole("button", { name: "Reopen" }).click();
  await expect(outcome(page)).toHaveText(`Reopened: ${plain}`);
  // Back from the receipt alone, ahead of a stream the page is not showing.
  await expect(card(page, plain)).toBeVisible();
  // A filter that excludes it is a new list, which the page's receipts are not
  // part of: only what the engine serves under it shows.
  await page
    .getByRole("combobox", { name: "Priority", exact: true })
    .selectOption({ label: "High" });
  await expect(card(page, "Review the action-items design")).toBeVisible();
  await expect(card(page, plain)).toHaveCount(0);
  expect((await titles(listRegion(page))).sort()).toEqual(
    listed(served, ["--all", "--priority", "high"])
      .map(({ item }) => item.title)
      .sort(),
  );

  // A reopen still on its way when the filter changes lands in a list it was
  // not asked from, and stays out of it.
  await page
    .getByRole("combobox", { name: "Priority", exact: true })
    .selectOption({ label: "Any priority" });
  const certificate = "Rotate the staging certificate";
  const certificateId = idOf(served, "certificate");
  await page.getByRole("button", { name: `Complete: ${certificate}` }).click();
  await expect(outcome(page)).toHaveText(`Completed: ${certificate}`);
  const release = await holdRequests(
    page,
    `/api/human-items/${certificateId}/reopen`,
  );
  await toast(page).getByRole("button", { name: "Reopen" }).click();
  await page
    .getByRole("combobox", { name: "Priority", exact: true })
    .selectOption({ label: "High" });
  await expect(card(page, "Review the action-items design")).toBeVisible();
  release();
  await expect(outcome(page)).toHaveText(`Reopened: ${certificate}`);
  expect(stored(served, certificateId).state).toBe("open");
  await page.waitForTimeout(500);
  await expect(card(page, certificate)).toHaveCount(0);
});
