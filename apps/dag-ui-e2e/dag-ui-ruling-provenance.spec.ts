import { execFileSync } from "node:child_process";
import {
  cpSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { channelQueueSchema } from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

/**
 * Who made each ruling, as a run's channel view shows it, driven in a real
 * browser against the real read API over the main corpus — every reply,
 * envelope and declined ruling in it written by the browser through the served
 * routes or by the provisioned `onepipeline` CLI of the release the server
 * links, the manager's own words, with no `--as`.
 *
 * A browser reply is recorded by the engine as the user's; a CLI reply with no
 * `--as` as the manager's, which writes no `provenance` key — the same record a
 * released engine wrote before the field existed. The view names each reply's
 * and each queued envelope's party once, in its plain heading, and reads a
 * declined ruling as one message drawn from the engine's typed record.
 */

const ENGINE = join(
  import.meta.dirname,
  "..",
  "..",
  ".tools",
  "bin",
  process.platform === "win32" ? "onepipeline.exe" : "onepipeline",
);
const RELEASED = join(
  import.meta.dirname,
  "..",
  "..",
  "tests",
  "fixtures",
  "released-rulings",
);

/** The node the manager adds for every ruling here to be about. */
const NODE = "provenance-target";
const MANAGER_NOTE = "Keep the export under fifty lines.";
const DECLINE_REASON = "The fixture already exceeds fifty lines.";
const BLOCKING_FINDING = "Stop: the schema moved under this node.";
const USER_NOTE = "Measure the cold start too.";
const QUEUED_MANAGER_NOTE = "Hold the release until the docs land.";
const USER_REPLY = "Carry on with the narrower diff.";
const MANAGER_REPLY = "Carry on; the manager agrees.";
const UNRELATED = "Lunch is at noon in the large room.";

const factsSchema = z.object({
  runs: z.object({ busy: z.string().min(1), history: z.string().min(1) }),
});
const receiptSchema = z.object({ reply: z.number().int().nonnegative() });

let server: FixtureServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/**
 * A server of this journey's own over the main corpus, whose engine waits one
 * second for a reconciler before it reports an envelope queued.
 */
async function serve(): Promise<FixtureServer> {
  server = await startFixtureServer("ruling-provenance", [], {
    ONEPIPELINE_REPLY_TIMEOUT_SECONDS: "1",
  });
  return server;
}

/** `onepipeline ARGS… [FILE]` over the served runs root, as the manager. */
function cli(served: FixtureServer, args: string[], input?: string): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ![
          "ONEPIPELINE_",
          "ONEAGENTGRAPH_",
          "ONEHARNESS_",
          "ONETASKGRAPH_",
        ].some((prefix) => name.startsWith(prefix)),
    ),
  );
  const runs = join(served.workspace, "runs");
  const file = join(served.workspace, `cli-input-${Date.now()}.txt`);
  if (input !== undefined) writeFileSync(file, input);
  return execFileSync(ENGINE, input === undefined ? args : [...args, file], {
    env: {
      ...env,
      ONEPIPELINE_RUNS_DIR: runs,
      ONEAGENTGRAPH_STATE_DIR: join(dirname(runs), "oneagentgraph"),
      ONEPIPELINE_REPLY_TIMEOUT_SECONDS: "1",
      XDG_CONFIG_HOME: join(served.workspace, "config"),
    },
    encoding: "utf8",
  });
}

/** A manager's reply through the CLI, answered with the envelope's id. */
function managerReply(served: FixtureServer, run: string, envelope: unknown) {
  return receiptSchema.parse(
    JSON.parse(cli(served, ["reply", run], JSON.stringify(envelope))),
  ).reply;
}

/**
 * Hold `run` as a driver on another host would: its ownership lock names a
 * holder this host cannot prove gone, so the engine applies nothing itself and
 * an envelope waits on the durable queue for that driver's reconciler.
 */
function heldElsewhere(served: FixtureServer, run: string): void {
  writeFileSync(
    join(served.workspace, "runs", run, "owner.lock"),
    JSON.stringify({
      pid: 4248,
      host: "a-recording-host",
      acquired_at: "2026-09-14T13:50:21.710Z",
      verb: "drive",
      started: "linux-proc-stat:4248",
    }),
  );
}

/** What a channel route serves, through the browser's own parser. */
async function channelOf(page: Page, served: FixtureServer, run: string) {
  const response = await page.request.get(
    `${served.origin}/api/v2/runs/${run}/channel`,
  );
  expect(response.ok()).toBe(true);
  return channelQueueSchema.parse(await response.json());
}

/** Every badge inside `scope`: the one element a party or an id must not be. */
function badges(scope: Locator): Locator {
  // llmlint: ignore[e2e_uses_accessible_selectors] a badge is a styled span with no role or name of its own, so what the view must not render as one can only be found by the slot `@oneharness/ui` marks it with.
  return scope.locator('[data-slot="badge"]');
}

async function colourOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).color);
}

/** The run's channel view, opened, with its queue read. */
async function openChannel(
  page: Page,
  served: FixtureServer,
  run: string,
): Promise<Locator> {
  await page.goto(`${served.origin}/?run=${run}&view=channel`);
  const queue = page.getByRole("region", { name: "Channel queue" });
  await expect(queue.getByRole("region", { name: "Surfaces" })).toBeVisible();
  return queue;
}

test("the channel names each reply's and envelope's party once, plainly, and reads a declined ruling from its record", async ({
  page,
}) => {
  const served = await serve();
  const run = factsSchema.parse(served.facts).runs.busy;
  const notes = [{ op: "note", id: NODE, addressee: "worker" }];

  // Nothing drives the run, so the CLI's edits are applied as they are sent:
  // a node for the rulings to be about, a blocking finding about it, and a
  // manager's note to it, which its dispatch then declines.
  managerReply(served, run, {
    version: 4,
    commands: [
      {
        op: "add",
        node: {
          id: NODE,
          persona: "engineer",
          task: "## What\nExport it.\n\n## Acceptance criteria\n\n- it is exported",
        },
      },
      { op: "finding", message: BLOCKING_FINDING, blocking: true, id: NODE },
    ],
  });
  const noted = managerReply(served, run, {
    version: 4,
    commands: [{ ...notes[0], text: MANAGER_NOTE }],
  });
  cli(
    served,
    ["decline-ruling", run, "--ruling", `c${noted}.0`],
    DECLINE_REASON,
  );

  // Then a driver elsewhere holds the run, so every envelope after this waits
  // queued: one the user sends from this page, and one the manager sends.
  heldElsewhere(served, run);
  const queue = await openChannel(page, served, run);
  const composer = page.getByRole("region", { name: "Reply" });
  const editor = composer.getByLabel("Envelope (sent as typed)");
  const receipt = page.getByRole("alert", { name: "Reply receipt" });
  await editor.fill(
    JSON.stringify({
      version: 4,
      commands: [{ ...notes[0], text: USER_NOTE }],
    }),
  );
  await composer.getByRole("button", { name: "Send reply" }).click();
  await expect(receipt).toContainText('"state": "queued"');
  await editor.fill(JSON.stringify({ message: USER_REPLY }));
  await composer.getByRole("button", { name: "Send reply" }).click();
  await expect(receipt).toContainText('"state": "delivered"');
  const queuedByManager = managerReply(served, run, {
    version: 4,
    commands: [{ ...notes[0], text: QUEUED_MANAGER_NOTE }],
  });
  managerReply(served, run, { message: MANAGER_REPLY });

  // What the engine recorded: the browser's words as the user's, the CLI's as
  // the manager's, which names no provenance at all.
  const recorded = await channelOf(page, served, run);
  const userEnvelope = recorded.commands.find(
    ({ provenance }) => provenance === "user",
  );
  expect(userEnvelope?.commands).toEqual([{ ...notes[0], text: USER_NOTE }]);
  const managerEnvelope = recorded.commands.find(
    ({ id }) => id === queuedByManager,
  );
  expect(managerEnvelope?.provenance).toBeUndefined();
  const userReply = recorded.replies.find(
    ({ reply }) => reply.message === USER_REPLY,
  );
  const managerReplyRecord = recorded.replies.find(
    ({ reply }) => reply.message === MANAGER_REPLY,
  );
  expect(userReply?.reply.provenance).toBe("user");
  expect(managerReplyRecord?.reply).not.toHaveProperty("provenance");
  if (
    userEnvelope === undefined ||
    managerEnvelope === undefined ||
    userReply === undefined ||
    managerReplyRecord === undefined
  )
    throw new Error("the engine recorded no such reply or envelope");

  // Each reply and each envelope names its party once, in its heading text,
  // and no reply, envelope, note or outcome shows a party or an id as a badge.
  const replies = queue.getByRole("region", { name: "Replies" });
  const userReplyCard = replies.getByRole("group", {
    name: `Reply ${userReply.id} message`,
  });
  const managerReplyCard = replies.getByRole("group", {
    name: `Reply ${managerReplyRecord.id} message`,
  });
  const userReplyHeading = userReplyCard.getByText(
    `Reply ${userReply.id} · from you`,
    { exact: true },
  );
  const managerReplyHeading = managerReplyCard.getByText(
    `Reply ${managerReplyRecord.id} · from the manager`,
    { exact: true },
  );
  await expect(userReplyHeading).toBeVisible();
  await expect(managerReplyHeading).toBeVisible();
  for (const card of [userReplyCard, managerReplyCard]) {
    await expect(card.getByText(/from (you|the manager)/u)).toHaveCount(1);
    await expect(badges(card)).toHaveCount(0);
  }
  const commands = queue.getByRole("region", { name: "Queued commands" });
  const userEnvelopeCard = commands
    .getByRole("listitem")
    .filter({ hasText: `Envelope ${userEnvelope.id} ·` });
  const managerEnvelopeCard = commands
    .getByRole("listitem")
    .filter({ hasText: `Envelope ${managerEnvelope.id} ·` });
  const userEnvelopeHeading = userEnvelopeCard.getByText(
    `Envelope ${userEnvelope.id} · from you`,
    { exact: true },
  );
  const managerEnvelopeHeading = managerEnvelopeCard.getByText(
    `Envelope ${managerEnvelope.id} · from the manager`,
    { exact: true },
  );
  await expect(userEnvelopeHeading).toBeVisible();
  await expect(managerEnvelopeHeading).toBeVisible();
  // Each queued note is listed under its envelope, with no party of its own.
  for (const [card, text] of [
    [userEnvelopeCard, USER_NOTE],
    [managerEnvelopeCard, QUEUED_MANAGER_NOTE],
  ] as const) {
    const listed = card.getByRole("list", { name: "Notes" });
    await expect(listed.getByRole("listitem")).toHaveText([
      `Note to ${NODE}: ${text}`,
    ]);
    await expect(card.getByText(/from (you|the manager)/u)).toHaveCount(1);
    await expect(badges(card)).toHaveCount(0);
  }
  // An outcome is headed by its envelope's id in plain text; only whether it
  // applied is a badge.
  const outcomes = queue.getByRole("region", { name: "Command outcomes" });
  const outcome = outcomes
    .getByRole("listitem")
    .filter({ hasText: `Envelope ${noted}` });
  await expect(
    outcome.getByText(`Envelope ${noted}`, { exact: true }),
  ).toBeVisible();
  await expect(badges(outcome)).toHaveText(["applied"]);
  // The two parties read in one colour.
  const colours = await Promise.all(
    [
      userReplyHeading,
      managerReplyHeading,
      userEnvelopeHeading,
      managerEnvelopeHeading,
    ].map(colourOf),
  );
  expect(new Set(colours).size).toBe(1);

  // A surface's head is its kind, and "blocking" only where it blocks.
  const surfaces = queue.getByRole("region", { name: "Surfaces" });
  const blocking = surfaces
    .getByRole("listitem")
    .filter({ hasText: BLOCKING_FINDING });
  await expect(badges(blocking)).toHaveText(["finding", "blocking"]);
  await expect(blocking).toContainText(`node ${NODE}`);
  const declined = surfaces
    .getByRole("listitem")
    .filter({ has: page.getByRole("region", { name: "Declined ruling" }) });
  await expect(badges(declined)).toHaveText(["declined-ruling"]);
  await expect(surfaces).not.toContainText("non-blocking");

  // The declined ruling reads as one message, in order, from its record.
  const ruling = declined.getByRole("region", { name: "Declined ruling" });
  const sentence = `The proposal on ${NODE} declined the manager's note from reply ${noted}`;
  await expect(ruling).toHaveText(
    `${sentence}${MANAGER_NOTE}Reason: ${DECLINE_REASON}`,
  );
  await expect(ruling.getByRole("blockquote")).toHaveText(MANAGER_NOTE);
  const [surface] = (await channelOf(page, served, run)).surfaces.filter(
    ({ kind }) => kind === "declined-ruling",
  );
  expect(surface?.declined_ruling).toEqual({
    node: NODE,
    ruling: `c${noted}.0`,
    provenance: "manager",
    kind: "note",
    reply: noted,
    text: MANAGER_NOTE,
    reason: DECLINE_REASON,
  });
  if (surface === undefined) throw new Error("no declined ruling was served");
  // Nothing of the message the engine wrote for people: not its opening line,
  // which names the ruling's reference the card never shows.
  const [opening = surface.message] = surface.message.split("\n");
  await expect(declined).not.toContainText(opening);
  await expect(declined).not.toContainText(`c${noted}.0`);
});

test("a declined ruling's card is its record: rewriting the surface's message on disk changes none of it", async ({
  page,
}) => {
  const served = await serve();
  const run = factsSchema.parse(served.facts).runs.busy;
  managerReply(served, run, {
    version: 4,
    commands: [
      {
        op: "add",
        node: {
          id: NODE,
          persona: "engineer",
          task: "## What\nExport it.\n\n## Acceptance criteria\n\n- it is exported",
        },
      },
    ],
  });
  const noted = managerReply(served, run, {
    version: 4,
    commands: [
      { op: "note", id: NODE, addressee: "worker", text: MANAGER_NOTE },
    ],
  });
  cli(
    served,
    ["decline-ruling", run, "--ruling", `c${noted}.0`],
    DECLINE_REASON,
  );

  // Only the surface's message, rewritten where the engine keeps it; the
  // record beside it is left as the engine wrote it.
  const store = join(
    served.workspace,
    "runs",
    run,
    "channel",
    "surfaces.jsonl",
  );
  const before = readFileSync(store, "utf8");
  const lines = before.trimEnd().split("\n");
  const rewritten = lines.map((line) => {
    const record = z
      .looseObject({ kind: z.string().optional() })
      .parse(JSON.parse(line));
    return record.kind === "declined-ruling"
      ? JSON.stringify({ ...record, message: UNRELATED })
      : line;
  });
  expect(rewritten).not.toEqual(lines);
  writeFileSync(store, `${rewritten.join("\n")}\n`);
  const [served_] = (await channelOf(page, served, run)).surfaces.filter(
    ({ kind }) => kind === "declined-ruling",
  );
  expect(served_?.message).toBe(UNRELATED);
  expect(served_?.declined_ruling?.text).toBe(MANAGER_NOTE);

  const queue = await openChannel(page, served, run);
  const ruling = queue.getByRole("region", { name: "Declined ruling" });
  await expect(ruling).toHaveText(
    `The proposal on ${NODE} declined the manager's note from reply ${noted}${MANAGER_NOTE}Reason: ${DECLINE_REASON}`,
  );
  await expect(queue).not.toContainText(UNRELATED);
});

/**
 * Copy the run root a released engine wrote into the served runs root, its
 * placeholders filled in as the engine's own journey fills them.
 */
function seedReleased(served: FixtureServer): string {
  const run = "released-rulings";
  const into = join(served.workspace, "runs", run);
  cpSync(RELEASED, into, { recursive: true });
  const quoted = (path: string) => JSON.stringify(path).slice(1, -1);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        writeFileSync(
          path,
          readFileSync(path, "utf8")
            .replaceAll("@REPO@", quoted(served.workspace))
            .replaceAll("@WORLD@", quoted(served.workspace)),
        );
    }
  };
  walk(into);
  return run;
}

test("replies and envelopes a released engine wrote, with no provenance, are served and read as the manager's", async ({
  page,
}) => {
  const served = await serve();
  const run = seedReleased(served);
  // On disk, a version 3 reply and two envelopes that name no party, as the
  // released engine wrote them; served without refusal, and with no party.
  const channel = join(served.workspace, "runs", run, "channel");
  expect(readFileSync(join(channel, "replies.jsonl"), "utf8")).toContain(
    '"reply":{"version":3,"completion":false,"message":"Carry on."}',
  );
  expect(readFileSync(join(channel, "commands.jsonl"), "utf8")).not.toContain(
    "provenance",
  );
  const recorded = await channelOf(page, served, run);
  expect(recorded.replies.map(({ reply }) => reply.message)).toEqual([
    "Carry on.",
  ]);
  expect(recorded.replies[0]?.reply).not.toHaveProperty("provenance");
  expect(recorded.outcomes.map(({ id }) => id)).toEqual([0, 1]);

  const queue = await openChannel(page, served, run);
  const replies = queue.getByRole("region", { name: "Replies" });
  await expect(
    replies.getByText("Reply 0 · from the manager", { exact: true }),
  ).toBeVisible();
  await expect(replies).not.toContainText("from you");
  await expect(badges(replies)).toHaveCount(0);
  const outcomes = queue.getByRole("region", { name: "Command outcomes" });
  for (const id of [0, 1])
    await expect(
      outcomes.getByText(`Envelope ${id}`, { exact: true }),
    ).toBeVisible();
  await expect(badges(outcomes)).toHaveText(["applied", "applied"]);

  // And the main corpus's own replies, written in the released engine's shape
  // by the fixture `tests/contract.rs` holds to the SDK's writer: the manager's.
  const history = factsSchema.parse(served.facts).runs.history;
  const written = (await channelOf(page, served, history)).replies;
  expect(written.length).toBeGreaterThan(0);
  const historyQueue = await openChannel(page, served, history);
  await expect(historyQueue).not.toContainText("from you");
  for (const { id } of written)
    await expect(
      historyQueue.getByText(`Reply ${id} · from the manager`, { exact: true }),
    ).toBeVisible();
});
