import { expect, test } from "@playwright/test";
import { z } from "zod";
import { CLOCK, intersects, OFFSET, readAxis } from "./axis-readings";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { appPlot } from "./observatory-locators";
import { DESKTOP, PHONE } from "./viewports";

/**
 * A node's chart keeps its clock readable at a phone's width and a desktop's: on the
 * large-run views corpus's history node, whose records span long enough to put many
 * ticks on the axis, no tick's label touches another's and every one is drawn inside
 * the axis that holds it.
 *
 * The corpus is its own, served by a server this file starts, for the reason
 * `dag-ui-large-run-views.spec.ts` gives: a run added to the shared one is counted by
 * every listing journey and photographed by the gallery.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  history: z.string().min(1),
});

let server: FixtureServer;
let facts: z.infer<typeof factsSchema>;

test.beforeAll(async () => {
  server = await startFixtureServer("timeline-axis", [
    "--large-run-views-corpus",
  ]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server.stop();
});

for (const width of [PHONE.width, 1440]) {
  test(`a large node's axis labels stand clear of each other at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: DESKTOP.height });
    await page.goto(
      `${server.origin}/?run=${facts.run}&view=graph&node=${facts.history}`,
    );
    const timeline = page.getByRole("region", { name: "Node timeline" });
    await expect(appPlot(timeline)).toBeVisible();
    const axis = timeline.getByRole("list", { name: "Timeline axis" });
    const bounds = await axis.boundingBox();
    if (bounds === null) throw new Error("an axis drawn nowhere");
    const ticks = await readAxis(timeline);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const [index, tick] of ticks.entries()) {
      expect(tick.clock).toMatch(CLOCK);
      expect(tick.offset).toMatch(OFFSET);
      // Inside the axis, to within the half pixel layout rounds to.
      expect(tick.box.x).toBeGreaterThanOrEqual(bounds.x - 0.5);
      expect(tick.box.x + tick.box.width).toBeLessThanOrEqual(
        bounds.x + bounds.width + 0.5,
      );
      for (const other of ticks.slice(index + 1))
        expect(
          intersects(tick.box, other.box),
          `${tick.clock} ${tick.offset} and ${other.clock} ${other.offset} overlap at ${width} px`,
        ).toBe(false);
    }
  });
}
