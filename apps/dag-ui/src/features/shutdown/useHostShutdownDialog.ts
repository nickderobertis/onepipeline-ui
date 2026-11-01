import type {
  HostShutdownScope,
  RunList,
  RunSummary,
} from "@onepipeline-ui/dag-model";
import { useEffect, useRef, useState } from "react";
import { runsInScope, type ScopedRun } from "./shutdown-model";

/** Name every host run from the whole listing before enabling confirmation. */
export function useHostShutdownDialog(
  list: RunList | undefined,
  loadMore: () => Promise<void>,
  loadingMore: boolean,
): {
  readonly open?: HostShutdownScope;
  readonly setOpen: (scope: HostShutdownScope | undefined) => void;
  readonly opener: (scope: HostShutdownScope) => () => void;
  readonly runs?: readonly ScopedRun[];
  readonly blocked?: string;
  readonly unreadable: number;
} {
  const [open, setOpen] = useState<HostShutdownScope>();
  const whole = useWholeListing(
    open !== undefined,
    list,
    loadMore,
    loadingMore,
  );
  const runs =
    whole.rows === undefined || open === undefined
      ? undefined
      : runsInScope(whole.rows);
  const opener = (scope: HostShutdownScope) => () => setOpen(scope);
  return {
    open,
    setOpen,
    opener,
    runs,
    blocked: whole.blocked,
    unreadable: list?.unreadable?.length ?? 0,
  };
}

/**
 * The listing, read to its end while a dialog is open, or why it is not yet.
 *
 * Each page is asked for once per opening: a page that fails leaves the dialog
 * saying the listing could not be read whole, rather than asking again for as
 * long as it is open.
 */
function useWholeListing(
  active: boolean,
  list: RunList | undefined,
  loadMore: () => Promise<void>,
  loadingMore: boolean,
): { readonly rows?: readonly RunSummary[]; readonly blocked?: string } {
  const asked = useRef(new Set<string>());
  const cursor = list?.next_cursor;
  useEffect(() => {
    if (!active) {
      asked.current.clear();
      return;
    }
    if (cursor === undefined || loadingMore || asked.current.has(cursor))
      return;
    asked.current.add(cursor);
    void loadMore();
  }, [active, cursor, loadingMore, loadMore]);
  if (list === undefined)
    return { blocked: "Reading the runs listing this view holds…" };
  if (cursor === undefined) return { rows: list.runs };
  if (!loadingMore && asked.current.has(cursor))
    return {
      blocked: `The rest of the runs listing could not be read (${list.runs.length} runs read), so the runs this acts on cannot all be named. Close this and try again.`,
    };
  return {
    blocked: `Reading the rest of the runs listing so every run this acts on can be named (${list.runs.length} read so far)…`,
  };
}
