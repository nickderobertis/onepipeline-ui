/**
 * The left navigation's rows and the drawer it becomes on a phone, against the
 * built view and the real read API: which rows a reader starts with and how they
 * open, how a row is laid out, how a row moves, and what a thumb can reach.
 */

import { join } from "node:path";
import { projectListSchema } from "@onepipeline-ui/dag-model";
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { z } from "zod";
import { runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";
import { appendRecords } from "./load/journal";
import { DESKTOP, PHONE } from "./viewports";

const WIDE = { name: "1440x900", width: 1440, height: 900 } as const;

const navigation = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Projects" });
const menu = (page: Page): Locator =>
  page.getByRole("button", { name: "Open navigation" });
const project = (page: Page, label: string): Locator =>
  navigation(page).getByRole("group", {
    name: `Project ${label}`,
    exact: true,
  });
/** Every run row a project or the whole navigation is listing. */
const runRows = (scope: Locator): Locator =>
  scope.getByRole("list", { name: /^Runs of / }).getByRole("button");
const runRow = (scope: Locator, run: string): Locator =>
  scope.getByRole("button", { name: new RegExp(run) });

/** Served projects, each with its runs newest first as the navigation lists them. */
async function servedProjects(request: APIRequestContext) {
  return projectListSchema.parse(
    await (await request.get("/api/v2/projects")).json(),
  ).projects;
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("the element has no box");
  return found;
}

/** Dot, name and tag share one line: each one's vertical centre within a pixel or two. */
async function expectOneLine(row: Locator, run: string): Promise<void> {
  const dot = await box(row.getByRole("img"));
  const name = await box(row.getByText(run, { exact: true }));
  const tag = await box(row.getByRole("note"));
  const middle = (part: { y: number; height: number }) =>
    part.y + part.height / 2;
  expect(Math.abs(middle(dot) - middle(name))).toBeLessThanOrEqual(2);
  expect(Math.abs(middle(tag) - middle(name))).toBeLessThanOrEqual(2);
  expect(dot.x + dot.width).toBeLessThanOrEqual(name.x);
  expect(name.x + name.width).toBeLessThanOrEqual(tag.x);
  const whole = await box(row);
  expect(tag.x + tag.width).toBeLessThanOrEqual(whole.x + whole.width);
}

for (const size of [WIDE, PHONE] as const) {
  test(`projects start collapsed with the selected run's project open, and a project row opens its newest shown run at ${size.name}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/?run=${runs().live}&view=graph`);
    if (size === PHONE) await menu(page).click();
    await expect(runRow(navigation(page), runs().live)).toBeVisible();

    const projects = await servedProjects(request);
    const label = (group: (typeof projects)[number]) =>
      group.name ?? group.project ?? "Other runs";
    const holding = projects.find((group) =>
      group.runs.some((run) => run.run_id === runs().live),
    );
    const other = projects.find(
      (group) => group !== holding && group.runs.length > 0,
    );
    if (holding === undefined || other === undefined)
      throw new Error("the fixture serves two projects with runs");
    await expect(
      navigation(page).getByRole("group", { name: /^Project / }),
    ).toHaveCount(projects.length);
    // Only the selected run's project lists its runs, under a row with its count.
    await expect(runRows(navigation(page))).toHaveCount(holding.runs.length);
    await expect(
      project(page, label(holding)).getByRole("button", {
        name: `${label(holding)} ${holding.runs.length} shown runs`,
        exact: true,
      }),
    ).toBeVisible();

    const newest = await project(page, label(other))
      .getByRole("button", {
        name: `${label(other)} ${other.runs.length} shown runs`,
        exact: true,
      })
      .click()
      .then(() => new URL(page.url()));
    await expect
      .poll(() => new URL(page.url()).searchParams.get("run"))
      .not.toBe(runs().live);
    expect(newest.pathname).toBe("/");
    const chosen = new URL(page.url()).searchParams.get("run");
    if (chosen === null) throw new Error("the project row chose no run");
    expect(other.runs.map((run) => run.run_id)).toContain(chosen);
    await expect(runRow(project(page, label(other)), chosen)).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The first row it lists is the one it opened.
    await expect(runRows(project(page, label(other))).first()).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
}

test("at phone width the navigation is a drawer over a main area spanning the viewport", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
  await page.goto(`/?run=${runs().live}&view=graph`);
  await expect(menu(page)).toBeVisible();

  // Closed: nothing of it on screen, and the main area has the whole width.
  await expect(navigation(page)).toHaveCount(0);
  const workspace = await box(page.getByRole("main"));
  expect(workspace.x).toBe(0);
  expect(workspace.width).toBe(PHONE.width);

  // Refresh and each setting lie inside the viewport, on any page.
  const inside = async (control: Locator) => {
    const found = await box(control);
    expect(found.x).toBeGreaterThanOrEqual(0);
    expect(found.x + found.width).toBeLessThanOrEqual(PHONE.width);
  };
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  const mainSetting = page.getByRole("combobox", { name: "Main area updates" });
  await inside(refresh);
  await inside(mainSetting);
  // And the run's name is still legible beside the menu button in the top bar.
  const title = page.getByRole("heading", { name: runs().live, exact: true });
  await expect(title).toBeVisible();
  expect(
    await title.evaluate((h) => h.scrollWidth - h.clientWidth),
  ).toBeLessThanOrEqual(0);

  // Opening it: `min(320px, 85vw)` over a scrim.
  await menu(page).click();
  await expect(navigation(page)).toBeVisible();
  await expect.poll(async () => (await box(navigation(page))).x).toBe(0);
  expect((await box(navigation(page))).width).toBeCloseTo(
    Math.min(320, PHONE.width * 0.85),
    0,
  );
  const scrim = page.getByRole("button", { name: "Close navigation" });
  await expect(scrim).toBeVisible();

  // A run row stays one line inside it.
  await expectOneLine(runRow(navigation(page), runs().live), runs().live);
  const navSetting = page.getByRole("combobox", { name: "Navigation updates" });
  await inside(navSetting);

  // Every control this drawer changes is thumb-sized and clear of the others.
  await page
    .getByRole("navigation", { name: "Projects" })
    .getByText(/^Run kinds:/)
    .click();
  const controls = [
    navigation(page).getByRole("button", { name: "Host" }),
    navigation(page).getByRole("button", { name: "Action items" }),
    navigation(page).getByText(/^Run kinds:/),
    // A checkbox's own box is small; the label around it is what a thumb presses.
    ...["field-research", "follow-ups", "main", "planning", "spikes"].map(
      (kind) =>
        navigation(page)
          .getByRole("group", { name: "Run kinds", exact: true })
          .getByText(kind, { exact: true }),
    ),
    navSetting,
    navigation(page).getByRole("button", { name: /^(Expand|Collapse) / }),
    navigation(page).getByRole("button", { name: /shown runs$/ }),
    runRows(navigation(page)),
  ];
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (const group of controls)
    for (const control of await group.all()) {
      const found = await box(control);
      expect(found.height).toBeGreaterThanOrEqual(44);
      boxes.push(found);
    }
  for (const [at, one] of boxes.entries())
    for (const two of boxes.slice(at + 1))
      expect(
        one.x < two.x + two.width &&
          two.x < one.x + one.width &&
          one.y < two.y + two.height &&
          two.y < one.y + one.height,
        `${JSON.stringify(one)} overlaps ${JSON.stringify(two)}`,
      ).toBe(false);

  // Escape closes it, and focus comes back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(navigation(page)).toHaveCount(0);
  await expect(menu(page)).toBeFocused();

  // So does the scrim, at an edge the drawer leaves uncovered.
  await menu(page).click();
  await scrim.click({ position: { x: PHONE.width - 8, y: 400 } });
  await expect(navigation(page)).toHaveCount(0);

  // A project row navigates and opens with the drawer left open, its runs in reach.
  const projects = await servedProjects(request);
  const other = projects.find(
    (group) =>
      group.runs.length > 0 &&
      !group.runs.some((run) => run.run_id === runs().live),
  );
  if (other === undefined)
    throw new Error("the fixture serves a second project");
  const label = other.name ?? other.project ?? "Other runs";
  await menu(page).click();
  await project(page, label)
    .getByRole("button", { name: /shown runs$/ })
    .click();
  await expect(navigation(page)).toBeVisible();
  await expect(runRows(project(page, label)).first()).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`run=${runs().live}`));

  // Choosing a run closes it and shows that run.
  const name = other.runs.at(-1)?.run_id;
  if (name === undefined) throw new Error("the second project serves a run");
  await runRow(project(page, label), name).click();
  await expect(navigation(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`run=${name}`));

  // As Host and Action items do.
  await menu(page).click();
  await navigation(page).getByRole("button", { name: "Host" }).click();
  await expect(navigation(page)).toHaveCount(0);
  await expect(page).toHaveURL(/page=host/);
  await menu(page).click();
  await navigation(page).getByRole("button", { name: "Action items" }).click();
  await expect(navigation(page)).toHaveCount(0);

  // The strip's controls and the menu button are thumb-sized, without overlap.
  await inside(refresh);
  await inside(mainSetting);
  const strip = [menu(page), mainSetting, refresh];
  const stripBoxes = [];
  for (const control of strip) {
    const found = await box(control);
    expect(found.height).toBeGreaterThanOrEqual(44);
    stripBoxes.push(found);
  }
  for (const [at, one] of stripBoxes.entries())
    for (const two of stripBoxes.slice(at + 1))
      expect(
        one.x < two.x + two.width &&
          two.x < one.x + one.width &&
          one.y < two.y + two.height &&
          two.y < one.y + one.height,
      ).toBe(false);
});

test("growing past phone width closes an open drawer and leaves the main area usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
  await page.goto(`/?run=${runs().live}&view=graph`);
  await menu(page).click();
  await expect(navigation(page)).toBeVisible();
  await expect(page.getByRole("main")).toHaveJSProperty("inert", true);

  await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
  await expect(page.getByRole("main")).toHaveJSProperty("inert", false);
  await expect(
    page.getByRole("button", { name: "Close navigation" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();

  // Coming back it is closed, as a page at that width starts.
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
  await expect(navigation(page)).toHaveCount(0);
  await expect(menu(page)).toBeVisible();
});

const longFactsSchema = z.object({ longNamedRun: z.string().min(1) });

test("a long name and tag stay aligned on one line, and only the selected run's row shows its counts", async ({
  page,
}) => {
  const server = await startFixtureServer("long-rows", [
    "--project-centric-corpus",
  ]);
  try {
    const { longNamedRun } = longFactsSchema.parse(server.facts);
    await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
    await page.goto(`${server.origin}/?run=${longNamedRun}&view=graph`);
    const row = runRow(navigation(page), longNamedRun);
    await expect(row).toBeVisible();
    await expectOneLine(row, longNamedRun);
    const name = row.getByText(longNamedRun, { exact: true });
    // The name has the room the dot and the tag leave rather than dead space.
    expect((await box(name)).width).toBeGreaterThan(60);

    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await menu(page).click();
    await expect(row).toBeVisible();
    await expectOneLine(row, longNamedRun);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: WIDE.width, height: WIDE.height });

    // The selected row carries a second line with what its title says; another,
    // only the title.
    const reading = await row.getAttribute("title");
    if (reading === null) throw new Error("the selected row has no title");
    const counts = row.getByText(reading, { exact: true });
    await expect(counts).toBeVisible();
    expect((await box(counts)).y).toBeGreaterThan((await box(name)).y);

    const group = navigation(page).getByRole("group", {
      name: "Project project-centric",
    });
    await group.getByRole("button", { name: "Expand project-centric" }).click();
    const other = runRows(group).first();
    const hover = await other.getAttribute("title");
    if (hover === null) throw new Error("another row has no title");
    await expect(other.getByText(hover, { exact: true })).toHaveCount(0);
    await expect(other).not.toHaveAttribute("aria-current", "page");
  } finally {
    await server.stop();
  }
});

/** The two undated runs of the ordering project, older activity last. */
const UNDATED = { first: "order-undated-active", second: "order-undated-old" };

/** Move the undated second run past the first, by giving it the later activity. */
function swap(workspace: string): void {
  appendRecords(join(workspace, "runs", UNDATED.second, "events.jsonl"), [
    {
      v: 1,
      ts: new Date(Date.now() + 60_000).toISOString(),
      stream: "swap-order",
      seq: 0,
      source: "pipeline",
      kind: "completion-requested",
      labels: { run_id: UNDATED.second },
      payload: {},
    },
  ]);
}

for (const motion of ["no-preference", "reduce"] as const) {
  test(`rows that swap order ${motion === "reduce" ? "stay put under reduced motion" : "animate from where they were"}`, async ({
    page,
  }) => {
    const server = await startFixtureServer(`swap-${motion}`, [
      "--project-centric-corpus",
    ]);
    try {
      await page.emulateMedia({ reducedMotion: motion });
      await page.setViewportSize({
        width: DESKTOP.width,
        height: DESKTOP.height,
      });
      await page.addInitScript(() => {
        // What a reader of a moving list would have seen: every animation a row
        // started, caught as it starts rather than raced for once it is running.
        const started: string[] = [];
        Object.assign(window, { startedAnimations: started });
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          const running = animate.apply(this, args);
          const key = this.getAttribute("data-row-key");
          if (key !== null && this.getAnimations().includes(running))
            started.push(key);
          return running;
        };
      });
      await page.goto(`${server.origin}/?page=host`);
      await page
        .getByRole("combobox", { name: "Navigation updates" })
        .selectOption({ label: "Live" });
      const ordering = project(page, "ordering");
      await ordering.getByRole("button", { name: "Expand ordering" }).click();
      const rows = runRows(ordering);
      await expect(rows.nth(3)).toHaveText(UNDATED.first);
      await expect(rows.nth(4)).toHaveText(UNDATED.second);

      swap(server.workspace);
      await expect(rows.nth(3)).toHaveText(UNDATED.second, { timeout: 20_000 });
      await expect(rows.nth(4)).toHaveText(UNDATED.first);

      const started = await page.evaluate(
        () =>
          (window as unknown as { startedAnimations: string[] })
            .startedAnimations,
      );
      if (motion === "reduce") expect(started).toStrictEqual([]);
      else {
        expect(started).toContain(`run:${UNDATED.second}`);
        expect(started).toContain(`run:${UNDATED.first}`);
      }
      // A project opening pushes rows without their changing places: none travels.
      const settled = started.length;
      await page.waitForTimeout(400);
      await project(page, "another-project")
        .getByRole("button", { name: "Expand another-project" })
        .click();
      await expect(runRows(project(page, "another-project"))).toHaveCount(1);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { startedAnimations: string[] })
              .startedAnimations.length,
        ),
      ).toBe(settled);
      // Nothing is left running once it has arrived.
      await expect
        .poll(() =>
          runRows(ordering).evaluateAll(
            (all) => all.flatMap((row) => row.getAnimations()).length,
          ),
        )
        .toBe(0);
    } finally {
      await server.stop();
    }
  });
}

test("one dropdown selects kinds: the rows narrow, and the selection survives a reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
  await page.goto(`/?run=${runs().live}&view=graph`);
  const nav = navigation(page);
  const liveRow = runRow(nav, runs().live);
  await expect(liveRow).toBeVisible();

  // Closed, it offers no choice and says how many it shows; opened, each kind once.
  const summary = nav.getByText(/^Run kinds:/);
  await expect(nav.getByRole("checkbox")).toHaveCount(0);
  await expect(summary).toHaveText(/^Run kinds: (\d+) of \1$/);
  await summary.click();
  const kinds = nav.getByRole("group", { name: "Run kinds", exact: true });
  const main = kinds.getByRole("checkbox", { name: "main", exact: true });
  await expect(main).toBeChecked();

  const rowsBefore = await runRows(nav).count();
  await kinds
    .getByRole("checkbox", { name: "planning", exact: true })
    .uncheck();
  await expect(summary).not.toHaveText(/^Run kinds: (\d+) of \1$/);
  await expect(page).toHaveURL(/hide-kind=planning/);
  // Its run's row goes, wherever the project is opened.
  await expect.poll(() => runRows(nav).count()).toBeLessThanOrEqual(rowsBefore);
  await expect(runRow(nav, runs().sibling)).toHaveCount(0);

  await page.reload();
  await nav.getByText(/^Run kinds:/).click();
  await expect(
    kinds.getByRole("checkbox", { name: "planning", exact: true }),
  ).not.toBeChecked();
  await expect(main).toBeChecked();
});
