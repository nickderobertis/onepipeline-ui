import { type RefObject, useLayoutEffect, useRef } from "react";

/** Long enough to see where a row went, short enough to be over before the next read. */
const TRAVEL_MS = 240;

/** The attribute naming a row across renders. */
export const ROW_KEY_ATTRIBUTE = "data-row-key";

/**
 * Rows that change order travel from where they were to where they are, so a
 * moved row reads as having moved rather than as something having gone wrong.
 *
 * Only a change of order moves anything: a project opening pushes the rows under
 * it without their having changed places. Positions are read against the list
 * itself, so scrolling it is no movement. A reader who asked for less motion gets
 * the rows in their new places.
 */
export function useRowMotion(
  list: RefObject<HTMLElement | null>,
  dependency: unknown,
): void {
  const positions = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `dependency` is not read here — it is what says the rows may have moved; the rows themselves are read off the list.
  useLayoutEffect(() => {
    const root = list.current;
    if (root === null) return;
    const origin = root.getBoundingClientRect().top;
    const rows = [
      ...root.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`),
    ];
    const now = new Map(
      rows.map((row): [string, number] => [
        row.getAttribute(ROW_KEY_ATTRIBUTE) ?? "",
        row.getBoundingClientRect().top - origin,
      ]),
    );
    // Rows come and go as a project opens or a kind is hidden; only those here
    // both times, in another order, have changed places.
    const before = [...positions.current.keys()].filter((key) => now.has(key));
    const after = [...now.keys()].filter((key) => positions.current.has(key));
    const reordered =
      before.join("\n") !== after.join("\n") &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reordered)
      for (const row of rows) {
        const was = positions.current.get(
          row.getAttribute(ROW_KEY_ATTRIBUTE) ?? "",
        );
        const is = now.get(row.getAttribute(ROW_KEY_ATTRIBUTE) ?? "");
        if (was === undefined || is === undefined || was === is) continue;
        row.animate(
          [
            { transform: `translateY(${was - is}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: TRAVEL_MS, easing: "ease-out" },
        );
      }
    positions.current = now;
  }, [list, dependency]);
}
