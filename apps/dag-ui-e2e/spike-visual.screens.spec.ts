// THROWAWAY: spike-visual mock for dag-ui-panel-cursor-action-items-2026-11-19.
// Nothing here lands. Each surface is shot twice at the same viewport:
//   "before" — the unchanged base app over the fixture runs root, plus the spike's own
//              fixture records (fixtures/runs.mjs) where the base fixture lacked the state;
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

/**
 * After only: the fix mocked. The unchanged base server answers this dispatch's span
 * page (`?span=harness.<id>`) with "no such span", so the base app shows its own
 * HistoryFailed line; the plan stops asking for that page, so the line is gone.
 */
async function hideNoSuchSpan(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("[role=alert], p, div")))
      if (el.children.length < 4 && /^Earlier rows did not load: no such span/.test(el.textContent ?? "")) (el as HTMLElement).style.display = "none";
  });
}

/** Overall on the live run, with its observer's oneharness dispatch (span harness.<id>) opened. */
async function openObserverDispatch(page: Page, mode: Mode): Promise<void> {
  await visit(page, `/?run=${runs().live}&view=overall`);
  const graph = page.getByRole("region", { name: "Graph timeline", exact: true });
  await graph.getByRole("button", { name: "Expand timeline" }).click();
  const runLevel = page.getByRole("region", { name: "Run-level timeline", exact: true });
  await runLevel.getByRole("button", { name: "Expand timeline" }).click();
  await runLevel.getByRole("button", { name: /^Run-level · observer/ }).first().click();
  await expect(page.getByRole("region", { name: "Timeline item detail" })).toContainText("Oneharness conversation");
  // The base's own error, unaided: the fixture server knows no such span.
  await expect(page.getByText(/Earlier rows did not load: no such span: harness\./).first()).toBeVisible();
  await quiet(page);
  if (mode === "after") {
    await hideNoSuchSpan(page);
    await expect(page.getByText(/no such span/).filter({ visible: true })).toHaveCount(0);
  }
}

const css = (page: Page, content: string) => page.addStyleTag({ content });

const SURFACES: Surface[] = [
  {
    name: "s1-observer-panel-closed",
    open: async (page, mode) => {
      await openObserverDispatch(page, mode);
      await page.getByRole("button", { name: "Close detail" }).click();
      await quiet(page);
      if (mode === "after") await hideNoSuchSpan(page);
    },
  },
  {
    name: "s1-observer-panel-open",
    open: async (page, mode) => {
      await openObserverDispatch(page, mode);
    },
  },
  {
    name: "s2-conversation-item",
    open: async (page, mode) => {
      // The transcripts corpus: a narrating worker read whole off a real recorded
      // history file, whose turn carries the usage-limit message (fixtures/runs.mjs).
      server = await startFixtureServer("spike-transcripts", ["--transcripts-corpus"]);
      await visit(page, `${server.origin}/?run=dag-ui-transcripts&node=narrated`);
      await expect(page.getByRole("region", { name: "Timeline for narrated" })).toBeVisible();
      await quiet(page);
      await page
        .getByRole("region", { name: "Node transcript" })
        .getByRole("button", { name: /weekly limit/ })
        .first()
        .click();
      const detail = page.getByRole("region", { name: "Timeline item detail" });
      await expect(detail.getByRole("article", { name: /^Turn .* from / })).toBeVisible();
      await quiet(page);
      if (mode === "before") {
        // The base's two stacked views in one frame: the conversation's end above the
        // field/value block it draws under it.
        await page.evaluate(() =>
          document.querySelector('section[aria-label="Recorded fields"]')?.scrollIntoView({ block: "end" }),
        );
      }
      if (mode === "after") {
        await page.evaluate(() => {
          const detail = document.querySelector('[aria-label="Timeline item detail"]');
          if (!detail) return;
          // One view: no field/value block and no Recorded fields heading at all.
          for (const el of Array.from(detail.querySelectorAll("h3, h4, dl, section"))) {
            if (/^Recorded fields$/i.test(el.textContent?.trim() ?? "")) {
              (el as HTMLElement).style.display = "none";
              const next = el.nextElementSibling as HTMLElement | null;
              if (next && next.tagName === "DL") next.style.display = "none";
            }
          }
          for (const el of Array.from(detail.querySelectorAll('section[aria-label="Recorded fields"], dl.record-fields, [data-fields]')))
            (el as HTMLElement).style.display = "none";
          // The opened item, in the real conversation view: the smallest element
          // holding its words, widened to its message group.
          const holders = Array.from(detail.querySelectorAll("article *")).filter(
            (el) => /weekly limit/.test(el.textContent ?? "") && !Array.from(el.children).some((c) => /weekly limit/.test(c.textContent ?? "")),
          );
          const leaf = holders[0] as HTMLElement | undefined;
          const target = (leaf?.closest('[role="group"]') as HTMLElement | null) ?? leaf;
          if (!target) return;
          // The DAG view's own selection accent: the selected event row's --primary
          // border, with a faint tint of the same accent behind it.
          target.style.outline = "1px solid var(--primary)";
          target.style.outlineOffset = "3px";
          target.style.borderRadius = "8px";
          target.style.background = "color-mix(in srgb, var(--primary) 8%, transparent)";
          target.setAttribute("aria-current", "true");
          target.scrollIntoView({ block: "center" });
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
        await css(page, '[aria-label="Timeline crosshair"]{stroke-width:2px!important;opacity:1!important;stroke:var(--primary)!important;border-color:var(--primary)!important;width:2px!important;background:var(--primary)!important}');
        await page.evaluate(([px, py]) => {
          const tip = document.createElement("div");
          tip.setAttribute("role", "tooltip");
          tip.style.cssText = `position:fixed;left:${px - 250}px;top:${py - 70}px;z-index:9999;background:#111827;border:1px solid var(--primary);color:#e5e7eb;font:12px/1.4 ui-sans-serif,system-ui;padding:6px 9px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.5);width:236px`;
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
      // The base draws its own Refused edits box from the live run's fixture
      // edit-rejected records (fixtures/runs.mjs); the after is the graph alone.
      const box = page.getByRole("region", { name: "Refused edits" });
      await expect(box).toBeVisible();
      if (mode === "after") await css(page, ".rejected-edits{display:none!important}");
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
    // Sort sits in the filter row immediately after Group by, as one more label-and-select
    // pair, so it takes that row's own label and select styling, baseline and spacing.
    const filters = document.querySelector("fieldset.human-items-filters");
    const groupSelect = filters?.querySelector<HTMLSelectElement>("select");
    const options = "<option>Default</option><option>Newest first</option><option>Oldest first</option>";
    if (filters && groupSelect) {
      const label = document.createElement("label");
      label.htmlFor = "spike-sort";
      label.textContent = "Sort";
      const select = groupSelect.cloneNode(false) as HTMLSelectElement;
      select.id = "spike-sort";
      select.innerHTML = options;
      groupSelect.insertAdjacentElement("afterend", label);
      label.insertAdjacentElement("afterend", select);
    }
    // At phone width the filters fold behind the Filters button; Sort sits beside that
    // button, as a copy of it (its class, styling and size) that reads the sort order.
    const toggle = document.querySelector<HTMLButtonElement>("button.human-items-filters-toggle");
    if (toggle && getComputedStyle(toggle).display !== "none") {
      const sortButton = toggle.cloneNode(true) as HTMLButtonElement;
      sortButton.removeAttribute("aria-controls");
      sortButton.removeAttribute("aria-expanded");
      sortButton.setAttribute("aria-label", "Sort: Default");
      sortButton.setAttribute("aria-haspopup", "listbox");
      sortButton.innerHTML =
        '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></svg>Sort: Default';
      sortButton.style.marginLeft = "0";
      toggle.insertAdjacentElement("afterend", sortButton);
    }
    const ages = ["Raised 3 min ago", "Raised 41 min ago", "Raised 2 h ago", "Raised yesterday, 16:20", "Raised Mon 11:05", "Raised Nov 12"];
    document.querySelectorAll('[aria-label="Action item list"] article').forEach((card, i) => {
      const h = card.querySelector("h2, h3, h4");
      const when = document.createElement("div");
      when.style.cssText = "font-size:11px;color:#9ca3af;margin-top:2px";
      when.textContent = ages[i % ages.length];
      h?.insertAdjacentElement("afterend", when);
      // More room inside a question card above its "Write an answer" field, exactly
      // enough that the gap above the field equals the card's own internal spacing;
      // spacing between cards and groups stays as on the base.
      const box = card.querySelector<HTMLElement>("textarea.human-item-answer");
      const meta = card.querySelector<HTMLElement>(".otg-card__meta");
      const description = meta?.nextElementSibling as HTMLElement | null | undefined;
      const above = box?.previousElementSibling as HTMLElement | null | undefined;
      if (box && meta && description && above) {
        // The Source line sits almost flush on its description (about 1px), so the
        // gap matched is the card's own padding, the larger of the two.
        const surface = card.querySelector<HTMLElement>(".otg-card__surface") ?? card;
        const inner = Math.max(
          description.getBoundingClientRect().top - meta.getBoundingClientRect().bottom,
          Number.parseFloat(getComputedStyle(surface).paddingTop) || 0,
        );
        const now = box.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
        const base = Number.parseFloat(getComputedStyle(box).marginTop) || 0;
        box.style.marginTop = `${Math.max(0, base + inner - now)}px`;
        box.dataset.spikeGap = `${inner.toFixed(1)}`;
      }
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
