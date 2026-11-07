import { type RefObject, useLayoutEffect, useRef } from "react";

/** How long a row takes to travel from where it was to where it is. */
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
  const order = useRef("");
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
    const next = [...now.keys()].join("\n");
    // The same rows in another order, or some gone or come: either way those
    // still here that changed places are the ones to move.
    const reordered =
      order.current !== "" &&
      order.current !== next &&
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
    order.current = next;
  }, [list, dependency]);
}
