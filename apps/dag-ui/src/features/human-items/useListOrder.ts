import {
  DEFAULT_GROUP_BY,
  DEFAULT_SORT,
  GROUP_CHOICES,
  type GroupBy,
  oneOf,
  SORT_CHOICES,
  type SortOrder,
} from "./human-items-model";
import { useRemembered } from "./useRemembered";

/** Where this browser remembers what Action items is grouped by. */
export const GROUP_BY_KEY = "onepipeline-ui.human-items.group-by";
/** Where this browser remembers how Action items is sorted. */
export const SORT_KEY = "onepipeline-ui.human-items.sort";

const groupByOf = (stored: string) => oneOf(GROUP_CHOICES, stored);
const sortOf = (stored: string) => oneOf(SORT_CHOICES, stored);

/**
 * What the list is grouped by and how each group is sorted, remembered per
 * browser: Priority and the engine's order until a reader chooses otherwise,
 * and that choice on every later visit.
 */
export function useListOrder() {
  const [groupBy, setGroupBy] = useRemembered<GroupBy>(
    GROUP_BY_KEY,
    groupByOf,
    DEFAULT_GROUP_BY,
  );
  const [sort, setSort] = useRemembered<SortOrder>(
    SORT_KEY,
    sortOf,
    DEFAULT_SORT,
  );
  return { groupBy, setGroupBy, sort, setSort };
}
