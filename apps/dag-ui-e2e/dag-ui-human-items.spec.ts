import { readFileSync, renameSync } from "node:fs";
import {
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
 * the app stands in for the engine. A request is only ever held or dropped on
 * its way (a delayed receipt, a refused connection), which is a network
 * condition rather than a double. These prove the UI/API contract over the
 * sample adapter, not the engine's runtime lifecycle.
 */

const factsSchema = z.object({ sample: z.string().min(1) });

const bundleSchema = z.object({
  items: z.array(
    z.object({
      item: z.object({
        id: z.string(),
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

/** The page, opened at its own address on the server's origin. */
async function open(page: Page, served: FixtureServer): Promise<Locator> {
  // Tracker links leave for GitHub and Linear: answered here, so a journey
  // that follows one never reaches the network.
  await page
    .context()
    .route(/^https:\/\/(github\.com|linear\.app)\//u, (route) =>
      route.fulfill({ contentType: "text/plain", body: "tracker" }),
    );
  await page.goto(`${served.origin}/human-items`);
  const list = page.getByRole("list", { name: "Action items" });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  return list;
}

function card(page: Page, title: string): Locator {
  return page.getByRole("article", { name: title });
}

function answerBox(page: Page, title: string): Locator {
  return page.getByRole("textbox", { name: `Answer: ${title}`, exact: true });
}

function outcome(page: Page): Locator {
  return page.locator(".human-items-outcome");
}

function detailPane(page: Page): Locator {
  return page.getByRole("complementary", { name: "Action item detail" });
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

  // And the address opens the page directly, back where it was.
  await page.goBack();
  await expect(page).toHaveURL(`${served.origin}/human-items`);
  await expect(list.getByRole("listitem")).toHaveCount(DECLARED.length);
});

test("lists every open item of the session in the engine's order, as compact full-width cards", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  const list = await open(page, served);
  expect(await titles(list)).toEqual(DECLARED.map(({ title }) => title));

  const wire = (await (
    await page.request.get(`${served.origin}/api/human-items`)
  ).json()) as { items: { item: { title: string; priority: string } }[] };
  for (const [index, expected] of DECLARED.entries()) {
    const shown = card(page, expected.title);
    await expect(shown.locator(".human-item-priority")).toHaveText(
      expected.priority,
    );
    await expect(shown.locator(".human-item-kind")).toHaveText(expected.kind);
    await expect(shown.locator(".human-item-meta")).toContainText(
      expected.source,
    );
    if (expected.blocks === undefined)
      await expect(shown.locator(".human-item-blocks")).toHaveCount(0);
    else
      await expect(shown.locator(".human-item-blocks")).toHaveText(
        expected.blocks,
      );
    // Critical is a label: the record says urgent.
    expect(wire.items[index]?.item).toMatchObject({
      title: expected.title,
      priority: expected.wire,
    });
    await expect(shown).toHaveAttribute(
      "data-blocking",
      String(expected.blocks !== undefined),
    );
  }
  // Every task has its tracker link on the card; no question has one.
  const tasks = DECLARED.filter(({ kind }) => kind === "Task");
  await expect(list.locator(".human-item-tracker")).toHaveCount(tasks.length);
  for (const task of tasks)
    if ("tracker" in task)
      await expect(
        card(page, task.title).getByRole("link", { name: task.tracker }),
      ).toBeVisible();

  // The session's own items only: another session's item is not shown.
  await expect(page.getByText("Rotate the deploy credentials")).toHaveCount(0);
  // No P-labels, no owner-ended anything, no scope, no approval control.
  const text = await page.locator("main").innerText();
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
  expect(await filters.locator("label").allTextContents()).toEqual([
    "Kind",
    "Blocking",
    "Priority",
    "State",
    "Source",
  ]);
  await expect(filters.getByLabel("Priority").locator("option")).toHaveText([
    "Any priority",
    "Critical",
    "High",
    "Medium",
    "Low",
  ]);
  await expect(filters.getByLabel("State").locator("option")).toHaveText([
    "Open",
    "Answered",
    "Completed",
    "Dismissed",
  ]);
  await expect(filters.getByLabel("Blocking").locator("option")).toHaveText([
    "Any",
    "Yes",
    "No",
  ]);
});

test("a tracker link opens its issue without selecting the card", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  const link = card(page, "Review the action-items design").getByRole("link", {
    name: "Open Linear issue ONE-412",
  });
  await expect(link).toHaveAttribute(
    "href",
    "https://linear.app/onepipeline/issue/ONE-412",
  );
  const [issue] = await Promise.all([
    page.context().waitForEvent("page"),
    link.click(),
  ]);
  expect(issue.url()).toBe("https://linear.app/onepipeline/issue/ONE-412");
  await issue.close();
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
  const region = page.getByRole("region", { name: "Action item list" });
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
  await expect(list.locator(".human-item-kind")).toHaveText(
    DECLARED.map(({ kind }) => kind),
  );
  await expect(list.getByRole("textbox")).toHaveCount(3);
  for (const shown of await cards.all()) {
    const cardBox = await shown.boundingBox();
    if (cardBox === null) throw new Error("a card has no box");
    expect(cardBox.y).toBeGreaterThanOrEqual(box.y);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(box.y + box.height);
    // Full width: the card spans the list rather than a column of it.
    expect(cardBox.width).toBeGreaterThan(box.width * 0.9);
    const body = shown.locator(".human-item-body");
    const length = (await body.innerText()).length;
    expect(length).toBeGreaterThanOrEqual(80);
    expect(length).toBeLessThanOrEqual(160);
    // Complete: nothing of the body is clipped.
    expect(
      await body.evaluate(
        (element) => element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    for (const control of await shown.locator("button, a, textarea").all())
      await expect(control).toBeInViewport({ ratio: 1 });
  }
  // Each answer box rests one line tall.
  for (const title of QUESTIONS) {
    const rest = await answerBox(page, title).evaluate((element) => {
      const style = getComputedStyle(element);
      const line = Number.parseFloat(style.lineHeight);
      const chrome =
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth);
      return { height: element.getBoundingClientRect().height, line, chrome };
    });
    expect(rest.height).toBeLessThanOrEqual(rest.line + rest.chrome + 1);
  }

  await card(page, "Review the action-items design")
    .locator(".human-item-meta")
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
  await expect(host).toHaveAttribute("data-blocking", "true");
  await host
    .getByRole("button", { name: "Details: Restore the build service" })
    .click();
  await expect(detailPane(page)).toContainText("blocks all work on this host");
  await expect(detailPane(page).locator(".human-item-priority")).toHaveText(
    "Critical",
  );
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
  await expect(list.locator(".human-item-priority")).toHaveText([
    "Critical",
    "Critical",
  ]);
  await reset("Priority", "");

  await choose("State", "answered", "?state=answered");
  await expect
    .poll(() => titles(list))
    .toEqual(["Which changelog section holds the fix?"]);
  await choose("State", "dismissed", "?state=dismissed");
  await expect
    .poll(() => titles(list))
    .toEqual(["Re-run the flaky screenshot job"]);
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

  // Shift+Enter writes a new line and sends nothing.
  const last = QUESTIONS[QUESTIONS.length - 1] ?? "";
  await page.keyboard.type("Keep it");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("for one more release");
  await expect(answerBox(page, last)).toHaveValue(
    "Keep it\nfor one more release",
  );
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
  await expect(answerBox(page, last)).toHaveValue(
    "Keep it\nfor one more release",
  );
});

test("card actions are a focus group of their own after the answer boxes, operable by keyboard", async ({
  page,
}) => {
  const served = await serveBundle("representative.json");
  await open(page, served);
  await answerBox(page, QUESTIONS[QUESTIONS.length - 1] ?? "").focus();
  // After the last answer box, Tab enters the group at the first card action.
  await page.keyboard.press("Tab");
  const tracker = card(page, "Restore the build service").getByRole("link", {
    name: "Open GitHub issue nickderobertis/onepipeline#1301",
  });
  await expect(tracker).toBeFocused();
  // Arrow keys move through the actions; Enter follows a link.
  const [issue] = await Promise.all([
    page.context().waitForEvent("page"),
    page.keyboard.press("Enter"),
  ]);
  expect(issue.url()).toBe(
    "https://github.com/nickderobertis/onepipeline/issues/1301",
  );
  await issue.close();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "Details: Restore the build service" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const dismiss = page.getByRole("button", {
    name: "Dismiss: Restore the build service",
  });
  await expect(dismiss).toBeFocused();
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
  await answerBox(page, QUESTIONS[QUESTIONS.length - 1] ?? "").focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", {
      name: "Details: Which region should the canary run in?",
    }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("button", {
      name: "Dismiss: Keep the legacy export format?",
    }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  for (const name of [
    "Dismiss: Which region should the canary run in?",
    "Open Linear issue ONE-412",
    "Details: Review the action-items design",
    "Complete: Review the action-items design",
  ]) {
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole(name.startsWith("Open") ? "link" : "button", { name }),
    ).toBeFocused();
  }
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

  // The server cannot read its bundle: the write fails, the list keeps what
  // it last read, and the draft stays for a retry that then succeeds.
  const other = "Keep the legacy export format?";
  const { sample } = factsSchema.parse(served.facts);
  renameSync(sample, `${sample}.away`);
  await answerBox(page, other).fill("Keep it one more release");
  await answerBox(page, other).press("Enter");
  await expect(card(page, other).getByRole("alert")).toContainText(
    "engine failure",
  );
  await expect(answerBox(page, other)).toHaveValue("Keep it one more release");
  await expect(card(page, other)).toBeVisible();
  renameSync(`${sample}.away`, sample);
  await answerBox(page, other).press("Enter");
  await expect(outcome(page)).toHaveText(`${other}: Answered`);

  // A dropped connection is a failure too, and keeps the draft.
  await page.route("**/api/human-items/*/complete", (route) => route.abort());
  await page
    .getByRole("button", { name: "Complete: Restore the build service" })
    .click();
  await expect(
    card(page, "Restore the build service").getByRole("alert"),
  ).toHaveText("Telemetry request failed");
  await expect(card(page, "Restore the build service")).toBeVisible();
});

test("an item whose body is longer than four lines shows four on its card and all of it in a pane that scrolls on its own", async ({
  page,
}) => {
  const served = await serveBundle("long-body.json");
  const list = await open(page, served);
  const long = card(page, "Work through the release review follow-ups");
  const body = long.locator(".human-item-body");
  const clamp = await body.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      line: Number.parseFloat(style.lineHeight),
      height: element.clientHeight,
      overflows: element.scrollHeight > element.clientHeight,
      clamp: style.getPropertyValue("-webkit-line-clamp"),
      text: element.textContent ?? "",
    };
  });
  // Exactly four rendered lines, more beneath them, and the clamp that ends
  // the fourth with an ellipsis; the text itself is the whole body.
  expect(clamp.clamp).toBe("4");
  expect(Math.round(clamp.height / clamp.line)).toBe(4);
  expect(clamp.overflows).toBe(true);
  expect(
    clamp.text.endsWith("The final words are: ship the reviewed release."),
  ).toBe(true);
  // Short bodies show whole, unclipped.
  for (const title of [
    "Restore the build service",
    "Which region should the canary run in?",
    "Keep the legacy export format?",
  ]) {
    const short = card(page, title).locator(".human-item-body");
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
  const short = card(page, "Restore the build service");
  const shortHeight = (await short.boundingBox())?.height ?? 0;
  const longHeight = (await long.boundingBox())?.height ?? 0;
  expect(Math.abs(longHeight - shortHeight - 3 * clamp.line)).toBeLessThan(2);
  for (const [index, box] of boxes.entries())
    if (index > 0)
      expect(
        Math.abs(box.top - (boxes[index - 1]?.bottom ?? 0) - 6),
      ).toBeLessThan(1);

  await long
    .getByRole("button", {
      name: "Details: Work through the release review follow-ups",
    })
    .click();
  const pane = detailPane(page);
  const full = pane.getByRole("region", { name: "Full body" });
  await expect(full).toContainText(
    "The final words are: ship the reviewed release.",
  );
  const listRegion = page.getByRole("region", { name: "Action item list" });
  const before = {
    list: await listRegion.evaluate((element) => element.scrollTop),
    cards: await list
      .getByRole("article")
      .evaluateAll((cards) =>
        cards.map((element) => element.getBoundingClientRect().top),
      ),
    heading: (await pane.getByRole("heading", { level: 2 }).boundingBox())?.y,
  };
  expect(
    await full.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await full.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
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
  expect(await listRegion.evaluate((element) => element.scrollTop)).toBe(
    before.list,
  );
  expect(
    await list
      .getByRole("article")
      .evaluateAll((cards) =>
        cards.map((element) => element.getBoundingClientRect().top),
      ),
  ).toEqual(before.cards);
  expect((await pane.getByRole("heading", { level: 2 }).boundingBox())?.y).toBe(
    before.heading,
  );
});

test("a live host's server serves no fixture items to the page", async ({
  page,
}) => {
  // The shared corpus's server: a runs root with runs, started without a
  // sample, as every live host is.
  await page.goto("/human-items");
  const region = page.getByRole("region", { name: "Action item list" });
  await expect(region.getByRole("alert")).toHaveText(
    "human-items unavailable against live state",
  );
  await expect(page.getByRole("article")).toHaveCount(0);
});
