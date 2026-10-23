import { expect, type Locator, test } from "@playwright/test";
import { delayGraphMeasurements } from "./delayed-graph-measurements";
import { runs } from "./fixture-facts";
import { graphNodes } from "./observatory-locators";

test.beforeEach(async ({ page }) => {
  await delayGraphMeasurements(page);
});

async function expectDrawn(edge: Locator): Promise<void> {
  await expect(edge).toBeAttached();
  // A horizontal SVG edge has zero bounding-box height, so Playwright's
  // visibility check rejects it. Its rendered geometry must still span a gap.
  await expect
    .poll(() => edge.evaluate((group: SVGGElement) => group.getBBox().width))
    .toBeGreaterThan(0);
}

test("draws dependencies before node measurements arrive and after a resize", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().live}&view=graph`);
  await expect(graphNodes(page, "running")).toHaveAccessibleName(
    "dashboard: running",
  );
  const edge = page.getByRole("group", {
    name: "Edge from foundation to dashboard",
    exact: true,
  });
  await expectDrawn(edge);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectDrawn(edge);
  // Navigating away destroys the canvas; returning must draw a fresh graph even
  // while the next batch of native node measurements is held again.
  await page.goto(`/?run=${runs().live}&view=overall`);
  await expect(edge).toHaveCount(0);
  await page.goto(`/?run=${runs().live}&view=graph`);
  await expectDrawn(edge);
});
