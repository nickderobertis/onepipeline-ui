/**
 * SPIKE (spike-visual, never lands): the before/after screenshots of the DAG UI
 * readability plan. Runs through the repository's own capture path,
 * `scripts/visual-capture.sh -- spike.screens.spec.ts --grep @before|@after`;
 * `scripts/spike-visual.sh` drives both halves. Throwaway: no assertions beyond
 * what it takes to reach each view.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CAPTURE_INSTANT_MS } from "./capture-clock";
import { delayGraphMeasurements } from "./delayed-graph-measurements";
import { runs } from "./fixture-facts";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import recorded from "./fixtures/timeline-recorded.json" with { type: "json" };
import { SPIKE_LONG_RUN, SPIKE_RUN } from "./fixtures/runs.mjs";
import { graphNodes } from "./observatory-locators";
import { FIXTURE_WORKSPACE } from "./playwright.config";
import { viewport } from "./viewports";

const out = (() => {
  const named = process.env.SHOTS_OUT;
  if (!named) throw new Error("SHOTS_OUT must name the capture directory");
  const directory = resolve(import.meta.dirname, "../..", named);
  mkdirSync(directory, { recursive: true });
  return directory;
})();

async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("[data-first-screen]")).toHaveCount(0);
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const held = window as unknown as { __p?: string; __q?: number };
      const print = document.body.innerHTML;
      if (held.__p === print) held.__q = (held.__q ?? 0) + 1;
      else {
        held.__p = print;
        held.__q = 0;
      }
      return (held.__q ?? 0) >= 4;
    },
    undefined,
    { polling: 250 },
  );
}

async function still(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important}",
  });
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (
        animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY
      ) {
        animation.currentTime = 0;
        animation.pause();
      } else animation.finish();
    }
  });
}

const node = (id: string) => `/?run=${SPIKE_RUN}&node=${id}`;

async function openRow(page: Page, text: RegExp): Promise<void> {
  await page
    .getByRole("region", { name: "Node transcript" })
    .locator("article.transcript-item")
    .filter({ hasText: text })
    .first()
    .getByRole("button")
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toBeVisible();
}

let world: FixtureServer | undefined;

async function actionItems(page: Page, name: string): Promise<void> {
  world = await startFixtureServer(
    `spike-${name}`,
    ["--human-items-world", name],
    {
      DAG_UI_E2E_WORLD_TEMPLATES: join(FIXTURE_WORKSPACE, "human-items-worlds"),
    },
    { samePath: true },
  );
  await visit(page, `${world.origin}/human-items`);
  await expect(
    page
      .getByRole("region", { name: "Action item list" })
      .getByRole("article")
      .first(),
  ).toBeVisible();
}

type Phase = "before" | "after";

interface Shot {
  readonly name: string;
  readonly phases: readonly Phase[];
  readonly sizes: readonly string[];
  readonly open: (page: Page, phase: Phase) => Promise<void>;
}

const DESK = ["1440x900"];
const BOTH = ["1440x900", "390x844"];

const SHOTS: readonly Shot[] = [
  {
    // Changes 1, 3 and 4: the node's event list, its filter, the chart's axis.
    name: "s01-node-events",
    phases: ["before", "after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, node("adopt-engine"));
      await expect(
        page.getByRole("region", { name: "Node transcript" }),
      ).toBeVisible();
    },
  },
  {
    // Change 4: the partial mark while the node is still loading.
    name: "s01b-node-chart-partial",
    phases: ["after"],
    sizes: DESK,
    open: async (page) => {
      await page.addInitScript(() =>
        window.localStorage.setItem("spike-partial", "1"),
      );
      await visit(page, node("adopt-engine"));
      await expect(page.getByText(/Partial — loading/u)).toBeVisible();
    },
  },
  {
    // Change 3: the event-type multi-select, opened.
    name: "s01c-node-events-filter",
    phases: ["after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, node("adopt-engine"));
      await page.getByRole("button", { name: /^Event types/u }).click();
      await expect(
        page.getByRole("group", { name: "Event types" }),
      ).toBeVisible();
    },
  },
  {
    // Change 1: the end of the same list, where each surface is one row.
    name: "s01d-node-events-end",
    phases: ["before", "after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, node("adopt-engine"));
      const list = page.getByRole("region", { name: "Node transcript" });
      await expect(list).toBeVisible();
      await settle(page);
      await list
        .locator("article.transcript-item")
        .last()
        .evaluate((element) => element.scrollIntoView({ block: "end" }));
    },
  },
  {
    // Change 2: what a person attested.
    name: "s02-attested-detail",
    phases: ["before", "after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, node("approve-release"));
      await openRow(page, /approve-release|Approved/u);
    },
  },
  {
    // Change 2: a command as one command line.
    name: "s03-command-detail",
    phases: ["before", "after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, node("build-docs"));
      await openRow(page, /command-started|bun run build/u);
    },
  },
  {
    // Change 5: Overall, with the run details card. Before is the baseline's
    // 20-recorded-overall, at both sizes.
    name: "s04-overall",
    phases: ["after"],
    sizes: BOTH,
    open: async (page) => {
      await visit(page, `/?run=${recorded.run_id}&view=overall`);
      await page
        .getByRole("button", { name: "Load the run's own records" })
        .click();
      const events = page.getByRole("region", { name: "Run events" });
      await expect(events.getByText(/completion-requested/u)).toBeVisible();
      if ((page.viewportSize()?.width ?? 0) < 700) {
        await settle(page);
        await page
          .getByRole("group", { name: "Run details" })
          .evaluate((element) => element.scrollIntoView({ block: "center" }));
      } else await events.scrollIntoViewIfNeeded();
    },
  },
  {
    // Changes 6 and 8: tabs and graph cards. Before is the baseline's 04-graph.
    name: "s05-graph",
    phases: ["after"],
    sizes: DESK,
    open: async (page) => {
      await delayGraphMeasurements(page);
      await visit(page, `/?run=${runs().live}&view=graph`);
      await settle(page);
      await expect(graphNodes(page, "running")).toHaveAccessibleName(
        "dashboard: running",
      );
      // Revision 3's evidence: each card's padding below its last line, in CSS px.
      const pads = await page.$$eval("article.dag-node", (cards) =>
        cards.map((card) => {
          const last = [...card.children]
            .filter((child) => child.tagName === "SPAN" || child.tagName === "STRONG")
            .at(-1);
          const scale = card.getBoundingClientRect().height / card.offsetHeight;
          const status = card.querySelector(".node-status")?.getBoundingClientRect();
          const reason = card.querySelector(".node-reason")?.getBoundingClientRect();
          const gap =
            status && reason ? ((reason.top - status.bottom) / scale).toFixed(1) : "-";
          return `${card.getAttribute("aria-label")} reason=${reason !== undefined} gap=${gap} pad=${((card.getBoundingClientRect().bottom - (last?.getBoundingClientRect().bottom ?? 0)) / scale - card.clientTop).toFixed(1)}`;
        }),
      );
      console.log(`SPIKE card padding:\n${pads.join("\n")}`);
    },
  },
  {
    // Change 7: a 160-character title beside DRIVER DEAD and Updates.
    name: "s06-header",
    phases: ["before", "after"],
    sizes: BOTH,
    open: async (page, phase) => {
      await delayGraphMeasurements(page);
      await visit(page, `/?run=${SPIKE_LONG_RUN}&view=graph`);
      await expect(
        page.getByLabel(
          phase === "after" ? "Run state Driver dead" : "Liveness DRIVER DEAD",
        ),
      ).toBeVisible();
    },
  },
  {
    // Change 9: the Task tab's Markdown.
    name: "s07-task",
    phases: ["before", "after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, node("adopt-engine"));
      await page.getByRole("tab", { name: "Task", exact: true }).click();
    },
  },
  {
    // Change 10: the Remote tab. Before is the baseline's 21-remote.
    name: "s08-remote",
    phases: ["after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, `/?run=${runs().live}&node=remote-open`);
      await settle(page);
      await page.getByRole("tab", { name: "Remote", exact: true }).click();
      await expect(
        page.getByRole("table", { name: "Remote checks" }),
      ).toBeVisible();
    },
  },
  {
    // Change 11: a question with choices and the design approval.
    name: "s09-action-items",
    phases: ["before", "after"],
    sizes: BOTH,
    open: async (page, phase) => {
      await actionItems(page, `spike-${phase}`);
    },
  },
  {
    // Change 12: one finished turn's words, reasoning and tools.
    name: "s10-transcript",
    phases: ["before", "after"],
    sizes: DESK,
    open: async (page) => {
      await visit(page, node("adopt-engine"));
      await openRow(page, /worker-adopt-engine/u);
    },
  },
];

test.afterEach(async () => {
  await world?.stop();
  world = undefined;
});

for (const shot of SHOTS)
  for (const phase of shot.phases)
    for (const size of shot.sizes) {
      const { width, height } = viewport(size);
      test.describe(`${shot.name} ${size}`, () => {
        test.use({ viewport: { width, height } });
        test(`${shot.name} @${phase} at ${size}`, async ({ page }) => {
          await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
          await shot.open(page, phase);
          // The run state badge waits on the status read; shoot once it is in.
          if (phase === "after" && (await page.locator(".run-topbar").count()) > 0)
            await page
              .locator(".run-topbar .spike-run-state")
              .first()
              .waitFor({ timeout: 15_000 });
          await page.mouse.move(0, 0);
          await settle(page);
          await still(page);
          await settle(page);
          await page.screenshot({
            path: join(out, `${shot.name}-${phase}-${size}.png`),
            animations: "disabled",
          });
        });
      });
    }
