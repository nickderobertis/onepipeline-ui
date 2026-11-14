/**
 * The rest of a run arriving on an opened page, as the read-latency measurement
 * reads it: the frames the page's stream receives, the detail's `progress` as the
 * server last published it, and the check that the page drawing no loading value
 * is only the rest arriving when the server also said `complete` and named no
 * failure.
 */
import {
  type Progress,
  patchOpSchema,
  progressSchema,
} from "@onepipeline-ui/dag-model";
import type { BrowserContext, Page } from "@playwright/test";
import { z } from "zod";

/** What a listener on one page's stream has heard. */
export interface RestListener {
  /** The detail's `progress` as the patches the page applied left it. */
  readonly served: () => Progress | undefined;
  /** The bytes of every `detail.patch` and `timeline.patch` frame received. */
  readonly framesBytes: () => number;
}

/**
 * Listen on `page`'s event streams from now on. A frame received before this is
 * never heard, so a measurement attaches it before the page navigates: a small
 * run's rest is published within moments of its first answer.
 */
export async function listenForRest(
  page: Page,
  context: BrowserContext,
): Promise<RestListener> {
  let framesBytes = 0;
  let served: Progress | undefined;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    if (
      event.eventName === "detail.patch" ||
      event.eventName === "timeline.patch"
    )
      framesBytes += Buffer.byteLength(event.data);
    if (event.eventName === "detail.patch")
      served = progressPatched(served, event.data);
  });
  return { served: () => served, framesBytes: () => framesBytes };
}

/**
 * When, on the page's own clock, `page` stopped saying it is loading any of the
 * rest — no quiet line, and no Turns tile still reading Loading… — or `null` if it
 * still said so at the deadline. Throws where the page drew no loading value but
 * `listener` heard no `complete` progress, or heard a failure.
 */
export async function restArrivedAt(
  page: Page,
  view: string,
  listener: RestListener,
  deadlineMs = 600_000,
): Promise<number | null> {
  const arrivedAt = async (): Promise<number | null> =>
    z
      .number()
      .nullable()
      .parse(
        // llmlint: ignore-block[e2e_uses_accessible_selectors] this runs inside the page to stamp the moment the last loading value is gone with the page's own clock, where Playwright's role engine does not exist; the status line and the `Turns` group are read by the role and name the app gives them, and a locator awaited from outside would time the round trip rather than the render.
        await page.evaluate(() => {
          const quiet = [...document.querySelectorAll('[role="status"]')].some(
            (element) =>
              element.textContent?.includes(
                "The rest of this run's history is still loading",
              ),
          );
          const turns = [...document.querySelectorAll('[role="group"]')].find(
            (group) => group.getAttribute("aria-label") === "Turns",
          );
          const turnsLoading =
            turns?.querySelector("strong")?.textContent === "Loading…";
          return quiet || turnsLoading ? null : performance.now();
        }),
      );
  // llmlint: ignore-end[e2e_uses_accessible_selectors]
  let at: number | null = null;
  const deadline = Date.now() + deadlineMs;
  while (at === null && Date.now() < deadline) {
    at = await arrivedAt();
    if (at === null) await page.waitForTimeout(100);
  }
  const served = listener.served();
  if (at !== null && (served?.complete !== true || served.failed !== undefined))
    throw new Error(
      `${view} drew no loading value, but the server's progress was ${JSON.stringify(served)}`,
    );
  return at;
}

/**
 * `progress` after one `detail.patch` frame's ops: the whole member where an op
 * sets it, one of its fields where an op sets that.
 */
function progressPatched(
  progress: Progress | undefined,
  frame: string,
): Progress | undefined {
  const ops = z
    .object({ ops: z.array(patchOpSchema) })
    .parse(JSON.parse(frame)).ops;
  let next = progress;
  for (const op of ops) {
    const [member, field] = op.p;
    if (member !== "progress" || "a" in op) continue;
    if (field === undefined) {
      next = "v" in op ? progressSchema.parse(op.v) : undefined;
      continue;
    }
    if (typeof field !== "string") continue;
    // The first answer's progress came with the snapshot; a field patched over it
    // is read over "nothing known" rather than skipped.
    const kept: Record<string, unknown> = {
      ...(next ?? { complete: false, loading: [] }),
    };
    if ("v" in op) kept[field] = op.v;
    else delete kept[field];
    next = progressSchema.parse(kept);
  }
  return next;
}
