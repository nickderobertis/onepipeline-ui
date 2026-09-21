import type {
  HostShutdownScope,
  RunList,
  RunSummary,
  Unwatched,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useEffect, useRef, useState } from "react";
import { type Read, useRead } from "../../lib/useRead";
import {
  type ActingSession,
  runsInScope,
  type ScopedRun,
} from "./shutdown-model";

/**
 * The acting session as a dialog needs it, or why it cannot be had yet.
 *
 * Read off the unwatched report, which is the acting session's by definition;
 * a report carrying no key is an unattributed server, which owns nothing.
 */
export function actingOf(read: Read<Unwatched>): {
  readonly acting?: ActingSession;
  readonly blocked?: string;
} {
  if (read.value !== undefined)
    return { acting: read.value.session_key ?? null };
  if (read.error !== undefined)
    return {
      blocked: `Which session this server acts as could not be read (${read.error.message}), so the runs this acts on cannot be named. Nothing can be sent until they can.`,
    };
  return { blocked: "Reading which session this server acts as…" };
}

/**
 * Which of the listing's two dialogs is open, and what it names.
 *
 * Each opening reads the acting session afresh off the unwatched report and
 * reads the listing to its end, so the runs a dialog names are every run the
 * engine is about to act on, told apart by whose they are. `runs` is absent,
 * and `blocked` says why, until both are read.
 */
export function useHostShutdownDialog(
  client: TelemetryClient,
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
  //: Counted so every opening reads the acting session afresh.
  const [openings, setOpenings] = useState(0);
  const unwatched = useRead(
    open === undefined ? undefined : `acting-${openings}`,
    () => client.unwatched(),
    0,
  );
  const whole = useWholeListing(
    open !== undefined,
    list,
    loadMore,
    loadingMore,
  );
  const { acting, blocked } = actingOf(unwatched);
  const runs =
    acting === undefined || whole.rows === undefined || open === undefined
      ? undefined
      : runsInScope(open, whole.rows, acting);
  const opener = (scope: HostShutdownScope) => () => {
    setOpenings((count) => count + 1);
    setOpen(scope);
  };
  return {
    open,
    setOpen,
    opener,
    runs,
    blocked: blocked ?? whole.blocked,
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
