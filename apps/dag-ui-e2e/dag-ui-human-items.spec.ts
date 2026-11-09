import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
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
import { FIXTURE_WORKSPACE } from "./playwright.config";

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
 * is the server really stopping; a journal the server cannot read is the
 * engine really refused its lock; a request held on its way is a delayed receipt,
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
  board: z.string(),
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
      choice: z.string().nullable().optional(),
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

/** Where this run keeps each world it built, removed with the run's fixtures. */
const WORLD_TEMPLATES = join(FIXTURE_WORKSPACE, "human-items-worlds");

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * The world `name`, served for this journey: built by the first journey that asks
 * for it and copied for the next (`human-items-world.mjs` says what is copied), so
 * each starts from the world as built without the engine building it again.
 */
async function serveWorld(name: string): Promise<FixtureServer> {
  server = await startFixtureServer(
    `human-items-${name}`,
    ["--human-items-world", name],
    { DAG_UI_E2E_WORLD_TEMPLATES: WORLD_TEMPLATES },
    { samePath: true },
  );
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
 * Make the journal unreadable to the server, and answer how to put it back.
 *
 * Every read and write the engine makes takes `index.lock` beside the journal,
 * and first creates the journal's directory if it has gone, so a server that
 * notices that directory moved away recreates it before anything can stand in
 * its place. Here the break is a single `rename` over the lock: a symlink to
 * itself, which the engine's open refuses (`ELOOP`) for as long as it stands,
 * leaving nothing to recreate. Only then does the journal's modified time move,
 * which is what tells the server to read again rather than answer with the
 * views it holds; putting it back returns the journal to the time it had, and
 * the engine's next read makes a new lock of its own.
 */
function breakJournal(served: FixtureServer): () => void {
  const dir = factsOf(served).journal;
  const lock = join(dir, "index.lock");
  const events = join(dir, "events.ndjson");
  const refusing = `${lock}.refusing`;
  const { atime, mtime } = statSync(events);
  symlinkSync("index.lock", refusing);
  renameSync(refusing, lock);
  utimesSync(events, atime, new Date(mtime.getTime() + 1_000));
  return () => {
    rmSync(lock);
    utimesSync(events, atime, mtime);
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

/** The region holding the send bar and its "Not sent" notices. */
function sendRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Drafted answers" });
}

function sendButton(page: Page): Locator {
  return sendRegion(page).getByRole("button", { name: /^Send \d+ answers?$/u });
}

/** Press the send bar, whatever it counts. */
async function sendAnswers(page: Page): Promise<void> {
  await sendButton(page).click();
}

/** The toast the last write leaves. */
function toast(page: Page): Locator {
  return page.getByRole("region", { name: "Action result" });
}

/** What the toast says, whether it went through or failed. */
function outcome(page: Page): Locator {
  return toast(page).getByRole("status").or(toast(page).getByRole("alert"));
}

/** The value of one labelled field in a detail's metadata block. */
function metadataOf(pane: Locator, label: string): Locator {
  return (
    pane
      .getByRole("term")
      .filter({ hasText: new RegExp(`^${label}$`, "u") })
      // llmlint: ignore[e2e_uses_accessible_selectors] a `dd` belongs to its `dt` only by position in the list: the accessibility tree offers no name or relation from a term to its definition, so the label is found by role and its value by that adjacency.
      .locator("+ dd")
  );
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
  await expect(metadataOf(detailPane(page), "Blocks")).toHaveText(
    "blocks all work on this host",
  );
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

test("Tab moves straight between answer boxes, Enter only keeps a draft, Shift+Enter is a new line", async ({
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

  // Enter on an empty box drafts nothing.
  await page.keyboard.press("Enter");
  await expect(sendButton(page)).toHaveCount(0);
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

  // Enter keeps the focused question's draft, sends nothing and opens nothing.
  const first = QUESTIONS[0] ?? "";
  await answerBox(page, first).focus();
  await page.keyboard.type("eu-west, matching the incident report");
  await page.keyboard.press("Enter");
  await expect(answerBox(page, first)).toHaveValue(
    "eu-west, matching the incident report",
  );
  await expect(sendButton(page)).toHaveText("Send 2 answers");
  await expect(detailPane(page)).toHaveCount(0);
  expect(sent).toHaveLength(0);

  // An input method's composition, through the browser's own input layer:
  // Enter while the words are still being composed is the composition's.
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
  await ime.send("Input.insertText", { text: "にほん" });
  await page.keyboard.press("Enter");
  await expect(sendButton(page)).toHaveText("Send 3 answers");
  expect(sent).toHaveLength(0);

  // The bar is the way out: one request, and each answer the journal's,
  // delivered to its owning session's watch alone.
  await sendAnswers(page);
  await expect(card(page, first)).toHaveCount(0);
  await expect(card(page, composing)).toHaveCount(0);
  await expect(card(page, LAST_QUESTION)).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(new URL(sent[0]?.url() ?? "").pathname).toBe(
    "/api/human-items/answers",
  );
  const region = idOf(served, "region");
  expect(stored(served, region)).toMatchObject({
    state: "answered",
    resolution: {
      actor: `browser:session:${SUPERVISOR}`,
      on_behalf_of: null,
      text: "eu-west, matching the incident report",
    },
  });
  expect(stored(served, idOf(served, "export")).resolution?.text).toContain(
    "Keep it にほん",
  );
  expect(
    watch(served, SUPERVISOR)
      .map(([, id]) => id)
      .sort(),
  ).toEqual([region, idOf(served, "export"), idOf(served, "cache")].sort());
  expect(watch(served, OTHER)).toEqual([]);
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
  await sendAnswers(page);
  // An answer leaves the pane on the item, now answered.
  await expect(metadataOf(pane, "State")).toHaveText("Answered");
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
  await page.route("**/api/human-items/answers", async (route) => {
    await held;
    await route.continue();
  });
  await answerBox(page, title).fill("Reuse it, and check the artifact digest");
  await sendAnswers(page);
  const out = sendRegion(page).getByRole("button", { name: "Sending…" });
  await expect(out).toBeDisabled();
  await expect(card(page, title)).toBeVisible();
  await expect(answerBox(page, title)).toHaveAttribute("readonly", "");
  expect(sent).toHaveLength(1);
  release();
  await expect(card(page, title)).toHaveCount(0);
  expect(sent).toHaveLength(1);
  await page.unroute("**/api/human-items/answers");
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
  await sendAnswers(page);
  await expect(sendRegion(page).getByRole("alert")).toContainText(
    "human-items",
  );
  await expect(answerBox(page, question)).toHaveValue(
    "Keep it one more release",
  );
  await expect(card(page, question)).toBeVisible();
  restore();
  expect(stored(served, idOf(served, "export")).state).toBe("open");
  await sendAnswers(page);
  await expect(card(page, question)).toHaveCount(0);
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
        await sendAnswers(page);
      } else if (verb === "dismiss") {
        await pane.getByRole("button", { name: /^Dismiss/ }).click();
      } else {
        await pane.getByRole("button", { name: /^Complete/ }).click();
      }
      await expect(card(page, before.title)).toHaveCount(0);
      if (verb !== "answer")
        await expect(outcome(page)).toHaveText(/^(Completed|Dismissed): /u);
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
  await sendAnswers(page);
  await expect(card(page, LAST_QUESTION)).toHaveCount(0);
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
    await sendAnswers(page);
    await expect(card(page, question)).toHaveCount(0);
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
  };
  expect(
    await pane.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  // The pane first paints from the list's summary, and the blocked steps only
  // the served detail carries then land at its foot: End waits for them, or it
  // stops at a bottom that has since moved.
  await expect(
    pane.getByRole("region", { name: "Blocked steps" }),
  ).toBeVisible();
  // A reader scrolls the detail from the keyboard: focus it, press End.
  await pane.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      pane.evaluate(
        (element) =>
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  // The final words are in view inside the pane, and nothing else moved.
  const fullBox = await pane.boundingBox();
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
  await expect(metadataOf(pane, "State")).toHaveText("Answered");
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
  await sendAnswers(page);
  await expect(card(page, LAST_QUESTION)).toHaveCount(0);
  expect(seen.requests.slice(beforeWrite)).toEqual([
    {
      method: "POST",
      path: "/api/human-items/answers",
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
  await page.route("**/api/human-items/answers", async (route) => {
    const response = await route.fetch();
    committed();
    await held;
    await route.fulfill({ response });
  });
  await answerBox(page, LAST_QUESTION).fill("Reuse it");
  await sendAnswers(page);
  await made;
  expect(stored(served, idOf(served, "cache")).state).toBe("answered");
  // A later change reaching the page proves the stream got past the commit,
  // and the answered card holds its place while the bar says the receipt is out.
  const later = "Raised after the answer was committed";
  raise(served, later, "task");
  await expect(card(page, later)).toBeVisible();
  await expect(
    sendRegion(page).getByRole("button", { name: "Sending…" }),
  ).toBeDisabled();
  expect((await titles(list)).filter((title) => title !== later)).toEqual(
    order,
  );
  release();
  await expect(card(page, LAST_QUESTION)).toHaveCount(0);
  await expect(sendRegion(page)).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Not sent" })).toHaveCount(0);
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

/** The loopback board's saved state: its issues and every request it answered. */
const boardSchema = z.object({
  repository: z.string(),
  issues: z.record(
    z.string(),
    z.looseObject({
      title: z.string(),
      state: z.string(),
      number: z.number(),
    }),
  ),
  requests: z.array(z.unknown()),
});

function board(served: FixtureServer) {
  return boardSchema.parse(
    JSON.parse(readFileSync(factsOf(served).board, "utf8")),
  );
}

test("a world copied for a later journey is the world as built, and its board goes on from where the build left it", async () => {
  const templates = mkdtempSync(join(tmpdir(), "dag-ui-e2e-world-templates-"));
  const start = () =>
    startFixtureServer(
      "human-items-copied",
      ["--human-items-world", "queue"],
      { DAG_UI_E2E_WORLD_TEMPLATES: templates },
      { samePath: true },
    );
  try {
    server = await start();
    const built = { items: listed(server), board: board(server) };
    const at = server.workspace;
    await server.stop();
    server = undefined;
    expect(existsSync(join(templates, "queue", "template.json"))).toBe(true);

    server = await start();
    expect(server.workspace).toBe(at);
    expect(listed(server)).toEqual(built.items);
    expect(board(server)).toEqual(built.board);
    // The board holds the issues the build's projections created and goes on
    // from them: an item resolved on the copy is projected as the next issue.
    const title = "Restore the build service";
    cli(server, ["human-items", "complete", idOf(server, "build")]);
    const after = board(server).issues;
    expect(after).toMatchObject(built.board.issues);
    const last = Math.max(
      ...Object.values(built.board.issues).map(({ number }) => number),
    );
    expect(
      Object.values(after)
        .filter((issue) => issue.title === title && issue.state === "CLOSED")
        .map(({ number }) => number),
    ).toEqual([last + 1]);
    await server.stop();
    server = undefined;

    // A template recorded for another workspace, or kept longer than a world is
    // copied for, is never copied: the world is built afresh, and nothing the
    // template held reaches it.
    const about = join(templates, "queue", "template.json");
    const record = z
      .object({ workspace: z.string(), builtAt: z.number() })
      .parse(JSON.parse(readFileSync(about, "utf8")));
    // Built again, so the same items and issues, though not the same moments.
    const titles = (items: typeof built.items) =>
      items.map(({ item }) => [item.id, item.title]);
    const issues = (held: typeof built.board) =>
      Object.entries(held.issues).map(([name, { title, state }]) => [
        name,
        title,
        state,
      ]);
    for (const unusable of [
      { ...record, workspace: `${record.workspace}-elsewhere` },
      { ...record, builtAt: Date.now() - 11 * 60_000 },
    ]) {
      await server?.stop();
      server = undefined;
      writeFileSync(about, JSON.stringify(unusable));
      writeFileSync(join(templates, "queue", "files", "copied-marker"), "");
      const rebuilt = await start();
      server = rebuilt;
      expect(existsSync(join(rebuilt.workspace, "copied-marker"))).toBe(false);
      expect(titles(listed(rebuilt))).toEqual(titles(built.items));
      expect(issues(board(rebuilt))).toEqual(issues(built.board));
      // Built again, it is kept as the template in place of the one refused.
      expect(
        existsSync(join(templates, "queue", "files", "copied-marker")),
      ).toBe(false);
    }
  } finally {
    rmSync(templates, { recursive: true, force: true });
  }
});

test("a board asked to resume refuses to start without state a board saved", () => {
  const resume = (root: string) =>
    spawnSync(
      "python3",
      [
        join(import.meta.dirname, "../../tests/support/github_board.py"),
        root,
        "--resume",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CACHE_BOARD_TOKEN: "token" },
        timeout: 30_000,
      },
    );
  const issue = (number: number, parent: string | null = null) => ({
    title: `Issue ${number}`,
    body: "",
    number,
    state: "OPEN",
    reason: null,
    status: "Todo",
    parent,
  });
  const saved = (issues: Record<string, unknown>) => ({
    repository: "generic/approval",
    issues,
    requests: [],
  });
  for (const [state, refusal] of [
    // Nothing saved at all.
    [undefined, "--resume found no readable state in"],
    // Saved, but not as a board keeps an issue: no title, or a state that is
    // not one of GitHub's.
    [
      saved({ I_1: { ...issue(1), title: undefined } }),
      "issue 'I_1' is not one it keeps",
    ],
    [
      saved({ I_1: { ...issue(1), state: 1 } }),
      "issue 'I_1' is not one it keeps",
    ],
    // Two issues of one repository with one number, and a parent cycle.
    [saved({ I_1: issue(1), I_2: issue(1) }), "two issues share a number"],
    [
      saved({ I_1: issue(1, "I_2"), I_2: issue(2, "I_1") }),
      "is its own ancestor",
    ],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "dag-ui-e2e-board-"));
    try {
      if (state !== undefined)
        writeFileSync(join(root, "state.json"), JSON.stringify(state));
      const refused = resume(root);
      expect(refused.status, refused.stderr).toBe(2);
      expect(refused.stderr).toContain(refusal);
      expect(existsSync(join(root, "endpoint"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
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
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __alerts: seen });
    new MutationObserver(() => {
      // llmlint: ignore[e2e_uses_accessible_selectors] a locator can only ask what is on the page now; a transient alert has to be noticed by an observer inside the page as it appears, and `[role="alert"]` is the accessible role itself, read where no locator reaches.
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

  // Nothing pointing at it and nothing focused in it, it still stays while what
  // it was asked to do is on its way, and leaves its duration after that lands.
  const letGo = async () => {
    await page.mouse.move(1, 1);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
  };
  const cache = idOf(served, "cache");
  await page.getByRole("button", { name: `Dismiss: ${LAST_QUESTION}` }).click();
  await expect(outcome(page)).toHaveText(`Dismissed: ${LAST_QUESTION}`);
  const releaseRestore = await holdRequests(
    page,
    `/api/human-items/${cache}/reopen`,
  );
  await toast(page).getByRole("button", { name: "Restore" }).click();
  await letGo();
  await page.clock.runFor((TOAST_SECONDS + 5) * 1_000);
  await expect(toast(page)).toBeVisible();
  releaseRestore();
  await expect(outcome(page)).toHaveText(`Restored: ${LAST_QUESTION}`);
  await page.clock.runFor((TOAST_SECONDS - 1) * 1_000);
  await expect(toast(page)).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(toast(page)).toHaveCount(0);
  await page.unroute(`**/api/human-items/${cache}/reopen`);

  // A reason being written holds it too, focus or no, until it is sent.
  await page.getByRole("button", { name: `Dismiss: ${LAST_QUESTION}` }).click();
  await expect(outcome(page)).toHaveText(`Dismissed: ${LAST_QUESTION}`);
  await toast(page).getByRole("button", { name: "Add reason" }).click();
  await toast(page)
    .getByRole("textbox", { name: "Reason" })
    .fill("Warm caches stay");
  await letGo();
  await page.clock.runFor((TOAST_SECONDS + 5) * 1_000);
  await expect(toast(page)).toBeVisible();
  await toast(page).getByRole("textbox", { name: "Reason" }).press("Enter");
  await expect(outcome(page)).toHaveText(`Reason saved: ${LAST_QUESTION}`);
  await letGo();
  await page.clock.runFor((TOAST_SECONDS + 1) * 1_000);
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

test("a receipt or refusal that comes after the toast's duration finds its toast still there", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const served = await serveWorld("undo");
  await open(page, served);
  watch(served, SUPERVISOR);
  // From here the page's time moves only when this journey moves it.
  await page.clock.pauseAt(Date.now() + 1_000);
  const sent = writes(page);
  const past = (TOAST_SECONDS + 5) * 1_000;
  // Nothing pointing at the toast and nothing focused in it: only the write
  // still on its way can be what keeps it.
  const letGo = async () => {
    await page.mouse.move(1, 1);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
  };

  // A Complete whose receipt is held past the duration: the toast stays,
  // sending, and its Reopen still works — pressed then, it waits for the
  // receipt, and once that lands it is sent and the card comes back.
  const plain = "File the flaky-runner report";
  const plainId = idOf(served, "plain");
  const releaseComplete = await holdRequests(
    page,
    `/api/human-items/${plainId}/complete`,
  );
  await card(page, plain)
    .getByRole("button", { name: `Complete: ${plain}` })
    .click();
  await letGo();
  await page.clock.runFor(past);
  await expect(toast(page)).toHaveAttribute("data-phase", "sending");
  await expect(outcome(page)).toHaveText(`Completing: ${plain}…`);
  await toast(page).getByRole("button", { name: "Reopen" }).click();
  await letGo();
  await page.clock.runFor(past);
  await expect(toast(page)).toBeVisible();
  expect(verbs(sent)).toEqual(["complete"]);
  expect(stored(served, plainId).state).toBe("open");
  await expect(card(page, plain)).toHaveCount(0);
  releaseComplete();
  await expect(outcome(page)).toHaveText(`Reopened: ${plain}`);
  expect(verbs(sent)).toEqual(["complete", "reopen"]);
  await expect(card(page, plain)).toBeVisible();
  expect(stored(served, plainId)).toMatchObject({
    state: "open",
    resolution: null,
  });
  await page.unroute(`**/api/human-items/${plainId}/complete`);
  await toast(page).getByRole("button", { name: "Close" }).click();

  // A Dismiss whose receipt lands after the duration: the toast says so in
  // green, and Restore — pressed only now, after the receipt — still brings
  // the card back.
  const certificate = "Rotate the staging certificate";
  const certificateId = idOf(served, "certificate");
  const releaseDismiss = await holdRequests(
    page,
    `/api/human-items/${certificateId}/dismiss`,
  );
  await card(page, certificate)
    .getByRole("button", { name: `Dismiss: ${certificate}` })
    .click();
  await letGo();
  await page.clock.runFor(past);
  await expect(outcome(page)).toHaveText(`Dismissing: ${certificate}…`);
  releaseDismiss();
  await expect(outcome(page)).toHaveText(`Dismissed: ${certificate}`);
  await expect(toast(page)).toHaveAttribute("data-tone", "success");
  expect(stored(served, certificateId).state).toBe("dismissed");
  await toast(page).getByRole("button", { name: "Restore" }).click();
  await expect(outcome(page)).toHaveText(`Restored: ${certificate}`);
  await expect(card(page, certificate)).toBeVisible();
  expect(stored(served, certificateId).state).toBe("open");
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-completed", plainId],
    ["human-item-reopened", plainId],
    ["human-item-dismissed", certificateId],
    ["human-item-reopened", certificateId],
  ]);
  await page.unroute(`**/api/human-items/${certificateId}/dismiss`);
  await toast(page).getByRole("button", { name: "Close" }).click();

  // A Complete the engine refuses after the duration: the card comes back where
  // it was, with the engine's reason on it and in the toast, in view above it.
  const order = await titles(listRegion(page));
  const releaseRefused = await holdRequests(
    page,
    `/api/human-items/${plainId}/complete`,
  );
  await card(page, plain)
    .getByRole("button", { name: `Complete: ${plain}` })
    .click();
  await letGo();
  await page.clock.runFor(past);
  await expect(toast(page)).toHaveAttribute("data-phase", "sending");
  await expect(card(page, plain)).toHaveCount(0);
  const restore = breakJournal(served);
  releaseRefused();
  await expect(toast(page)).toHaveAttribute("data-tone", "failure");
  const reason = card(page, plain).getByRole("alert");
  await expect(reason).toBeVisible();
  await expect(outcome(page)).toContainText((await reason.textContent()) ?? "");
  expect(await titles(listRegion(page))).toEqual(order);
  const top = (await box(toast(page))).y;
  for (const part of [
    reason,
    ...(await card(page, plain).getByRole("button").all()),
  ]) {
    await expect(part).toBeInViewport();
    const at = await box(part);
    expect(at.y + at.height).toBeLessThanOrEqual(top);
  }
  restore();
  expect(stored(served, plainId).state).toBe("open");
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
    // A second press puts it away again once the pointer has gone.
    await why(label).click();
    await expect(why(label)).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(1, 1);
    await expect(tip).toBeHidden();
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

test("a bulleted body on a card keeps its bullets, and its clamp cuts between lines", async ({
  page,
}) => {
  const served = await serveWorld("realistic");
  const list = await open(page, served);
  const bullets = list.getByRole("article").first().getByRole("listitem");
  await expect(bullets).toHaveCount(3);
  // llmlint: ignore[e2e_uses_accessible_selectors] the bullets are located by role; what is asserted is their computed marker and how each sits against the box the shared package clamps the body in, which is their list's parent and has no role of its own.
  const reading = await bullets.evaluateAll((items) => {
    const body = items[0]?.parentElement?.parentElement;
    if (!body) throw new Error("the list has no body around it");
    const style = getComputedStyle(body);
    return {
      line: Number.parseFloat(style.lineHeight),
      bottom: body.getBoundingClientRect().bottom,
      markers: items.map((item) => getComputedStyle(item).listStyleType),
      boxes: items.map((item) => {
        const { top, bottom } = item.getBoundingClientRect();
        return { top, bottom };
      }),
    };
  });
  expect(reading.markers).toEqual(["disc", "disc", "disc"]);
  for (const [index, { top, bottom }] of reading.boxes.entries()) {
    const next = reading.boxes[index + 1];
    if (next !== undefined) expect(next.top - top).toBe(reading.line);
    // A line is either wholly inside the clamp or wholly below it.
    if (top < reading.bottom)
      expect(bottom).toBeLessThanOrEqual(reading.bottom + 0.5);
  }
});

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
      const parts = await shown.evaluate((card) =>
        // llmlint: ignore[e2e_uses_accessible_selectors] "nothing leaves its card" is a property of every rendered box inside it, text runs and inline code included, most of which carry no role; the walk reads each one's geometry, never selects by a class.
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
        expect(action.height).toBeGreaterThanOrEqual(28);
        expect(action.height).toBeLessThanOrEqual(32);
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

  // Restore pressed again while the first is still waiting on Dismiss's
  // receipt is the same request: one reopen reaches the server, after it.
  const releaseRestored = await holdRequests(
    page,
    `/api/human-items/${plainId}/dismiss`,
  );
  await page.getByRole("button", { name: `Dismiss: ${plain}` }).click();
  await toast(page).getByRole("button", { name: "Restore" }).click();
  await toast(page)
    .getByRole("button", { name: /^Restore/u })
    .click();
  await page.waitForTimeout(500);
  expect(verbs(sent).slice(4)).toEqual(["dismiss"]);
  releaseRestored();
  await expect(outcome(page)).toHaveText(`Restored: ${plain}`);
  await expect(card(page, plain)).toBeVisible();
  await page.waitForTimeout(500);
  expect(verbs(sent).slice(4)).toEqual(["dismiss", "reopen"]);
  expect(stored(served, plainId).state).toBe("open");
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-dismissed", plainId],
    ["human-item-reopened", plainId],
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

test("a write or follow-up whose toast a newer write replaced lands on its item, never in the toast now showing", async ({
  page,
}) => {
  const served = await serveWorld("undo");
  await open(page, served);
  const plain = "File the flaky-runner report";
  const plainId = idOf(served, "plain");
  const certificate = "Rotate the staging certificate";
  const certificateId = idOf(served, "certificate");
  const design = "Review the action-items design";
  const final = "Approve the final release notes";
  const finalId = idOf(served, "final");
  /** Release a held request and wait until the page has its answer. */
  const deliver = async (release: () => void, path: string) => {
    const answered = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(path),
    );
    release();
    await answered;
  };
  /** The toast still reads as `text` says, green and done, after a late answer. */
  const stillShows = async (text: string) => {
    // What a late answer would change has had every chance to: the page's own
    // promise chain runs within a task of the response.
    await page.waitForTimeout(500);
    await expect(outcome(page)).toHaveText(text);
    await expect(toast(page)).toHaveAttribute("data-tone", "success");
    await expect(toast(page)).toHaveAttribute("data-phase", "done");
  };

  // An older Complete whose receipt lands after a Dismiss replaced its toast:
  // the item is completed and stays off the list, and the Dismiss's toast is
  // untouched.
  const completePlain = `/api/human-items/${plainId}/complete`;
  const releasePlain = await holdRequests(page, completePlain);
  await card(page, plain)
    .getByRole("button", { name: `Complete: ${plain}` })
    .click();
  await expect(outcome(page)).toHaveText(`Completing: ${plain}…`);
  await card(page, certificate)
    .getByRole("button", { name: `Dismiss: ${certificate}` })
    .click();
  await expect(outcome(page)).toHaveText(`Dismissed: ${certificate}`);
  await deliver(releasePlain, completePlain);
  await stillShows(`Dismissed: ${certificate}`);
  expect(stored(served, plainId).state).toBe("completed");
  await expect(card(page, plain)).toHaveCount(0);
  await page.unroute(`**${completePlain}`);

  // A Restore pressed on that toast and still on its way when a Complete
  // replaces the toast: the certificate comes back, and the Complete's toast
  // never says it was restored.
  const reopenCertificate = `/api/human-items/${certificateId}/reopen`;
  const releaseRestore = await holdRequests(page, reopenCertificate);
  await toast(page).getByRole("button", { name: "Restore" }).click();
  await card(page, design)
    .getByRole("button", { name: `Complete: ${design}` })
    .click();
  await expect(outcome(page)).toHaveText(`Completed: ${design}`);
  await deliver(releaseRestore, reopenCertificate);
  await expect(card(page, certificate)).toBeVisible();
  await stillShows(`Completed: ${design}`);
  expect(stored(served, certificateId).state).toBe("open");
  await page.unroute(`**${reopenCertificate}`);

  // An older Complete the engine refuses after a Dismiss replaced its toast:
  // the card comes back with the engine's reason on it, and the Dismiss's
  // toast stays green rather than turning to that refusal.
  const completeCertificate = `/api/human-items/${certificateId}/complete`;
  const releaseRefused = await holdRequests(page, completeCertificate);
  await card(page, certificate)
    .getByRole("button", { name: `Complete: ${certificate}` })
    .click();
  await expect(outcome(page)).toHaveText(`Completing: ${certificate}…`);
  await card(page, final)
    .getByRole("button", { name: `Dismiss: ${final}` })
    .click();
  await expect(outcome(page)).toHaveText(`Dismissed: ${final}`);
  const mend = breakJournal(served);
  try {
    await deliver(releaseRefused, completeCertificate);
    await expect(card(page, certificate).getByRole("alert")).toBeVisible();
  } finally {
    mend();
  }
  await stillShows(`Dismissed: ${final}`);
  expect(stored(served, certificateId).state).toBe("open");
  await page.unroute(`**${completeCertificate}`);

  // A reason on that Dismiss, refused while a Complete has replaced its toast:
  // nothing is recorded, and the Complete's toast says only what it did.
  const noteFinal = `/api/human-items/${finalId}/note`;
  const releaseNote = await holdRequests(page, noteFinal);
  await toast(page).getByRole("button", { name: "Add reason" }).click();
  await toast(page)
    .getByRole("textbox", { name: "Reason" })
    .fill("Superseded by the published notes");
  await toast(page).getByRole("button", { name: "Send" }).click();
  await card(page, certificate)
    .getByRole("button", { name: `Complete: ${certificate}` })
    .click();
  await expect(outcome(page)).toHaveText(`Completed: ${certificate}`);
  const mendAgain = breakJournal(served);
  try {
    await deliver(releaseNote, noteFinal);
    await page.waitForTimeout(500);
  } finally {
    mendAgain();
  }
  await stillShows(`Completed: ${certificate}`);
  await expect(toast(page).getByRole("textbox")).toHaveCount(0);
  expect(stored(served, finalId)).toMatchObject({
    state: "dismissed",
    resolution: { reason: null },
  });
  await page.unroute(`**${noteFinal}`);
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

interface Offered {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

const REGIONS: readonly Offered[] = [
  { id: "eu", title: "Europe", description: "Closest to the incident." },
  { id: "us", title: "United States", description: "Most of the traffic." },
  { id: "ap", title: "Asia Pacific", description: "The quietest region." },
];

/** A question raised through the real CLI, offering `choices`. */
function raiseQuestion(
  served: FixtureServer,
  fields: {
    readonly key: string;
    readonly title?: string;
    readonly body?: string;
    readonly choices?: readonly Offered[];
    readonly owner?: {
      readonly session?: string;
      readonly run?: string;
      readonly plan?: string;
    };
  },
): string {
  const facts = factsOf(served);
  const input = join(facts.cwd, `raise-${fields.key}.json`);
  const session = fields.owner?.session ?? SUPERVISOR;
  writeFileSync(
    input,
    JSON.stringify({
      schema_version: 1,
      dedup_key: fields.key,
      kind: "question",
      title: fields.title ?? `Question ${fields.key}?`,
      body: fields.body ?? `What ${fields.key} needs from a person.`,
      ...(fields.choices === undefined ? {} : { choices: fields.choices }),
      priority: "medium",
      owner: {
        session,
        run: fields.owner?.run ?? null,
        plan: fields.owner?.plan ?? null,
      },
      block: { scope: "nothing" },
      approval: null,
    }),
  );
  return receiptSchema.parse(
    JSON.parse(
      cli(served, ["human-items", "raise", "--input", input], session),
    ),
  ).item.item.id;
}

function choiceButton(root: Page | Locator, title: string): Locator {
  return root.getByRole("button", { name: title, exact: true });
}

/** Details for `title`, opened from its card. */
async function openDetail(page: Page, title: string): Promise<Locator> {
  await page.getByRole("button", { name: `Details: ${title}` }).click();
  const pane = detailPane(page);
  await expect(pane.getByRole("heading", { name: title })).toBeVisible();
  return pane;
}

const DRAFT_KEY = (id: string) => `onepipeline-ui.human-items.draft.${id}`;

function storedDraft(page: Page, id: string) {
  return page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY(id));
}

/** The whole batch requests this page made, as what each carried. */
function batchesOf(sent: readonly Request[]) {
  return sent
    .filter((r) => new URL(r.url()).pathname === "/api/human-items/answers")
    .map((r) =>
      z.object({ answers: z.array(z.unknown()) }).parse(r.postDataJSON()),
    );
}

function setUpdates(page: Page, label: "Off" | "Live") {
  return page
    .getByRole("combobox", { name: "Main area updates" })
    .selectOption({ label });
}

test("one press and Send answers a question, and a typed answer on a question with choices stores no choice", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const pick = raiseQuestion(served, {
    key: "pick-one",
    title: "Which region first?",
    choices: REGIONS,
  });
  const typed = raiseQuestion(served, {
    key: "type-one",
    title: "Which region second?",
    choices: REGIONS,
  });
  await open(page, served);
  const sent = writes(page);

  await choiceButton(
    card(page, "Which region first?"),
    "United States",
  ).click();
  await expect(
    choiceButton(card(page, "Which region first?"), "United States"),
  ).toHaveAttribute("aria-pressed", "true");
  expect(sent).toHaveLength(0);
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  await sendAnswers(page);
  await expect(card(page, "Which region first?")).toHaveCount(0);
  expect(stored(served, pick).resolution).toMatchObject({
    choice: "us",
    text: null,
  });
  expect(stored(served, pick).state).toBe("answered");

  const pane = await openDetail(page, "Which region second?");
  await pane
    .getByRole("textbox", { name: "Answer in detail: Which region second?" })
    .fill("None of these: use the staging region");
  await sendAnswers(page);
  await expect(card(page, "Which region second?")).toHaveCount(0);
  const answered = stored(served, typed);
  expect(answered.state).toBe("answered");
  expect(answered.resolution?.text).toBe(
    "None of these: use the staging region",
  );
  expect(answered.resolution?.choice ?? null).toBeNull();
});

test("a press clears and replaces the draft, and four drafts survive a reload and go as one batch", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const ids = [
    raiseQuestion(served, {
      key: "draft-a",
      title: "Draft A?",
      choices: REGIONS,
    }),
    raiseQuestion(served, {
      key: "draft-b",
      title: "Draft B?",
      choices: REGIONS,
    }),
    raiseQuestion(served, { key: "draft-c", title: "Draft C?" }),
    raiseQuestion(served, {
      key: "draft-d",
      title: "Draft D?",
      choices: REGIONS,
    }),
  ] as const;
  await open(page, served);
  watch(served, SUPERVISOR);

  const europe = choiceButton(card(page, "Draft A?"), "Europe");
  await europe.click();
  await europe.click();
  await expect(europe).toHaveAttribute("aria-pressed", "false");
  await expect(sendButton(page)).toHaveCount(0);
  await europe.click();
  await choiceButton(card(page, "Draft A?"), "Asia Pacific").click();
  await expect(europe).toHaveAttribute("aria-pressed", "false");
  await choiceButton(card(page, "Draft B?"), "United States").click();
  await answerBox(page, "Draft C?").fill("Words only");
  const pane = await openDetail(page, "Draft D?");
  await choiceButton(pane, "Europe").click();
  await pane
    .getByRole("textbox", { name: "Answer in detail: Draft D?" })
    .fill("And the words too");
  await expect(sendButton(page)).toHaveText("Send 4 answers");

  await page.reload();
  await expect(card(page, "Draft A?")).toBeVisible();
  await expect(
    choiceButton(card(page, "Draft A?"), "Asia Pacific"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    choiceButton(card(page, "Draft B?"), "United States"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(answerBox(page, "Draft C?")).toHaveValue("Words only");
  await expect(choiceButton(card(page, "Draft D?"), "Europe")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sendButton(page)).toHaveText("Send 4 answers");

  const sent = writes(page);
  await sendAnswers(page);
  await expect(card(page, "Draft A?")).toHaveCount(0);
  await expect(card(page, "Draft D?")).toHaveCount(0);
  await expect(sendRegion(page)).toHaveCount(0);
  expect(batchesOf(sent)).toHaveLength(1);
  expect(batchesOf(sent)[0]?.answers).toHaveLength(4);
  expect(sent).toHaveLength(1);
  expect(stored(served, ids[0]).resolution?.choice).toBe("ap");
  expect(stored(served, ids[1]).resolution?.choice).toBe("us");
  expect(stored(served, ids[2]).resolution?.text).toBe("Words only");
  expect(stored(served, ids[3]).resolution).toMatchObject({
    choice: "eu",
    text: "And the words too",
  });
  for (const id of ids) expect(await storedDraft(page, id)).toBeNull();

  // One watch prints every answer of the batch, under one id.
  const printed = cli(served, ["human-items", "watch", "--session", SUPERVISOR])
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) =>
      z
        .object({
          kind: z.string(),
          payload: z.object({
            item_id: z.string(),
            batch: z.object({ id: z.string(), size: z.number() }),
          }),
        })
        .parse(JSON.parse(line)),
    );
  expect(printed.map(({ payload }) => payload.item_id).sort()).toEqual(
    [...ids].sort(),
  );
  expect(new Set(printed.map(({ payload }) => payload.batch.id)).size).toBe(1);
  expect(printed[0]?.payload.batch.size).toBe(4);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const LONG_CHOICE = `${"Roll the release back to the previous tag and ".repeat(2).slice(0, 80)}`;

test("at phone width a choice is picked and sent with the detail open, an 80-character title wraps inside its button, and Enter never sends", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const served = await serveWorld("queue");
  const body = `The whole of this question. ${"Read on, there is more. ".repeat(60)}The last words of the body.`;
  const title = "Roll back or roll forward?";
  const id = raiseQuestion(served, {
    key: "long-choice",
    title,
    body,
    choices: [
      { id: "roll", title: LONG_CHOICE, description: "The long one." },
      { id: "keep", title: "Keep going", description: "The short one." },
    ],
  });
  raiseQuestion(served, { key: "plain", title: "Plain question?" });
  await open(page, served);

  expect([...LONG_CHOICE].length).toBeGreaterThanOrEqual(78);
  const long = card(page, title).getByRole("button", { name: LONG_CHOICE });
  await long.scrollIntoViewIfNeeded();
  const longBox = await box(long);
  const shortBox = await box(choiceButton(card(page, title), "Keep going"));
  // Two lines of the card's small text, inside the button.
  expect(longBox.height).toBeGreaterThan(40);
  expect(longBox.height).toBeLessThanOrEqual(66);
  expect(overlap(longBox, shortBox)).toBe(false);
  expect(inside(longBox, await box(card(page, title)))).toBe(true);

  // Enter keeps the draft, and only the bar records it.
  const sent = writes(page);
  await answerBox(page, "Plain question?").fill("Typed then Enter");
  await answerBox(page, "Plain question?").press("Enter");
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  expect(sent).toHaveLength(0);
  const plain = idOf2(served, "Plain question?");
  expect(stored(served, plain).state).toBe("open");
  await sendAnswers(page);
  await expect(card(page, "Plain question?")).toHaveCount(0);
  expect(stored(served, plain).resolution?.text).toBe("Typed then Enter");

  const pane = await openDetail(page, title);
  await choiceButton(pane, "Keep going").click();
  const bar = await box(sendButton(page));
  expect(bar.y + bar.height).toBeLessThanOrEqual(844);
  expect(bar.y).toBeGreaterThanOrEqual(0);
  const paragraph = pane
    .getByRole("region", { name: "Full body" })
    .getByText(/The last words/u);
  await paragraph.scrollIntoViewIfNeeded();
  await expect(paragraph).toBeInViewport();
  expect(
    await pane
      .getByRole("region", { name: "Full body" })
      .evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  await sendAnswers(page);
  await expect(metadataOf(pane, "State")).toHaveText("Answered");
  expect(stored(served, id).resolution?.choice).toBe("keep");
  await context.close();
});

/** The id of the open question titled `title`, as the CLI lists it. */
function idOf2(served: FixtureServer, title: string): string {
  const view = listed(served).find(({ item }) => item.title === title);
  if (view === undefined) throw new Error(`no open item titled ${title}`);
  return view.item.id;
}

test("a refused draft follows the policy: gone with a notice once its item closed, kept with its reason while open, and a dead server keeps everything", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const policy = (key: string) =>
    raiseQuestion(served, {
      key: `policy-${key}`,
      title: `Policy ${key}?`,
      choices: REGIONS,
    });
  const one = policy("one");
  const two = policy("two");
  const three = policy("three");
  await open(page, served);

  // (a) The page hears of nothing: a dismissal only the send can find out about.
  await setUpdates(page, "Off");
  await choiceButton(card(page, "Policy one?"), "Europe").click();
  await choiceButton(card(page, "Policy two?"), "Europe").click();
  const pane = await openDetail(page, "Policy three?");
  await choiceButton(pane, "Europe").click();
  await pane
    .getByRole("textbox", { name: "Answer in detail: Policy three?" })
    .fill("Words that must survive");
  await pane.getByRole("button", { name: "Close detail" }).click();
  cli(
    served,
    ["human-items", "dismiss", three, "--reason", "no longer needed"],
    SUPERVISOR,
  );
  await expect(sendButton(page)).toHaveText("Send 3 answers");
  const sent = writes(page);
  await sendAnswers(page);

  const notices = page.getByRole("list", { name: "Not sent" });
  await expect(notices.getByRole("listitem")).toHaveCount(1);
  await expect(notices).toContainText("Policy three?");
  await expect(notices).toContainText("Words that must survive");
  await expect(notices).toContainText("Europe");
  await expect(notices).toContainText(/already|resolved/iu);
  expect(batchesOf(sent)).toHaveLength(1);
  expect(stored(served, one).state).toBe("answered");
  expect(stored(served, two).state).toBe("answered");
  expect(stored(served, three).state).toBe("dismissed");
  expect(await storedDraft(page, three)).toBeNull();
  await expect(sendButton(page)).toHaveCount(0);
  await notices.getByRole("button", { name: "Clear" }).click();
  await expect(notices).toHaveCount(0);

  // (b) The asker re-raised it without the drafted choice; the item stays open.
  const again = raiseQuestion(served, {
    key: "policy-again",
    title: "Policy again?",
    choices: REGIONS,
  });
  await page.reload();
  await expect(card(page, "Policy again?")).toBeVisible();
  await setUpdates(page, "Off");
  await choiceButton(card(page, "Policy again?"), "Asia Pacific").click();
  raiseQuestion(served, {
    key: "policy-again",
    title: "Policy again?",
    choices: REGIONS.filter(({ id }) => id !== "ap"),
  });
  await sendAnswers(page);
  const refused = card(page, "Policy again?").getByRole("alert");
  await expect(refused).toContainText("offers no choice ap");
  expect(stored(served, again).state).toBe("open");
  expect(await storedDraft(page, again)).not.toBeNull();
  await expect(sendButton(page)).toHaveText("Send 1 answer");

  // (c) Live: answered elsewhere, seen arriving, and the draft is retired.
  await setUpdates(page, "Live");
  await expect(card(page, "Policy again?")).toBeVisible();
  cli(
    served,
    ["human-items", "answer", again, "--text", "From the CLI"],
    SUPERVISOR,
  );
  await expect(card(page, "Policy again?")).toHaveCount(0);
  await expect(notices).toContainText("answered or dismissed elsewhere");
  await expect(notices).toContainText("Policy again?");
  await expect(sendButton(page)).toHaveCount(0);
  expect(await storedDraft(page, again)).toBeNull();

  // A dead server keeps every draft and says so.
  const last = raiseQuestion(served, {
    key: "policy-last",
    title: "Policy last?",
  });
  await expect(answerBox(page, "Policy last?")).toBeVisible();
  await answerBox(page, "Policy last?").fill("Kept through an outage");
  await served.stopServing();
  await sendAnswers(page);
  await expect(sendRegion(page).getByRole("alert")).toContainText("kept");
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  expect(await storedDraft(page, last)).not.toBeNull();
});

test("a refused draft whose item cannot then be read stays stored and sendable beside its reason", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const id = raiseQuestion(served, {
    key: "refused-unread",
    title: "Refused then unread?",
    choices: REGIONS,
  });
  await open(page, served);
  await setUpdates(page, "Off");
  await choiceButton(
    card(page, "Refused then unread?"),
    "Asia Pacific",
  ).click();
  raiseQuestion(served, {
    key: "refused-unread",
    title: "Refused then unread?",
    choices: REGIONS.filter(({ id: offered }) => offered !== "ap"),
  });
  const looked: string[] = [];
  // llmlint: ignore[e2e_not_mocked] the transport failing for the one read that follows a refusal, while the send and every other request stay up, is the state under test, and no real server can fail a single GET; the bundle, the engine's refusal and all other routes are real.
  await page.route(`**/api/human-items/${id}`, (route) => {
    looked.push(route.request().url());
    return route.abort();
  });
  const sent = writes(page);
  await sendAnswers(page);

  const refused = card(page, "Refused then unread?").getByRole("alert");
  await expect(refused).toContainText("offers no choice ap");
  expect(looked.length).toBeGreaterThan(0);
  expect(batchesOf(sent)).toHaveLength(1);
  expect(stored(served, id).state).toBe("open");
  expect(await storedDraft(page, id)).not.toBeNull();
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  await expect(page.getByRole("list", { name: "Not sent" })).toHaveCount(0);
  await page.unroute(`**/api/human-items/${id}`);
});

test("a filter hiding a drafted item does not retire its draft", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const id = raiseQuestion(served, {
    key: "hidden-by-filter",
    title: "Hidden by a filter?",
    choices: REGIONS,
  });
  await open(page, served);
  await choiceButton(card(page, "Hidden by a filter?"), "Europe").click();
  await page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("Priority", { exact: true })
    .selectOption("urgent");
  await expect(card(page, "Hidden by a filter?")).toHaveCount(0);
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  await expect(page.getByRole("list", { name: "Not sent" })).toHaveCount(0);
  expect(await storedDraft(page, id)).not.toBeNull();

  // A later filter asks again: answered meanwhile, the draft is retired.
  cli(served, ["human-items", "answer", id, "--text", "Elsewhere"], SUPERVISOR);
  await page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("Priority", { exact: true })
    .selectOption("high");
  await expect(page.getByRole("list", { name: "Not sent" })).toContainText(
    "answered or dismissed elsewhere",
  );
  await expect(sendButton(page)).toHaveCount(0);
  expect(await storedDraft(page, id)).toBeNull();
});

test("an item that no longer reads retires its draft, a read that fails keeps it, and blank words are no answer", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const kept = raiseQuestion(served, {
    key: "read-fails",
    title: "Read fails?",
    choices: REGIONS,
  });
  const blank = raiseQuestion(served, {
    key: "blank-words",
    title: "Blank words?",
    choices: REGIONS,
  });
  raiseQuestion(served, { key: "only-spaces", title: "Only spaces?" });
  const vanishing = raiseQuestion(served, {
    key: "vanishes",
    title: "Vanishes?",
  });
  await open(page, served);

  // Whitespace alone is nothing to send; beside a choice it is left out.
  await answerBox(page, "Only spaces?").fill("   ");
  await expect(sendButton(page)).toHaveCount(0);
  const pane = await openDetail(page, "Blank words?");
  await choiceButton(pane, "Europe").click();
  await pane
    .getByRole("textbox", { name: "Answer in detail: Blank words?" })
    .fill("   ");
  await pane.getByRole("button", { name: "Close detail" }).click();
  const sent = writes(page);
  await sendAnswers(page);
  await expect(card(page, "Blank words?")).toHaveCount(0);
  expect(batchesOf(sent)[0]?.answers).toEqual([{ id: blank, choice: "eu" }]);

  // A hidden item whose read fails stays drafted: unknown is not gone.
  await choiceButton(card(page, "Read fails?"), "Europe").click();
  await answerBox(page, "Vanishes?").fill("Words for a vanished item");
  // llmlint: ignore[e2e_not_mocked] the transport failing for this one read while the page and every other request stay up is the state under test, and no real server can fail a single GET; the bundle, the engine and all other routes are real.
  await page.route(`**/api/human-items/${kept}`, (route) => route.abort());
  await page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("Priority", { exact: true })
    .selectOption("urgent");
  await expect(card(page, "Read fails?")).toHaveCount(0);
  await expect(sendButton(page)).toHaveText("Send 2 answers");
  await expect(page.getByRole("list", { name: "Not sent" })).toHaveCount(0);
  expect(await storedDraft(page, kept)).not.toBeNull();
  await page.unroute(`**/api/human-items/${kept}`);

  // Every item goes from under the server, which then answers 404 for it.
  const dir = factsOf(served).journal;
  renameSync(dir, `${dir}.gone`);
  await page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("Priority", { exact: true })
    .selectOption("low");
  const notices = page.getByRole("list", { name: "Not sent" });
  await expect(notices).toContainText("Words for a vanished item");
  await expect(notices).toContainText("answered or dismissed elsewhere");
  expect(await storedDraft(page, vanishing)).toBeNull();
});

test("choice buttons are reached by Tab and pressed from the keyboard, and resolved items state when", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const title = "Pick by keyboard?";
  const id = raiseQuestion(served, {
    key: "keyboard",
    title,
    choices: REGIONS,
  });
  await open(page, served);
  const shown = card(page, title);
  const first = choiceButton(shown, "Europe");
  await first.focus();
  await page.keyboard.press("Tab");
  await expect(choiceButton(shown, "United States")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Space");
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  const pane = await openDetail(page, title);
  await expect(metadataOf(pane, "Raised")).toHaveText(/\d{4}/u);
  await expect(pane.getByRole("term")).not.toContainText(["Answered"]);
  await sendAnswers(page);
  await expect(metadataOf(pane, "State")).toHaveText("Answered");
  await expect(metadataOf(pane, "Answered")).toHaveText(/\d{4}/u);
  expect(stored(served, id).resolution?.choice).toBe("eu");
  await pane.getByRole("button", { name: "Close detail" }).click();

  // A completed task and a dismissed one say when, under their own labels.
  for (const [state, verb, label] of [
    ["completed", "complete", "Completed"],
    ["dismissed", "dismiss", "Dismissed"],
  ] as const) {
    const taskTitle = `Done by ${verb}`;
    const taskId = raise(served, taskTitle, "task");
    cli(served, ["human-items", verb, taskId], SUPERVISOR);
    await page
      .getByRole("group", { name: "Filter action items" })
      .getByLabel("State", { exact: true })
      .selectOption(state);
    const resolved = await openDetail(page, taskTitle);
    await expect(metadataOf(resolved, label)).toHaveText(/\d{4}/u);
    await resolved.getByRole("button", { name: "Close detail" }).click();
  }
});

test("editing a draft keeps its other half, clearing the last half drops it, and an edit clears a refusal and resends", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const title = "Edit a draft?";
  const id = raiseQuestion(served, {
    key: "edits",
    title,
    choices: REGIONS,
  });
  raiseQuestion(served, { key: "edits-text", title: "Text only?" });
  await open(page, served);

  // Clearing a text-only draft's words leaves nothing to send.
  await answerBox(page, "Text only?").fill("Second thoughts");
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  await answerBox(page, "Text only?").fill("");
  await expect(sendButton(page)).toHaveCount(0);

  // Words survive a choice's press, replacement and clearing; a choice survives
  // the words being cleared.
  const pane = await openDetail(page, title);
  const words = pane.getByRole("textbox", {
    name: `Answer in detail: ${title}`,
  });
  await words.fill("My own words");
  await choiceButton(pane, "Europe").click();
  await choiceButton(pane, "Asia Pacific").click();
  await expect(words).toHaveValue("My own words");
  await choiceButton(pane, "Asia Pacific").click();
  await expect(words).toHaveValue("My own words");
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  await choiceButton(pane, "Asia Pacific").click();
  await words.fill("");
  await expect(choiceButton(pane, "Asia Pacific")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  await pane.getByRole("button", { name: "Close detail" }).click();

  // Refused while open, then edited: the reason goes, and the resend lands.
  await setUpdates(page, "Off");
  raiseQuestion(served, {
    key: "edits",
    title,
    choices: REGIONS.filter((choice) => choice.id !== "ap"),
  });
  await sendAnswers(page);
  const reason = card(page, title).getByRole("alert");
  await expect(reason).toContainText("offers no choice ap");
  await choiceButton(card(page, title), "Europe").click();
  await expect(reason).toHaveCount(0);
  await sendAnswers(page);
  await expect(card(page, title)).toHaveCount(0);
  expect(stored(served, id).resolution?.choice).toBe("eu");
});

test("Discard removes every draft for good and writes nothing", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const id = raiseQuestion(served, {
    key: "discarded",
    title: "Discarded?",
    choices: REGIONS,
  });
  await open(page, served);
  const sent = writes(page);
  await choiceButton(card(page, "Discarded?"), "Europe").click();
  await sendRegion(page).getByRole("button", { name: "Discard" }).click();
  await expect(sendRegion(page)).toHaveCount(0);
  await expect(
    choiceButton(card(page, "Discarded?"), "Europe"),
  ).toHaveAttribute("aria-pressed", "false");
  expect(await storedDraft(page, id)).toBeNull();
  await page.reload();
  await expect(card(page, "Discarded?")).toBeVisible();
  await expect(sendButton(page)).toHaveCount(0);
  expect(sent).toHaveLength(0);
  expect(stored(served, id).state).toBe("open");
});

test("dismissing a drafted question here keeps its words as a notice", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const id = raiseQuestion(served, { key: "dismissed", title: "Dismissed?" });
  await open(page, served);
  await answerBox(page, "Dismissed?").fill("Words kept after dismissing");
  await page.getByRole("button", { name: "Dismiss: Dismissed?" }).click();
  const notices = page.getByRole("list", { name: "Not sent" });
  await expect(notices).toContainText("dismissed here");
  await expect(notices).toContainText("Words kept after dismissing");
  expect(await storedDraft(page, id)).toBeNull();
  await expect(sendButton(page)).toHaveCount(0);
});

test("what storage holds is only used if valid, and a browser that keeps nothing can still draft and send", async ({
  page,
  context,
}) => {
  const served = await serveWorld("queue");
  const good = raiseQuestion(served, {
    key: "stored-good",
    title: "Stored good?",
    choices: REGIONS,
  });
  await open(page, served);
  await choiceButton(card(page, "Stored good?"), "Europe").click();
  // llmlint: ignore-block[tests_mirror_real_usage] the state under test is storage holding bytes no press on this page can write (an older build's or another writer's draft, a key that is no item id), so they can only be put there directly; the page reads them back through the real reload, server and engine.
  await page.evaluate(() => {
    localStorage.setItem(
      "onepipeline-ui.human-items.draft.hi-notjson",
      "{not json",
    );
    localStorage.setItem(
      "onepipeline-ui.human-items.draft.hi-badshape",
      JSON.stringify({ title: 7 }),
    );
    localStorage.setItem(
      "onepipeline-ui.human-items.draft.bad id",
      JSON.stringify({ title: "Bad key", text: "Never sent" }),
    );
  });
  // llmlint: ignore-end[tests_mirror_real_usage]
  await page.reload();
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  expect(await storedDraft(page, good)).not.toBeNull();

  const denied = await context.newPage();
  // llmlint: ignore-block[e2e_not_mocked] a browser that refuses storage (a blocked-cookies profile, an opaque origin) throws exactly these SecurityErrors, and Playwright can neither launch nor toggle that setting per page; the server and every other layer here are real.
  // llmlint: ignore-block[tests_mirror_real_usage] as above: the throw a denied browser produces, which no user action can induce from this page.
  await denied.addInitScript(() => {
    const refuse = () => {
      throw new DOMException("denied", "SecurityError");
    };
    Storage.prototype.getItem = refuse;
    Storage.prototype.setItem = refuse;
    Storage.prototype.removeItem = refuse;
    Storage.prototype.key = refuse;
  });
  // llmlint: ignore-end[tests_mirror_real_usage]
  // llmlint: ignore-end[e2e_not_mocked]
  const typed = raiseQuestion(served, {
    key: "stored-denied",
    title: "Storage denied?",
  });
  await denied.goto(page.url());
  await expect(answerBox(denied, "Storage denied?")).toBeVisible();
  await answerBox(denied, "Storage denied?").fill("Kept for this visit");
  await sendAnswers(denied);
  await expect(card(denied, "Storage denied?")).toHaveCount(0);
  expect(stored(served, typed).resolution?.text).toBe("Kept for this visit");
});

test("a draft another tab discarded is not sent from a tab still showing it", async ({
  page,
  context,
}) => {
  const served = await serveWorld("queue");
  const id = raiseQuestion(served, {
    key: "two-tabs",
    title: "Two tabs?",
    choices: REGIONS,
  });
  await open(page, served);
  await choiceButton(card(page, "Two tabs?"), "Europe").click();
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(sendButton(other)).toHaveText("Send 1 answer");
  const sent = writes(other);
  await sendRegion(page).getByRole("button", { name: "Discard" }).click();
  await sendAnswers(other);
  await expect(sendRegion(other)).toHaveCount(0);
  expect(sent).toHaveLength(0);
  expect(stored(served, id).state).toBe("open");
});

test("more drafts than one batch takes go out fifty at a time, and the rest wait", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const ids = Array.from({ length: 51 }, (_, at) =>
    raiseQuestion(served, { key: `cap-${at}`, title: `Capped ${at}?` }),
  );
  await open(page, served);
  for (let at = 0; at < 51; at += 1)
    await answerBox(page, `Capped ${at}?`).fill("Capped");
  await expect(sendButton(page)).toHaveText("Send 50 answers");
  await expect(sendRegion(page)).toContainText("1 more after this");
  const sent = writes(page);
  await sendAnswers(page);
  await expect(sendButton(page)).toHaveText("Send 1 answer");
  expect(batchesOf(sent)[0]?.answers).toHaveLength(50);
  await sendAnswers(page);
  await expect(sendRegion(page)).toHaveCount(0);
  expect(batchesOf(sent)).toHaveLength(2);
  for (const id of ids) expect(stored(served, id).state).toBe("answered");
});

const HOSTILE = [
  "<script>window.__pwn='script'</script>",
  "<img src=x onerror=\"window.__pwn='img'\">",
  "[the link](javascript:window.__pwn='link')",
  "![remote](https://evil.example.org/pixel.png)",
].join("\n\n");

test("choices and answers carrying hostile markup are shown as readable text and do nothing", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const images: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("evil.example.org")) images.push(request.url());
  });
  const asked = raiseQuestion(served, {
    key: "hostile-choices",
    title: "Hostile choices?",
    choices: [
      {
        id: "tag",
        title: "<script>window.__pwn='title'</script>",
        description: HOSTILE,
      },
      { id: "safe", title: "Plain", description: "A plain description." },
    ],
  });
  const viaPage = raiseQuestion(served, {
    key: "hostile-page",
    title: "Hostile page answer?",
    choices: REGIONS,
  });
  const viaCli = raiseQuestion(served, {
    key: "hostile-cli",
    title: "Hostile CLI answer?",
  });
  const noticed = raiseQuestion(served, {
    key: "hostile-notice",
    title: "Hostile notice?",
  });
  cli(served, ["human-items", "answer", viaCli, "--text", HOSTILE], SUPERVISOR);
  await open(page, served);
  const assertHarmless = async () => {
    expect(
      await page.evaluate(() => Reflect.get(window, "__pwn")),
    ).toBeUndefined();
    expect(images).toEqual([]);
    // llmlint: ignore[e2e_uses_accessible_selectors] what is asserted is that no such attribute reached the DOM, which no role or name can express.
    expect(await page.locator("[onerror]").count()).toBe(0);
    // llmlint: ignore[e2e_uses_accessible_selectors] as above: the assertion is about an href value no link's accessible name carries.
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  };

  const hostile = card(page, "Hostile choices?");
  await expect(
    hostile.getByRole("button", {
      name: "<script>window.__pwn='title'</script>",
    }),
  ).toBeVisible();
  const pane = await openDetail(page, "Hostile choices?");
  await expect(pane).toContainText("<script>window.__pwn='script'</script>");
  await expect(pane).toContainText("the link");
  await assertHarmless();
  await pane.getByRole("button", { name: "Close detail" }).click();

  // A choice plus hostile words, sent through the page.
  const answeringPane = await openDetail(page, "Hostile page answer?");
  await choiceButton(answeringPane, "Europe").click();
  await answeringPane
    .getByRole("textbox", { name: "Answer in detail: Hostile page answer?" })
    .fill(HOSTILE);
  await answerBox(page, "Hostile notice?").fill(HOSTILE);
  await setUpdates(page, "Off");
  cli(served, ["human-items", "dismiss", noticed], SUPERVISOR);
  await sendAnswers(page);
  const notices = page.getByRole("list", { name: "Not sent" });
  await expect(notices).toContainText("Hostile notice?");
  await expect(notices).toContainText("<script>window.__pwn='script'</script>");
  await assertHarmless();
  expect(stored(served, viaPage).resolution?.text).toBe(HOSTILE);
  expect(asked).toBeTruthy();

  // After a reload, under the answered filter, the stored words are read back.
  await page.reload();
  await page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("State", { exact: true })
    .selectOption("answered");
  for (const title of ["Hostile page answer?", "Hostile CLI answer?"]) {
    const answered = card(page, title);
    await expect(answered).toContainText(
      "<script>window.__pwn='script'</script>",
    );
    await expect(answered).toContainText("the link");
  }
  await expect(card(page, "Hostile page answer?")).toContainText("Europe");
  const detail = await openDetail(page, "Hostile page answer?");
  await expect(detail).toContainText("<img src=x");
  await assertHarmless();

  // The link's text is shown, and pressing it goes nowhere.
  const url = page.url();
  await detail.getByText("the link", { exact: true }).click();
  expect(page.url()).toBe(url);
  await assertHarmless();
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  test(`at ${width} wide choice buttons and card actions are compact, and the bar clears the toast and every card action`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: width === 390,
    });
    const page = await context.newPage();
    const served = await serveWorld("queue");
    const title = "Compact choices?";
    raiseQuestion(served, { key: "compact", title, choices: REGIONS });
    await open(page, served);
    const shown = card(page, title);
    await shown.scrollIntoViewIfNeeded();
    const buttons = await Promise.all(
      REGIONS.map((choice) => box(choiceButton(shown, choice.title))),
    );
    const cardBox = await box(shown);
    for (const button of buttons) {
      expect(button.height).toBeGreaterThanOrEqual(28);
      expect(button.height).toBeLessThanOrEqual(32);
      expect(inside(button, cardBox)).toBe(true);
    }
    expect(new Set(buttons.map(({ y }) => Math.round(y))).size).toBe(1);
    for (const [left, right] of [
      [buttons[0], buttons[1]],
      [buttons[1], buttons[2]],
    ] as const) {
      if (left === undefined || right === undefined)
        throw new Error("a button");
      expect(right.x - (left.x + left.width)).toBeGreaterThanOrEqual(8 - 0.5);
    }

    // A card's own controls, one line and clear of one another.
    const task = card(page, "Restore the build service");
    await task.scrollIntoViewIfNeeded();
    const controls = await Promise.all(
      ["Details", "Complete", "Dismiss"].map((verb) =>
        box(
          task.getByRole("button", {
            name: `${verb}: Restore the build service`,
          }),
        ),
      ),
    );
    for (const control of controls) {
      expect(control.height).toBeGreaterThanOrEqual(28);
      expect(control.height).toBeLessThanOrEqual(32);
    }
    for (const [index, control] of controls.entries()) {
      const next = controls[index + 1];
      if (next === undefined) continue;
      const apart =
        Math.round(control.y) === Math.round(next.y)
          ? next.x - (control.x + control.width)
          : next.y - (control.y + control.height);
      expect(apart).toBeGreaterThanOrEqual(8 - 0.5);
    }

    // At the expanded view each title button is as compact, description beneath.
    const pane = await openDetail(page, title);
    for (const choice of REGIONS) {
      const button = await box(choiceButton(pane, choice.title));
      expect(button.height).toBeGreaterThanOrEqual(28);
      expect(button.height).toBeLessThanOrEqual(32);
      const description = await box(pane.getByText(choice.description));
      expect(description.y).toBeGreaterThanOrEqual(
        button.y + button.height - 1,
      );
      expect(description.y).toBeLessThanOrEqual(button.y + button.height + 8);
    }
    await pane.getByRole("button", { name: "Close detail" }).click();

    if (width === 390) {
      await choiceButton(shown, "Europe").tap();
      await expect(choiceButton(shown, "Europe")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await choiceButton(shown, "Europe").tap();
      await expect(sendButton(page)).toHaveCount(0);
      await task
        .getByRole("button", { name: "Details: Restore the build service" })
        .tap();
      await expect(
        detailPane(page).getByRole("heading", {
          name: "Restore the build service",
        }),
      ).toBeVisible();
      await detailPane(page)
        .getByRole("button", { name: "Close detail" })
        .click();
    }

    // A draft out, a notice under the bar and a toast at once: none overlaps.
    const vanishing = raiseQuestion(served, {
      key: "compact-gone",
      title: "Gone soon?",
    });
    await expect(answerBox(page, "Gone soon?")).toBeVisible();
    await answerBox(page, "Gone soon?").fill("Words for the notice");
    cli(served, ["human-items", "dismiss", vanishing], SUPERVISOR);
    await expect(page.getByRole("list", { name: "Not sent" })).toBeVisible();
    await choiceButton(shown, "Europe").click();
    await task
      .getByRole("button", { name: "Complete: Restore the build service" })
      .click();
    await expect(toast(page)).toBeVisible();
    await expect(sendButton(page)).toBeVisible();
    const region = await box(sendRegion(page));
    const toasted = await box(toast(page));
    expect(overlap(region, toasted)).toBe(false);
    // The list ends where the bar starts, so what scrolls past is clipped by it.
    const listed = await box(listRegion(page));
    expect(listed.y + listed.height).toBeLessThanOrEqual(region.y + 1);
    for (const action of await page
      .getByRole("article")
      .getByRole("button")
      .all()) {
      if (!(await action.isVisible()) || !(await action.isEnabled())) continue;
      const button = await box(action);
      if (button.y + button.height <= listed.y) continue;
      if (button.y >= listed.y + listed.height) continue;
      expect(overlap(button, region), "a card action under the bar").toBe(
        button.y + button.height > listed.y + listed.height,
      );
    }
    await context.close();
  });

  test(`at ${width} wide a detail leads with the item and ends in a labelled metadata block`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const served = await serveWorld("queue");
    const question = "Which region for the metadata test?";
    raiseQuestion(served, {
      key: "metadata",
      title: question,
      choices: REGIONS,
    });
    await open(page, served);
    const checks: [string, boolean][] = [
      [question, true],
      ["Restore the build service", false],
    ];
    for (const [title, asks] of checks) {
      const pane = await openDetail(page, title);
      const heading = await box(pane.getByRole("heading", { name: title }));
      const bodyRegion = pane.getByRole("region", { name: "Full body" });
      const body = await box(bodyRegion);
      expect(body.y).toBeGreaterThanOrEqual(heading.y);
      let last = body.y + body.height;
      if (asks) {
        const answer = await box(pane.getByRole("textbox"));
        const list = await box(pane.getByRole("group", { name: "Choices" }));
        expect(list.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
        expect(answer.y).toBeGreaterThanOrEqual(list.y);
        last = answer.y + answer.height;
      }
      // llmlint: ignore[e2e_uses_accessible_selectors] the criterion is that the block is a `<dl>`, an element ARIA has no role for as a whole; its fields are read by role just below.
      const block = pane.locator("dl");
      await expect(block).toHaveCount(1);
      const blockBox = await box(block);
      expect(blockBox.y).toBeGreaterThanOrEqual(last - 1);
      const labels = await pane.getByRole("term").allTextContents();
      for (const label of [
        "Priority",
        "Kind",
        "State",
        "Source",
        "Blocks",
        "Raised",
      ])
        expect(labels).toContain(label);
      // None of those values reads above the body.
      for (const label of ["Priority", "Kind", "State", "Raised"]) {
        const value = (await metadataOf(pane, label).textContent()) ?? "";
        const above = await pane.evaluate(
          (element, [text, stop]) => {
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.parentElement?.closest("dl")) continue;
              if (node.textContent !== text) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              if (range.getBoundingClientRect().y < Number(stop)) return true;
            }
            return false;
          },
          [value, String(body.y)] as const,
        );
        expect(above).toBe(false);
      }
      await pane.getByRole("button", { name: "Close detail" }).click();
    }
  });

  test(`at ${width} wide long text wraps or clamps predictably and never scrolls the page sideways`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const served = await serveWorld("long-tracker");
    const longTitle = `Should the very long question title that keeps going ${"and going ".repeat(12)}finally end here?`;
    const longBody = `${"This body is long enough to clamp on a card. ".repeat(60)}Final words.`;
    const longDescription = `${"This choice's description is long and wraps in full. ".repeat(20)}End of description.`;
    const longName = `plan-${"x".repeat(70)}`;
    const longRun = `run-${"y".repeat(70)}`;
    const nearLimit =
      "A choice title that sits right at the engine's limit of eighty characters total";
    expect([...nearLimit].length).toBeGreaterThanOrEqual(78);
    expect([...nearLimit].length).toBeLessThanOrEqual(80);
    const id = raiseQuestion(served, {
      key: "long-text",
      title: longTitle,
      body: longBody,
      choices: [
        { id: "near", title: nearLimit, description: longDescription },
        { id: "short", title: "Short", description: "Brief." },
      ],
      owner: {
        session: `session-${"z".repeat(70)}`,
        run: longRun,
        plan: longName,
      },
    });
    await open(page, served);
    const shown = card(page, longTitle);
    await shown.scrollIntoViewIfNeeded();

    const heading = shown.getByRole("heading", { level: 3 });
    await expect(heading).toHaveText(longTitle);
    const headingBox = await box(heading);
    if (width === 390) expect(headingBox.height).toBeGreaterThan(40);
    expect(
      await heading.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);

    // llmlint: ignore[e2e_uses_accessible_selectors] what is asserted is the shared package's own clamped box, which only its `otg-` class names.
    const clamp = shown.locator(".otg-markdown--clamped");
    const clamped = await clamp.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        lines: style.webkitLineClamp,
        overflows: element.scrollHeight > element.clientHeight,
      };
    });
    expect(clamped.lines).toBe("4");
    expect(clamped.overflows).toBe(true);

    const near = await box(choiceButton(shown, nearLimit));
    const short = await box(choiceButton(shown, "Short"));
    const cardBox = await box(shown);
    expect(near.height).toBeGreaterThan(40);
    expect(short.height).toBeLessThanOrEqual(32);
    expect(inside(near, cardBox)).toBe(true);
    await expect(shown).toContainText(longRun);
    await expect(shown).toContainText(longName);

    const pane = await openDetail(page, longTitle);
    await expect(pane.getByRole("region", { name: "Full body" })).toContainText(
      "Final words.",
    );
    await expect(pane).toContainText("End of description.");
    const nearInDetail = await box(choiceButton(pane, nearLimit));
    expect(nearInDetail.height).toBeGreaterThan(40);
    expect(nearInDetail.height).toBeLessThanOrEqual(66);
    const source = metadataOf(pane, "Source");
    await expect(source).toContainText(longRun);
    await expect(metadataOf(pane, "Plan")).toHaveText(longName);
    await expect(metadataOf(pane, "Run")).toHaveText(longRun);
    expect(
      await pane.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    expect(id).toBeTruthy();
    await pane.getByRole("button", { name: "Close detail" }).click();

    // A long tracker reference is cut in its chip and whole in its metadata.
    const tracked = "Carry a very long tracker reference";
    const reference =
      stored(served, idOf(served, "tracked")).tracker?.task ?? "";
    expect(reference.length).toBeGreaterThan(60);
    const chip = card(page, tracked).getByRole("link", {
      name: new RegExp(escapeRegExp(reference), "u"),
    });
    await expect(chip).toHaveAttribute("title", reference);
    expect(
      await chip.evaluate((element) => ({
        cut: element.scrollWidth > element.clientWidth,
        ellipsis: getComputedStyle(element).textOverflow,
      })),
    ).toEqual({ cut: true, ellipsis: "ellipsis" });
    const trackedPane = await openDetail(page, tracked);
    await expect(metadataOf(trackedPane, "Tracker")).toHaveText(reference);
  });
}
