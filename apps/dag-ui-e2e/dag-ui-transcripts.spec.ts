import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactContentSchema,
  conversationSchema,
  runTimelineSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { seen, watch } from "./dom-watch";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { appendRecords } from "./load/journal";

/**
 * Every turn read whole from the transcript it was recorded in.
 *
 * Over the transcripts corpus (`fixtures/runs.mjs`, `buildTranscriptRuns`): a
 * history store built from sessions a real oneharness recorded on an operator's
 * host, the turn records `oneagentgraph` 0.8 relays — a reference into that store
 * and no copy — and the real server reading them through the engine's resolver.
 * Each text a journey reads is longer than the recorder's old bound, and each is
 * proved whole by its last sentence.
 */

const factsSchema = z.object({
  run: z.string(),
  legacyRun: z.string(),
  project: z.string(),
  sentinels: z.object({
    instruction: z.string(),
    output: z.string(),
    report: z.string(),
    reportHead: z.string(),
    session: z.string(),
    log: z.string(),
  }),
  log: z.string(),
  sessions: z.record(
    z.string(),
    z.object({ session: z.string(), historyId: z.string() }),
  ),
  conversations: z.object({
    died: z.string(),
    live: z.string(),
    narrated: z.string(),
    narratedLive: z.string(),
  }),
  narratedOrder: z.array(z.string()),
  usageLimit: z.string(),
});
type Facts = z.infer<typeof factsSchema>;

let server: FixtureServer;
let facts: Facts;

test.beforeAll(async () => {
  server = await startFixtureServer("transcripts", ["--transcripts-corpus"]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server.stop();
});

/** Open one node's timeline in the run's own view. */
async function openNode(page: Page, run: string, node: string): Promise<void> {
  await page.goto(`${server.origin}/?run=${run}&node=${node}`);
  await expect(
    page.getByRole("region", { name: `Timeline for ${node}` }),
  ).toBeVisible();
}

/** Open the transcript row whose one line is `label`. */
async function openRow(page: Page, label: string | RegExp): Promise<void> {
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("button", {
      name: typeof label === "string" ? `Open ${label}` : label,
    })
    .first()
    .click();
}

const DETAIL = "Timeline item detail";
const detail = (page: Page) => page.getByRole("region", { name: DETAIL });

/**
 * An element's text in full, rather than the trimmed match a text assertion
 * makes: what is measured is how long the served text is.
 */
const textOf = async (page: Page, label: string): Promise<string> =>
  (await detail(page).getByLabel(label).first().textContent()) ?? "";

test("a member that died is read whole off its history file, and a gone file is named", async ({
  page,
}) => {
  const conversation = conversationSchema.parse(
    (
      await (
        await page.request.get(
          `${server.origin}/api/v2/runs/${facts.run}/conversations/${facts.conversations.died}`,
        )
      ).json()
    ).conversation,
  );
  // Nothing a reference resolved to was cut, so nothing says it was.
  for (const turn of conversation.turns) {
    expect(turn.unknown).toEqual({});
    for (const tool of turn.tools) {
      expect(tool.output_truncated).toBeUndefined();
      expect(tool.input_truncated).toBeUndefined();
    }
  }

  await openNode(page, facts.run, "died");
  // The read the worker made, in one line, opened on that call.
  await openRow(
    page,
    "Read /home/operator/projects/ai-orchestrator/.plans/documents/accepted-followups-1008-design.md",
  );
  const turn = detail(page).getByRole("article", { name: /^Turn .*\.0 from / });
  // The prompt it was given, whole: past the old 4096-byte bound, to its last
  // sentence.
  await expect(turn).toContainText(facts.sentinels.instruction);
  const prompt = conversation.turns[0]?.user ?? "";
  expect(new TextEncoder().encode(prompt).length).toBeGreaterThan(4096);
  // What the read returned, whole: past 64 KiB, to its last line.
  await expect(
    detail(page).getByLabel("Read tool output").first(),
  ).toContainText(facts.sentinels.output);
  expect((await textOf(page, "Read tool output")).length).toBeGreaterThan(
    64 * 1024,
  );
  await expect(detail(page).getByText("Cut by the recorder")).toHaveCount(0);

  // Its second turn points at a file the store no longer holds: said, naming
  // the file and why, on the row and in the conversation — never a blank.
  const gone = `${facts.sessions.removed?.session}.jsonl: missing-file`;
  await page.getByRole("button", { name: "Close detail" }).click();
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("button", { name: "Open turn-started" })
    .nth(1)
    .click();
  await expect(
    detail(page).getByRole("article", { name: /^Turn .*\.1 from / }),
  ).toContainText(
    new RegExp(`transcript unavailable: .*${facts.project}/${gone}`),
  );
});

test("a standalone harness session is a structured conversation, whole", async ({
  page,
}) => {
  await openNode(page, facts.run, "drafted");
  await openRow(page, "oneharness-session");
  const turn = detail(page).getByRole("article", { name: /^Turn / });
  await expect(turn).toContainText(facts.sentinels.session);
  // Its calls are calls, each opening on what it returned, whole.
  await detail(page)
    .getByRole("button", { name: "Read tool details" })
    .first()
    .click();
  await expect(
    detail(page).getByLabel("Read tool output").first(),
  ).toContainText(facts.sentinels.output);
  expect((await textOf(page, "Read tool output")).length).toBeGreaterThan(
    64 * 1024,
  );
});

test("a stored report longer than a preview is shown whole", async ({
  page,
}) => {
  await openNode(page, facts.run, "reported");
  await openRow(page, "member-settled");
  const report = detail(page).getByLabel("Worker report");
  await expect(report).toContainText(facts.sentinels.reportHead);
  await expect(report).toContainText(facts.sentinels.report);
  expect(((await report.textContent()) ?? "").length).toBeGreaterThan(4000);
  await expect(
    detail(page).getByRole("button", { name: /^Expand/ }),
  ).toHaveCount(0);
});

test("a log longer than the end of it the server keeps says its beginning is not shown", async ({
  page,
}) => {
  await openNode(page, facts.run, "reported");
  const plot = page.getByRole("region", { name: "Node timeline" });
  await plot.getByRole("button", { name: "Expand timeline" }).click();
  await plot
    .getByRole("button", { name: new RegExp(`Verification.*${facts.log}`) })
    .first()
    .click();
  const log = detail(page).getByLabel("Full log");
  // The end of it, to its last line, and a line saying the rest is not shown —
  // never a cut log passed off as the whole of one.
  await expect(log).toContainText(facts.sentinels.log);
  await expect(log).not.toContainText("the first line the gate printed");
  await expect(detail(page)).toContainText(
    "The server keeps the end of a log this long; its beginning is not shown.",
  );
});

test("a run recorded before references is read whole wherever a whole copy exists", async ({
  page,
}) => {
  for (const [node, whole] of [
    ["reported", true],
    ["historied", true],
    ["neither", false],
  ] as const) {
    await openNode(page, facts.legacyRun, node);
    await openRow(page, "turn-started");
    const turn = detail(page).getByRole("article", { name: /^Turn / });
    await expect(turn).toBeVisible();
    if (whole) {
      // The member's report, or the history file the run names: the prompt to
      // its last sentence, and nothing saying it was cut.
      await expect(turn).toContainText(facts.sentinels.instruction);
      await expect(detail(page).getByText("Cut by the recorder")).toHaveCount(
        0,
      );
    } else {
      // Neither: the recorder's copy, said to be one.
      await expect(turn).not.toContainText(facts.sentinels.instruction);
      const note = detail(page)
        .getByRole("note")
        .filter({ hasText: "Cut by the recorder" });
      await expect(note).toContainText(
        "cut its prompt, its reply, a tool's output, a tool's input to its bound",
      );
      await expect(note).toContainText("no whole copy exists");
    }
  }
});

test("a tool call recorded while the reader watches is described in a line and opens focused", async ({
  page,
}) => {
  await openNode(page, facts.run, "live");
  const listed = page.getByRole("region", { name: "Node transcript" });
  const command = "just check --affected-by the-live-call";
  const toolCallId = "toolu_01LiveCallRecordedMidJourney";
  await expect(
    listed.getByRole("button", { name: `Open ${command}` }),
  ).toHaveCount(0);

  // The harness appends the call to the history file, then the producer relays
  // a record pointing at it — in that order, as oneharness writes before its
  // sink sees the event.
  const live = facts.sessions.live;
  if (live === undefined) throw new Error("the corpus names no live session");
  const store = join(server.workspace, "transcript-history");
  const index = 7;
  appendFileSync(
    join(store, facts.project, `${live.session}.jsonl`),
    `${JSON.stringify({
      type: "event",
      schema_version: "1.1",
      run_id: live.historyId,
      harness: "claude-code",
      variant: "alternate",
      harness_id: "claude-code:alternate",
      event: {
        kind: "tool_call",
        name: "Bash",
        input: { command, description: "Check what the live call touched" },
        output: null,
        index,
        tool_call_id: toolCallId,
      },
    })}\n`,
  );
  const journal = join(server.workspace, "runs", facts.run, "events.jsonl");
  const stream = `a-recording-host-${facts.run}`;
  const seq = readFileSync(journal, "utf8")
    .split("\n")
    .filter((line) => line.includes(`"stream":"${stream}"`)).length;
  appendRecords(journal, [
    {
      v: 1,
      ts: new Date().toISOString(),
      stream,
      seq,
      source: "agentgraph",
      kind: "turn-activity",
      labels: {
        run_id: facts.run,
        node: "live",
        member: "worker",
        persona: "worker",
        session: facts.conversations.live,
      },
      payload: {
        transcript: {
          history_dir: store,
          history_project: facts.project,
          history_session: live.session,
          history_id: live.historyId,
          index,
          tool_call_id: toolCallId,
        },
        kind: "tool_call",
        name: "Bash",
        tool_call_id: toolCallId,
        index,
      },
      artifacts: [],
    },
  ]);

  // Without a reload: the row arrives with the server's one line for the call.
  const row = listed.getByRole("button", { name: `Open ${command}` });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  // Opened on the conversation, focused on that call: its details are the ones
  // opened, and its entry is the one marked current.
  const details = (call: string) =>
    detail(page)
      .getByRole("button", { name: "Bash tool details" })
      .filter({ hasText: call });
  // llmlint: ignore-block[e2e_uses_accessible_selectors] the design system's `TurnCard` marks the focused tool call with `aria-current` on its accordion item, an element with no role of its own, so no role query can reach the state the acceptance criterion names; the call is found by its button's accessible name and only the item's state is read from it.
  const marked = (call: string) =>
    details(call).evaluate(
      (button) =>
        button.closest("[aria-current]")?.getAttribute("aria-current") ?? null,
    );
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  await expect(details(command)).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => marked(command)).toBe("true");
  await expect(
    detail(page).getByLabel("Bash tool input").first(),
  ).toContainText(command);

  // A call the harness minted no identity for is found by the index the
  // producer gave it, and opens focused the same way.
  const unnamed = "just check --affected-by the-unnamed-call";
  appendFileSync(
    join(store, facts.project, `${live.session}.jsonl`),
    `${JSON.stringify({
      type: "event",
      schema_version: "1.1",
      run_id: live.historyId,
      harness: "claude-code",
      variant: "alternate",
      harness_id: "claude-code:alternate",
      event: {
        kind: "tool_call",
        name: "Bash",
        input: { command: unnamed },
        output: null,
        index: index + 1,
        tool_call_id: null,
      },
    })}\n`,
  );
  appendRecords(journal, [
    {
      v: 1,
      ts: new Date().toISOString(),
      stream,
      seq: seq + 1,
      source: "agentgraph",
      kind: "turn-activity",
      labels: {
        run_id: facts.run,
        node: "live",
        member: "worker",
        persona: "worker",
        session: facts.conversations.live,
      },
      payload: {
        transcript: {
          history_dir: store,
          history_project: facts.project,
          history_session: live.session,
          history_id: live.historyId,
          index: index + 1,
        },
        kind: "tool_call",
        name: "Bash",
        index: index + 1,
      },
      artifacts: [],
    },
  ]);
  await page.getByRole("button", { name: "Close detail" }).click();
  const unnamedRow = listed.getByRole("button", { name: `Open ${unnamed}` });
  await expect(unnamedRow).toBeVisible({ timeout: 15_000 });
  await unnamedRow.click();
  await expect(details(unnamed)).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => marked(unnamed)).toBe("true");
  await expect.poll(() => marked(command)).toBeNull();
});

test("what the server serves of a turn is what the client's schemas read", async ({
  page,
}) => {
  const read = async (path: string) =>
    (await page.request.get(`${server.origin}/api/v2/runs/${path}`)).json();
  // The node timeline, read by the schema the browser reads it with: every
  // turn-activity row carries the served line and where it sits.
  const timeline = runTimelineSchema.parse(
    await read(`${facts.run}/timeline?scope=node&node=died`),
  );
  const activity = timeline.spans
    .find((span) => span.kind === "node")
    ?.events.filter((event) => event.kind === "turn-activity");
  expect(activity?.length).toBeGreaterThan(0);
  for (const event of activity ?? []) {
    expect(event.description).toBeTruthy();
    expect(event.tool?.turn).toBe(`${facts.conversations.died}.0`);
    expect(event.reference).toEqual({
      kind: "conversation",
      value: facts.conversations.died,
    });
  }
  // A standalone harness session, read by the artifact schema: its turn whole,
  // its record served whole and never as a tail.
  const drafted = facts.sessions.drafted;
  const session = artifactContentSchema.parse(
    await read(`${facts.run}/artifacts/${drafted?.historyId}`),
  );
  expect(session.truncated).toBe(false);
  expect(session.unavailable).toBeUndefined();
  expect(session.turns?.[0]?.user).toContain(facts.sentinels.session);
});

/**
 * What one opened turn's activity shows, top to bottom: each of the agent's words
 * by its kind and each call by the tool it named — a call and its result are one
 * entry, as the turn card draws them.
 */
async function activityOrder(page: Page): Promise<string[]> {
  const activity = detail(page).getByRole("region", { name: "Agent activity" });
  await expect(activity).toBeVisible();
  // One locator over the three, so they are read in the order they are drawn.
  const entries = activity
    .getByRole("group", { name: "Agent message" })
    .or(activity.getByRole("button", { name: "Reasoning" }))
    .or(activity.getByRole("button", { name: / tool details$/ }));
  const order: string[] = [];
  for (const entry of await entries.all()) {
    const label = (await entry.getAttribute("aria-label")) ?? "";
    order.push(
      label === "Agent message"
        ? "message"
        : label.endsWith(" tool details")
          ? `tool:${label.slice(0, -" tool details".length)}`
          : "reasoning",
    );
  }
  return order;
}

for (const [reading, node, settled] of [
  ["settled", "narrated", true],
  ["live", "narrated-live", false],
] as const) {
  test(`a ${reading} turn shows what its agent said, reasoned and called in the order its history recorded`, async ({
    page,
  }) => {
    // The history interleaves the agent's words with its calls. Settled, the
    // member's report keeps only the calls, so the words are read out of that
    // file; live, they are the activity the producer relayed.
    const conversation = conversationSchema.parse(
      (
        await (
          await page.request.get(
            `${server.origin}/api/v2/runs/${facts.run}/conversations/${
              settled
                ? facts.conversations.narrated
                : facts.conversations.narratedLive
            }`,
          )
        ).json()
      ).conversation,
    );
    const served = conversation.turns[0]?.agentEvents ?? [];
    expect(served.map((event) => event.index)).toEqual(
      [...served.map((event) => event.index)].sort((a, b) => a - b),
    );

    await openNode(page, facts.run, node);
    await page
      .getByRole("region", { name: "Node transcript" })
      .getByRole("button", { name: "Open turn-started" })
      .first()
      .click();
    const turn = detail(page).getByRole("article", {
      name: /^Turn .*\.0 from /,
    });
    await expect(turn).toBeVisible();
    // A settled turn's closing message is its reply, drawn after everything it
    // did; a live turn has none yet, so its last message is in its activity.
    const order = settled
      ? facts.narratedOrder.slice(0, -1)
      : facts.narratedOrder;
    expect(await activityOrder(page)).toEqual(order);
    await expect(
      turn.getByRole("group", { name: "Agent message" }).first(),
    ).toContainText("The document is there; checking the branch next.");
    // The reply is shown once: after the activity settled, inside it live.
    const reply = "The criterion is met";
    await expect(turn).toContainText(reply);
    const activity = turn.getByRole("region", { name: "Agent activity" });
    if (settled) await expect(activity).not.toContainText(reply);
    else await expect(activity).toContainText(reply);
  });
}

/**
 * What the field/value view draws, any moment of which in a conversation item's
 * panel is the second view this panel must never paint: each by the words it
 * reads as, held to the item's panel. Its recorded fields open under their own
 * heading (or say there are none), its facts open on when the item was recorded,
 * and its reference line reads as the reference's kind beside its value.
 */
const fieldView = (reference: { kind: string; value: string }) =>
  ({
    recordedHeading: { text: "Recorded fields", within: DETAIL },
    noFields: { text: "This record holds no fields.", within: DETAIL },
    facts: { text: "Recorded at", within: DETAIL },
    referenceLine: {
      text: `${reference.kind}${reference.value}`,
      within: DETAIL,
    },
  }) as const;

const NONE_SEEN = {
  recordedHeading: false,
  noFields: false,
  facts: false,
  referenceLine: false,
};

const CONVERSATIONS = "**/api/v2/runs/*/conversations/**";

/** The usage-limit message, as the narrated node's served timeline lists it. */
async function usageLimitItem(page: Page) {
  const timeline = runTimelineSchema.parse(
    await (
      await page.request.get(
        `${server.origin}/api/v2/runs/${facts.run}/timeline?scope=node&node=narrated`,
      )
    ).json(),
  );
  const item = timeline.spans
    .flatMap((span) => span.events)
    .find((event) => event.description === facts.usageLimit);
  if (item === undefined) throw new Error("the corpus has no such item");
  return item;
}

test("a conversation item opens in the conversation view alone, before, while and after its transcript loads", async ({
  page,
}) => {
  const { reference } = await usageLimitItem(page);
  if (reference?.kind !== "conversation")
    throw new Error("the usage-limit message names no conversation");
  await watch(page, fieldView(reference));
  await openNode(page, facts.run, "narrated");
  // The transcript's answer held back at the network boundary, then let through
  // unchanged: the only way to look at the panel while it loads.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // llmlint: ignore-block[e2e_not_mocked] the acceptance criterion requires the transcript response held back at the network boundary so the panel can be observed while it loads; nothing is doubled, the real server's own answer is passed through unchanged once released.
  await page.route(CONVERSATIONS, async (route) => {
    await held;
    await route.continue();
  });
  // llmlint: ignore-end[e2e_not_mocked]
  await openRow(page, new RegExp(facts.usageLimit.slice(0, 25)));
  await expect(detail(page).getByText("Loading transcript…")).toBeVisible();
  expect(await seen(page), "the field/value view while loading").toEqual(
    NONE_SEEN,
  );
  release();

  // The package's own conversation view, as an observer's dispatch panel draws it.
  const turn = detail(page).getByRole("article", { name: /^Turn .* from / });
  await expect(turn).toBeVisible();
  await expect(turn).toContainText(facts.usageLimit);
  await expect(
    turn.getByRole("button", { name: /^Collapse turn / }),
  ).toHaveAttribute("aria-expanded", "true");
  // llmlint: ignore[e2e_uses_accessible_selectors] the package marks who speaks only by this attribute, and the criterion is that its own blocks are drawn: a re-styled list would carry no such marks.
  const you = turn.locator('[data-message-author="user"]');
  await expect(you).toContainText("You");
  // llmlint: ignore-block[e2e_uses_accessible_selectors] the same attribute, for the agent's block, and the package's own avatar and model-chip slots, none of which has a role or accessible name: the criterion is that the package's own parts are drawn, which only its own marks can tell from a re-styled copy.
  const agent = turn.locator('[data-message-author="assistant"]');
  await expect(agent.locator('[data-slot="avatar"]').first()).toBeVisible();
  await expect(agent.locator('[data-slot="badge"]').first()).toBeVisible();
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  await expect(
    turn.getByRole("button", { name: / tool details$/ }).first(),
  ).toBeVisible();
  await expect(turn.getByLabel("Usage").first()).toBeVisible();
  expect(await seen(page), "the field/value view at any moment").toEqual(
    NONE_SEEN,
  );
  await page.unroute(CONVERSATIONS);

  // Scrolled to the item it opened on, at a desktop's width and a phone's, nothing
  // pinned in the panel covers that item or the panel's Close control.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expectNothingPinnedOver(page);
  }
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(detail(page)).toHaveCount(0);
});

/**
 * Scroll the panel to the item it opened on, its top at the top of the panel, and
 * hold that nothing pinned there — the conversation's own timeline header, the
 * panel's Close control — is painted over either of them: what is hit at the
 * item's top edge is the item, and what is hit at Close is Close.
 */
async function expectNothingPinnedOver(page: Page): Promise<void> {
  // llmlint: ignore[e2e_uses_accessible_selectors] `aria-current` is the package's own mark of the item a panel opened on — the turn, or the tool call within it (its plot marks the same turn, hence the article) — and no role query can filter on it; the criterion is about that one item.
  const focused = detail(page)
    .locator('article[aria-current="true"], article [aria-current="true"]')
    .first();
  await expect(focused).toBeVisible();
  await focused.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
  const pinned = detail(page).getByRole("region", {
    name: "Conversation timeline",
  });
  await expect(pinned).toBeVisible();
  const close = page.getByRole("button", { name: "Close detail" });
  const hits = await focused.evaluate((element, closeLabel) => {
    const box = element.getBoundingClientRect();
    const button = document.querySelector(`[aria-label="${closeLabel}"]`);
    const at = (x: number, y: number) => document.elementFromPoint(x, y);
    const edge = [0.1, 0.5, 0.9].map((share) => {
      const hit = at(box.left + box.width * share, box.top + 4);
      return hit !== null && element.contains(hit);
    });
    const closeBox = button?.getBoundingClientRect();
    const closeHit =
      closeBox === undefined
        ? null
        : at(
            closeBox.left + closeBox.width / 2,
            closeBox.top + closeBox.height / 2,
          );
    return {
      edge,
      close: closeHit !== null && button?.contains(closeHit) === true,
    };
  }, "Close detail");
  expect(hits.edge, "the opened item's top edge is the item").toEqual([
    true,
    true,
    true,
  ]);
  expect(hits.close, "Close is what a tap at Close hits").toBe(true);
  // And the conversation's pinned header leaves Close a place of its own.
  const [header, button] = await Promise.all([
    pinned.boundingBox(),
    close.boundingBox(),
  ]);
  if (header === null || button === null)
    throw new Error("the pinned header or Close is not laid out");
  const apart =
    button.x >= header.x + header.width ||
    button.x + button.width <= header.x ||
    button.y >= header.y + header.height ||
    button.y + button.height <= header.y;
  expect(apart, "the pinned header lies under Close").toBe(true);
}

test("a conversation item whose transcript cannot be served says so with its recorded values, and anything else opens its fields", async ({
  page,
}) => {
  const item = await usageLimitItem(page);
  if (item.fields === undefined) throw new Error("the item holds no fields");
  const transcript = z
    .object({ history_id: z.string(), history_session: z.string() })
    .parse(item.fields.transcript);

  // A transcript the server cannot answer, refused at the network boundary.
  // llmlint: ignore-block[e2e_not_mocked] the acceptance criterion requires the transcript request failing so the conversation view's failure state is shown; the real server over this corpus always serves the transcript, so the failure is made at the network boundary, in the API's own error envelope, and every other request reaches the real server.
  await page.route(CONVERSATIONS, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unavailable", message: "the history store is offline" },
      }),
    }),
  );
  // llmlint: ignore-end[e2e_not_mocked]
  await openNode(page, facts.run, "narrated");
  await openRow(page, new RegExp(facts.usageLimit.slice(0, 25)));
  const failed = detail(page)
    .getByRole("alert")
    .filter({ hasText: "Transcript unavailable" });
  await expect(failed).toBeVisible();
  for (const value of [
    transcript.history_id,
    transcript.history_session,
    "message",
  ])
    await expect(failed).toContainText(value);
  await expect(
    detail(page).getByRole("region", { name: "Recorded fields" }),
  ).toHaveCount(0);
  await expect(detail(page).getByText("Recorded fields")).toHaveCount(0);
  await page.unroute(CONVERSATIONS);

  // A record that is no conversation opens in the field/value view alone.
  await page.keyboard.press("Escape");
  await openRow(page, "node-settled");
  await expect(
    detail(page).getByRole("region", { name: "Recorded fields" }),
  ).toBeVisible();
  await expect(
    detail(page).getByRole("article", { name: /^Turn / }),
  ).toHaveCount(0);
});
