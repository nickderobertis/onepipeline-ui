/**
 * The words the page draws in place of a value it does not hold yet. One place, so
 * the first screen, the app and the journeys that read them say the same thing.
 */
import type { LiveRunDetail, Progress } from "@onepipeline-ui/dag-model";

export const LOADING_TEXT = "Loading…";
export const STILL_LOADING_TEXT = "Still loading";
export const HISTORY_LOADING_TEXT =
  "The rest of this run's history is still loading";

/** Whether a member a payload leaves out means not yet known. */
export function loaded(progress: Progress | undefined): boolean {
  return progress?.complete !== false;
}

/** The run's `progress.loading` path is named, so its value is drawn as loading. */
export function loadingPath(detail: LiveRunDetail, path: string): boolean {
  return detail.progress?.loading.includes(path) === true;
}

/**
 * The time the fold behind `telemetry` was taken, while records have arrived since:
 * the moment the page labels "as of <time>, updating" beside what it read off it.
 */
export function staleFoldAsOf(detail: LiveRunDetail): string | undefined {
  const asOf = detail.telemetry?.as_of;
  if (asOf === undefined) return undefined;
  // `observed_at` moves with every record a frame carried; the fold does not.
  return Date.parse(detail.observed_at) > Date.parse(asOf) ? asOf : undefined;
}
