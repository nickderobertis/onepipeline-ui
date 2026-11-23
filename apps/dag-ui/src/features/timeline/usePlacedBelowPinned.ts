import { type RefObject, useLayoutEffect } from "react";

/** Input that means the reader is scrolling for themselves, so placement lets go. */
const READER_SCROLL_EVENTS = [
  "keydown",
  "pointerdown",
  "touchstart",
  "wheel",
] as const;

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * Place `target`'s top below whatever is pinned over its scroll container, before
 * the frame that first shows it is painted, and keep it there while the content
 * around it settles — until `key` changes or the reader scrolls.
 *
 * The same placement `@oneharness/ui` gives a turn's focused item, for the one item
 * this app marks itself: the note standing in a turn's place. Its offset is the
 * element's own `scroll-margin-top`, which the stylesheet reads from
 * `--conversation-focus-offset`, so the note stands exactly where the turn's item
 * is placed when it replaces it.
 */
export function usePlacedBelowPinned(
  target: RefObject<HTMLElement | null>,
  key: string,
): void {
  useLayoutEffect(() => {
    const element = target.current;
    if (element === null || key === "") return;
    const scroller = scrollerOf(element);
    if (scroller === null) return;
    const drift = () => {
      const offset =
        Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      return element.getBoundingClientRect().top - (top + offset);
    };
    const place = () => {
      const distance = drift();
      if (Math.abs(distance) >= 0.5)
        scroller.scrollTo({
          behavior: "instant",
          top: scroller.scrollTop + distance,
        });
    };
    place();
    let held = true;
    const release = () => {
      held = false;
    };
    const observer = new ResizeObserver(() => {
      if (held) place();
    });
    for (const child of new Set([element, ...scroller.children]))
      observer.observe(child);
    for (const type of READER_SCROLL_EVENTS)
      scroller.addEventListener(type, release, { passive: true });
    return () => {
      observer.disconnect();
      for (const type of READER_SCROLL_EVENTS)
        scroller.removeEventListener(type, release);
    };
  }, [target, key]);
}
