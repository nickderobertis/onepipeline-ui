import { API_V2_PATHS, runDetailSchema } from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

/**
 * The run page read at a glance: the run's one state, the run bar and the node bar,
 * the run details card, the graph's cards, the change links, the Remote tab's
 * checks and the Task tab's prose.
 *
 * Its corpus is its own (`runs.mjs`'s readability corpus): a run in each of the
 * eight states, each reached the way the engine reaches it, a run whose id is the
 * longest the read API admits, and a run whose nodes cover every kind, a reason
 * line, a change request on GitHub with its checks, and a task written as a
 * document. A run added to the shared corpus is counted by every listing journey.
 */

const WORDS = [
  "Complete",
  "Failed",
  "Stopped",
  "Unfinished",
  "Waiting on you",
  "Driver dead",
  "Idle",
  "Running",
] as const;

const factsSchema = z.object({
  states: z.object({
    Complete: z.string().min(1),
    Failed: z.string().min(1),
    Stopped: z.string().min(1),
    Unfinished: z.string().min(1),
    "Waiting on you": z.string().min(1),
    "Driver dead": z.string().min(1),
    Idle: z.string().min(1),
    Running: z.string().min(1),
  }),
  oneLineTitle: z.string().min(1),
  cards: z.object({
    agent: z.string(),
    failed: z.string(),
    blocked: z.string(),
    command: z.string(),
    human: z.string(),
    changeByRepo: z.string(),
    changeBySteps: z.string(),
    commandWithRepo: z.string(),
    humanWithRepo: z.string(),
  }),
  pr: z.string().url(),
  prId: z.string(),
  noProgress: z.string(),
});

let server: FixtureServer;
let facts: z.infer<typeof factsSchema>;

test.beforeAll(async () => {
  server = await startFixtureServer("readability", ["--readability-corpus"]);
  facts = factsSchema.parse(server.facts);
});
test.afterAll(async () => {
  await server.stop();
});

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${locator} has no box`);
  return box;
}

const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const runBar = (page: Page) =>
  page.getByRole("region", { name: "Run header", exact: true });
const wholeDag = (page: Page) =>
  page.getByRole("region", { name: "Whole DAG", exact: true });
const runDetails = (page: Page) =>
  page.getByRole("group", { name: "Run details", exact: true });

/** The run's state as it is shown inside `scope`: its group, word and icon. */
function shownState(scope: Locator) {
  const group = scope.getByRole("group", { name: "Run state", exact: true });
  return { group, icon: group.getByRole("img") };
}

async function openOverall(page: Page, run: string) {
  await page.goto(`${server.origin}/?run=${run}&view=overall`);
  await expect(runDetails(page)).toBeVisible();
}

const colourOf = (locator: Locator): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).color);

const tokenColour = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);

test("Overall shows the run's state once, the done count, and the run details card, and none of the retired sections", async ({
  page,
}) => {
  const run = facts.states.Running;
  await openOverall(page, run);
  for (const gone of [
    "Timing and usage",
    "Goal and repository identities",
    "Recorded results",
    "Provider health",
    "Summary",
    "Graph state",
  ])
    await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Status", exact: true }),
  ).toHaveCount(0);

  // The state once on Overall: in the Whole DAG card and nowhere else below the bar.
  const view = page.getByRole("tabpanel");
  await expect(view.getByRole("group", { name: "Run state" })).toHaveCount(1);
  const { group, icon } = shownState(wholeDag(page));
  await expect(group).toHaveText("Running");
  await expect(icon).toHaveAccessibleName("Running");
  await expect(shownState(runBar(page)).group).toHaveText("Running");

  // Nodes: the done count beside the total, as served.
  const detail = runDetailSchema.parse(
    await (
      await page.request.get(`${server.origin}/api/v2/runs/${run}`)
    ).json(),
  );
  const statuses = Object.values(detail.graph?.node_status ?? {});
  const done = statuses.filter((status) => status === "done").length;
  await expect(
    page.getByRole("group", { name: "Nodes", exact: true }).getByRole("strong"),
  ).toHaveText(`${done} of ${statuses.length} done`);

  // Exactly three label and value pairs, with no expander.
  const card = runDetails(page);
  await expect(card.getByRole("term")).toHaveText([
    "Launching session",
    "Unread surfaces",
    "Last progress",
  ]);
  await expect(card.getByRole("definition")).toHaveCount(3);
  // No expander: a disclosure is a group, and its summary a button.
  await expect(card.getByRole("group")).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("definition").nth(1)).toHaveText(/^\d+/u);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = [
      ...(await card.getByRole("term").all()),
      ...(await card.getByRole("definition").all()),
    ];
    const measured = await Promise.all(boxes.map(boxOf));
    for (const [index, box] of measured.entries())
      for (const other of measured.slice(index + 1))
        expect(intersects(box, other), `at ${width}px`).toBe(false);
  }

  // Nowhere but Overall: not on the graph, not in the bar.
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(runDetails(page)).toHaveCount(0);
  await expect(page.getByText("Launching session")).toHaveCount(0);
  await expect(page.getByText("Run details", { exact: true })).toHaveCount(0);
});

test("each of the eight states reads as its own word, icon and colour, in the Whole DAG card and the run bar", async ({
  page,
}) => {
  const seen: { word: string; icon: string; colour: string }[] = [];
  for (const word of WORDS) {
    await openOverall(page, facts.states[word]);
    const { group, icon } = shownState(wholeDag(page));
    await expect(group).toHaveText(word);
    await expect(icon).toHaveAccessibleName(word);
    await expect(shownState(runBar(page)).group).toHaveText(word);
    seen.push({
      word,
      icon: (await icon.getAttribute("class")) ?? "",
      colour: await colourOf(group),
    });
  }
  for (const key of ["word", "icon", "colour"] as const)
    expect(
      new Set(seen.map((state) => state[key])).size,
      `${key}: ${JSON.stringify(seen.map((state) => state[key]))}`,
    ).toBe(WORDS.length);
});

test("a run that has not ended counts its failed nodes beside its state, in the failure colour", async ({
  page,
}) => {
  await openOverall(page, facts.states.Running);
  const failure = await tokenColour(page, "--destructive");
  for (const scope of [wholeDag(page), runBar(page)]) {
    const count = scope.getByText("1 failed", { exact: true });
    await expect(count).toBeVisible();
    expect(await colourOf(count)).toBe(failure);
    await expect(shownState(scope).group).toHaveText("Running");
  }
  // Nothing failed, nothing counted.
  await openOverall(page, facts.states.Idle);
  await expect(page.getByText(/^\d+ failed$/u)).toHaveCount(0);
});

test("a run with no recorded progress shows its last progress as a dash", async ({
  page,
}) => {
  await openOverall(page, facts.noProgress);
  const progress = runDetails(page).getByRole("status", {
    name: "Last progress",
  });
  await expect(progress).toHaveText("—");
  await expect(runDetails(page)).not.toContainText("1970");
  await expect(runDetails(page)).not.toContainText(/years? ago/u);
});

/** Whether every box in `members` sits inside `bar`, on one row of it. */
async function oneRow(bar: Locator, members: readonly Locator[]) {
  const outer = await boxOf(bar);
  const boxes = await Promise.all(members.map(boxOf));
  for (const box of boxes) {
    expect(box.y).toBeGreaterThanOrEqual(outer.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
  }
  // One row: every member overlaps every other vertically.
  for (const box of boxes)
    for (const other of boxes)
      expect(
        box.y < other.y + other.height && other.y < box.y + box.height,
      ).toBe(true);
  return outer;
}

test("one run bar above a view, and one node bar inside a node, at 1440 and 390 CSS px", async ({
  page,
}) => {
  const run = facts.states.Running;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.origin}/?run=${run}&view=overall`);
    const bar = runBar(page);
    const members = [
      bar.getByRole("heading", { name: run }),
      shownState(bar).group,
      bar.getByRole("button", { name: "Stop" }),
      bar.getByRole("combobox", { name: "Main area updates" }),
      bar.getByRole("tab", { name: "Graph" }),
      bar.getByRole("tab", { name: "Overall" }),
    ];
    for (const member of members) await expect(member).toBeVisible();
    const outer =
      width === 1440 ? await oneRow(bar, members) : await boxOf(bar);
    for (const member of members) {
      const box = await boxOf(member);
      expect(box.y + box.height).toBeLessThanOrEqual(
        outer.y + outer.height + 1,
      );
    }
    // Nothing but the bar between the page top and the view.
    expect(outer.y).toBeLessThanOrEqual(1);
    const view = await boxOf(page.getByRole("tabpanel"));
    expect(Math.abs(view.y - (outer.y + outer.height))).toBeLessThanOrEqual(1);

    await page.goto(
      `${server.origin}/?run=${run}&node=${facts.cards.changeByRepo}&tab=remote`,
    );
    const node = page.getByRole("region", {
      name: `Timeline for ${facts.cards.changeByRepo}`,
    });
    const head = node.getByRole("region", { name: "Node header", exact: true });
    const nodeMembers = [
      head.getByRole("button", { name: "Graph" }),
      head.getByText(facts.cards.changeByRepo, { exact: true }),
      head.getByText("done", { exact: true }),
      head.getByRole("link", { name: facts.prId }),
      head.getByRole("tablist", { name: "Node details" }),
    ];
    for (const member of nodeMembers) await expect(member).toBeVisible();
    const nodeBar =
      width === 1440 ? await oneRow(head, nodeMembers) : await boxOf(head);
    for (const member of nodeMembers) {
      const box = await boxOf(member);
      expect(box.y + box.height).toBeLessThanOrEqual(
        nodeBar.y + nodeBar.height + 1,
      );
    }
    // The node bar sits straight under the run bar, its content straight under it.
    const runBox = await boxOf(runBar(page));
    expect(
      Math.abs(nodeBar.y - (runBox.y + runBox.height)),
    ).toBeLessThanOrEqual(1);
    const panel = await boxOf(node.getByRole("tabpanel"));
    expect(
      Math.abs(panel.y - (nodeBar.y + nodeBar.height)),
    ).toBeLessThanOrEqual(1);
  }
});

test("the longest title the read API admits never overlaps the state badge or Updates, at any width", async ({
  page,
}) => {
  const run = facts.states["Driver dead"];
  expect(run).toHaveLength(128);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.origin}/?run=${run}&view=overall`);
  const bar = runBar(page);
  const title = bar.getByRole("heading", { level: 2 });
  const badge = shownState(bar).group;
  const updates = bar.getByRole("combobox", { name: "Main area updates" });
  await expect(badge).toHaveText("Driver dead");
  // The whole title, as its accessible name and its tooltip.
  await expect(title).toHaveAccessibleName(run);
  await expect(title).toHaveAttribute("title", run);
  for (let width = 320; width <= 1920; width += 40) {
    await page.setViewportSize({ width, height: 900 });
    const titleBox = await boxOf(title);
    const badgeBox = await boxOf(badge);
    const updatesBox = await boxOf(updates);
    expect(intersects(titleBox, badgeBox), `title and badge at ${width}`).toBe(
      false,
    );
    expect(
      intersects(titleBox, updatesBox),
      `title and Updates at ${width}`,
    ).toBe(false);
    expect(
      intersects(badgeBox, updatesBox),
      `badge and Updates at ${width}`,
    ).toBe(false);
    // At most two lines: what does not fit them is cut, never spilt.
    const lines = await title.evaluate((element) =>
      Math.round(
        element.clientHeight /
          Number.parseFloat(getComputedStyle(element).lineHeight),
      ),
    );
    expect(lines, `lines at ${width}`).toBeLessThanOrEqual(2);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(
    await title.evaluate((element) => ({
      clamp: getComputedStyle(element).webkitLineClamp,
      cut: element.scrollHeight > element.clientHeight,
    })),
  ).toEqual({ clamp: "2", cut: true });
});

test("at 1440 CSS px a 28-character title stays on one line, and the last activity gives way first", async ({
  page,
}) => {
  const run = facts.oneLineTitle;
  expect(run).toHaveLength(28);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.origin}/?run=${run}&view=overall`);
  const bar = runBar(page);
  const title = bar.getByRole("heading", { name: run });
  // The last-activity line: the button naming what the working node last did.
  const activity = bar.getByRole("button", {
    name: new RegExp(`^${facts.cards.agent}: `, "u"),
  });
  await expect(shownState(bar).group).toHaveText("Running");
  await expect(bar.getByText("1 failed", { exact: true })).toBeVisible();
  await expect(activity).toBeVisible();
  const lineOf = (locator: Locator) =>
    locator.evaluate((element) => ({
      lines: Math.round(
        element.clientHeight /
          Number.parseFloat(getComputedStyle(element).lineHeight),
      ),
      clipped: element.scrollWidth > element.clientWidth,
    }));
  expect((await lineOf(title)).lines).toBe(1);
  expect((await lineOf(activity)).clipped).toBe(true);
  // Narrower, the title wraps only once the activity has given all its room.
  for (const width of [1400, 1360, 1320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    if ((await lineOf(title)).lines > 1)
      expect((await boxOf(activity)).width, `at ${width}`).toBeLessThan(1);
  }
});

// llmlint: ignore-block[e2e_uses_accessible_selectors] a card's rows are measured, and the status word, the reason line and the pill's text node have no role or name to reach them by: the card itself is found by its accessible name, and inside it the rows are read as the geometry they are, never clicked or read for meaning.
/** One card's rows, measured in the card's own CSS pixels, unscaled by the zoom. */
async function cardRows(card: Locator) {
  return card.evaluate((element: HTMLElement) => {
    const scale = element.getBoundingClientRect().width / element.offsetWidth;
    const box = (selector: string) => {
      const found = element.querySelector(selector);
      if (found === null) return undefined;
      const rect = found.getBoundingClientRect();
      return { top: rect.top / scale, bottom: rect.bottom / scale };
    };
    const card = element.getBoundingClientRect();
    const border = Number.parseFloat(getComputedStyle(element).borderTopWidth);
    const pill = element.querySelector(".node-kind");
    const icon = pill?.querySelector("svg")?.getBoundingClientRect();
    const range = document.createRange();
    if (pill?.lastChild) range.selectNodeContents(pill.lastChild);
    const text = range.getBoundingClientRect();
    return {
      top: card.top / scale + border,
      bottom: card.bottom / scale - border,
      heading: box(".node-heading"),
      title: box("strong"),
      status: box(".node-status"),
      reason: box(".node-reason"),
      iconMid:
        icon === undefined ? Number.NaN : (icon.top + icon.bottom) / 2 / scale,
      textMid: (text.top + text.bottom) / 2 / scale,
    };
  });
}
// llmlint: ignore-end[e2e_uses_accessible_selectors]

test("a graph card's status sits under its title, its reason line inside the card, its content centred", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.origin}/?run=${facts.states.Running}&view=graph`);
  // The app's own cards, not the first screen's that stand in for them.
  await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
  const cards = page.getByRole("article", { name: /: [a-z-]+$/u });
  await expect(cards.first()).toBeVisible();
  const plainBottoms: number[] = [];
  const reasonBottoms: number[] = [];
  for (const card of await cards.all()) {
    const rows = await cardRows(card);
    const { heading, title, status, reason } = rows;
    if (!heading || !title || !status) throw new Error("a card row is missing");
    const last = reason ?? status;
    const above = heading.top - rows.top;
    const below = rows.bottom - last.bottom;
    expect(
      Math.abs(above - below),
      `${await card.getAttribute("aria-label")}`,
    ).toBeLessThanOrEqual(2);
    const titleGap = status.top - title.bottom;
    expect(titleGap).toBeLessThanOrEqual(8);
    expect(titleGap).toBeLessThanOrEqual(
      reason === undefined ? below : reason.top - status.bottom,
    );
    if (reason !== undefined) {
      expect(reason.top - status.bottom).toBeLessThanOrEqual(4);
      expect(reason.top).toBeGreaterThanOrEqual(rows.top);
      expect(reason.bottom).toBeLessThanOrEqual(rows.bottom);
      reasonBottoms.push(below);
    } else plainBottoms.push(below);
    expect(
      Math.abs(rows.iconMid - rows.textMid),
      `${await card.getAttribute("aria-label")}: icon ${rows.iconMid}, text ${rows.textMid}`,
    ).toBeLessThanOrEqual(1);
  }
  // The blocked and the failed node carry a reason line.
  expect(reasonBottoms).toHaveLength(2);
  for (const below of reasonBottoms)
    expect(Math.abs(below - (plainBottoms[0] ?? 0))).toBeLessThanOrEqual(2);
  await expect(
    page.getByRole("article", { name: `${facts.cards.blocked}: skipped` }),
  ).toContainText(`blocked by ${facts.cards.failed}`);
});

test("every card's kind pill names its kind, with an icon of its own", async ({
  page,
}) => {
  await page.goto(`${server.origin}/?run=${facts.states.Running}&view=graph`);
  await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
  const { cards } = facts;
  const expected: Record<string, string> = {
    [cards.agent]: "AGENT",
    [cards.failed]: "AGENT",
    [cards.blocked]: "AGENT",
    [cards.command]: "COMMAND",
    [cards.human]: "HUMAN",
    [cards.changeByRepo]: "CHANGE",
    [cards.changeBySteps]: "CHANGE",
    // A declared kind wins over a change's shape.
    [cards.commandWithRepo]: "COMMAND",
    [cards.humanWithRepo]: "HUMAN",
  };
  const icons = new Map<string, string>();
  for (const [node, kind] of Object.entries(expected)) {
    const card = page.getByRole("article", {
      name: new RegExp(`^${node}: `, "u"),
    });
    const icon = card.getByRole("img", { name: kind.toLowerCase() });
    await expect(icon).toHaveCount(1);
    // The pill is the icon's own badge, its word drawn in capitals.
    // llmlint: ignore[e2e_uses_accessible_selectors] the pill has no role of its own: it is reached as the parent of its icon, found by the kind it names, so its drawn word can be read beside it.
    const pill = icon.locator("xpath=..");
    await expect(pill).toHaveText(kind, { useInnerText: true });
    // Before the word.
    expect((await boxOf(icon)).x).toBeLessThan(
      (await boxOf(pill)).x + (await boxOf(pill)).width / 2,
    );
    icons.set(kind, (await icon.getAttribute("class")) ?? "");
  }
  expect(new Set(icons.values()).size).toBe(4);
  await expect(page.getByText(/lifecycle/iu)).toHaveCount(0);
});

test("the Task tab reads as a document: real heading sizes and spacing", async ({
  page,
}) => {
  await page.goto(
    `${server.origin}/?run=${facts.states.Running}&node=${facts.cards.agent}&tab=task`,
  );
  const scope = page
    .getByRole("tabpanel", { name: "Task" })
    .getByRole("heading", { name: "Scope", exact: true });
  await expect(scope).toBeVisible();
  // The rendered task: the block the heading is one of.
  // llmlint: ignore-block[e2e_uses_accessible_selectors] the rendered markdown has no role or name of its own; it is reached as the parent of a heading found by name, and its blocks' type sizes and spacing are measured, which no role exposes.
  const prose = scope.locator("xpath=..");
  const sizes = await prose.evaluate((element) => {
    const size = (selector: string) => {
      const found = element.querySelector(selector);
      if (found === null) throw new Error(`the task renders no ${selector}`);
      return Number.parseFloat(getComputedStyle(found).fontSize);
    };
    const gaps: number[] = [];
    const blocks = [...element.children];
    for (const [index, block] of blocks.entries()) {
      const next = blocks[index + 1];
      if (
        next !== undefined &&
        /^(P|UL|OL)$/u.test(block.tagName) &&
        /^(P|UL|OL)$/u.test(next.tagName)
      )
        gaps.push(
          next.getBoundingClientRect().top -
            block.getBoundingClientRect().bottom,
        );
    }
    return { h2: size("h2"), h3: size("h3"), p: size("p"), gaps };
  });
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  expect(sizes.h2).toBeGreaterThan(sizes.h3);
  expect(sizes.h3).toBeGreaterThan(sizes.p);
  expect(sizes.gaps.length).toBeGreaterThan(0);
  for (const gap of sizes.gaps) expect(gap).toBeGreaterThan(0);
});

test("every change request link reads as its short id", async ({ page }) => {
  const { pr, prId, cards } = facts;
  await page.goto(
    `${server.origin}/?run=${facts.states.Running}&node=${cards.changeByRepo}&tab=remote`,
  );
  const node = page.getByRole("region", {
    name: `Timeline for ${cards.changeByRepo}`,
  });
  await expect(
    node
      .getByRole("region", { name: "Node header", exact: true })
      .getByRole("link", { name: prId }),
  ).toHaveAttribute("href", pr);
  await expect(
    node.getByRole("tabpanel").getByRole("link", { name: prId }),
  ).toHaveAttribute("href", pr);
  await expect(page.getByRole("link", { name: /Pull request/u })).toHaveCount(
    0,
  );

  // The publication record's own detail names it the same way.
  await node.getByRole("tab", { name: "Timeline" }).click();
  await page
    .getByRole("button", { name: /^Open change-opened/u })
    .first()
    .click();
  const detail = page.getByRole("region", { name: "Timeline item detail" });
  await expect(detail.getByRole("link", { name: prId })).toHaveAttribute(
    "href",
    pr,
  );
  await expect(page.getByRole("link", { name: /Pull request/u })).toHaveCount(
    0,
  );
});

test("an opened record covers the node's content and leaves the run bar and the node bar in reach", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { cards } = facts;
  await page.goto(
    `${server.origin}/?run=${facts.states.Running}&node=${cards.changeByRepo}`,
  );
  await page
    .getByRole("button", { name: /^Open change-opened/u })
    .first()
    .click();
  const drawer = page.getByRole("complementary", {
    name: "Item detail panel",
  });
  await expect(drawer).toBeVisible();
  const node = page.getByRole("region", {
    name: `Timeline for ${cards.changeByRepo}`,
  });
  const bar = await boxOf(
    node.getByRole("region", { name: "Node header", exact: true }),
  );
  expect((await boxOf(drawer)).y).toBeGreaterThanOrEqual(
    bar.y + bar.height - 1,
  );
  // Both bars' tabs still take a press while it is open.
  await node.getByRole("tab", { name: "Remote" }).click();
  await expect(node.getByRole("tab", { name: "Remote" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await runBar(page).getByRole("tab", { name: "Overall" }).click();
  await expect(wholeDag(page)).toBeVisible();
});

test("the Remote tab's checks read as one coloured status icon each, with no Conclusion column", async ({
  page,
}) => {
  await page.goto(
    `${server.origin}/?run=${facts.states.Running}&node=${facts.cards.changeByRepo}&tab=remote`,
  );
  const table = page.getByRole("table", { name: "Remote checks" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Name",
    "Status",
    "Runtime",
    "Required",
  ]);
  const expected: Record<string, string> = {
    lint: "passed",
    unit: "passed",
    e2e: "failed",
    build: "running",
    "deploy-preview": "queued",
    docs: "skipped",
    audit: "neutral",
  };
  const colours = new Map<string, string>();
  for (const [name, word] of Object.entries(expected)) {
    const row = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name, exact: true }),
    });
    const status = row.getByRole("cell").first();
    await expect(status.getByRole("img")).toHaveCount(1);
    await expect(status.getByRole("img")).toHaveAccessibleName(word);
    colours.set(word, await colourOf(status.getByRole("img")));
    if (word === "passed") {
      // A successful row never reads as a warning: every colour painted in it.
      // llmlint: ignore-block[e2e_uses_accessible_selectors] the colour of every element a row paints is the property under test, which no role or name exposes; the row is found by its row header's name.
      const painted = await row.evaluate((element) =>
        [element, ...element.querySelectorAll("*")].map(
          (each) => getComputedStyle(each).color,
        ),
      );
      // llmlint: ignore-end[e2e_uses_accessible_selectors]
      for (const colour of painted) {
        const [r = 0, g = 0, b = 0] = (colour.match(/[\d.]+/gu) ?? []).map(
          Number,
        );
        const yellow = r > 150 && g > 120 && b < 0.6 * Math.min(r, g);
        expect(yellow, `${name}: ${colour}`).toBe(false);
      }
    }
  }
  expect(new Set(colours.values()).size).toBe(colours.size);
});

test("a bookmark naming the retired Channel view or Decisions reading opens Overall, read whole", async ({
  page,
}) => {
  const run = facts.states.Running;
  // The reading the page subscribes under, read off the request as it leaves.
  const subscribed = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === API_V2_PATHS.subscriptions &&
      request.method() === "POST",
  );
  await page.goto(`${server.origin}/?run=${run}&view=channel&detail=decisions`);
  const view = z
    .object({ view: z.object({ filter: z.string().optional() }) })
    .parse((await subscribed).postDataJSON()).view;
  expect(view.filter).toBe("detailed");
  await expect(page.getByRole("tab", { name: "Overall" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(wholeDag(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Channel" })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Level of detail" }),
  ).toHaveCount(0);
});
