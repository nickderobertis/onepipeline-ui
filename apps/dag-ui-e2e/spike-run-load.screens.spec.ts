import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CAPTURE_INSTANT_MS } from "./capture-clock";
import { delayGraphMeasurements } from "./delayed-graph-measurements";
import { runs } from "./fixture-facts";
import { graphNodes } from "./observatory-locators";
import { PHONE, viewport } from "./viewports";

/**
 * THROWAWAY spike mock (spike-visual, dag-run-load-speed-2026-11-06). Never lands.
 *
 * The app under this is the unchanged base against the small `dag-ui-live` fixture:
 * a held or failed subscription read is real, and every "still loading" mark is
 * markup injected into the page below, over a run the page in fact holds whole.
 *
 * Re-capture: `just spike-visual-shots` (writes to shots/local/spike-visual).
 */
const OUT = resolve(
  import.meta.dirname,
  "../..",
  process.env.SHOTS_OUT ?? "shots/local/spike-visual",
);
const DESKTOP = viewport("1440x900");
const SUBSCRIPTIONS = "**/api/v2/subscriptions";

/** The read never answers: what a large run opening looks like today. */
const holdSubscription = (page: Page) =>
  page.route(SUBSCRIPTIONS, () => {
    // Left pending on purpose.
  });

async function shot(page: Page, name: string) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important}",
  });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
}

async function openRun(page: Page, view: string) {
  await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
  await page.goto(`/?list=runs&run=${runs().live}&view=${view}`);
}

/** Replace the skeleton's panel contents; `.loading-state` is the base's own. */
const setLoadingPanel = (page: Page, html: string) =>
  page.locator(".loading-state").evaluate((el, markup) => {
    el.innerHTML = markup;
  }, html);

/**
 * Hatch the left `percent` of a plot, down to its axis labels: what is not held yet.
 * Opaque, so no marker or tick of the small run the fixture really holds shows through.
 */
const hatchPlot = (
  region: Locator,
  { percent, text }: { percent: number; text: string },
) =>
  region.evaluate(
    (el, { percent, text }) => {
      const plot = el.querySelector<HTMLElement>(
        '[aria-label^="Timeline plot"]',
      );
      if (!plot) throw new Error("no timeline plot");
      const plotBox = plot.getBoundingClientRect();
      const axisLabels = Array.from(plot.querySelectorAll("*"))
        .filter(
          (node) => node.children.length === 0 && /min$/.test(node.textContent ?? ""),
        )
        .map((node) => node.getBoundingClientRect().top);
      const bottom = axisLabels.length
        ? plotBox.bottom - Math.min(...axisLabels)
        : 0;
      const hatch = document.createElement("div");
      hatch.style.cssText = `position:absolute;top:0;left:0;bottom:${bottom}px;width:${percent}%;z-index:40;pointer-events:none;display:grid;place-content:center;background:repeating-linear-gradient(135deg,var(--background) 0 6px,color-mix(in srgb,var(--muted-foreground) 35%,var(--background)) 6px 12px)`;
      const label = document.createElement("span");
      label.style.cssText =
        "padding:2px 4px;border-radius:4px;background:var(--background);color:var(--foreground);font-size:11px;white-space:nowrap";
      label.textContent = text;
      hatch.appendChild(label);
      if (getComputedStyle(plot).position === "static")
        plot.style.position = "relative";
      plot.appendChild(hatch);
    },
    { percent, text },
  );

test("run opening, before: the unchanged base", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await holdSubscription(page);
  await openRun(page, "overall");
  await expect(page.getByText("Loading execution history…")).toBeVisible();
  // The header's status badge is a separate read; wait so the pair differs only by the line.
  await expect(page.getByText(/^active$/i).first()).toBeVisible();
  await page.waitForTimeout(1000);
  await shot(page, "run-opening-before");
});

test("run opening, after: the Graph view at once, and a quiet line", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await delayGraphMeasurements(page);
  await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
  await page.goto(`/?run=${runs().live}&view=graph`);
  await expect(graphNodes(page, "running").first()).toBeVisible();
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const line = document.createElement("p");
    line.setAttribute("role", "status");
    line.style.cssText =
      "position:fixed;right:24px;bottom:16px;z-index:40;margin:0;color:var(--muted-foreground);font-size:12px";
    line.textContent = "The rest of this run's history is still loading";
    document.body.appendChild(line);
  });
  await shot(page, "run-opening-after");
});

test("read failed: what failed, and Try again, at phone width", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.route(SUBSCRIPTIONS, (route) =>
    route.fulfill({ status: 524, body: "" }),
  );
  await openRun(page, "overall");
  await page.waitForTimeout(1500);
  // The base's own banner names no read and offers no way back; the mock's panel does.
  await page.evaluate(() => {
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      if (alert.textContent?.includes("Live telemetry issue")) alert.remove();
    }
    // The same read feeds the project list, so it must not keep saying it is loading.
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length === 0 && el.textContent === "Loading projects…")
        el.textContent = "Projects did not load";
    }
  });
  await setLoadingPanel(
    page,
    `<div role="alert" style="display:grid;gap:12px;justify-items:center;max-width:320px;padding:0 16px;text-align:center">
      <strong style="color:var(--destructive);font-size:16px">This run's history did not load</strong>
      <p style="color:var(--foreground);font-size:14px;margin:0">
        The read of its history got no answer within 90 seconds, so nothing here is up to date.
      </p>
      <button type="button" style="min-height:44px;padding:0 20px;border-radius:6px;background:var(--primary);color:var(--primary-foreground);font-size:14px;font-weight:500">
        Try again
      </button>
    </div>`,
  );
  await shot(page, "read-failed");
});

test("partial history: the whole run's values, and a timeline still filling", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openRun(page, "overall");
  const timeline = page.getByRole("region", { name: "Graph timeline" });
  await expect(timeline).toBeVisible();
  await page.waitForTimeout(2000);
  await page
    .getByRole("group", { name: "Turns", exact: true })
    .evaluate((tile) => {
      const value = Array.from(tile.querySelectorAll("*")).find(
        (node) => node.children.length === 0 && /^[0-9]+$/.test(node.textContent ?? ""),
      );
      if (!value) throw new Error("no turns value");
      value.textContent = "Loading…";
      (value as HTMLElement).style.color = "var(--muted-foreground)";
    });
  await hatchPlot(timeline, { percent: 60, text: "Still loading" });
  await shot(page, "partial-history");
});

test("node timeline: latest rows, with earlier ones on demand, at phone width", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
  await page.goto(`/?run=${runs().live}&node=dashboard`);
  const plot = page.getByRole("region", { name: "Node timeline" });
  const transcript = page.getByRole("region", { name: "Node transcript" });
  await expect(transcript.getByRole("article").first()).toBeVisible();
  await page.waitForTimeout(2000);
  // Two cuts so the transcript fits under the plot at this height, both stated in the
  // report: the plot's legend and zoom row, and the node's turn counts, which would
  // otherwise state a number the page does not hold yet.
  await plot.evaluate((el) => {
    let row: Element | null | undefined = Array.from(
      el.querySelectorAll("*"),
    ).find((n) => n.textContent?.trim() === "Queued");
    while (row?.parentElement && !row.parentElement.querySelector('[aria-label^="Timeline plot"]'))
      row = row.parentElement;
    (row as HTMLElement).style.display = "none";
  });
  await page.evaluate(() => {
    const meta = document.querySelector(".node-view-meta");
    if (meta) meta.textContent = "agent node · turns still loading";
  });
  await hatchPlot(plot, { percent: 55, text: "Still loading" });
  await transcript.evaluate((el) => {
    // The latest rows only, and no dispatch left standing with none of its rows.
    const rows = Array.from(el.querySelectorAll(".transcript-item"));
    for (const old of rows.slice(0, -4)) old.remove();
    for (const old of el.querySelectorAll(".transcript-collapsed")) old.remove();
    for (const dispatch of el.querySelectorAll(".transcript-dispatch"))
      if (!dispatch.querySelector(".transcript-item")) dispatch.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Load earlier rows";
    button.style.cssText =
      "display:block;width:100%;min-height:44px;margin:0 0 12px;border:1px solid var(--border);border-radius:6px;background:var(--secondary);color:var(--foreground);font-size:14px;font-weight:500";
    el.prepend(button);
    el.scrollTop = 0;
  });
  await shot(page, "node-timeline-earlier-rows");
});
