// THROWAWAY: spike-visual mock for dag-ui-panel-cursor-action-items-2026-11-19.
// Nothing here lands. Each surface is shot twice at the same viewport:
//   "before" — the unchanged base app, with only fixture data the base fixture lacks
//              injected into the served API responses (page.route);
//   "after"  — the same, with the proposed change mocked by patching the page.
// Run it with `just spike-visual-screens` (scripts/visual-capture.sh filtered to this file).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CAPTURE_INSTANT_MS } from "./capture-clock";
import { startFixtureServer, type FixtureServer } from "./fixture-server";
import { runs } from "./fixture-facts";
import recorded from "./fixtures/timeline-recorded.json" with { type: "json" };

async function openRecordedOverall(page: Page): Promise<void> {
  await visit(page, `/?run=${recorded.run_id}&view=overall`);
  await page.getByRole("button", { name: "Load the run's own records" }).click();
  await page.getByRole("region", { name: "Run events" }).getByRole("button").first().waitFor();
  await quiet(page);
}
const runEvent = (page: Page) =>
  page.getByRole("region", { name: "Run events" }).getByRole("button").filter({ hasText: /monitor|observer|harness|dispatch/i }).or(page.getByRole("region", { name: "Run events" }).getByRole("button").first()).first();
import { FIXTURE_WORKSPACE } from "./playwright.config";
import { VIEWPORTS } from "./viewports";

const out = resolve(import.meta.dirname, "../..", process.env.SHOTS_OUT ?? "shots/local/spike-visual");
mkdirSync(out, { recursive: true });

type Mode = "before" | "after";
interface Surface {
  name: string;
  phone?: boolean;
  modes?: Mode[];
  open: (page: Page, mode: Mode) => Promise<void>;
}

const SPAN_ID = "harness.01JD7K3M9QXWV2R4T8YB6N5C0E";

async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("[data-first-screen]")).toHaveCount(0);
}
async function quiet(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
}
async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important}",
  });
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY) {
        a.currentTime = 0;
        a.pause();
      } else a.finish();
    }
  });
}

/** Before only: span pages of the observer's oneharness dispatch answer the base server's error. */
async function failSpanPages(page: Page): Promise<void> {
  await page.route((url) => /timeline/.test(url.pathname) && /span/.test(url.search), (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      json: { error: { code: "not_found", message: `no such span: ${SPAN_ID}` } },
    }),
  );
}

/** Fixture: a turn-activity item in the conversation reads the usage-limit notice. */
async function weeklyLimit(page: Page): Promise<void> {
  await page.route(/\/api\/v2\//, async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    const at = text.indexOf('"turn-activity"');
    const body =
      at < 0
        ? text
        : text.slice(0, at) +
          text.slice(at).replace(/"(text|message|content|summary)":"([^"\\]*)"/, (_all, key) => `"${key}":"You've hit your weekly limit · resets Mon 9:00 AM"`);
    await route.fulfill({ response, body });
  });
}

/** Fixture: the run's graph carries two refused edits (one by the planner, one by the monitor). */
async function refusedEdits(page: Page): Promise<void> {
  await page.route(/\/api\/v2\/runs\//, async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
    const json = await response.json();
    const edits = [
      {
        at: "2026-11-19T09:12:04Z",
        author: "planner",
        command: { op: "add-dependency", node: "dashboard", on: "foundation" },
        reason: "dashboard is already running; a dependency cannot be added to a node that has started",
      },
      {
        at: "2026-11-19T09:14:40Z",
        author: "monitor",
        command: { op: "redirect", node: "foundation", to: "reviewer" },
        reason: "foundation has settled; a settled node cannot be redirected",
      },
    ];
    const walk = (o: unknown): void => {
      if (o === null || typeof o !== "object") return;
      const rec = o as Record<string, unknown>;
      if ("plan" in rec && typeof rec.plan === "object") rec.rejected_edits = edits;
      for (const v of Object.values(rec)) walk(v);
    };
    walk(json);
    await route.fulfill({ response, json });
  });
}


/** Before only: the base's HistoryFailed line (its own markup and class), under the timeline and in the open panel. */
async function showNoSuchSpan(page: Page, inPanel: boolean): Promise<void> {
  await page.evaluate(([span, panel]) => {
    const failed = () => {
      const p = document.createElement("p");
      p.className = "page-failed";
      p.setAttribute("role", "alert");
      p.innerHTML = `<span>Earlier rows did not load: no such span: ${span}</span><button type="button">Try again</button>`;
      return p;
    };
    document.querySelector('[aria-label="Graph timeline"]')?.insertAdjacentElement("afterend", failed());
    if (panel) document.querySelector('aside[aria-label="Item detail panel"]')?.appendChild(failed());
  }, [SPAN_ID, inPanel] as const);
}

/** Before only: the base's RejectedEdits box (its own markup and class) over the nodes. */
async function showRefusedEdits(page: Page): Promise<void> {
  await page.evaluate(() => {
    const flow = document.querySelector('[aria-label="DAG execution graph"]');
    const section = document.createElement("section");
    section.className = "rejected-edits";
    section.setAttribute("aria-labelledby", "rejected-edits-title");
    const edits = [
      ["planner", "edit refused: add-dependency dashboard → foundation: dashboard is already running; a dependency cannot be added to a node that has started"],
      ["monitor", "edit refused: redirect foundation → reviewer: foundation has settled; a settled node cannot be redirected"],
    ];
    section.innerHTML = `<h2 id="rejected-edits-title">Refused edits</h2><ol>${edits.map(([a, r]) => `<li><span class="rejected-edit-what">${a}</span><span class="rejected-edit-reason">${r}</span></li>`).join("")}</ol>`;
    flow?.insertAdjacentElement("afterend", section);
  });
}

const css = (page: Page, content: string) => page.addStyleTag({ content });

const SURFACES: Surface[] = [
  {
    name: "s1-observer-panel-closed",
    open: async (page, mode) => {
      await openRecordedOverall(page);
      await runEvent(page).click();
      await page.getByRole("button", { name: "Close detail" }).click();
      await quiet(page);
      if (mode === "before") await showNoSuchSpan(page, false);
    },
  },
  {
    name: "s1-observer-panel-open",
    open: async (page, mode) => {
      await openRecordedOverall(page);
      await runEvent(page).click();
      await quiet(page);
      if (mode === "before") await showNoSuchSpan(page, true);
    },
  },
  {
    name: "s2-conversation-item",
    open: async (page, mode) => {
      await visit(page, `/?run=${runs().live}&node=dashboard`);
      await quiet(page);
      await page.getByRole("button", { name: /^turn-completed, marker/ }).first().click();
      await quiet(page);
      // Fixture words: the item is a turn-activity message reading the usage-limit notice.
      await page.evaluate(() => {
        const detail = document.querySelector('[aria-label="Timeline item detail"]');
        const turns = Array.from(detail?.querySelectorAll("article") ?? []);
        const t = turns[Math.min(2, turns.length - 1)];
        const p = t?.querySelector("p, pre, div:last-child");
        if (p) p.textContent = "You've hit your weekly limit · resets Mon 9:00 AM";
      });
      if (mode === "after") {
        await page.evaluate(() => {
          const detail = document.querySelector('[aria-label="Timeline item detail"]');
          if (!detail) return;
          for (const el of Array.from(detail.querySelectorAll("dl, table, [data-fields]"))) (el as HTMLElement).style.display = "none";
          const turns = Array.from(detail.querySelectorAll("article"));
          const target = turns.find((t) => /weekly limit/.test(t.textContent ?? "")) ?? turns[Math.min(3, turns.length - 1)];
          if (target) {
            (target as HTMLElement).style.outline = "2px solid #f5b942";
            (target as HTMLElement).style.background = "rgba(245,185,66,0.12)";
            target.scrollIntoView({ block: "center" });
          }
        });
      }
    },
  },
  {
    name: "s3-node-timeline-hover",
    open: async (page, mode) => {
      await visit(page, `/?run=${runs().live}&node=dashboard`);
      await quiet(page);
      const plot = page
        .getByRole("region", { name: "Node timeline" })
        .getByLabel("Timeline plot. Scroll to zoom or drag to select a range.");
      const box = await plot.boundingBox();
      if (!box) throw new Error("no plot");
      const x = Math.round(box.x + box.width * 0.96);
      const y = Math.round(box.y + box.height / 2);
      await page.mouse.move(x, y);
      await quiet(page);
      if (mode === "after") {
        await css(page, '[aria-label="Timeline crosshair"]{stroke-width:2px!important;opacity:1!important;stroke:#f5b942!important;border-color:#f5b942!important;width:2px!important;background:#f5b942!important}');
        await page.evaluate(([px, py]) => {
          const tip = document.createElement("div");
          tip.setAttribute("role", "tooltip");
          tip.style.cssText = `position:fixed;left:${px - 250}px;top:${py - 70}px;z-index:9999;background:#111827;border:1px solid #f5b942;color:#e5e7eb;font:12px/1.4 ui-sans-serif,system-ui;padding:6px 9px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.5);width:236px`;
          tip.innerHTML = "<b>verdict-recorded</b> · worker · judge<br>09:41:07 · 2.1 s after the last turn<br><span style='color:#9ca3af'>nearest marker · click to open</span>";
          document.body.appendChild(tip);
        }, [x, y]);
      }
    },
  },
  {
    name: "s4-graph",
    open: async (page, mode) => {
      await visit(page, `/?run=${runs().live}&view=graph`);
      await quiet(page);
      if (mode === "before") await showRefusedEdits(page);
    },
  },
  {
    name: "s5-refusal-rows",
    modes: ["after"],
    open: async (page) => {
      await openRecordedOverall(page);
      await page.evaluate(() => {
        const list = document.querySelector('[aria-label="Run events"]');
        const row = list?.querySelector("button");
        if (!row) return;
        const rows: [string, string][] = [
          ["Add dependency dashboard → foundation · by planner · not applied", "09:12:04"],
          ["Redirect foundation to reviewer · by monitor · not applied", "09:14:40"],
        ];
        for (const [text, at] of rows) {
          const clone = row.cloneNode(true) as HTMLElement;
          clone.innerHTML = `<span style="color:#f87171;font-weight:600;margin-right:8px">refused</span><span>${text}</span><span style="margin-left:auto;color:#9ca3af">${at}</span>`;
          clone.style.cssText += ";display:flex;width:100%;gap:4px;text-align:left";
          clone.dataset.spikeRefusal = "1";
          row.parentElement?.insertBefore(clone, row);
        }
      });
    },
  },
  {
    name: "s5-refusal-detail",
    modes: ["after"],
    open: async (page) => {
      await openRecordedOverall(page);
      await page.getByRole("region", { name: "Run events" }).getByRole("button").first().click();
      await quiet(page);
      await page.evaluate(() => {
        const detail = document.querySelector('[aria-label="Item detail panel"]');
        const body = detail?.querySelector('[aria-label="Timeline item detail"]') ?? detail?.lastElementChild;
        if (!body) return;
        const row = (k: string, v: string) => `<dt style="color:#9ca3af;font-size:12px;margin-top:10px">${k}</dt><dd style="margin:2px 0 0;font-size:13px;white-space:pre-wrap">${v}</dd>`;
        body.innerHTML = `<div style="padding:16px;color:#e5e7eb;font-family:ui-sans-serif,system-ui"><h2 style="font-size:15px;margin:0 0 4px">Refused edit · not applied</h2><p style="margin:0;color:#f87171;font-size:12px">The engine refused this edit; the run is unchanged.</p><dl style="margin:8px 0 0">${row("Author", "planner")}${row("Summary", "Add dependency dashboard → foundation")}${row("Node", "dashboard")}${row("Command", '<code style="font-size:12px;background:#1f2937;padding:6px;border-radius:4px;display:block">{ "op": "add-dependency", "node": "dashboard", "on": "foundation" }</code>')}${row("Reason", "dashboard is already running; a dependency cannot be added to a node that has started. Re-plan the dependency on a node that has not been dispatched, or wait for dashboard to settle and add a follow-up node instead.")}${row("At", "09:12:04")}</dl></div>`;
      });
    },
  },
  {
    name: "s6-action-items",
    phone: true,
    open: async (page, mode) => {
      await openActionItems(page, "realistic");
      if (mode === "after") await mockSortDatesSpacing(page);
    },
  },
  {
    name: "s7-dismiss-reason-toast",
    phone: true,
    open: async (page, mode) => {
      const list = await openActionItems(page, "realistic");
      const title = (await list.getByRole("article").first().getByRole("heading").first().textContent())?.trim() ?? "";
      await page.getByRole("button", { name: /^Dismiss: / }).first().click();
      const toast = page.getByRole("region", { name: "Action result" });
      await toast.getByRole("button", { name: /Add (reason|comment)/i }).click();
      await toast.getByRole("textbox").fill("Duplicate of the release-notes review; tracked there.");
      await toast.getByRole("button", { name: /^(Save|Send|Add)/i }).first().click();
      await expect(toast).toContainText(/saved/i);
      if (mode === "after") {
        await page.evaluate((t) => {
          const region = document.querySelector('[aria-label="Action result"]');
          const p = Array.from(region?.querySelectorAll("p, span, div") ?? []).find((e) => /saved/i.test(e.textContent ?? "") && e.children.length === 0);
          if (p) p.innerHTML = `Reason saved for “${t}”:<br><q style="color:#d1d5db">Duplicate of the release-notes review; tracked there.</q>`;
        }, title);
      }
      await toast.hover({ position: { x: 2, y: 2 } });
    },
  },
  {
    name: "s7-dismissed-card",
    phone: true,
    modes: ["after"],
    open: async (page) => {
      const list = await openActionItems(page, "realistic");
      await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[aria-label="Action item list"] article'));
        const card = cards[0] as HTMLElement | undefined;
        if (!card) return;
        for (const other of cards.slice(1)) (other as HTMLElement).style.display = "none";
        const heading = document.querySelector('[aria-label="Action item list"] h2, [aria-label="Action item list"] h3');
        if (heading) heading.textContent = "State: Dismissed";
        const buttons = Array.from(card.querySelectorAll("button"));
        const note = document.createElement("div");
        note.style.cssText = "margin:8px 0;padding:8px 10px;border-left:3px solid #9ca3af;background:rgba(156,163,175,.1);font-size:13px;color:#e5e7eb";
        note.innerHTML = "<b>Dismissed by you · 2 min ago</b><br>Reason: Duplicate of the release-notes review; tracked there.";
        (card.querySelector("h2, h3, h4") ?? card.firstElementChild)?.insertAdjacentElement("afterend", note);
        const keep = buttons[0];
        for (const b of buttons) if (b !== keep && /Dismiss|Complete|Answer|Send/.test(b.textContent ?? "")) b.style.display = "none";
        if (keep) keep.textContent = "Reopen";
        // A second card in the pending state of a pressed button.
        const pending = cards[1]?.cloneNode(true) as HTMLElement | undefined;
        if (pending) {
          pending.style.display = "";
          const pb = Array.from(pending.querySelectorAll("button")).find((b) => /Dismiss/.test(b.textContent ?? ""));
          if (pb) {
            pb.setAttribute("aria-busy", "true");
            pb.setAttribute("disabled", "");
            pb.style.opacity = "0.7";
            pb.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;margin-right:6px;vertical-align:-1px"></span>Dismissing…';
          }
          card.parentElement?.appendChild(pending);
        }
      });
      await expect(list).toBeVisible();
    },
  },
];

let server: FixtureServer | undefined;
async function openActionItems(page: Page, world: string) {
  server = await startFixtureServer(
    `spike-${world}`,
    ["--human-items-world", world],
    { DAG_UI_E2E_WORLD_TEMPLATES: join(FIXTURE_WORKSPACE, "human-items-worlds") },
    { samePath: true },
  );
  await visit(page, `${server.origin}/human-items`);
  const list = page.getByRole("region", { name: "Action item list" });
  await expect(list.getByRole("article").first()).toBeVisible();
  await quiet(page);
  return list;
}

async function mockSortDatesSpacing(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Sort, cloned from the page's own Group by control so it takes its styling, placed
    // before the filters so it shows at desktop and phone width alike.
    const filters = document.querySelector("fieldset.human-items-filters");
    const groupSelect = document.querySelector<HTMLSelectElement>("fieldset.human-items-filters select");
    const sort = document.createElement("div");
    sort.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;margin:0 8px 6px 0";
    const label = document.createElement("label");
    label.htmlFor = "spike-sort";
    label.textContent = "Sort";
    const select = (groupSelect?.cloneNode(false) as HTMLSelectElement | undefined) ?? document.createElement("select");
    select.id = "spike-sort";
    select.setAttribute("aria-label", "Sort");
    select.innerHTML = "<option>Default</option><option>Newest first</option><option>Oldest first</option>";
    sort.append(label, select);
    filters?.parentElement?.insertBefore(sort, filters);
    const ages = ["Raised 3 min ago", "Raised 41 min ago", "Raised 2 h ago", "Raised yesterday, 16:20", "Raised Mon 11:05", "Raised Nov 12"];
    document.querySelectorAll('[aria-label="Action item list"] article').forEach((card, i) => {
      const h = card.querySelector("h2, h3, h4");
      const when = document.createElement("div");
      when.style.cssText = "font-size:11px;color:#9ca3af;margin-top:2px";
      when.textContent = ages[i % ages.length];
      h?.insertAdjacentElement("afterend", when);
      const box = card.querySelector("textarea");
      if (box) ((box.closest("div") as HTMLElement) ?? box).style.marginTop = "14px";
    });
  });
}

for (const size of VIEWPORTS.filter((v) => v.name === "1440x900" || v.name === "390x844")) {
  test.describe(`spike at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
    });
    test.afterEach(async () => {
      await server?.stop();
      server = undefined;
    });
    for (const surface of SURFACES) {
      if (size.name === "390x844" && !surface.phone) continue;
      for (const mode of surface.modes ?? (["before", "after"] as Mode[])) {
        test(`${surface.name} ${mode}`, async ({ page }) => {
          await surface.open(page, mode);
          await settle(page);
          await quiet(page);
          const base = `${surface.name}-${mode}-${size.name}`;
          writeFileSync(join(out, `${base}.html`), await page.locator("body").innerHTML());
          await page.screenshot({ path: join(out, `${base}.png`), animations: "disabled" });
        });
      }
    }
  });
}
