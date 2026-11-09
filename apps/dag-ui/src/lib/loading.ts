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
  const last = detail.run.last_event;
  if (asOf === undefined || last === undefined || last === null)
    return undefined;
  const lastAt = Date.parse(last);
  return Number.isFinite(lastAt) && lastAt > Date.parse(asOf)
    ? asOf
    : undefined;
}
