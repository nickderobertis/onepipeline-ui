// SPIKE (throwaway, never lands): the judge-turns / event-kinds visual spike's captures.
// `SPIKE_SIDE=before|after` names the images; `scripts/spike-judge-turns-capture.sh`
// runs this once on the base (mock reverted, fixture kept) and once on the mock, then
// lays each view's two widths side by side once the after-shots are taken.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

const side = process.env.SPIKE_SIDE ?? "after";
const out = resolve(
  import.meta.dirname,
  "../..",
  process.env.SPIKE_OUT ?? "shots/local/judge-spike",
);
mkdirSync(join(out, "raw"), { recursive: true });
mkdirSync(join(out, "report"), { recursive: true });

const SIZES = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];
const RUN = "dag-ui-judge-spike";
const FIRST = "node-scope-1794000000000-5100";

let server: FixtureServer | undefined;

async function visit(page: Page, query: string): Promise<void> {
  server ??= await startFixtureServer("judge-spike", ["--judge-spike-corpus"]);
  await page.goto(`${server.origin}/?run=${RUN}&${query}`);
}

const transcript = (page: Page) =>
  page.getByRole("region", { name: "Node transcript" });
const drawer = (page: Page) =>
  page.getByRole("complementary", { name: "Item detail panel" });

async function node(page: Page): Promise<void> {
  await visit(page, "node=drawer");
  await expect(
    side === "after"
      ? transcript(page).locator(".spike-row").first()
      : transcript(page).getByRole("article").first(),
  ).toBeVisible();
  await page.waitForTimeout(1500);
}

/**
 * Open a dispatch's whole worker or judge conversation: its session's span row on
 * the base, which the grouped list no longer lists, so the mock's own hook there.
 */
async function openSession(
  page: Page,
  dispatch: number,
  judge: boolean,
): Promise<void> {
  if (side === "before") {
    await openRow(page, judge ? judgeSpan : `worker (${FIRST}.worker)`);
    return;
  }
  await page.evaluate(
    ([n, j]) =>
      (window as unknown as { __spikeOpenSession: (n: number, j: boolean) => string | undefined })
        .__spikeOpenSession(n as number, j as boolean),
    [dispatch, judge] as const,
  );
  await drawerOpened(page);
}

/** The drawer's first turn, once it has opened. */
async function drawerOpened(page: Page): Promise<void> {
  await expect(
    drawer(page).getByRole("article", { name: /^Turn / }).first(),
  ).toBeVisible();
  await page.waitForTimeout(2000);
}

/**
 * Open the `nth` row whose label starts with `start`. On the mock the list is
 * grouped by turn, newest dispatch first, so `afterNth` counts in that order and
 * the group holding the row is opened first; on the base it is the flat list.
 */
async function openRow(
  page: Page,
  start: string,
  nth = 0,
  afterNth = nth,
): Promise<void> {
  if (side === "after") {
    const key = await page.evaluate(
      ([text, n]) =>
        (window as unknown as { __spikeReveal: (t: string, n: number) => string | undefined })
          .__spikeReveal(text as string, n as number),
      [start, afterNth] as const,
    );
    if (key === undefined) throw new Error(`no row starts with ${start}`);
    const row = transcript(page).locator(`[data-row-key="${key}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await drawerOpened(page);
    return;
  }
  const row = transcript(page)
    .getByRole("article")
    .filter({ has: page.getByRole("button", { name: `Open ${start}` }) })
    .nth(nth);
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button").first().click({ position: { x: 24, y: 8 } });
  await expect(
    drawer(page).getByRole("article", { name: /^Turn / }).first(),
  ).toBeVisible();
  await page.waitForTimeout(2000);
}

/** Scroll the drawer's reading so `target` sits under its pinned chart, or to its top. */
async function scrollDrawer(page: Page, target?: Locator): Promise<void> {
  if (target === undefined) {
    await drawer(page)
      .locator("[data-radix-scroll-area-viewport]")
      .first()
      .evaluate((element) => {
        element.scrollTop = 0;
      });
  } else {
    await target.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
  }
  await page.waitForTimeout(800);
}

const judgeSpan = `worker · judge (${FIRST}.worker.judge)`;
const turn = (page: Page, id: string) =>
  drawer(page).locator(`article[data-turn-id="${id}"]`).first();

async function overall(page: Page): Promise<Locator> {
  await visit(page, "view=overall");
  const graph = page.getByRole("region", { name: "Graph timeline" });
  await expect(graph).toBeVisible();
  await page.waitForTimeout(1500);
  return graph;
}

type Shot = {
  name: string;
  /** A view only the mock has: no before. */
  fresh?: boolean;
  /** The viewports it is shown at, where not both. */
  sizes?: string[];
  go: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
  // 1. The drawer's Close, over a worker conversation and over a judge conversation.
  {
    name: "01-close-worker",
    go: async (page) => {
      await node(page);
      await openRow(page, "I'll move Close into a bar of its own", 1, 0);
      await scrollDrawer(page);
    },
  },
  {
    name: "01-close-judge",
    go: async (page) => {
      await node(page);
      await openSession(page, 1, true);
      await scrollDrawer(page);
    },
  },
  // 2. Collapsed tool calls, and an expanded codex call.
  {
    name: "02-tools-claude",
    go: async (page) => {
      await node(page);
      await openRow(page, "I'll move Close into a bar of its own", 1, 0);
    },
  },
  {
    name: "02-tools-codex",
    go: async (page) => {
      await node(page);
      await openRow(page, "I'll run the drawer's focused tests");
    },
  },
  {
    name: "02-tools-claude-expanded",
    go: async (page) => {
      await node(page);
      await openRow(page, "I'll move Close into a bar of its own", 1, 0);
      const call = drawer(page)
        .getByRole("button", { name: "Bash tool details" })
        .filter({ hasText: "Run the timeline unit tests" })
        .first();
      await call.click();
      await page.waitForTimeout(800);
      // Below the drawer's pinned chart, not under it.
      await call.evaluate((element) => {
        const viewport = element.closest("[data-radix-scroll-area-viewport]");
        if (!viewport) return;
        const pinned = viewport.querySelector(".conversation-timeline-sticky");
        const below = pinned ? pinned.getBoundingClientRect().bottom : viewport.getBoundingClientRect().top;
        viewport.scrollTop += element.getBoundingClientRect().top - below - 12;
      });
      await page.waitForTimeout(800);
    },
  },
  {
    name: "02-tools-codex-expanded",
    go: async (page) => {
      await node(page);
      await openRow(
        page,
        side === "after"
          ? "Shell cd apps/dag-ui && bunx vitest run src/features/timeline/timeline-model"
          : "cd apps/dag-ui && bunx vitest run src/features/timeline/timeline-model",
      );
    },
  },
  // 3. A judge conversation: the supervisor's and the verdict judge's turns, then
  // the concluding turn.
  {
    name: "03-judge-turns",
    go: async (page) => {
      await node(page);
      await openSession(page, 1, true);
      await scrollDrawer(page, turn(page, `${FIRST}.worker.judge.2`));
    },
  },
  {
    name: "03-judge-verdict",
    go: async (page) => {
      await node(page);
      await openSession(page, 1, true);
      await scrollDrawer(page, turn(page, `${FIRST}.worker.judge.3`));
    },
  },
  {
    // The concluding turn's answer — its verdicts and completion reason — placed
    // just below the drawer's pinned chart, so all of it fits at both widths.
    name: "03-judge-conclusion",
    go: async (page) => {
      await node(page);
      await openSession(page, 1, true);
      await turn(page, `${FIRST}.worker.judge.4`)
        .locator('[data-turn-part="answer"]')
        .evaluate((answer) => {
          const viewport = answer.closest("[data-radix-scroll-area-viewport]");
          const pinned = viewport?.querySelector(".conversation-timeline-sticky");
          if (!viewport || !pinned) return;
          // The turn's author line sits just above its answer; keep it in view.
          const from = answer.getBoundingClientRect().top - 28;
          viewport.scrollTop += from - pinned.getBoundingClientRect().bottom - 8;
        });
      await page.waitForTimeout(800);
    },
  },
  // 4. A worker turn and the judge turn that ruled on it, and the judge's lane.
  {
    name: "04-worker-turn",
    go: async (page) => {
      await node(page);
      await openSession(page, 1, false);
      await scrollDrawer(page, turn(page, `${FIRST}.worker.1`));
    },
  },
  {
    name: "04-judge-turn",
    go: async (page) => {
      await node(page);
      await openSession(page, 1, true);
      await scrollDrawer(page, turn(page, `${FIRST}.worker.judge.1`));
    },
  },
  {
    name: "04-judge-lane",
    fresh: true,
    go: async (page) => {
      await node(page);
      await page
        .getByRole("region", { name: "Node timeline" })
        .getByRole("button", { name: "Expand timeline" })
        .click();
      await page.waitForTimeout(1200);
    },
  },
  // 5. The dispatch's event list, and its open filter.
  {
    name: "05-event-rows",
    go: async (page) => {
      await node(page);
    },
  },
  {
    // The grouped list scrolled to its newest dispatch: the newest worker turn and
    // the rulings on it open, every other turn and dispatch folded.
    name: "05-event-grouped",
    fresh: true,
    go: async (page) => {
      await node(page);
      await transcript(page)
        .locator(".spike-dispatch")
        .first()
        .evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(600);
    },
  },
  {
    name: "05-event-filter",
    go: async (page) => {
      await node(page);
      await page.locator(".event-type-filter > summary").click();
      await page.waitForTimeout(600);
    },
  },
  // 8. A tool call row of the final verdict's group, opened in the drawer.
  {
    name: "08-judge-row",
    fresh: true,
    sizes: ["1440x900"],
    go: async (page) => {
      await node(page);
      const verdict = transcript(page)
        .locator(".spike-group")
        .filter({ hasText: "Final verdict on turn 3" })
        .first();
      const row = verdict.locator(".spike-row").filter({ hasText: "git diff --stat main...HEAD" });
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await drawerOpened(page);
      // The judge turn's heading just below the drawer's pinned chart.
      await drawer(page)
        .locator(".spike-judge-heading")
        .evaluate((heading) => {
          const viewport = heading.closest("[data-radix-scroll-area-viewport]");
          const pinned = viewport?.querySelector(".conversation-timeline-sticky");
          if (!viewport || !pinned) return;
          viewport.scrollTop +=
            heading.getBoundingClientRect().top - pinned.getBoundingClientRect().bottom - 8;
        });
      // The list's selected row in view beside it.
      await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(800);
    },
  },
  // 6. The node chart beside the drawer's turns chart; the Graph timeline; a row's.
  {
    name: "06-charts",
    go: async (page) => {
      await node(page);
      await openRow(page, "Read apps/dag-ui/src/features/timeline/useConversation.ts");
      await scrollDrawer(page);
    },
  },
  {
    name: "06-graph-timeline",
    go: async (page) => {
      await overall(page);
    },
  },
  {
    name: "06-row-timeline",
    go: async (page) => {
      const graph = await overall(page);
      await graph.getByRole("button", { name: /^(Expand|Collapse) timeline$/ }).click();
      const row = page.getByRole("region", { name: "drawer timeline" });
      await row.getByRole("button", { name: "Expand timeline" }).click();
      await page.waitForTimeout(1200);
      await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(600);
    },
  },
  // 7. The Graph timeline's Expand, and Collapse after it.
  {
    name: "07-expanded",
    fresh: true,
    go: async (page) => {
      const graph = await overall(page);
      await graph.getByRole("button", { name: "Expand timeline" }).click();
      await page.waitForTimeout(1200);
      await graph.evaluate((element) => element.scrollIntoView({ block: "start" }));
    },
  },
  {
    name: "07-collapsed",
    fresh: true,
    go: async (page) => {
      const graph = await overall(page);
      await graph.getByRole("button", { name: "Expand timeline" }).click();
      await page.waitForTimeout(1200);
      await graph.getByRole("button", { name: "Collapse timeline" }).click();
      await page.waitForTimeout(1200);
      await graph.evaluate((element) => element.scrollIntoView({ block: "start" }));
    },
  },
];

const only = process.env.SPIKE_ONLY?.split(",");
const wanted = (shot: Shot) =>
  !only || only.some((prefix) => shot.name.startsWith(prefix));

function compose() {
  // One image per view and side: the desktop shot beside the phone shot.
  test.describe("SPIKE-judge compose", () => {
    test.use({ viewport: { width: 1900, height: 1000 } });
    for (const shot of SHOTS.filter(wanted))
      for (const which of ["before", "after"])
        test(`SPIKE-judge compose ${which} ${shot.name}`, async ({ page }) => {
          const files = SIZES.filter(
            (size) => !shot.sizes || shot.sizes.includes(size.name),
          ).map((size) => join(out, "raw", `${which}-${shot.name}-${size.name}.png`));
          test.skip(!files.every((file) => existsSync(file)), "not captured");
          const images = files.map(
            (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`,
          );
          const widths = [1440, 390];
          await page.setContent(
            `<body style="margin:0;background:#0b0f17"><div id="c" style="display:inline-flex;gap:24px;padding:16px;align-items:flex-start;background:#0b0f17">${images
              .map((src, i) => `<img src="${src}" style="width:${widths[i]}px;outline:1px solid #334">`)
              .join("")}</div></body>`,
          );
          await page.locator("#c").screenshot({
            path: join(out, "report", `${which}-${shot.name}.png`),
          });
        });
  });
}

{
  for (const size of SIZES) {
    test.describe(`SPIKE-judge at ${size.name}`, () => {
      test.use({ viewport: { width: size.width, height: size.height } });
      test.afterAll(async () => {
        await server?.stop();
        server = undefined;
      });
      for (const shot of SHOTS.filter(wanted)) {
        if (side === "before" && shot.fresh) continue;
        if (shot.sizes && !shot.sizes.includes(size.name)) continue;
        test(`SPIKE-judge ${side} ${shot.name} ${size.name}`, async ({ page }) => {
          await shot.go(page);
          await page.mouse.move(size.width - 2, size.height - 2);
          await page.waitForTimeout(400);
          await page.screenshot({
            path: join(out, "raw", `${side}-${shot.name}-${size.name}.png`),
            animations: "disabled",
          });
        });
      }
    });
  }
}
// After the after-shots, in file order: both sides' raw shots exist by then.
if (side === "after") compose();
