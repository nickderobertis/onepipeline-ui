import type { Page } from "@playwright/test";

/**
 * What the detail drawer showed on one sample: which views were drawn, and where
 * the one marked item of its conversation stood, in viewport pixels.
 */
export interface FocusFrame {
  /** `frame` for a sample taken once a frame was painted; `mutation` between frames. */
  readonly source: "frame" | "mutation";
  readonly at: number;
  readonly drawer: boolean;
  /** An event heading, its "Event" badge, or a field list: the view that must never show. */
  readonly eventView: boolean;
  /** The conversation view: a session's own header, or a harness record's. */
  readonly conversation: boolean;
  /** The view's header and its placeholder, while the transcript is read. */
  readonly placeholder: boolean;
  /** A transcript turn, or the note standing in one's place, is drawn. */
  readonly loaded: boolean;
  /** How many elements of the conversation carry `aria-current="true"`. */
  readonly marked: number;
  readonly mark?: {
    readonly turn?: string;
    readonly part?: string;
    readonly eventIndex?: string;
    readonly toolCallId?: string;
    readonly note?: string;
    readonly top: number;
    readonly bottom: number;
    /** Whether a tap at the middle of its top edge lands on it, on this frame. */
    readonly hit: boolean;
    /** Whether it is drawn open: not closed, and any disclosure inside it expanded. */
    readonly open: boolean;
  };
  /** The drawer's scroll viewport, and the pinned card's bottom edge within it. */
  readonly viewport?: { readonly top: number; readonly bottom: number };
  readonly cardBottom?: number;
}

/**
 * The conversation's marked item: `aria-current` on a turn or inside one, outside
 * the pinned card, whose plot marks the opened turn's bar the same way.
 */
export const MARKED =
  '[data-turn-id][aria-current="true"]:not(.conversation-timeline-sticky *), [data-turn-id] [aria-current="true"]:not(.conversation-timeline-sticky *)';

declare global {
  interface Window {
    __focusFrames?: FocusFrame[];
    __focusStop?: boolean;
  }
}

/**
 * Sample the detail drawer on every mutation and on every animation frame, from
 * now until {@link stopRecording}: a view drawn for one frame and replaced the next
 * is still seen, and the frames say where the marked item was painted.
 */
export async function startRecording(page: Page): Promise<void> {
  await page.evaluate((MARKED) => {
    window.__focusFrames = [];
    window.__focusStop = false;
    // llmlint: ignore-block[e2e_uses_accessible_selectors] this runs inside the page on every frame and mutation, where Playwright's role locators do not exist; each selector is the drawer's own region, the package's own marks (`aria-current`, `data-turn-id`, `data-turn-part`, `data-event-index`, `data-tool-call-id`), or the class of a view the criterion names.
    const sample = (source: "frame" | "mutation") => {
      const drawer = document.querySelector<HTMLElement>(
        '[aria-label="Timeline item detail"]',
      );
      if (drawer === null) {
        window.__focusFrames?.push({
          source,
          at: performance.now(),
          drawer: false,
          eventView: false,
          conversation: false,
          placeholder: false,
          loaded: false,
          marked: 0,
        });
        return;
      }
      const badges = [...drawer.querySelectorAll('[data-slot="badge"]')];
      const eventView =
        drawer.querySelector(".detail-title") !== null ||
        badges.some((badge) => badge.textContent?.trim() === "Event") ||
        drawer.querySelector(
          '[aria-label="Recorded fields"], dl.record-fields',
        ) !== null;
      const harness = [...drawer.querySelectorAll("h3")].some(
        (heading) => heading.textContent === "Oneharness conversation",
      );
      const conversation =
        drawer.querySelector(".transcript-header") !== null || harness;
      const marked = [...drawer.querySelectorAll<HTMLElement>(MARKED)];
      const one = marked.length === 1 ? marked[0] : undefined;
      const viewport = drawer
        .querySelector('[data-slot="scroll-area-viewport"]')
        ?.getBoundingClientRect();
      const card = drawer
        .querySelector(
          ".conversation-timeline-sticky:not(.conversation-timeline-placeholder)",
        )
        ?.getBoundingClientRect();
      const box = one?.getBoundingClientRect();
      const tapped =
        box === undefined
          ? null
          : document.elementFromPoint(box.left + box.width / 2, box.top + 2);
      window.__focusFrames?.push({
        source,
        at: performance.now(),
        drawer: true,
        eventView,
        conversation,
        placeholder:
          drawer.querySelector(".conversation-loading") !== null ||
          (harness &&
            (drawer.textContent ?? "").includes("Loading conversation")),
        loaded: drawer.querySelector("[data-turn-id]") !== null,
        marked: marked.length,
        ...(one === undefined || box === undefined
          ? {}
          : {
              mark: {
                turn: one.closest<HTMLElement>("[data-turn-id]")?.dataset
                  .turnId,
                part: one.dataset.turnPart,
                eventIndex: one.dataset.eventIndex,
                toolCallId: one.dataset.toolCallId,
                note:
                  one.getAttribute("role") === "note"
                    ? (one.textContent ?? "")
                    : undefined,
                top: box.top,
                bottom: box.bottom,
                hit: tapped !== null && one.contains(tapped),
                open:
                  one.getAttribute("data-state") !== "closed" &&
                  (one.querySelector('[aria-expanded="false"]') === null ||
                    one.querySelector('[aria-expanded="true"]') !== null),
              },
            }),
        ...(viewport === undefined
          ? {}
          : { viewport: { top: viewport.top, bottom: viewport.bottom } }),
        ...(card === undefined ? {} : { cardBottom: card.bottom }),
      });
    };
    // llmlint: ignore-end[e2e_uses_accessible_selectors]
    new MutationObserver(() => {
      if (!window.__focusStop) sample("mutation");
    }).observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    // A frame's own callback runs before its layout and before the resize pass
    // that re-places a focused item, so what it reads is not what is painted: the
    // sample is taken in a task queued from it, which runs once the frame is.
    const painted = new MessageChannel();
    painted.port1.onmessage = () => {
      if (!window.__focusStop) sample("frame");
    };
    const frame = () => {
      if (window.__focusStop) return;
      painted.port2.postMessage(null);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, MARKED);
}

/** Every sample since {@link startRecording}. */
export async function recorded(page: Page): Promise<FocusFrame[]> {
  return page.evaluate(() => [...(window.__focusFrames ?? [])]);
}

/** Stop sampling, and return every sample taken. */
export async function stopRecording(page: Page): Promise<FocusFrame[]> {
  return page.evaluate(() => {
    window.__focusStop = true;
    return [...(window.__focusFrames ?? [])];
  });
}
