/**
 * The words the page draws in place of a value it does not hold yet. One place, so
 * the first screen, the app and the journeys that read them say the same thing.
 */
import type { Progress } from "@onepipeline-ui/dag-model";

export const LOADING_TEXT = "Loading…";
export const STILL_LOADING_TEXT = "Still loading";
export const HISTORY_LOADING_TEXT =
  "The rest of this run's history is still loading";

/** Whether a member a payload leaves out means not yet known. */
export function loaded(progress: Progress | undefined): boolean {
  return progress?.complete !== false;
}
