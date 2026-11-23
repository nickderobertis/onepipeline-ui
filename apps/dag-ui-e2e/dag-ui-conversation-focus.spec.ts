import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runTimelineSchema,
  type TimelineEvent,
  type TimelineSpan,
} from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import {
  type FocusFrame,
  MARKED,
  recorded,
  startRecording,
  stopRecording,
} from "./focus-recorder";
import { appendLines } from "./load/journal";
import { openRepeatedLoops } from "./observatory-locators";

/**
 * Every event and span that belongs to a conversation opens straight into that
 * conversation, with its own item marked and wholly in view below the pinned
 * Turns/Tools card, from the first frame — held for every kind the timeline
 * schema 18 table names (`docs/contract.md`), on the real `onepipeline-api serve`
 * over `fixtures/runs.mjs`'s `buildConversationFocusRuns`, in the record shapes a
 * host's runs carry.
 *
 * Each journey opens its row the way a reader does, by clicking it in the event
 * list or on the timeline, with a recorder sampling the drawer on every frame and
 * every mutation from before the click until two seconds after its transcript has
 * rendered. Nothing in a journey scrolls the drawer: where the marked item stands
 * is where the view put it.
 *
 * Its corpus is its own, served by a server this file starts, because three of
 * its journeys append to a live run while the drawer is open.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  turns: z.number().int(),
  busyTurn: z.number().int(),
  busyReasoning: z.number().int(),
  longPromptTurn: z.number().int(),
  longReasoningTurn: z.number().int(),
  longReasoningIndex: z.number().int(),
  reviewTurns: z.number().int(),
  sessions: z.object({
    panels: z.string(),
    gapped: z.string(),
    reviewed: z.string(),
    drafted: z.string(),
    observer: z.string(),
    stopped: z.string(),
  }),
  pending: z.string(),
});
const pendingSchema = z.record(
  z.string(),
  z.object({ stream: z.string(), lines: z.array(z.string()) }),
);

let server: FixtureServer | undefined;
let facts: z.infer<typeof factsSchema>;

test.beforeAll(async () => {
  server = await startFixtureServer("conversation-focus", [
    "--conversation-focus-corpus",
  ]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server?.stop();
  server = undefined;
});

function up(): FixtureServer {
  if (server === undefined) throw new Error("the fixture server is not up");
  return server;
}

const NOT_YET = "This turn is not in the recorded transcript yet.";
const NO_LONGER = "This turn is no longer part of the recorded transcript.";

/** What the table says a row marks: a part, an entry, or the note in a turn's place. */
type Expected =
  | { readonly turn: string; readonly part: "prompt" | "answer" | "end" }
  | { readonly turn: string; readonly eventIndex: number }
  | { readonly turn: string; readonly toolCallId: string }
  | { readonly turn: string; readonly note: string };

/** A row of the served timeline, by what its record says. */
interface Wanted {
  readonly session: string;
  readonly kind: string;
  readonly turn?: number;
  readonly role?: "assistant" | "user";
  readonly index?: number;
}

async function nodeTimeline(page: Page, node: string) {
  const answer = await page.request.get(
    `${up().origin}/api/v2/runs/${facts.run}/timeline?scope=node&node=${node}`,
  );
  return runTimelineSchema.parse(await answer.json());
}

/** The one record a reader opens, as the real server served it. */
async function served(
  page: Page,
  node: string,
  wanted: Wanted,
): Promise<TimelineEvent> {
  const stream = wanted.session.slice(0, wanted.session.lastIndexOf("."));
  const found = (await nodeTimeline(page, node)).spans
    .flatMap((span) => span.events)
    .find(
      (event) =>
        event.kind === wanted.kind &&
        event.stream === stream &&
        (wanted.turn === undefined || event.fields?.turn === wanted.turn) &&
        (wanted.role === undefined || event.fields?.role === wanted.role) &&
        (wanted.index === undefined || event.tool?.index === wanted.index),
    );
  if (found === undefined)
    throw new Error(`the corpus serves no ${JSON.stringify(wanted)}`);
  return found;
}

async function servedSpan(
  page: Page,
  node: string,
  conversation: string,
): Promise<TimelineSpan> {
  const span = (await nodeTimeline(page, node)).spans.find(
    (candidate) => candidate.reference?.value === conversation,
  );
  if (span === undefined) throw new Error(`no span draws ${conversation}`);
  return span;
}

const list = (page: Page): Locator =>
  page.getByRole("region", { name: "Node transcript" });

async function openNode(page: Page, node: string): Promise<void> {
  await page.goto(`${up().origin}/?run=${facts.run}&node=${node}`);
  await expect(list(page).getByRole("article").first()).toBeVisible();
}

/** Click a row of the event list, the way a reader opens it. */
async function clickRow(page: Page, id: string, seq?: number): Promise<void> {
  // llmlint: ignore-block[e2e_uses_accessible_selectors] a turn's start and close, and every activity of it, are read under the same few words, so the one record a journey opens is told apart only by the ids the list puts on its row — the record's own id and journal place, which are what the served timeline names it by.
  const row = list(page).locator(
    seq === undefined
      ? `article[data-row-id="${id}"]`
      : `article[data-row-id="${id}"][data-journal-seq="${seq}"]`,
  );
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  if ((await row.count()) === 0) await openRepeatedLoops(page);
  await startRecording(page);
  await row.getByRole("button").first().click();
}

/**
 * How often a journey asks whether the drawer has rendered: Playwright's default
 * backs off to a second, which every journey here would add to its two seconds of
 * sampling after the render.
 */
const POLL = [100];

/** Every sample until two seconds after the drawer's transcript rendered. */
async function settledFrames(page: Page): Promise<FocusFrame[]> {
  await expect
    .poll(async () => (await recorded(page)).some((frame) => frame.loaded), {
      message: "the drawer's transcript renders",
      intervals: POLL,
    })
    .toBe(true);
  await page.waitForTimeout(2_000);
  return stopRecording(page);
}

function matches(mark: FocusFrame["mark"], expected: Expected): boolean {
  if (mark === undefined || mark.turn !== expected.turn) return false;
  if ("part" in expected) return mark.part === expected.part;
  if ("eventIndex" in expected)
    return mark.eventIndex === String(expected.eventIndex);
  if ("toolCallId" in expected) return mark.toolCallId === expected.toolCallId;
  return mark.note === expected.note;
}

/**
 * Hold the recorded frames, and the drawer as it stands, to the criterion: only
 * the conversation view, from the first frame the drawer drew; exactly one item
 * marked, the one the table names, open where it was collapsed; wholly inside the
 * scroll viewport and below the pinned card — or, for an item taller than the
 * space, its top at the card's edge and filling the rest — what a tap at its top
 * edge hits; and still, from the first painted frame of the loaded transcript on.
 */
async function expectPlaced(
  page: Page,
  frames: readonly FocusFrame[],
  expected: Expected,
  { oversized = false, harness = false } = {},
): Promise<number> {
  const opened = frames.findIndex((frame) => frame.drawer);
  expect(opened, "the drawer opened").toBeGreaterThanOrEqual(0);
  const drawn = frames.slice(opened);
  expect(
    drawn.filter((frame) => frame.eventView),
    "an event heading, badge or field list was drawn",
  ).toEqual([]);
  expect(
    drawn.filter((frame) => !frame.drawer || !frame.conversation),
    "a sample after the click showed something other than the conversation view",
  ).toEqual([]);
  const painted = drawn.filter((frame) => frame.source === "frame");
  const first = painted.findIndex((frame) => frame.loaded);
  expect(first, "a frame painted the loaded transcript").toBeGreaterThanOrEqual(
    0,
  );
  const loaded = painted.slice(first);
  const entry = "eventIndex" in expected || "toolCallId" in expected;
  for (const [index, frame] of loaded.entries()) {
    const at = `frame ${index} of the loaded transcript (t=${Math.round(frame.at)}ms)`;
    expect(frame.marked, `${at}: exactly one item is marked`).toBe(1);
    expect(
      matches(frame.mark, expected),
      `${at}: marked ${JSON.stringify(frame.mark)}, not ${JSON.stringify(expected)}`,
    ).toBe(true);
    const { mark, viewport } = frame;
    if (mark === undefined || viewport === undefined)
      throw new Error(
        `${at}: the drawer has no marked item or scroll viewport`,
      );
    // A harness record pins no card of its own; Close is what it clears.
    const edge = harness ? viewport.top : frame.cardBottom;
    if (edge === undefined)
      throw new Error(`${at}: the pinned card is not drawn`);
    const where = `${at}: ${JSON.stringify({ top: mark.top, bottom: mark.bottom, edge, viewport })}`;
    if (oversized) {
      expect(
        Math.abs(mark.top - edge),
        `${where}: its top is at the card's edge`,
      ).toBeLessThanOrEqual(1);
      expect(
        mark.bottom,
        `${where}: it fills the visible area`,
      ).toBeGreaterThan(viewport.bottom);
    } else {
      expect(
        mark.top,
        `${where}: its top is below the card`,
      ).toBeGreaterThanOrEqual(edge - 0.5);
      expect(
        mark.bottom,
        `${where}: its bottom is inside the viewport`,
      ).toBeLessThanOrEqual(viewport.bottom + 0.5);
    }
    expect(
      mark.top,
      `${where}: its top is inside the viewport`,
    ).toBeGreaterThanOrEqual(viewport.top - 0.5);
    expect(mark.hit, `${at}: a tap at its top edge hits it`).toBe(true);
    if (entry) expect(mark.open, `${at}: the marked entry is open`).toBe(true);
  }
  const tops = new Set(loaded.map((frame) => Math.round(frame.mark?.top ?? 0)));
  expect(
    [...tops],
    `the marked item moved after it was painted: ${JSON.stringify(
      painted
        .slice(Math.max(0, first - 2), first + 4)
        .map((frame) => [
          Math.round(frame.at),
          frame.loaded,
          frame.mark?.top,
          frame.cardBottom,
          frame.viewport?.top,
        ]),
    )}`,
  ).toHaveLength(1);

  // And the drawer as it stands once sampling ends holds one mark, no other.
  // llmlint: ignore-block[e2e_uses_accessible_selectors] `aria-current` inside a turn (`data-turn-id`) is the package's own mark of the opened item, and the criterion is about that one element.
  const marked = page
    .getByRole("region", { name: "Timeline item detail" })
    .locator(MARKED);
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  await expect(marked).toHaveCount(1);
  const last = loaded.at(-1)?.mark;
  if (last === undefined) throw new Error("no loaded frame was sampled");
  return last.top;
}

/** Open one record of `node`'s event list, and hold where it lands. */
async function opensAt(
  page: Page,
  node: string,
  wanted: Wanted,
  expected: (event: TimelineEvent) => Expected,
  options: { oversized?: boolean } = {},
): Promise<void> {
  const event = await served(page, node, wanted);
  await openNode(page, node);
  await clickRow(page, event.record_id ?? event.id, event.seq);
  await expectPlaced(page, await settledFrames(page), expected(event), options);
}

const turnId = (session: string, turn: number) => `${session}.${turn - 1}`;

/** Append the records a live dispatch had not relayed, as its writer does. */
function relay(name: string): void {
  const pending = pendingSchema.parse(
    JSON.parse(readFileSync(join(up().workspace, facts.pending), "utf8")),
  )[name];
  if (pending === undefined) throw new Error(`nothing held back as ${name}`);
  appendLines(
    join(up().workspace, "runs", facts.run, "events.jsonl"),
    pending.lines,
  );
}

/**
 * Open a row whose turn the transcript lacks, hold the note standing in its place,
 * then let the turn arrive and hold that its prompt takes the mark where the note
 * stood, with nothing in the journey scrolling.
 */
async function arrivesInPlace(
  page: Page,
  node: string,
  wanted: Wanted,
  turn: string,
  held: string,
): Promise<void> {
  await opensAt(page, node, wanted, () => ({ turn, note: NOT_YET }));
  const note = (await recorded(page)).at(-1)?.mark?.top;
  await startRecording(page);
  relay(held);
  await expect
    .poll(
      async () =>
        (await recorded(page)).some((frame) =>
          matches(frame.mark, { turn, part: "prompt" }),
        ),
      {
        message: "the turn arrives and takes the mark",
        timeout: 20_000,
        intervals: POLL,
      },
    )
    .toBe(true);
  await page.waitForTimeout(2_000);
  const frames = (await stopRecording(page)).filter(
    (frame) => frame.source === "frame",
  );
  const arrived = frames.findIndex((frame) =>
    matches(frame.mark, { turn, part: "prompt" }),
  );
  const after = frames.slice(arrived);
  for (const frame of after) {
    expect(frame.marked, "exactly one item is marked").toBe(1);
    expect(matches(frame.mark, { turn, part: "prompt" })).toBe(true);
    expect(
      Math.abs((frame.mark?.top ?? 0) - (note ?? Number.NaN)),
      "the prompt stands where the note stood",
    ).toBeLessThanOrEqual(0.5);
  }
  await expect(page.getByText(NOT_YET)).toHaveCount(0);
  // The appended records would stay appended; the next journey reads the corpus
  // fresh, which only a restart writes.
  await up().stopServing();
  await up().serveRebuilt();
}

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("a tool call opens at that call, open", async ({ page }) => {
      const session = facts.sessions.panels;
      await opensAt(
        page,
        "panels",
        { session, kind: "turn-activity", turn: undefined, index: 4 },
        (event) => ({
          turn: event.tool?.turn ?? "",
          toolCallId: event.tool?.tool_call_id ?? "",
        }),
      );
    });

    test("an agent message opens at that message", async ({ page }) => {
      await opensAt(
        page,
        "panels",
        { session: facts.sessions.panels, kind: "turn-activity", index: 6 },
        (event) => ({ turn: event.tool?.turn ?? "", eventIndex: 6 }),
      );
    });

    test("an agent's final message opens at its turn's answer", async ({
      page,
    }) => {
      await opensAt(
        page,
        "panels",
        { session: facts.sessions.panels, kind: "turn-activity", index: 7 },
        (event) => ({ turn: event.tool?.turn ?? "", part: "answer" }),
      );
    });

    test("a reasoning item past index 80 in a turn of fifty calls opens at it, open", async ({
      page,
    }) => {
      await opensAt(
        page,
        "panels",
        {
          session: facts.sessions.panels,
          kind: "turn-activity",
          index: facts.busyReasoning,
        },
        () => ({
          turn: turnId(facts.sessions.panels, facts.busyTurn),
          eventIndex: facts.busyReasoning,
        }),
      );
    });

    test("a reasoning item of several screens fills the view from the card's edge", async ({
      page,
    }) => {
      const session = facts.sessions.panels;
      const busy = await served(page, "panels", {
        session,
        kind: "turn-activity",
        index: facts.longReasoningIndex,
      });
      // The one at that index inside the long-reasoning turn, not the first turn's.
      const timeline = await nodeTimeline(page, "panels");
      const event = timeline.spans
        .flatMap((span) => span.events)
        .find(
          (candidate) =>
            candidate.kind === "turn-activity" &&
            candidate.tool?.index === facts.longReasoningIndex &&
            candidate.tool.turn === turnId(session, facts.longReasoningTurn),
        );
      if (event === undefined || busy === undefined)
        throw new Error("the corpus has no long reasoning item");
      await openNode(page, "panels");
      await clickRow(page, event.record_id ?? event.id, event.seq);
      await expectPlaced(
        page,
        await settledFrames(page),
        {
          turn: turnId(session, facts.longReasoningTurn),
          eventIndex: facts.longReasoningIndex,
        },
        { oversized: true },
      );
    });

    for (const [kind, part] of [
      ["turn-started", "prompt"],
      ["turn-message", "answer"],
      ["turn-completed", "end"],
    ] as const)
      test(`an agent ${kind} opens at its turn's ${part}`, async ({ page }) => {
        const session = facts.sessions.panels;
        await opensAt(
          page,
          "panels",
          { session, kind, turn: 10, role: "assistant" },
          () => ({ turn: turnId(session, 10), part }),
        );
      });

    test("a prompt of several screens fills the view from the card's edge", async ({
      page,
    }) => {
      const session = facts.sessions.panels;
      await opensAt(
        page,
        "panels",
        {
          session,
          kind: "turn-started",
          turn: facts.longPromptTurn,
          role: "assistant",
        },
        () => ({ turn: turnId(session, facts.longPromptTurn), part: "prompt" }),
        { oversized: true },
      );
    });

    test("a supervisor's message opens at the prompt it became", async ({
      page,
    }) => {
      const session = facts.sessions.panels;
      await opensAt(
        page,
        "panels",
        { session, kind: "turn-message", turn: 10, role: "user" },
        () => ({ turn: turnId(session, 11), part: "prompt" }),
      );
    });

    for (const kind of ["turn-started", "turn-completed"])
      test(`a running dispatch's supervisor ${kind} opens at the reply it judges`, async ({
        page,
      }) => {
        const session = facts.sessions.panels;
        await opensAt(
          page,
          "panels",
          { session, kind, turn: 10, role: "user" },
          () => ({ turn: turnId(session, 10), part: "end" }),
        );
      });

    for (const [kind, part] of [
      ["turn-started", "prompt"],
      ["turn-completed", "end"],
    ] as const)
      test(`a settled dispatch's supervisor ${kind} opens its judge turn's ${part}`, async ({
        page,
      }) => {
        const session = facts.sessions.reviewed;
        await opensAt(
          page,
          "reviewed",
          { session, kind, turn: 2, role: "user" },
          () => ({ turn: `${session}.judge.1`, part }),
        );
      });

    for (const [name, node, conversation] of [
      ["a worker", "panels", () => facts.sessions.panels],
      [
        "a worker's judge",
        "reviewed",
        () => `${facts.sessions.reviewed}.judge`,
      ],
      ["a change request drafter", "drafted", () => facts.sessions.drafted],
    ] as const)
      test(`${name}'s conversation span opens at its first turn's prompt`, async ({
        page,
      }) => {
        const span = await servedSpan(page, node, conversation());
        await openNode(page, node);
        await clickRow(page, span.id);
        await expectPlaced(page, await settledFrames(page), {
          turn: `${conversation()}.0`,
          part: "prompt",
        });
      });

    test("a run-level session opens at its first turn's prompt", async ({
      page,
    }) => {
      await page.goto(`${up().origin}/?run=${facts.run}&view=overall`);
      const line = page.getByRole("region", { name: "Graph timeline" });
      await line.getByRole("button", { name: "Expand timeline" }).click();
      const runRow = page.getByRole("region", { name: "Run-level timeline" });
      const lane = runRow.getByRole("button", { name: /^Run-level · monitor/ });
      await expect(lane.first()).toBeVisible();
      await startRecording(page);
      await lane.first().click();
      await expectPlaced(page, await settledFrames(page), {
        turn: `${facts.sessions.observer}.0`,
        part: "prompt",
      });
    });

    test("an oneharness-session opens as its record's conversation alone, at its prompt", async ({
      page,
    }) => {
      const event = await served(page, "drafted", {
        session: facts.sessions.drafted,
        kind: "oneharness-session",
      });
      await openNode(page, "drafted");
      await clickRow(page, event.record_id ?? event.id, event.seq);
      const frames = await settledFrames(page);
      const turn = frames.at(-1)?.mark?.turn ?? "";
      await expectPlaced(
        page,
        frames,
        { turn, part: "prompt" },
        { harness: true },
      );
      await expect(
        page.getByRole("region", { name: "Recorded fields" }),
      ).toHaveCount(0);
    });

    test("a turn the settled transcript no longer holds is a marked note in its place", async ({
      page,
    }) => {
      const session = facts.sessions.reviewed;
      const turn = facts.reviewTurns + 1;
      await opensAt(
        page,
        "reviewed",
        { session, kind: "turn-message", turn, role: "assistant" },
        (event) => {
          expect(event.conversation_item?.turn).toBe(turnId(session, turn));
          return { turn: turnId(session, turn), note: NO_LONGER };
        },
      );
    });

    test("a turn a failed node never started is a marked note that it is no longer coming", async ({
      page,
    }) => {
      const session = facts.sessions.stopped;
      await opensAt(
        page,
        "stopped",
        { session, kind: "turn-message", turn: 1, role: "user" },
        (event) => {
          expect(event.conversation_item?.turn).toBe(turnId(session, 2));
          return { turn: turnId(session, 2), note: NO_LONGER };
        },
      );
    });

    test("a turn whose place a later turn holds marks the note, never that turn", async ({
      page,
    }) => {
      const session = facts.sessions.gapped;
      await opensAt(
        page,
        "gapped",
        { session, kind: "turn-message", turn: 3, role: "assistant" },
        (event) => {
          expect(event.conversation_item?.gap).toBe(true);
          return { turn: turnId(session, 3), note: NOT_YET };
        },
      );
      // The later turn standing at that place is not drawn as the opened turn.
      // llmlint: ignore-block[e2e_uses_accessible_selectors] the package names each turn's article by its id only through this attribute.
      const later = page.locator(
        `[data-turn-id="${turnId(session, 3)}"] article`,
      );
      // llmlint: ignore-end[e2e_uses_accessible_selectors]
      await expect(later).toHaveCount(0);
    });

    test("the live session's newest turn-started is a note until its turn arrives, then its prompt in place", async ({
      page,
    }) => {
      const session = facts.sessions.gapped;
      await arrivesInPlace(
        page,
        "gapped",
        { session, kind: "turn-started", turn: 4, role: "assistant" },
        turnId(session, 4),
        "gap",
      );
    });

    test("a reader who scrolls from the note keeps their place when the drawer reflows", async ({
      page,
    }) => {
      const session = facts.sessions.gapped;
      await opensAt(
        page,
        "gapped",
        { session, kind: "turn-started", turn: 4, role: "assistant" },
        () => ({ turn: turnId(session, 4), note: NOT_YET }),
      );
      const drawer = page.getByRole("region", { name: "Timeline item detail" });
      const note = drawer.getByRole("note").filter({ hasText: NOT_YET });
      const pinned = drawer.getByRole("region", {
        name: "Conversation timeline",
      });
      const offset = async () => {
        const [box, card] = await Promise.all([
          note.boundingBox(),
          pinned.boundingBox(),
        ]);
        if (box === null || card === null)
          throw new Error("the note or the pinned card is not laid out");
        return box.y - (card.y + card.height);
      };
      // Where the drawer placed it: under the card, at the card's own padding.
      const placed = await offset();
      // The reader scrolls the drawer themselves, then the drawer reflows.
      await note.hover();
      await page.mouse.wheel(0, 120);
      await expect.poll(offset).toBeLessThan(placed - 60);
      await page.setViewportSize({
        width: size.width - 40,
        height: size.height,
      });
      await page.waitForTimeout(1_000);
      expect(
        await offset(),
        "the drawer put the note back under the card after the reader scrolled",
      ).toBeLessThan(placed - 60);
    });

    test("a supervisor's message whose next turn has not started is a note until it does", async ({
      page,
    }) => {
      const session = facts.sessions.panels;
      await arrivesInPlace(
        page,
        "panels",
        { session, kind: "turn-message", turn: facts.turns, role: "user" },
        turnId(session, facts.turns + 1),
        "next",
      );
    });

    test("a transcript held at the network boundary shows only the header and its placeholder until it is let through", async ({
      page,
    }) => {
      const session = facts.sessions.panels;
      const event = await served(page, "panels", {
        session,
        kind: "turn-started",
        turn: 12,
        role: "assistant",
      });
      await openNode(page, "panels");
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // llmlint: ignore-block[e2e_not_mocked] the criterion requires the transcript response held back at the network boundary so the drawer can be watched while it loads; nothing is doubled, the real server's own answer is passed through unchanged once released.
      await page.route("**/api/v2/runs/*/conversations/**", async (route) => {
        await held;
        await route.continue();
      });
      // llmlint: ignore-end[e2e_not_mocked]
      await clickRow(page, event.record_id ?? event.id, event.seq);
      await page.waitForTimeout(1_500);
      const waiting = (await recorded(page)).filter((frame) => frame.drawer);
      expect(waiting.length, "the drawer drew while held").toBeGreaterThan(0);
      expect(
        waiting.filter(
          (frame) =>
            frame.eventView ||
            !frame.conversation ||
            !frame.placeholder ||
            frame.loaded,
        ),
        "a held frame showed anything but the header and its placeholder",
      ).toEqual([]);
      release();
      await expectPlaced(page, await settledFrames(page), {
        turn: turnId(session, 12),
        part: "prompt",
      });
      await page.unroute("**/api/v2/runs/*/conversations/**");
    });

    test("a long session's span is drawn from the read asked when it opened, while its own pages ask for another", async ({
      page,
    }) => {
      const session = facts.sessions.panels;
      const span = await servedSpan(page, "panels", session);
      await openNode(page, "panels");
      let reads = 0;
      let reread = () => {};
      const rereadAsked = new Promise<void>((resolve) => {
        reread = resolve;
      });
      let releaseFirst = () => {};
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseRest = () => {};
      const restReleased = new Promise<void>((resolve) => {
        releaseRest = resolve;
      });
      // llmlint: ignore-block[e2e_not_mocked] the defect is a race between the transcript read and the span's own pages, which no corpus can order on demand: every read is held at the network boundary until the pages have asked for another, then the real server's answers pass through unchanged — the first one alone, so only a view that keeps the read it asked can draw.
      await page.route("**/api/v2/runs/*/conversations/**", async (route) => {
        reads += 1;
        if (reads === 1) await firstReleased;
        else {
          reread();
          await restReleased;
        }
        await route.continue();
      });
      // llmlint: ignore-end[e2e_not_mocked]
      await clickRow(page, span.id);
      await rereadAsked;
      releaseFirst();
      await expectPlaced(page, await settledFrames(page), {
        turn: `${session}.0`,
        part: "prompt",
      });
      releaseRest();
      await page.unrouteAll({ behavior: "wait" });
    });
  });
}
