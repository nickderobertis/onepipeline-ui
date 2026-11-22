// SPIKE (throwaway, never lands): the conversation-focus visual spike's captures.
// `SPIKE_SIDE=before|after` names the images; `scripts/focus-spike-capture.sh`
// runs this once on the base (mock reverted) and once on the mock.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

const side = process.env.SPIKE_SIDE ?? "after";
const out = resolve(import.meta.dirname, "../..", process.env.SHOTS_OUT ?? "shots/local/focus-spike");
mkdirSync(out, { recursive: true });

const SIZES = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];

/** Index of the node-transcript row whose text starts with `start`, searching from `from`. */
async function rowIndex(page: Page, start: string, from = 0, back = false, tries = 40): Promise<number> {
  try { return await rowIndexOnce(page, start, from, back); } catch (error) {
    if (tries <= 0) throw error;
    await page.waitForTimeout(500);
    return rowIndex(page, start, from, back, tries - 1);
  }
}

async function rowIndexOnce(page: Page, start: string, from: number, back: boolean): Promise<number> {
  const texts = await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  if (back) {
    for (let i = from; i >= 0; i -= 1) if (texts[i]?.startsWith(start)) return i;
  } else {
    for (let i = from; i < texts.length; i += 1) if (texts[i]?.startsWith(start)) return i;
  }
  throw new Error(`no row starting ${start}`);
}

/** Rows around the worker's turn `n`, found from its first tool call. */
async function turnRows(page: Page, n: number) {
  const read = await rowIndex(page, `Read apps/dag-ui/src/panels/panel-${n}.tsx`);
  const started = await rowIndex(page, "turn-started", read, true);
  const message = await rowIndex(page, "turn-message", read);
  const completed = await rowIndex(page, "turn-completed", message);
  const supMessage = await rowIndex(page, "turn-message", started, true);
  const supStarted = await rowIndex(page, "turn-started", supMessage, true);
  return { read, started, message, completed, supMessage, supStarted };
}

async function open(page: Page, index: number): Promise<void> {
  const row = page.getByRole("region", { name: "Node transcript" }).getByRole("article").nth(index);
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button").first().click({ position: { x: 24, y: 8 } });
}

const detail = (page: Page) => page.getByRole("region", { name: "Timeline item detail" });

async function loaded(page: Page): Promise<void> {
  // The base opens some events (its turn-message among them) as a field list, not a conversation.
  await expect(
    detail(page).getByRole("article", { name: /^Turn / }).first()
      .or(detail(page).getByRole("region", { name: "Recorded fields" })).first(),
  ).toBeVisible();
  await page.waitForTimeout(1500);
}

let server: FixtureServer | undefined;

async function visit(page: Page, node = "panels"): Promise<void> {
  server ??= await startFixtureServer("focus-spike", ["--focus-spike-corpus"]);
  await page.goto(`${server.origin}/?run=dag-ui-focus-spike&node=${node}`);
  await expect(
    page.getByRole("region", { name: "Node transcript" }).getByRole("article").first(),
  ).toBeVisible();
  await page.waitForTimeout(1000);
}

const holdTranscripts = (page: Page) =>
  page.route(/\/api\/v2\/runs\/[^/]+\/(conversations|artifacts)\//, () => {
    /* held: never answered, so the drawer stays loading */
  });

type Shot = { name: string; go: (page: Page) => Promise<void> };
const SHOTS: Shot[] = [
  { name: "01-tool-call-loading", go: async (page) => {
    await visit(page); const r = await turnRows(page, 20);
    await holdTranscripts(page); await open(page, r.read + 3); // the git commit call
    await page.waitForTimeout(1500);
  } },
  { name: "01-tool-call-loaded", go: async (page) => {
    await visit(page); const r = await turnRows(page, 20);
    await open(page, r.read + 3); await loaded(page);
  } },
  { name: "02-reasoning", go: async (page) => {
    await visit(page); await open(page, await rowIndex(page, "I'm resolving the merge")); await loaded(page);
  } },
  { name: "03-turn-started", go: async (page) => {
    await visit(page); await open(page, (await turnRows(page, 20)).started); await loaded(page);
  } },
  { name: "03-turn-message", go: async (page) => {
    await visit(page); await open(page, (await turnRows(page, 20)).message); await loaded(page);
  } },
  { name: "03-turn-completed", go: async (page) => {
    await visit(page); await open(page, (await turnRows(page, 20)).completed); await loaded(page);
  } },
  { name: "04-worker-session-span", go: async (page) => {
    await visit(page); await open(page, await rowIndex(page, "Agent (node-scope-1793000000000-4600.worker)")); await loaded(page);
  } },
  { name: "04-judge-span", go: async (page) => {
    await visit(page); await open(page, await rowIndex(page, "Judge (")); await loaded(page);
  } },
  { name: "05-oneharness-session", go: async (page) => {
    await visit(page, "drafted"); await open(page, await rowIndex(page, "oneharness-session")); await loaded(page);
  } },
  { name: "06-supervisor-turn-message", go: async (page) => {
    await visit(page); await open(page, (await turnRows(page, 17)).supMessage); await page.waitForTimeout(2500);
  } },
  { name: "06-supervisor-turn-started", go: async (page) => {
    await visit(page); await open(page, (await turnRows(page, 17)).supStarted); await page.waitForTimeout(2500);
  } },
];

const only = process.env.SPIKE_ONLY?.split(",");
for (const size of SIZES) {
  test.describe(`at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.afterAll(async () => { await server?.stop(); server = undefined; });
    for (const shot of SHOTS) {
      if (only && !only.some((o) => shot.name.startsWith(o))) continue;
      if (side === "before" && shot.name.startsWith("06-")) continue; // new views: after only
      test(`${side} ${shot.name}`, async ({ page }) => {
        await shot.go(page);
        await page.mouse.move(size.width - 2, 2);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, `${side}-${shot.name}-${size.name}.png`), animations: "disabled" });
      });
    }
  });
}
