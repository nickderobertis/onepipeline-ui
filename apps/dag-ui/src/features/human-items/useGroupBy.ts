import { useCallback, useState } from "react";
import {
  DEFAULT_GROUP_BY,
  GROUP_CHOICES,
  type GroupBy,
  oneOf,
} from "./human-items-model";

/** Where this browser remembers what Action items is grouped by. */
export const GROUP_BY_KEY = "onepipeline-ui.human-items.group-by";

function remembered(): GroupBy {
  try {
    return (
      oneOf(GROUP_CHOICES, window.localStorage.getItem(GROUP_BY_KEY) ?? "") ??
      DEFAULT_GROUP_BY
    );
  } catch {
    // Storage this page may not read is no choice made.
    return DEFAULT_GROUP_BY;
  }
}

/**
 * What the list is grouped by, remembered per browser: Priority until a reader
 * chooses otherwise, and that choice on every later visit.
 */
export function useGroupBy() {
  const [groupBy, setHeld] = useState<GroupBy>(remembered);
  const setGroupBy = useCallback((next: GroupBy) => {
    setHeld(next);
    try {
      window.localStorage.setItem(GROUP_BY_KEY, next);
    } catch {
      // A browser that keeps nothing still groups this visit as asked.
    }
  }, []);
  return { groupBy, setGroupBy };
}
