import { useCallback, useRef } from "react";

/**
 * A ref for a pinned (`position: sticky`) element that keeps its height on its
 * parent as the CSS custom property `property`, re-measured whenever it resizes.
 *
 * A pinned header covers whatever scrolls to the top beneath it, and a scroll to an
 * item lands that item's top exactly there. Its siblings read the height as their
 * `scroll-margin-top`, so a scroll to one of them stops below the header instead —
 * whatever the header's height is at that moment, folded, expanded or wrapped.
 */
export function usePinnedHeight(
  property: string,
): (element: HTMLElement | null) => void {
  const observer = useRef<ResizeObserver | undefined>(undefined);
  return useCallback(
    (element: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = undefined;
      const scope = element?.parentElement;
      if (element === null || scope === null || scope === undefined) return;
      const report = () =>
        scope.style.setProperty(
          property,
          `${element.getBoundingClientRect().height}px`,
        );
      report();
      observer.current = new ResizeObserver(report);
      observer.current.observe(element);
    },
    [property],
  );
}
