import {
  dagConversationSchema,
  runTimelineSchema,
} from "@onepipeline-ui/dag-model";
import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { runs } from "./fixture-facts";

/**
 * A shared address that names one session — `?run=…&node=…&event=<its span>` —
 * opens that session's transcript in the detail drawer, and the page reads the
 * transcript beside the view's own code rather than once the view has drawn an
 * empty drawer. The drawer takes the page's read over as its own first, so the
 * transcript is still asked for once.
 *
 * Against the shared server's live run, through the view's real entry; the reads
 * are held or refused at the network boundary only where a journey says so.
 */

const DETAIL = "Timeline item detail";
const CONVERSATIONS = "**/api/v2/runs/*/conversations/**";

/** The live run's first dispatch that opens a conversation, and its turns. */
async function session(page: Page) {
  const runId = runs().live;
  const node = "foundation";
  const timeline = runTimelineSchema.parse(
    await (
      await page.request.get(
        `/api/v2/runs/${runId}/timeline?scope=node&node=${node}`,
      )
    ).json(),
  );
  const span = timeline.spans.find(
    (candidate) =>
      candidate.kind === "dispatch" &&
      candidate.reference?.kind === "conversation",
  );
  if (span?.reference === undefined)
    throw new Error(`${node} serves no dispatch that opens a conversation`);
  const conversation = dagConversationSchema.parse(
    await (
      await page.request.get(
        `/api/v2/runs/${runId}/conversations/${encodeURIComponent(span.reference.value)}`,
      )
    ).json(),
  );
  return {
    address: `/?run=${runId}&node=${node}&event=${encodeURIComponent(span.id)}`,
    id: span.reference.value,
    turns: conversation.conversation.turns.length,
  };
}

/** The opened session's turns, as the drawer draws them. */
function turnsOf(page: Page, id: string): Locator {
  return page.getByRole("region", { name: DETAIL }).getByRole("article", {
    name: new RegExp(
      `^Turn ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+ from `,
    ),
  });
}

/** Every transcript read the page asks for, from here on. */
function transcriptReads(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/conversations/")) asked.push(request.url());
  });
  return asked;
}

declare global {
  interface Window {
    __viewArrivedAt?: number;
    __drawerWaitedOnTranscript?: boolean;
  }
}

test("an address naming a session asks for its transcript before the view's code arrives, and draws its turns", async ({
  page,
}) => {
  const opened = await session(page);
  // When the view arrives behind the first screen, on the page's own clock: the
  // entry inserts the view's root, marked so, before the view draws anything
  // (`app/mount.tsx`), and the transcript read's start is on the same clock.
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      // llmlint: ignore[e2e_uses_accessible_selectors] the moment the view's code arrives is no element a reader can name: its root is marked so only for this probe, and is unmarked before it draws.
      if (document.querySelector("[data-app-behind-first-screen]") === null)
        return;
      window.__viewArrivedAt = performance.now();
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(opened.address);
  await expect(turnsOf(page, opened.id)).toHaveCount(opened.turns);
  const { arrived, asked } = await page.evaluate(() => ({
    arrived: window.__viewArrivedAt,
    asked: performance
      .getEntriesByType("resource")
      .filter(({ name }) => name.includes("/conversations/"))
      .map(({ startTime }) => startTime),
  }));
  expect(arrived, "the view arrived behind the first screen").toBeDefined();
  expect(asked.length, "the transcript was read").toBeGreaterThan(0);
  expect(
    Math.min(...asked),
    "the transcript was asked for before the view's code arrived",
  ).toBeLessThan(Number(arrived));
});

test("a transcript still being read when the view arrives is waited for, not asked for again", async ({
  page,
}) => {
  const opened = await session(page);
  const asked = transcriptReads(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // llmlint: ignore-block[e2e_not_mocked] the criterion is what the drawer does while the page's own transcript read is still out, so that read is held at the network boundary until the view has drawn; nothing is doubled, and the real server's answer passes through unchanged once released.
  await page.route(CONVERSATIONS, async (route) => {
    await held;
    await route.continue();
  });
  // llmlint: ignore-end[e2e_not_mocked]
  // The node view asks for the opened span's page in an effect of the commit
  // that draws the drawer, and React runs the drawer's own effects first: once
  // that page is asked, any transcript read of the drawer's own has been asked.
  const spanPage = page.waitForRequest(
    (request) =>
      request.url().includes("/timeline/events?") &&
      request.url().includes("span="),
  );
  await page.goto(opened.address);
  const detail = page.getByRole("region", { name: DETAIL });
  await expect(detail).toContainText("Loading transcript…");
  await spanPage;
  expect(asked, "the page asked for the transcript once").toHaveLength(1);
  release();
  await expect(turnsOf(page, opened.id)).toHaveCount(opened.turns);
  await page.unrouteAll({ behavior: "wait" });
});

/** Each way the page's entry can fail to read a transcript, as the network serves it. */
// llmlint: ignore-block[e2e_not_mocked] each is a failure a conforming server never produces on demand, so it is served at the network boundary to the page's own first read alone (see the journey below); every later read reaches the real server unchanged.
const ENTRY_READ_FAILURES: ReadonlyArray<{
  readonly name: string;
  readonly refuse: (route: Route) => Promise<void>;
}> = [
  {
    name: "whose connection was reset",
    refuse: (route) => route.abort("connectionreset"),
  },
  {
    name: "the server refused",
    refuse: (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "unavailable", message: "try again" },
        }),
      }),
  },
  {
    name: "whose body is not JSON",
    refuse: (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "not json",
      }),
  },
];
// llmlint: ignore-end[e2e_not_mocked]

for (const failure of ENTRY_READ_FAILURES) {
  test(`a transcript read ${failure.name} at the page's entry is read again by the drawer`, async ({
    page,
  }) => {
    const opened = await session(page);
    const asked = transcriptReads(page);
    let refused = false;
    // llmlint: ignore-block[e2e_not_mocked] the criterion is the drawer's recovery when the page's own transcript read fails, which a conforming server never produces on demand: that one read is refused at the network boundary, and every later one reaches the real server unchanged.
    await page.route(CONVERSATIONS, async (route) => {
      if (refused) return route.continue();
      refused = true;
      return failure.refuse(route);
    });
    // llmlint: ignore-end[e2e_not_mocked]
    await page.goto(opened.address);
    await expect(turnsOf(page, opened.id)).toHaveCount(opened.turns);
    expect(refused, "the page's own read was the one refused").toBe(true);
    expect(asked.length, "the drawer read it again").toBeGreaterThanOrEqual(2);
    await page.unrouteAll({ behavior: "wait" });
  });
}

test("a transcript that landed before the view arrived is drawn in the drawer's first frame, and not asked for again", async ({
  page,
}) => {
  const opened = await session(page);
  const asked = transcriptReads(page);
  // Whether the drawer ever said it was waiting on the transcript, on the page.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.body?.textContent?.includes("Loading transcript…"))
        window.__drawerWaitedOnTranscript = true;
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  const landed = page.waitForResponse(
    (response) => response.url().includes("/conversations/") && response.ok(),
  );
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // llmlint: ignore-block[e2e_not_mocked] the criterion is what the drawer draws when the page's transcript read landed before the view's code did, which only holding that code makes certain: the view's own chunk is held at the network boundary until the read has landed, and is then served unchanged.
  await page.route("**/assets/mount-*.js", async (route) => {
    await held;
    await route.continue();
  });
  // llmlint: ignore-end[e2e_not_mocked]
  await page.goto(opened.address);
  await (await landed).finished();
  release();
  await expect(turnsOf(page, opened.id)).toHaveCount(opened.turns);
  expect(asked, "the page asked for the transcript once").toHaveLength(1);
  expect(
    await page.evaluate(() => window.__drawerWaitedOnTranscript ?? false),
    "the drawer drew the landed transcript rather than waiting on it",
  ).toBe(false);
  await page.unrouteAll({ behavior: "wait" });
});

test("a transcript the page's entry read but the contract refuses is read again by the drawer", async ({
  page,
}) => {
  const opened = await session(page);
  const asked = transcriptReads(page);
  let refused = false;
  // llmlint: ignore-block[e2e_not_mocked] the criterion is the drawer's recovery from a successful read whose body the contract refuses, which a conforming server never serves: that one answer's body is replaced at the network boundary, and every later read reaches the real server unchanged.
  await page.route(CONVERSATIONS, async (route) => {
    if (refused) return route.continue();
    refused = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversation: "not a conversation" }),
    });
  });
  // llmlint: ignore-end[e2e_not_mocked]
  await page.goto(opened.address);
  await expect(turnsOf(page, opened.id)).toHaveCount(opened.turns);
  expect(refused, "the page's own read was the one refused").toBe(true);
  expect(asked.length, "the drawer read it again").toBeGreaterThanOrEqual(2);
  await page.unrouteAll({ behavior: "wait" });
});

test("a session reopened after the drawer took the page's read over is read afresh", async ({
  page,
}) => {
  const opened = await session(page);
  const asked = transcriptReads(page);
  await page.goto(opened.address);
  await expect(turnsOf(page, opened.id)).toHaveCount(opened.turns);
  expect(asked, "the page asked for the transcript once").toHaveLength(1);
  const list = page.getByRole("region", { name: "Node transcript" });
  // llmlint: ignore-block[e2e_uses_accessible_selectors] the opened row is the one the list marks current; its accessible name is then what the reader clicks by.
  const label = await list
    .locator('article[aria-current="true"]')
    .getAttribute("aria-label");
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  if (label === null) throw new Error("the list marks no row as the open one");
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(turnsOf(page, opened.id)).toHaveCount(0);
  await list
    .getByRole("button", { name: `Open ${label}`, exact: true })
    .click();
  await expect(turnsOf(page, opened.id)).toHaveCount(opened.turns);
  await expect
    .poll(() => asked.length, {
      message: "the reopened drawer asked for the transcript itself",
    })
    .toBe(2);
});
