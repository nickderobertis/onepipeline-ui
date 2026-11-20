import type { Page } from "@playwright/test";

/**
 * What a journey asks never to have appeared, at any moment, rather than only at
 * the moments it looked: one CSS selector or one text, each named.
 */
export interface Watched {
  readonly [name: string]:
    | { readonly selector: string }
    | { readonly text: string };
}

declare global {
  interface Window {
    __domWatchSeen?: Record<string, boolean>;
  }
}

/**
 * Watch the page for `watched` from before its first script runs: every mutation
 * is checked, so something drawn for one frame and replaced the next is still seen.
 * Read back with {@link seen}.
 */
export async function watch(page: Page, watched: Watched): Promise<void> {
  await page.addInitScript((wanted: Watched) => {
    const seen: Record<string, boolean> = {};
    for (const name of Object.keys(wanted)) seen[name] = false;
    window.__domWatchSeen = seen;
    const look = () => {
      const body = document.body;
      if (body === null) return;
      for (const [name, what] of Object.entries(wanted)) {
        if (seen[name]) continue;
        // llmlint: ignore-block[e2e_uses_accessible_selectors] this runs inside the page as an init script on every DOM mutation, so a view painted for one frame is caught; Playwright's role and text locators do not exist there, and each selector is the calling journey's, which carries its own reason.
        seen[name] =
          "selector" in what
            ? document.querySelector(what.selector) !== null
            : (body.textContent ?? "").includes(what.text);
        // llmlint: ignore-end[e2e_uses_accessible_selectors]
      }
    };
    new MutationObserver(look).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, watched);
}

/** Which of the watched things have appeared since the page loaded. */
export async function seen(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => ({ ...(window.__domWatchSeen ?? {}) }));
}

/** Start watching afresh, from now. */
export async function resetSeen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = window.__domWatchSeen ?? {};
    for (const name of Object.keys(held)) held[name] = false;
  });
}
