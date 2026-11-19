/**
 * The settled large run's busiest node, opened on the real release server: its
 * whole transcript is read through the node's one stream, every record in order.
 *
 * Apart from `reach-everything.spec.ts`, which it belongs beside, because its
 * hundred pages are as long as every other journey there together: as a file of
 * its own it runs in another worker, beside them rather than after them.
 */

import { nodeStreamLineSchema } from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import {
  addressOf,
  buildWorld,
  LARGE_WORKLOAD,
  NEVER,
  removeWorld,
  type Served,
  serve,
  settledTimeline,
  stop,
  type World,
} from "./journey-world";

type Json = Record<string, unknown> & { events?: Json[]; id?: string };

let world: World;
let served: Served;
test.beforeAll(async () => {
  world = buildWorld(LARGE_WORKLOAD, "settled");
  served = await serve(world);
});
test.afterAll(async () => {
  await stop(served);
  removeWorld(world);
});

const open = (page: Page, view: "graph" | "overall" | "node", node?: string) =>
  page.goto(
    `${served.origin}${addressOf(world.facts.openLiveRun, view, node)}`,
  );

test("the busiest node's whole transcript is read once, through its stream, every record in order", async ({
  page,
}) => {
  const node = world.facts.large.busiestNode;
  const run = world.facts.openLiveRun;
  const timeline = await settledTimeline(world, served, run, node);
  // A span is the SDK's record, which the API passes through untyped
  // as a JSON value (AGENTS.md); this reads only its rows' records.
  const expected = new Set(
    (timeline.spans as Json[]).flatMap((span) =>
      (span.events ?? []).flatMap((event) => {
        const record = event.record_id ?? event.id;
        return typeof record === "string" ? [record] : [];
      }),
    ),
  );
  const reads: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.endsWith("/timeline/events") ||
      url.pathname.endsWith("/timeline/node-stream")
    )
      reads.push(url);
  });
  await open(page, "node", node);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  await expect(transcript).toHaveAttribute("aria-busy", "false", {
    timeout: NEVER,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The view asked once, for the node's stream, and paged nothing.
  expect(reads.map((url) => url.pathname)).toStrictEqual([
    `/api/v2/runs/${run}/timeline/node-stream`,
  ]);
  // That read, asked of the same route: a browser keeps no body of a response it
  // read as a stream. Every record of the node once, newest first.
  const lines = (
    await (
      await page.request.get(reads[0]?.href ?? "", { timeout: NEVER })
    ).text()
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => nodeStreamLineSchema.parse(JSON.parse(line)));
  expect(lines.at(-1)?.kind).toBe("end");
  const rows = lines.flatMap((line) => (line.kind === "rows" ? line.rows : []));
  const records = rows.map((row) => row.record_id ?? row.id);
  expect(new Set(records).size, "no record repeated").toBe(records.length);
  expect(new Set(records)).toStrictEqual(expected);
  const at = rows.map((row) => [Date.parse(row.at), row.journal_order ?? 0]);
  expect(
    at.every(
      ([time = 0, order = 0], index) =>
        index === 0 ||
        time < (at[index - 1]?.[0] ?? 0) ||
        (time === at[index - 1]?.[0] && order <= (at[index - 1]?.[1] ?? 0)),
    ),
    "newest first",
  ).toBe(true);
});
