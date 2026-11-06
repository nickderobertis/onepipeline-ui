import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CAPTURE_INSTANT_MS } from "./capture-clock";
import { runs } from "./fixture-facts";
import { PHONE, viewport } from "./viewports";

/**
 * THROWAWAY spike mock (spike-visual, dag-run-load-speed-2026-11-06). Never lands.
 *
 * The app under this is the unchanged base: a held or failed subscription read
 * is real, and everything new is markup injected into the page below. Every
 * figure in the injected text is a fixture string; nothing reads it from a run.
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

const SKELETON =
  '<div class="animate-pulse rounded-md bg-accent h-2 w-48"></div>' +
  '<div class="animate-pulse rounded-md bg-accent h-2 w-32"></div>';

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

test("run opening, after: skeleton beside a progress line", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await holdSubscription(page);
  await openRun(page, "overall");
  await expect(page.getByText("Loading execution history…")).toBeVisible();
  // The header's status badge is a separate read; wait so the pair differs only by the line.
  await expect(page.getByText(/^active$/i).first()).toBeVisible();
  await page.waitForTimeout(1000);
  await setLoadingPanel(
    page,
    `${SKELETON}
    <p role="status" style="margin-top:8px;color:var(--foreground);font-size:14px;text-align:center">
      Loading this run's history: 41,200 of 116,000 records (36 MB of 100 MB)
    </p>`,
  );
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

test("partial history: visible, and marked as still arriving", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openRun(page, "overall");
  const timeline = page.getByRole("region", { name: "Graph timeline" });
  await expect(timeline).toBeVisible();
  await page.waitForTimeout(2000);
  await timeline.evaluate((el) => {
    // Above the run's whole summary, because every figure below it is partial too.
    const card = Array.from(document.querySelectorAll("main *, section *"))
      .find((node) => node.textContent?.trim().toLowerCase() === "whole dag")
      ?.parentElement;
    const banner = document.createElement("p");
    banner.setAttribute("role", "status");
    banner.style.cssText =
      "margin:0 0 12px;padding:8px 16px;background:color-mix(in srgb,var(--primary) 18%,transparent);border-left:3px solid var(--primary);color:var(--foreground);font-size:14px;font-weight:500";
    banner.textContent =
      "Partial history: 41,200 of 116,000 records so far. Earlier events are still arriving, so this view is not complete.";
    const anchor = card ?? el;
    anchor.parentElement?.insertBefore(banner, anchor);
    // A count over partial history says so beside the number.
    for (const label of document.querySelectorAll("body *")) {
      if (
        label.children.length === 0 &&
        label.textContent?.trim().toLowerCase() === "turns"
      ) {
        const value = label.nextElementSibling;
        if (value) value.textContent = `${value.textContent} so far`;
      }
    }
    const plot = el.querySelector<HTMLElement>(
      '[aria-label^="Timeline plot"]',
    );
    if (plot) {
      const hatch = document.createElement("div");
      hatch.style.cssText =
        "position:absolute;inset:0 auto 0 0;width:35%;z-index:5;pointer-events:none;display:grid;place-content:center;background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--background) 92%,transparent) 0 6px,color-mix(in srgb,var(--muted-foreground) 35%,var(--background)) 6px 12px)";
      const label = document.createElement("span");
      label.style.cssText =
        "padding:2px 8px;border-radius:4px;background:var(--background);color:var(--foreground);font-size:12px";
      label.textContent = "Earlier events still loading";
      hatch.appendChild(label);
      if (getComputedStyle(plot).position === "static")
        plot.style.position = "relative";
      plot.appendChild(hatch);
    }
  });
  await shot(page, "partial-history");
});
