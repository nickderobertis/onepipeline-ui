import { expect, type Locator, test } from "@playwright/test";
import { runs } from "./fixture-facts";
import { graphNodes } from "./observatory-locators";

// Keep native measurements, but hold their delivery for graph nodes until the
// reader resizes the window. The canvas container is still measured normally.
// This makes a slow first measurement deterministic without replacing API data
// or the graph renderer.
// llmlint: ignore-block[tests_mirror_real_usage] this scheduling fault cannot be
// produced reliably by clicking the UI. Hold real native observations, with their
// original sizes, to reproduce a loaded runner's delayed delivery; the built graph,
// real API, fixture storage and all user interactions remain under test.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const immediate = entries.filter(
            (entry) => !entry.target.classList.contains("react-flow__node"),
          );
          const delayed = entries.filter((entry) =>
            entry.target.classList.contains("react-flow__node"),
          );
          if (immediate.length > 0) callback(immediate, observer);
          if (delayed.length > 0)
            window.addEventListener(
              "resize",
              () => callback(delayed, observer),
              {
                once: true,
              },
            );
        });
      }
    };
  });
});
// llmlint: ignore-end[tests_mirror_real_usage]

async function expectDrawn(edge: Locator): Promise<void> {
  await expect(edge).toBeAttached();
  // A horizontal SVG path has zero bounding-box height, so Playwright's
  // visibility check rejects it even though its stroke is drawn.
  await expect
    .poll(() =>
      edge
        .locator("path")
        .first()
        .evaluate((path: SVGPathElement) => path.getTotalLength()),
    )
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
