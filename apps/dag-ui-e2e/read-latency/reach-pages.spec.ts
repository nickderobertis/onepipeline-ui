/**
 * The settled large run's history read with no view open, as a reader of the API
 * alone takes it: every span's pages, joined, are the complete document's events.
 *
 * Apart from `reach-everything.spec.ts`, which it belongs beside, because its
 * 230-odd pages, each a read of the journal, are as long as every other journey
 * there together: as a file of its own it runs in another worker, beside them.
 */

import { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { expect, test } from "@playwright/test";
import {
  buildWorld,
  LARGE_WORKLOAD,
  removeWorld,
  type Served,
  serve,
  settledTimeline,
  stop,
  type World,
} from "./journey-world";

type Json = Record<string, unknown> & { events?: Json[]; id?: string };

/** How many spans the union journey pages at once: the cores a CI runner has. */
const PAGERS = 4;

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

test("the union of every span's pages is the complete document's events, in order", async () => {
  const run = world.facts.openLiveRun;
  const timeline = await settledTimeline(world, served, run);
  const client = new TelemetryClient(served.origin);
  // A span is the SDK's record, which the API passes through untyped
  // as a JSON value (AGENTS.md); this reads only its id, events and node_id.
  const spans = (timeline.spans as Json[]).filter(
    (span) => (span.events ?? []).length > 0,
  );
  // Each span's pages in order, as a reader paging back takes them; the spans
  // side by side, PAGERS at a time, as readers of several spans do. With no view
  // open each page is a read of the journal, so taken one after another the
  // large run's 230-odd pages were most of this tier's time.
  const pageThrough = async (span: Json) => {
    const all = (span.events ?? []).map((event) => event.id);
    const collected: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await client.getTimelineEvents(run, {
        // A node span names its node by id, a string wherever it is present.
        ...(span.node_id === undefined ? {} : { node: span.node_id as string }),
        span: span.id,
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      collected.unshift(...page.rows.map((row) => row.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(collected, `span ${span.id}`).toStrictEqual(all);
  };
  const waiting = [...spans];
  await Promise.all(
    Array.from({ length: PAGERS }, async () => {
      for (let span = waiting.shift(); span; span = waiting.shift())
        await pageThrough(span);
    }),
  );
});
