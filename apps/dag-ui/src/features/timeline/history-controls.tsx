import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { STILL_LOADING_TEXT } from "../../lib/loading";
import type { HistoryFailure } from "./useTimelineHistory";

/** Says a page of history failed, naming what failed, with Try again beside it. */
export function HistoryFailed({
  failure,
}: {
  readonly failure: HistoryFailure;
}) {
  return (
    <p className="page-failed" role="alert">
      <span>Earlier rows did not load: {failure.message}</span>
      <button onClick={failure.retry} type="button">
        Try again
      </button>
    </p>
  );
}

export function LoadEarlier({
  failure,
  loading,
  onLoad,
}: {
  readonly failure?: HistoryFailure;
  readonly loading: boolean;
  readonly onLoad: () => void;
}) {
  if (failure !== undefined) return <HistoryFailed failure={failure} />;
  return (
    <button
      className="load-earlier"
      disabled={loading}
      onClick={onLoad}
      type="button"
    >
      {loading ? "Loading earlier rows…" : "Load earlier rows"}
    </button>
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
  range,
  stretches,
}: {
  /** What holds the plot. */
  readonly container: { readonly current: HTMLElement | null };
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
        <span className="history-hatch-label">{STILL_LOADING_TEXT}</span>
      </span>
    )),
    plot,
  );
}
