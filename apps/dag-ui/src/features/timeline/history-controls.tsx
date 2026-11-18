import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { STILL_LOADING_TEXT } from "../../lib/loading";
import type { HistoryFailure, NodeLoad } from "./useTimelineHistory";

/** Says a read of history failed, naming what failed, with Try again beside it. */
export function HistoryFailed({
  failure,
  what = "Earlier rows",
}: {
  readonly failure: HistoryFailure;
  /** What did not load, as the sentence opens. */
  readonly what?: string;
}) {
  return (
    <p className="page-failed" role="alert">
      <span>
        {what} did not load: {failure.message}
      </span>
      <button onClick={failure.retry} type="button">
        Try again
      </button>
    </p>
  );
}

/** The words a chart drawn from part of its node's records is marked with. */
export const PARTIAL_TEXT = "Partial — loading";

/**
 * Marks a node's chart as drawn from what has arrived so far, and says how much that
 * is, while the rest keeps loading.
 */
export function PartialMark({ load }: { readonly load: NodeLoad }) {
  const counted =
    load.total === undefined
      ? `${load.loaded.toLocaleString()} records loaded`
      : `${load.loaded.toLocaleString()} of ${load.total.toLocaleString()} records loaded`;
  return (
    <p className="partial-mark" role="status">
      <span className="partial-mark-label">{PARTIAL_TEXT}</span>
      <span className="partial-mark-count">{counted}</span>
    </p>
  );
}

/**
 * The plot `container` holds, once it is there. Until it is found it is looked for
 * after every render and whenever the container's contents change, and it is looked
 * for again if it is replaced, so a plot mounted after its container, or a container
 * mounted after this, still gets its overlay on the frame it appears.
 */
function usePlotElement(
  container: { readonly current: HTMLElement | null },
  wanted: boolean,
): HTMLElement | null {
  const [plot, setPlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (plot !== null && !plot.isConnected) setPlot(null);
  });
  // No dependency list: the container is a ref, whose filling no dependency sees.
  useLayoutEffect(() => {
    const root = container.current;
    if (!wanted || plot !== null || root === null) return;
    const look = (): boolean => {
      const found = root.querySelector<HTMLElement>(
        '[aria-label^="Timeline plot"]',
      );
      if (found === null) return false;
      if (getComputedStyle(found).position === "static")
        found.style.position = "relative";
      setPlot(found);
      return true;
    };
    if (look()) return;
    const observer = new MutationObserver(() => {
      if (look()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  });
  return plot;
}

/**
 * The stretches of a plot not held, hatched over it. Drawn inside the plot so the
 * percentages run along the axis the plot draws, and hatched opaque so nothing of the
 * rows either side shows through.
 */
export function PlotHatches({
  container,
  partial = false,
  range,
  stretches,
}: {
  /** What holds the plot. */
  readonly container: { readonly current: HTMLElement | null };
  /** The read has run past its delay, and the plot is drawn as partial. */
  readonly partial?: boolean;
  readonly range: readonly [number, number];
  readonly stretches: readonly (readonly [number, number])[];
}): ReactNode {
  const plot = usePlotElement(container, stretches.length > 0);
  if (plot === null) return null;
  const span = Math.max(range[1] - range[0], 1);
  const percent = (time: number) =>
    ((Math.min(Math.max(time, range[0]), range[1]) - range[0]) / span) * 100;
  return createPortal(
    stretches.map(([from, to]) => (
      <span
        className="history-hatch"
        data-from={from}
        data-to={to}
        key={`${from}-${to}`}
        style={{
          left: `${percent(from)}%`,
          width: `${percent(to) - percent(from)}%`,
        }}
      >
        <span className="history-hatch-label">
          {partial ? PARTIAL_TEXT : STILL_LOADING_TEXT}
        </span>
      </span>
    )),
    plot,
  );
}
