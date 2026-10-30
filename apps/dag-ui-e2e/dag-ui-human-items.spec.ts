import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * serving the engine's own sample adapter (`--human-items-sample`).
 *
 * Each journey starts a server of its own over a fresh copy of a bundle in
 * `tests/fixtures/human-items/`, because every write lands in that copy. What
 * answers is the item-contract release's `HumanItemSample` — nothing here or in
 * the app stands in for the engine. A connection failure is the server really
 * stopping; the one request held on its way is a delayed receipt, released
 * untouched. These prove the UI/API contract over the sample adapter, not the
 * engine's runtime lifecycle.
 */

const factsSchema = z.object({ sample: z.string().min(1) });

/** The part of a bundle a hand-over rewrites; every other field is kept as read. */
const ownedBundleSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      item: z.looseObject({
        id: z.string(),
        owner: z.looseObject({ session: z.string() }),
      }),
    }),
  ),
});

const bundleSchema = z.object({
  items: z.array(
    z.object({
      item: z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
        state: z.string(),
        resolution: z
          .object({
            actor: z.string(),
            text: z.string().nullable(),
            reason: z.string().nullable(),
          })
          .nullable(),
      }),
    }),
  ),
  approvals: z
    .array(
      z.object({
        approval: z.object({ board_copy: z.string(), key: z.string() }),
        actor: z.string(),
        on_behalf_of: z.string().nullable(),
      }),
    )
    .optional(),
});

const listSchema = z.object({
  items: z.array(
    z.object({ item: z.object({ title: z.string(), priority: z.string() }) }),
  ),
});

/** The visible open items of `representative.json`, in the engine's order. */
const DECLARED = [
  {
    title: "Restore the build service",
    kind: "Task",
    priority: "Critical",
    wire: "urgent",
    blocks: "blocks all work on this host",
    source: "Source: host",
    tracker: "Open GitHub issue nickderobertis/onepipeline#1301",
  },
  {
    title: "Which region should the canary run in?",
    kind: "Question",
    priority: "High",
    wire: "high",
    blocks: "blocks 2 steps in plan-a: deploy, verify",
    source: "Source: plan plan-a / run run-a",
  },
  {
    title: "Review the action-items design",
    kind: "Task",
    priority: "High",
    wire: "high",
    blocks:
      "blocks 5 steps in plan-a: build, test, lint +2 more; blocks 2 steps in plan-b: docs, screens",
    source: "Source: plan plan-a / run run-a",
    tracker: "Open Linear issue ONE-412",
  },
  {
    title: "Review the dashboard layout",
    kind: "Task",
    priority: "Medium",
    wire: "medium",
    blocks: "blocks all of plan-b",
    source: "Source: plan plan-b / run run-b",
    tracker: "Open GitHub issue nickderobertis/onepipeline#1302",
  },
  {
    title: "Should retries reuse the warm cache?",
    kind: "Question",
    priority: "Critical",
    wire: "urgent",
    blocks: undefined,
    source: "Source: session claude-code-supervising-session",
  },
  {
    title: "Keep the legacy export format?",
    kind: "Question",
    priority: "Low",
    wire: "low",
    blocks: undefined,
    source: "Source: plan plan-b / run run-b",
  },
] as const;

const QUESTIONS = DECLARED.filter(({ kind }) => kind === "Question").map(
  ({ title }) => title,
);
const LAST_QUESTION = "Keep the legacy export format?";

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test.use({ viewport: { width: 1440, height: 900 } });

async function serveBundle(name: string): Promise<FixtureServer> {
  server = await startFixtureServer(`human-items-${name}`, [
    "--human-items-sample",
    name,
  ]);
  return server;
}

function bundleOf(served: FixtureServer) {
  const { sample } = factsSchema.parse(served.facts);
  return bundleSchema.parse(JSON.parse(readFileSync(sample, "utf8")));
}

function stored(served: FixtureServer, id: string) {
  const found = bundleOf(served).items.find(({ item }) => item.id === id);
  if (found === undefined) throw new Error(`no item ${id} in the bundle`);
  return found.item;
}

/** The body the bundle holds for the item titled `title`. */
function bodyOf(served: FixtureServer, title: string): string {
  const found = bundleOf(served).items.find(({ item }) => item.title === title);
  if (found === undefined) throw new Error(`no item titled ${title}`);
  return found.item.body;
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
 * observed rather than answered, so nothing stands in for the tracker — and
 * made with the browser offline, so it never leaves this host for GitHub or
 * Linear. The page's own reads are done by then, and it is put back online.
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

function card(page: Page, title: string): Locator {
  return page.getByRole("article", { name: title });
}

function answerBox(page: Page, title: string): Locator {
  return page.getByRole("textbox", { name: `Answer: ${title}`, exact: true });
}

function outcome(page: Page): Locator {
  return page.getByRole("status", { name: "Last outcome" });
}

/** The bundle `original` with the item `id` handed to another session. */
function handedOver(original: string, id: string): string {
  const bundle = ownedBundleSchema.parse(JSON.parse(original));
  for (const { item } of bundle.items) {
    if (item.id === id) item.owner.session = "other-session";
  }
  return JSON.stringify(bundle);
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
  const served = await serveBundle("representative.json");
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
  await expect(
    page.getByRole("heading", { name: "No DAG runs found" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Action items" })).toHaveCount(0);
});

test("the sidebar's kinds stay on Action items and a run selected from it leaves for the run", async ({
  page,
}) => {
  // A host's live root with runs and run kinds, served without a sample.
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
});

test("lists every open item of the session in the engine's order, as compact full-width cards", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  const list = await open(page, served);
  expect(await titles(list)).toEqual(DECLARED.map(({ title }) => title));

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
      shown.getByText(bodyOf(served, expected.title), { exact: true }),
    ).toBeVisible();
    // Critical is a label: the record says urgent.
    expect(wire.items[index]?.item).toEqual({
      title: expected.title,
      priority: expected.wire,
    });
  }
  // Every task has its tracker link on the card; no question has one.
  const tasks = DECLARED.filter(({ kind }) => kind === "Task");
  await expect(list.getByRole("link")).toHaveCount(tasks.length);
  for (const task of tasks)
    if ("tracker" in task)
      await expect(
        card(page, task.title).getByRole("link", { name: task.tracker }),
      ).toBeVisible();

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
  const served = await serveBundle("representative.json");
  await open(page, served);
  const link = card(page, "Review the action-items design").getByRole("link", {
    name: "Open Linear issue ONE-412",
  });
  const url = "https://linear.app/onepipeline/issue/ONE-412";
  await expect(link).toHaveAttribute("href", url);
  await followed(context, () => link.click(), url);
  await expect(detailPane(page)).toHaveCount(0);
  await expect(card(page, "Review the action-items design")).toHaveAttribute(
    "data-selected",
    "false",
  );
});

test("at 1440×900 six complete cards and all their controls fit the list unscrolled, and selection opens detail beside it", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
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
  for (const { title } of DECLARED) {
    const shown = card(page, title);
    const cardBox = await shown.boundingBox();
    if (cardBox === null) throw new Error("a card has no box");
    expect(cardBox.y).toBeGreaterThanOrEqual(box.y);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(box.y + box.height);
    // Full width: the card spans the list rather than a column of it.
    expect(cardBox.width).toBeGreaterThan(box.width * 0.9);
    const text = bodyOf(served, title);
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
    .getByText("Source: plan plan-a / run run-a", { exact: true })
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

test("the detail enumerates every blocked step, and an open host item is blocking in list and detail", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  await card(page, "Review the action-items design")
    .getByRole("button", { name: "Details: Review the action-items design" })
    .click();
  const steps = detailPane(page).getByRole("region", { name: "Blocked steps" });
  await expect(
    steps.getByRole("heading", { name: "blocks 5 steps in plan-a" }),
  ).toBeVisible();
  await expect(
    steps.getByRole("heading", { name: "blocks 2 steps in plan-b" }),
  ).toBeVisible();
  await expect(steps.getByRole("listitem")).toHaveText([
    "run-a / build: Build the release binaries",
    "run-a / test: Run the release journeys",
    "run-a / lint: Lint the changed files",
    "run-a / package: Package the wheels",
    "run-a / publish: Publish to the registries",
    "run-b / docs: Rewrite the operator guide",
    "run-b / screens: Photograph every surface",
  ]);

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
});

test("every filter narrows the list on its own, on the wire's vocabulary", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
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

  await choose("Kind", "question", "?kind=question");
  await expect.poll(() => titles(list)).toEqual(QUESTIONS);
  await reset("Kind", "");

  await choose("Blocking", "yes", "?blocking=true");
  await expect
    .poll(() => titles(list))
    .toEqual(DECLARED.slice(0, 4).map(({ title }) => title));
  await choose("Blocking", "no", "?blocking=false");
  await expect
    .poll(() => titles(list))
    .toEqual(DECLARED.slice(4).map(({ title }) => title));
  await reset("Blocking", "");

  // Critical on the page is urgent on the wire.
  await choose("Priority", "urgent", "?priority=urgent");
  await expect
    .poll(() => titles(list))
    .toEqual([
      "Restore the build service",
      "Should retries reuse the warm cache?",
    ]);
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

  await filters.getByLabel("Source", { exact: true }).selectOption("run");
  const byRun = page.waitForRequest((request) =>
    request.url().endsWith("/api/human-items?run=run-a"),
  );
  await filters.getByLabel("Source identifier").fill("run-a");
  await byRun;
  await expect
    .poll(() => titles(list))
    .toEqual([
      "Which region should the canary run in?",
      "Review the action-items design",
    ]);
  await filters.getByLabel("Source", { exact: true }).selectOption("plan");
  const byPlan = page.waitForRequest((request) =>
    request.url().endsWith("/api/human-items?plan=plan-b"),
  );
  await filters.getByLabel("Source identifier").fill("plan-b");
  await byPlan;
  await expect
    .poll(() => titles(list))
    .toEqual(["Review the dashboard layout", "Keep the legacy export format?"]);
  await filters.getByLabel("Source", { exact: true }).selectOption("session");
  const bySession = page.waitForRequest((request) =>
    request
      .url()
      .endsWith("/api/human-items?session=claude-code-supervising-session"),
  );
  await filters
    .getByLabel("Source identifier")
    .fill("claude-code-supervising-session");
  await bySession;
  await expect
    .poll(() => titles(list))
    .toEqual(DECLARED.map(({ title }) => title));
});

test("Tab moves straight between answer boxes, Enter answers in place, Shift+Enter is a new line", async ({
  page,
  context,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  const sent = writes(page);

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
  await page.keyboard.type("Keep it");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("for one more release");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("then drop it");
  await expect(answerBox(page, LAST_QUESTION)).toHaveValue(
    "Keep it\nfor one more release\nthen drop it",
  );
  const grown = await answerBox(page, LAST_QUESTION).evaluate(heights);
  expect(grown.height).toBeGreaterThan(resting.height + resting.oneLine);
  expect(sent).toHaveLength(0);

  // Enter answers the focused question, without opening detail.
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
  expect(stored(served, "question-canary")).toMatchObject({
    state: "answered",
    resolution: {
      actor: "claude-code-supervising-session",
      text: "eu-west, matching the incident report",
    },
  });
  // The other draft is still there, unsent.
  await expect(answerBox(page, LAST_QUESTION)).toHaveValue(
    "Keep it\nfor one more release\nthen drop it",
  );

  // An input method's composition, through the browser's own input layer:
  // Enter while the words are still being composed sends nothing, and Enter
  // once they are committed sends the answer.
  const composing = "Should retries reuse the warm cache?";
  await answerBox(page, composing).click();
  await page.keyboard.type("Reuse it ");
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
  expect(stored(served, "question-cache").resolution?.text).toContain(
    "Reuse it にほん",
  );
});

test("card actions are a focus group of their own after the answer boxes, operable by keyboard", async ({
  page,
  context,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  await answerBox(page, LAST_QUESTION).focus();
  // After the last answer box, Tab enters the group at the first card action.
  await page.keyboard.press("Tab");
  const tracker = card(page, "Restore the build service").getByRole("link", {
    name: "Open GitHub issue nickderobertis/onepipeline#1301",
  });
  await expect(tracker).toBeFocused();
  // Enter follows a link; arrow keys move through the actions.
  await followed(
    context,
    () => page.keyboard.press("Enter"),
    "https://github.com/nickderobertis/onepipeline/issues/1301",
  );
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
  expect(stored(served, "task-build")).toMatchObject({
    state: "dismissed",
    resolution: { reason: null },
  });

  // Complete, from the keyboard. The group now opens on the first card left —
  // a question, whose actions are Details and Dismiss — and the arrows walk on
  // into the next card's; End and Home reach the ends of the group.
  await answerBox(page, LAST_QUESTION).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", {
      name: "Details: Which region should the canary run in?",
    }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("button", { name: `Dismiss: ${LAST_QUESTION}` }),
  ).toBeFocused();
  // At either end of the group the arrows hold focus there.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: `Dismiss: ${LAST_QUESTION}` }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("button", {
      name: "Details: Which region should the canary run in?",
    }),
  ).toBeFocused();
  for (const [role, name] of [
    ["button", "Dismiss: Which region should the canary run in?"],
    ["link", "Open Linear issue ONE-412"],
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
  await expect(
    page.getByRole("link", { name: "Open Linear issue ONE-412" }),
  ).toBeFocused();
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
  expect(stored(served, "task-design").state).toBe("completed");
});

test("a design review completes with the ordinary Complete, and a changed document is refused and replaced", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  const list = await open(page, served);
  const sent = writes(page);

  await page
    .getByRole("button", { name: "Complete: Review the action-items design" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Review the action-items design: Completed",
  );
  await expect(card(page, "Review the action-items design")).toHaveCount(0);
  expect(sent.map((request) => request.postData())).toEqual(["{}"]);
  // The approval the sample authority recorded before completing: the
  // reference stored when the task was raised, as the acting session.
  expect(bundleOf(served).approvals).toEqual([
    {
      approval: {
        board_copy: "docs/design/action-items.md",
        key: "sha256:5d1c0a",
      },
      actor: "claude-code-supervising-session",
      on_behalf_of: null,
    },
  ]);

  await page
    .getByRole("button", { name: "Complete: Review the dashboard layout" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Review the dashboard layout: Re-read the current document",
  );
  // The obsolete task is dismissed and exactly one replacement is open.
  await expect(card(page, "Review the dashboard layout")).toHaveCount(1);
  expect(stored(served, "task-dashboard")).toMatchObject({
    state: "dismissed",
    resolution: { reason: "Re-read the current document" },
  });
  expect(bundleOf(served).approvals).toHaveLength(1);
  expect(await titles(list)).toContain("Review the dashboard layout");
  // The replacement is current, so the same Complete now completes it.
  await page
    .getByRole("button", { name: "Complete: Review the dashboard layout" })
    .click();
  await expect(outcome(page)).toHaveText(
    "Review the dashboard layout: Completed",
  );
  expect(bundleOf(served).approvals?.[1]?.approval.key).toBe("sha256:c4e2f9");
});

test("a dismissal sends a reason only when one is written", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  const sent = writes(page);

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
  expect(stored(served, "question-export").resolution?.reason).toBe(
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
  expect(stored(served, "task-dashboard").resolution?.reason).toBeNull();
  expect(sent.map((request) => request.postData())).toEqual([
    JSON.stringify({ reason: "the export stays" }),
    "{}",
  ]);

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
  const served = await serveBundle("representative.json");
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
  expect(stored(served, "question-cache").resolution?.text).toBe(
    "Reuse it, and check the artifact digest",
  );

  await page
    .getByRole("button", { name: "Details: Review the action-items design" })
    .click();
  await followed(
    context,
    () => pane.getByRole("link", { name: "Open Linear issue ONE-412" }).click(),
    "https://linear.app/onepipeline/issue/ONE-412",
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
  expect(stored(served, "task-dashboard").resolution?.reason).toBe(
    "superseded",
  );
});

test("a pending receipt keeps the item open, repeats send nothing, and a failure keeps the draft", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  const sent = writes(page);
  const title = "Should retries reuse the warm cache?";

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

  // A task's Complete and Dismiss are held to one write the same way: while
  // its receipt is out, further clicks send nothing.
  let releaseTask: () => void = () => {};
  const heldTask = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  await page.route("**/api/human-items/task-design/complete", async (route) => {
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
  expect(stored(served, "task-design").state).toBe("completed");
  await page.unroute("**/api/human-items/task-design/complete");

  // The server cannot read its bundle: the write fails, the list keeps what
  // it last read, and the draft stays for a retry that then succeeds.
  const { sample } = factsSchema.parse(served.facts);
  renameSync(sample, `${sample}.away`);
  await answerBox(page, LAST_QUESTION).fill("Keep it one more release");
  await answerBox(page, LAST_QUESTION).press("Enter");
  await expect(card(page, LAST_QUESTION).getByRole("alert")).toContainText(
    "engine failure",
  );
  await expect(answerBox(page, LAST_QUESTION)).toHaveValue(
    "Keep it one more release",
  );
  await expect(card(page, LAST_QUESTION)).toBeVisible();
  renameSync(`${sample}.away`, sample);
  await answerBox(page, LAST_QUESTION).press("Enter");
  await expect(outcome(page)).toHaveText(`${LAST_QUESTION}: Answered`);

  // The server stops answering at all: the write's connection fails, the item
  // and its card stay, and once the server is back the same action succeeds.
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
});

test("a write to an item that became another session's is refused, hides it and changes nothing, and lands once it is handed back", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  const sent = writes(page);
  const { sample } = factsSchema.parse(served.facts);
  const original = readFileSync(sample, "utf8");

  /** Hand the item `id` to another session in the bundle the server reads. */
  function handOver(id: string): string {
    const handed = handedOver(original, id);
    writeFileSync(sample, handed);
    return handed;
  }

  // After the page read it, each item becomes another session's: the server's
  // authority refuses the acting session's one write in the engine's words,
  // the list's next read no longer shows its content, and nothing is written.
  const question = "Should retries reuse the warm cache?";
  const task = "Restore the build service";
  for (const [id, title, act] of [
    [
      "question-cache",
      question,
      async () => {
        await answerBox(page, question).fill("Reuse it");
        await answerBox(page, question).press("Enter");
      },
    ],
    [
      "task-build",
      task,
      () => page.getByRole("button", { name: `Complete: ${task}` }).click(),
    ],
  ] as const) {
    const handed = handOver(id);
    const before = sent.length;
    await act();
    await expect(outcome(page)).toHaveText(
      `${title}: human item ${id} belongs to another session; its content and its actions are that session's`,
    );
    await expect(card(page, title)).toHaveCount(0);
    expect(sent).toHaveLength(before + 1);
    const response = await sent[before]?.response();
    if (!response) throw new Error(`the write to ${id} had no response`);
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe("human_item_not_owner");
    expect(readFileSync(sample, "utf8")).toBe(handed);
    writeFileSync(sample, original);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(card(page, title)).toBeVisible();
  }

  // Handed back, the refused answer's draft is still there and lands as written.
  await expect(answerBox(page, question)).toHaveValue("Reuse it");
  await answerBox(page, question).press("Enter");
  await expect(outcome(page)).toHaveText(`${question}: Answered`);
  expect(stored(served, "question-cache").resolution?.text).toBe("Reuse it");
});

test("a detail that cannot be read says why, and another item's opens once the server can read again", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  const { sample } = factsSchema.parse(served.facts);
  renameSync(sample, `${sample}.away`);
  await page
    .getByRole("button", { name: "Details: Review the dashboard layout" })
    .click();
  const pane = detailPane(page);
  await expect(pane.getByRole("alert")).toContainText("engine failure");
  // What the list already read of the item is still shown beside the refusal.
  await expect(
    pane.getByRole("heading", { name: "Review the dashboard layout" }),
  ).toBeVisible();
  renameSync(`${sample}.away`, sample);
  await page
    .getByRole("button", { name: "Details: Review the action-items design" })
    .click();
  await expect(
    pane.getByRole("region", { name: "Blocked steps" }).getByRole("listitem"),
  ).toHaveCount(7);
  await expect(pane.getByRole("alert")).toHaveCount(0);
});

test("an open detail whose reread fails drops what it read, and shows it again once it can be read", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  const { sample } = factsSchema.parse(served.facts);
  const original = readFileSync(sample, "utf8");
  const design = "Review the action-items design";
  const refresh = () => page.getByRole("button", { name: "Refresh" }).click();
  const pane = detailPane(page);
  const steps = pane
    .getByRole("region", { name: "Blocked steps" })
    .getByRole("listitem");
  await page.getByRole("button", { name: `Details: ${design}` }).click();
  await expect(steps).toHaveCount(7);

  // The server cannot read its bundle: the reread fails, the steps only the
  // detail served go with it, and the pane keeps what the list last read
  // beside the refusal.
  renameSync(sample, `${sample}.away`);
  await refresh();
  await expect(pane.getByRole("alert")).toContainText("engine failure");
  await expect(steps).toHaveCount(0);
  await expect(pane.getByRole("heading", { name: design })).toBeVisible();
  renameSync(`${sample}.away`, sample);
  await refresh();
  await expect(steps).toHaveCount(7);
  await expect(pane.getByRole("alert")).toHaveCount(0);

  // The item becomes another session's: the reread is refused, and nothing of
  // its content or its actions stays on screen — only why, and a way out.
  writeFileSync(sample, handedOver(original, "task-design"));
  await refresh();
  await expect(card(page, design)).toHaveCount(0);
  await expect(pane.getByRole("alert")).toContainText(
    "belongs to another session",
  );
  await expect(pane.getByRole("heading", { name: design })).toHaveCount(0);
  await expect(steps).toHaveCount(0);
  await expect(pane.getByRole("button", { name: /^Complete/ })).toHaveCount(0);
  await expect(pane.getByRole("button", { name: /^Dismiss/ })).toHaveCount(0);

  // Handed back, the same pane reads it again in full.
  writeFileSync(sample, original);
  await refresh();
  await expect(pane.getByRole("heading", { name: design })).toBeVisible();
  await expect(steps).toHaveCount(7);
  await expect(pane.getByRole("alert")).toHaveCount(0);

  // Refused again, the pane's own Close dismisses it.
  writeFileSync(sample, handedOver(original, "task-design"));
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
  const served = await serveBundle("representative.json");
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

test("an item whose body is longer than four lines shows four on its card and all of it in a pane that scrolls on its own", async ({
  page,
}) => {
  const served = await serveBundle("long-body.json");
  const list = await open(page, served);
  const longTitle = "Work through the release review follow-ups";
  const longText = bodyOf(served, longTitle);
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
  for (const title of [
    "Restore the build service",
    "Which region should the canary run in?",
    "Keep the legacy export format?",
  ]) {
    const short = card(page, title).getByText(bodyOf(served, title), {
      exact: true,
    });
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
});

test("an item raised in a plan alone or a run alone names it as its source, and a tracker of another host is a tracker", async ({
  page,
  context,
}) => {
  const served = await serveBundle("long-body.json");
  await open(page, served);
  await expect(
    card(page, "Which plan owns the shared fixtures?").getByText(
      "Source: plan plan-c",
      { exact: true },
    ),
  ).toBeVisible();
  const runOnly = card(page, "File the flaky-runner report");
  await expect(
    runOnly.getByText("Source: run run-d", { exact: true }),
  ).toBeVisible();
  const url = "https://tracker.example.com/issues/INFRA-77";
  const link = runOnly.getByRole("link", {
    name: "Open tracker issue INFRA-77",
  });
  await expect(link).toHaveAttribute("href", url);
  await followed(context, () => link.click(), url);
});

test("a hold of one step says so, and a plan hold lists the steps it reaches", async ({
  page,
}) => {
  const served = await serveBundle("long-body.json");
  await open(page, served);
  const one = card(page, "Pick the release branch's base");
  await expect(
    one.getByText("blocks 1 step in plan-e: rebase", { exact: true }),
  ).toBeVisible();
  await one
    .getByRole("button", { name: "Details: Pick the release branch's base" })
    .click();
  const steps = detailPane(page).getByRole("region", { name: "Blocked steps" });
  await expect(
    steps.getByRole("heading", { name: "blocks 1 step in plan-e" }),
  ).toBeVisible();
  await expect(steps.getByRole("listitem")).toHaveText([
    "run-e / rebase: Rebase the release branch",
  ]);

  const plan = card(page, "Work through the release review follow-ups");
  await expect(
    plan.getByText("blocks all of plan-a", { exact: true }),
  ).toBeVisible();
  await plan
    .getByRole("button", {
      name: "Details: Work through the release review follow-ups",
    })
    .click();
  await expect(
    steps.getByRole("heading", { name: "blocks all of plan-a" }),
  ).toBeVisible();
  await expect(steps.getByRole("listitem")).toHaveText([
    "run-a / build: Build the release binaries",
    "run-a / test: Run the release journeys",
  ]);
});

test("a read overtaken by a newer one never replaces what the newer one showed", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
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
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route("**/api/human-items/question-canary", async (route) => {
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
    response.url().endsWith("/api/human-items/question-canary"),
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

test("a live host's server serves no fixture items to the page", async ({
  page,
}) => {
  // The shared corpus's server: a runs root with runs, started without a
  // sample, as every live host is.
  await page.goto("/human-items");
  await expect(listRegion(page).getByRole("alert")).toHaveText(
    "human-items unavailable against live state",
  );
  await expect(page.getByRole("article")).toHaveCount(0);
});
