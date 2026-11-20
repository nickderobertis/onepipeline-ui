import { runTimelineSchema } from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import every from "./fixtures/every-kind.json" with { type: "json" };

/**
 * Every record's detail shows the whole of what it recorded.
 *
 * The corpus is one record of every kind the linked engine writes — held to that
 * engine's `PIPELINE_KINDS` and to the payload document it registers for each, by
 * `tests/contract.rs` — and one of every kind the other fixtures relay. Each is
 * opened in the browser through the real read API, and every leaf value its payload
 * holds has to be read in its detail as text: nothing dropped by a list of fields
 * kept somewhere, and no object or list shown as the JSON that encodes it.
 */

const factsSchema = z.object({
  every: z.string().min(1),
  every_node: z.string().min(1),
});

/**
 * The one field no detail may show: an `onevcs` session's token is a capability
 * over that session, and the read API serves every field of a record but it.
 */
const CREDENTIALS: ReadonlySet<string> = new Set(["token"]);

/** Every leaf value of a payload, as the text a reader would find it by. */
function leaves(value: unknown, key = ""): string[] {
  if (CREDENTIALS.has(key)) return [];
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => leaves(entry));
  if (typeof value === "object")
    return Object.entries(value).flatMap(([field, entry]) =>
      leaves(entry, field),
    );
  return [String(value)];
}

/** Text a record's detail shows that is a JSON object or list spelled out. */
const JSON_SPELLED = /[{[]\s*"[^"\n]*"\s*[:,\]]/u;

let server: FixtureServer | undefined;
let facts: z.infer<typeof factsSchema>;
/** The records the server serves as conversation items, by record id. */
let conversations: ReadonlySet<string> = new Set();

test.beforeAll(async () => {
  server = await startFixtureServer("event-details", ["--event-list-corpus"]);
  facts = factsSchema.parse(server.facts);
  const served = await Promise.all(
    ["scope=run", `scope=node&node=${every.node}`].map(async (query) =>
      runTimelineSchema.parse(
        await (
          await fetch(
            `${server?.origin}/api/v2/runs/${every.run_id}/timeline?${query}`,
          )
        ).json(),
      ),
    ),
  );
  conversations = new Set(
    served
      .flatMap((timeline) => timeline.spans)
      .flatMap((span) => span.events)
      .filter((event) => event.reference?.kind === "conversation")
      .map((event) => event.record_id ?? event.id),
  );
});

test.afterAll(async () => {
  await server?.stop();
  server = undefined;
});

/** Each record of the corpus, with the id the read API serves it under. */
const records = every.records.map((record, seq) => ({
  ...record,
  recordId: `${every.stream}.${seq}`,
}));

/**
 * Open `record` by the address a link to it is — the run, its node where it
 * names one, and the record — and read the fields its detail recorded. A
 * conversation item is read in the conversation view instead, which shows its
 * turn or, where the transcript cannot be served, says so with these values.
 */
async function readDetail(
  page: Page,
  origin: string,
  record: (typeof records)[number],
): Promise<void> {
  const node =
    "node" in record ? `&node=${record.node}&view=graph` : "&view=overall";
  await page.goto(
    `${origin}/?run=${every.run_id}${node}&event=${record.recordId}`,
  );
  const panel = page.getByRole("complementary", { name: "Item detail panel" });
  if (conversations.has(record.recordId)) {
    await expect(
      panel
        .getByRole("article", { name: /^Turn / })
        .or(
          panel
            .getByRole("alert")
            .filter({ hasText: "Transcript unavailable" }),
        ),
      `${record.kind} opens its conversation`,
    ).toBeVisible();
    await expect(
      panel.getByRole("region", { name: "Recorded fields" }),
    ).toHaveCount(0);
    return;
  }
  const detail = panel.getByRole("region", { name: "Recorded fields" });
  await expect(detail, `${record.source} ${record.kind} opens`).toBeVisible();
  const text = await detail.innerText();
  for (const leaf of leaves(record.payload))
    expect(text, `${record.kind}'s detail shows ${leaf}`).toContain(leaf);
  expect(text, `${record.kind}'s detail spells JSON`).not.toMatch(JSON_SPELLED);
}

test("every kind's detail shows each value its record holds, and none as JSON", async ({
  page,
}) => {
  test.setTimeout(600_000);
  if (server === undefined) throw new Error("the fixture server is not up");
  for (const record of records) await readDetail(page, server.origin, record);
});

test("a human-attested record names who answered, for whom, whose words, the choice and the words", async ({
  page,
}) => {
  if (server === undefined) throw new Error("the fixture server is not up");
  const attested = records.find(({ kind }) => kind === "human-attested");
  if (attested === undefined) throw new Error("the corpus has no attestation");
  await page.goto(
    `${server.origin}/?run=${facts.every}&node=${facts.every_node}&view=graph&event=${attested.recordId}`,
  );
  const item = page
    .getByRole("complementary", { name: "Item detail panel" })
    .getByRole("heading", { name: "Human item" });
  await expect(item).toBeVisible();
  const said = z
    .object({
      item: z.object({
        resolution: z.object({
          actor: z.string(),
          on_behalf_of: z.string(),
          choice: z.string(),
          text: z.string(),
        }),
      }),
    })
    .parse(attested.payload).item.resolution;
  const detail = page.getByRole("complementary", { name: "Item detail panel" });
  for (const [term, value] of [
    ["By", said.actor],
    ["On behalf of", said.on_behalf_of],
    ["Choice", said.choice],
  ] as const)
    await expect(
      detail.getByRole("definition").filter({ hasText: value }).first(),
      term,
    ).toBeVisible();
  await expect(detail).toContainText(said.text);
});
