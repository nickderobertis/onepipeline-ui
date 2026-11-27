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
  await expect(transcript(page).getByRole("article").first()).toBeVisible();
  await page.waitForTimeout(1500);
}

/** Open the `nth` transcript row whose label starts with `start`. */
async function openRow(page: Page, start: string, nth = 0): Promise<void> {
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
  go: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
  // 1. The drawer's Close, over a worker conversation and over a judge conversation.
  {
    name: "01-close-worker",
    go: async (page) => {
      await node(page);
      await openRow(page, "I'll move Close into a bar of its own", 1);
      await scrollDrawer(page);
    },
  },
  {
    name: "01-close-judge",
    go: async (page) => {
      await node(page);
      await openRow(page, judgeSpan);
      await scrollDrawer(page);
    },
  },
  // 2. Collapsed tool calls, and an expanded codex call.
  {
    name: "02-tools-claude",
    go: async (page) => {
      await node(page);
      await openRow(page, "I'll move Close into a bar of its own", 1);
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
      await openRow(page, "I'll move Close into a bar of its own", 1);
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
      await openRow(page, "cd apps/dag-ui && bunx vitest run src/features/timeline/timeline-model");
    },
  },
  // 3. A judge conversation: the supervisor's and the verdict judge's turns, then
  // the concluding turn.
  {
    name: "03-judge-turns",
    go: async (page) => {
      await node(page);
      await openRow(page, judgeSpan);
      await scrollDrawer(page, turn(page, `${FIRST}.worker.judge.2`));
    },
  },
  {
    name: "03-judge-verdict",
    go: async (page) => {
      await node(page);
      await openRow(page, judgeSpan);
      await scrollDrawer(page, turn(page, `${FIRST}.worker.judge.3`));
    },
  },
  {
    // The concluding turn's answer — its verdicts and completion reason — placed
    // just below the drawer's pinned chart, so all of it fits at both widths.
    name: "03-judge-conclusion",
    go: async (page) => {
      await node(page);
      await openRow(page, judgeSpan);
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
      await openRow(page, `worker (${FIRST}.worker)`);
      await scrollDrawer(page, turn(page, `${FIRST}.worker.1`));
    },
  },
  {
    name: "04-judge-turn",
    go: async (page) => {
      await node(page);
      await openRow(page, judgeSpan);
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
    name: "05-event-filter",
    go: async (page) => {
      await node(page);
      await page.locator(".event-type-filter > summary").click();
      await page.waitForTimeout(600);
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
          const files = SIZES.map((size) =>
            join(out, "raw", `${which}-${shot.name}-${size.name}.png`),
          );
          test.skip(!files.every((file) => existsSync(file)), "not captured");
          const [desktop, phone] = files.map(
            (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`,
          );
          await page.setContent(
            `<body style="margin:0;background:#0b0f17"><div id="c" style="display:inline-flex;gap:24px;padding:16px;align-items:flex-start;background:#0b0f17"><img src="${desktop}" style="width:1440px;outline:1px solid #334"><img src="${phone}" style="width:390px;outline:1px solid #334"></div></body>`,
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
