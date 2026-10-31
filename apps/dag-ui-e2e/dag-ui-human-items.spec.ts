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

/** The page, opened at its own address on the server's origin. */
async function open(page: Page, served: FixtureServer): Promise<Locator> {
  await page.goto(`${served.origin}/human-items`);
  const list = page.getByRole("list", { name: "Action items" });
  await expect(list.getByRole("listitem").first()).toBeVisible();
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

function outcome(page: Page): Locator {
  return page.getByRole("status", { name: "Last outcome" });
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
  const list = page.getByRole("list", { name: "Action items" });
  await expect(list.getByRole("listitem")).toHaveCount(DECLARED.length);

  await nav.getByRole("button", { name: "Host" }).click();
  await expect(page).toHaveURL(/\/\?page=host$/u);
  const host = page.getByRole("region", { name: "Host" });
  await expect(host.getByRole("heading", { name: /This host/u })).toBeVisible();
  await expect(
    host.getByRole("button", { name: "Refresh host" }),
  ).toBeVisible();
  // The Host page carries none of the action items: no list, no card, no title.
  await expect(page.getByRole("list", { name: "Action items" })).toHaveCount(0);
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
  await expect(page.getByRole("list", { name: "Action items" })).toHaveCount(0);
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
    .getByRole("button", { name: /^Open / })
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

test("lists every open item of the session in the engine's order, as compact full-width cards", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  expect(await titles(list)).toEqual(DECLARED.map(({ title }) => title));
  // The engine's own order, as its CLI lists the same journal.
  expect(
    listed(served, ["--session", SUPERVISOR]).map(({ item }) => item.title),
  ).toEqual(DECLARED.map(({ title }) => title));

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

  // The session's own items only: another session's item is not shown.
  await expect(page.getByText("Rotate the deploy credentials")).toHaveCount(0);
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
  await expect(filters.getByRole("combobox")).toHaveCount(5);
  for (const name of ["Kind", "Blocking", "Priority", "State", "Source"])
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
  const list = await open(page, served);
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
  for (const { title, key } of DECLARED) {
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
  await expect(
    detailPane(page).getByText("blocks all work on this host", { exact: true }),
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
  const choose = async (label: string, value: string, query: string) => {
    const read = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/human-items" &&
        new URL(request.url()).search === query,
    );
    await filters.getByLabel(label, { exact: true }).selectOption(value);
    await read;
  };
  const reset = async (label: string, value: string) =>
    choose(label, value, "");
  /** What the engine's CLI selects for `args`, for this session. */
  const selected = (args: string[]) =>
    listed(
      served,
      args.includes("--session") ? args : [...args, "--session", SUPERVISOR],
    ).map(({ item }) => item.title);

  await choose("Kind", "question", "?kind=question");
  await expect.poll(() => titles(list)).toEqual(QUESTIONS);
  expect(selected(["--kind", "question"])).toEqual(QUESTIONS);
  await reset("Kind", "");

  await choose("Blocking", "yes", "?blocking=true");
  await expect
    .poll(() => titles(list))
    .toEqual(DECLARED.slice(0, 3).map(({ title }) => title));
  expect(selected(["--blocking", "yes"])).toEqual(await titles(list));
  await choose("Blocking", "no", "?blocking=false");
  await expect
    .poll(() => titles(list))
    .toEqual(DECLARED.slice(3).map(({ title }) => title));
  expect(selected(["--blocking", "no"])).toEqual(await titles(list));
  await reset("Blocking", "");

  // Critical on the page is urgent on the wire.
  await choose("Priority", "urgent", "?priority=urgent");
  await expect
    .poll(() => titles(list))
    .toEqual([
      "Restore the build service",
      "Should retries reuse the warm cache?",
    ]);
  expect(selected(["--priority", "Critical"])).toEqual(await titles(list));
  await expect(list.getByText("Critical", { exact: true })).toHaveCount(2);
  await reset("Priority", "");

  await choose("State", "answered", "?state=answered");
  await expect
    .poll(() => titles(list))
    .toEqual(["Which changelog section holds the fix?"]);
  await choose("State", "dismissed", "?state=dismissed");
  await expect
    .poll(() => titles(list))
    .toEqual(["Re-run the flaky screenshot job"]);
  // A state nothing is in is an empty list, said so.
  await choose("State", "completed", "?state=completed");
  await expect(
    listRegion(page).getByRole("status").filter({
      hasText: "No action items match these filters.",
    }),
  ).toBeVisible();
  await choose("State", "open", "");

  await choose("Source", "host", "?host=true");
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
    ["session", SUPERVISOR, DECLARED.map(({ title }) => title)],
  ] as const) {
    await filters.getByLabel("Source", { exact: true }).selectOption(source);
    const read = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/human-items" &&
        new URL(request.url()).searchParams.get(source) === id,
    );
    await filters.getByLabel("Source identifier").fill(id);
    await read;
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
  await expect(outcome(page)).toHaveText(`${first}: Answered`);
  await expect(card(page, first)).toHaveCount(0);
  await expect(detailPane(page)).toHaveCount(0);
  expect(sent.map((request) => request.postData())).toEqual([
    JSON.stringify({ text: "eu-west, matching the incident report" }),
  ]);
  const region = idOf(served, "region");
  expect(stored(served, region)).toMatchObject({
    state: "answered",
    resolution: {
      actor: SUPERVISOR,
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
  await expect(outcome(page)).toHaveText(`${composing}: Answered`);
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
  // Dismiss, with no reason, from the keyboard alone.
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Dismiss Restore the build service",
  });
  await expect(dialog.getByLabel("Reason (optional)")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(outcome(page)).toHaveText(
    "Restore the build service: Dismissed",
  );
  await expect(card(page, "Restore the build service")).toHaveCount(0);
  expect(stored(served, idOf(served, "build"))).toMatchObject({
    state: "dismissed",
    resolution: { actor: SUPERVISOR, reason: null },
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
  for (const [role, name] of [
    ["button", `Dismiss: ${region}`],
    ["button", "Details: Keep the legacy export format?"],
    ["button", "Dismiss: Keep the legacy export format?"],
    ["button", `Details: ${LAST_QUESTION}`],
    ["button", `Dismiss: ${LAST_QUESTION}`],
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
    "Review the action-items design: Completed",
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
    "Review the action-items design: Completed",
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
      actor: SUPERVISOR,
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
    "Review the dashboard layout: Re-read the current document",
  );
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
    "Review the dashboard layout: Completed",
  );
  expect(approvals(served)[1]).toEqual({
    board_copy: "docs/design/dashboard.md",
    key: "sha256:c4e2f9",
    actor: SUPERVISOR,
    on_behalf_of: null,
  });
  const told = watch(served, SUPERVISOR).map(([kind]) => kind);
  expect(told).toContain("human-item-completed");
});

test("a dismissal sends a reason only when one is written", async ({
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
  const dialog = page.getByRole("dialog", {
    name: "Dismiss Keep the legacy export format?",
  });
  await dialog.getByLabel("Reason (optional)").fill("the export stays");
  await dialog.getByRole("button", { name: "Dismiss item" }).click();
  await expect(outcome(page)).toHaveText(
    "Keep the legacy export format?: Dismissed",
  );
  expect(stored(served, idOf(served, "export")).resolution?.reason).toBe(
    "the export stays",
  );

  await page
    .getByRole("button", { name: "Dismiss: Review the dashboard layout" })
    .click();
  await page
    .getByRole("dialog", { name: "Dismiss Review the dashboard layout" })
    .getByRole("button", { name: "Dismiss item" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Review the dashboard layout: Dismissed",
  );
  expect(stored(served, idOf(served, "dashboard")).resolution?.reason).toBe(
    null,
  );
  expect(sent.map((request) => request.postData())).toEqual([
    JSON.stringify({ reason: "the export stays" }),
    "{}",
  ]);
  expect(watch(served, SUPERVISOR)).toEqual([
    ["human-item-dismissed", idOf(served, "export")],
    ["human-item-dismissed", idOf(served, "dashboard")],
  ]);
  expect(watch(served, OTHER)).toEqual([]);

  // Cancelling sends nothing.
  await page
    .getByRole("button", { name: "Dismiss: Restore the build service" })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(sent).toHaveLength(2);
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
    "Should retries reuse the warm cache?: Answered",
  );
  // The pane stays on the item, now answered.
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
    "Review the action-items design: Completed",
  );
  await expect(pane.getByText("Task · Completed")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Complete" })).toHaveCount(0);

  await page
    .getByRole("button", { name: "Details: Review the dashboard layout" })
    .click();
  await pane.getByRole("button", { name: "Dismiss" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Dismiss Review the dashboard layout",
  });
  await dialog.getByLabel("Reason (optional)").fill("superseded");
  await dialog.getByRole("button", { name: "Dismiss item" }).click();
  await expect(outcome(page)).toHaveText(
    "Review the dashboard layout: Dismissed",
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
  await expect(outcome(page)).toHaveText(`${title}: Answered`);
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

  // A task's Complete and Dismiss are held to one write the same way: while
  // its receipt is out, further clicks send nothing.
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
  await expect(card(page, design).getByRole("status")).toHaveText("Sending…");
  await page.getByRole("button", { name: `Complete: ${design}` }).click();
  await page.getByRole("button", { name: `Dismiss: ${design}` }).click();
  await page
    .getByRole("dialog", { name: `Dismiss ${design}` })
    .getByRole("button", { name: "Dismiss item" })
    .click();
  expect(sent).toHaveLength(2);
  releaseTask();
  await expect(outcome(page)).toHaveText(`${design}: Completed`);
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
  await expect(outcome(page)).toHaveText(`${question}: Answered`);
  expect(stored(served, idOf(served, "export")).resolution?.text).toBe(
    "Keep it one more release",
  );

  // The server stops answering at all: the write's connection fails, the item
  // and its card stay, and once a server is back over the same journal the
  // same action succeeds.
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
    "Restore the build service: Completed",
  );
  expect(stored(served, idOf(served, "build")).state).toBe("completed");
});

test("a write by a server acting for another session is refused, changes nothing, and lands once the owner is back", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  await open(page, served);
  const sent = writes(page);
  const question = "Should retries reuse the warm cache?";
  const task = "Restore the build service";

  // After the page read them, the server is replaced by one acting for
  // another session over the same journal: its authority refuses the one
  // write of each in the engine's words, the next read no longer shows the
  // item, and the journal is unchanged.
  for (const [key, title, act] of [
    [
      "cache",
      question,
      async () => {
        await answerBox(page, question).fill("Reuse it");
        await answerBox(page, question).press("Enter");
      },
    ],
    [
      "build",
      task,
      () => page.getByRole("button", { name: `Complete: ${task}` }).click(),
    ],
  ] as const) {
    const id = idOf(served, key);
    await actAs(served, OTHER);
    const before = journal(served);
    const count = sent.length;
    await act();
    await expect(outcome(page)).toHaveText(
      `${title}: human item ${id} belongs to another session; its content and its actions are that session's`,
    );
    await expect(card(page, title)).toHaveCount(0);
    expect(sent).toHaveLength(count + 1);
    const response = await sent[count]?.response();
    if (!response) throw new Error(`the write to ${id} had no response`);
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe("human_item_not_owner");
    expect(journal(served)).toBe(before);
    expect(stored(served, id).state).toBe("open");
    // The other session's own item is what that server lists.
    await expect(card(page, "Rotate the deploy credentials")).toBeVisible();
    await actAs(served, SUPERVISOR);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(card(page, title)).toBeVisible();
  }

  // The owner reconnected: the refused answer's draft is still there and
  // lands as written.
  await expect(answerBox(page, question)).toHaveValue("Reuse it");
  await answerBox(page, question).press("Enter");
  await expect(outcome(page)).toHaveText(`${question}: Answered`);
  expect(stored(served, idOf(served, "cache")).resolution?.text).toBe(
    "Reuse it",
  );
});

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

  // A server acting for another session: the reread is refused, and nothing
  // of the item's content or its actions stays on screen — only why, and a way
  // out.
  await actAs(served, OTHER);
  await refresh();
  await expect(card(page, region)).toHaveCount(0);
  await expect(pane.getByRole("alert")).toContainText(
    "belongs to another session",
  );
  await expect(pane.getByRole("heading", { name: region })).toHaveCount(0);
  await expect(steps).toHaveCount(0);
  await expect(pane.getByRole("button", { name: /^Dismiss/ })).toHaveCount(0);

  // The owner is back: the same pane reads it again in full.
  await actAs(served, SUPERVISOR);
  await refresh();
  await expect(pane.getByRole("heading", { name: region })).toBeVisible();
  await expect(steps).toHaveCount(5);
  await expect(pane.getByRole("alert")).toHaveCount(0);

  // Refused again, the pane's own Close dismisses it.
  await actAs(served, OTHER);
  await refresh();
  await expect(pane.getByRole("alert")).toContainText(
    "belongs to another session",
  );
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
  await page.route("**/api/human-items", async (route) => {
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
  await page.getByRole("button", { name: "Refresh" }).click();
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
  await expect(outcome(page)).toHaveText(`${LAST_QUESTION}: Answered`);
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

test("ten sessions each see only their own items, and each answer reaches only its owner's watch", async ({
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
    await expect.poll(() => titles(list)).toEqual(own);
    const question = `Which day should ${session} ship?`;
    await answerBox(page, question).fill("Thursday");
    await answerBox(page, question).press("Enter");
    await expect(outcome(page)).toHaveText(`${question}: Answered`);
    const id = idOf(served, `${session}-question`);
    expect(stored(served, id).resolution).toEqual({
      actor: session,
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
  const body = long.getByText(longText, { exact: true });
  const clamp = await body.evaluate((element) => {
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
      await short.evaluate((element) => ({
        clipped: element.scrollHeight > element.clientHeight,
        lines: Math.round(
          element.clientHeight /
            Number.parseFloat(getComputedStyle(element).lineHeight),
        ),
      })),
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
        Math.abs(box.top - (boxes[index - 1]?.bottom ?? 0) - 6),
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
  const shown = await full.evaluate((element) => {
    const text = element.firstChild;
    if (text === null) throw new Error("the body holds no text");
    const range = document.createRange();
    const words = "ship the reviewed release.";
    const at = (text.textContent ?? "").lastIndexOf(words);
    range.setStart(text, at);
    range.setEnd(text, at + words.length);
    const word = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return word.top >= box.top && word.bottom <= box.bottom + 1;
  });
  expect(shown).toBe(true);
  expect(await region.evaluate((element) => element.scrollTop)).toBe(
    before.list,
  );
  expect(await positions()).toEqual(before.cards);
  expect((await pane.getByRole("heading", { level: 2 }).boundingBox())?.y).toBe(
    before.heading,
  );
  // The CLI prints the same body whole, in its list and its report.
  for (const verb of ["list", "report"])
    expect(cli(served, ["human-items", verb])).toContain(longText);
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

test("a read overtaken by a newer one never replaces what the newer one showed", async ({
  page,
}) => {
  const served = await serveWorld("queue");
  const list = await open(page, served);
  const filters = page.getByRole("group", { name: "Filter action items" });

  // The list: the read for tasks is held while the read for questions lands;
  // when the tasks' answer finally arrives it is dropped.
  let releaseTasks: () => void = () => {};
  const tasksHeld = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });
  await page.route("**/api/human-items?kind=task", async (route) => {
    await tasksHeld;
    await route.continue();
  });
  const tasksAsked = page.waitForRequest((request) =>
    request.url().endsWith("/api/human-items?kind=task"),
  );
  await filters.getByLabel("Kind", { exact: true }).selectOption("task");
  await tasksAsked;
  await filters.getByLabel("Kind", { exact: true }).selectOption("question");
  await expect.poll(() => titles(list)).toEqual(QUESTIONS);
  const tasksAnswered = page.waitForResponse((response) =>
    response.url().endsWith("/api/human-items?kind=task"),
  );
  releaseTasks();
  await tasksAnswered;
  await expect(list.getByRole("article")).toHaveCount(QUESTIONS.length);
  expect(await titles(list)).toEqual(QUESTIONS);
  await page.unroute("**/api/human-items?kind=task");

  // The detail: the first item's read is held while the second item opens;
  // the first's late answer does not take the pane back.
  const region = idOf(served, "region");
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route(`**/api/human-items/${region}`, async (route) => {
    await firstHeld;
    await route.continue();
  });
  await page
    .getByRole("button", {
      name: "Details: Which region should the canary run in?",
    })
    .click();
  await page.getByRole("button", { name: `Details: ${LAST_QUESTION}` }).click();
  const pane = detailPane(page);
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(
    LAST_QUESTION,
  );
  const firstAnswered = page.waitForResponse((response) =>
    response.url().endsWith(`/api/human-items/${region}`),
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
        `serve-fixture: '${name}' is not a human-items world; name one of sessions, queue, long`,
      );
      expect(existsSync(join(workspace, "runs")), name).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});
