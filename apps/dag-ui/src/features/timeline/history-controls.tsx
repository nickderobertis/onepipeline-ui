import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { STILL_LOADING_TEXT } from "../../lib/loading";
import type { HistoryFailure } from "./useTimelineHistory";

/** The control beside a page's rows: it loads the next, or says the last failed. */
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
  const [plot, setPlot] = useState<HTMLElement | null>(null);
  const looked = useRef(false);
  useLayoutEffect(() => {
    if (stretches.length === 0 || looked.current) return;
    const found = container.current?.querySelector<HTMLElement>(
      '[aria-label^="Timeline plot"]',
    );
    if (found === null || found === undefined) return;
    if (getComputedStyle(found).position === "static")
      found.style.position = "relative";
    looked.current = true;
    setPlot(found);
  }, [container, stretches]);
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
