import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactContentSchema,
  conversationSchema,
  runTimelineSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
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
  conversations: z.object({ died: z.string(), live: z.string() }),
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

const detail = (page: Page) =>
  page.getByRole("region", { name: "Timeline item detail" });

/** The whole of an element's text, as the browser holds it. */
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
  // Opened on the conversation, focused on that call: its entry is the one
  // marked current.
  const marked = (call: string) =>
    detail(page)
      .getByRole("button", { name: "Bash tool details" })
      .filter({ hasText: call })
      .evaluate(
        (button) =>
          button.closest("[aria-current]")?.getAttribute("aria-current") ??
          null,
      );
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
