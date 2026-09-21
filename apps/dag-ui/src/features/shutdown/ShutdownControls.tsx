import { Button } from "@oneharness/ui";
import type {
  HostShutdownScope,
  RunLaunch,
  RunList,
  RunSummary,
  Unwatched,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { Power } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Read, useRead } from "../../lib/useRead";
import { ShutdownDialog } from "./ShutdownDialog";
import {
  type ActingSession,
  runsInScope,
  type ScopedRun,
  scopedRun,
} from "./shutdown-model";
import { type Shutdown, useShutdown } from "./useShutdown";

/**
 * The acting session as a dialog needs it, or why it cannot be had yet.
 *
 * Read off the unwatched report, which is the acting session's by definition;
 * a report carrying no key is an unattributed server, which owns nothing.
 */
function actingOf(read: Read<Unwatched>): {
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
 * *Shut down this run*: the control beside Stop and Adopt, and its dialog.
 *
 * `launched` is what the view has read of the run — its row on the listing, or
 * its detail — and carries the launch its owner is named from; `unwatched` is
 * the acting session's report the header already holds.
 */
export function ShutdownRunButton({
  runId,
  launched,
  unwatched,
  shutdown,
}: {
  readonly runId: string;
  readonly launched?: { readonly launch?: RunLaunch };
  readonly unwatched: Read<Unwatched>;
  readonly shutdown: Shutdown;
}) {
  const [open, setOpen] = useState(false);
  const { acting, blocked } = actingOf(unwatched);
  const runs: ScopedRun[] | undefined =
    acting === undefined || launched === undefined
      ? undefined
      : [scopedRun(runId, launched.launch, acting)];
  return (
    <>
      <Button
        aria-label="Shut down this run"
        disabled={shutdown.state.phase === "sending"}
        onClick={() => setOpen(true)}
        size="sm"
        title="Shut down this run"
        type="button"
        variant="destructive"
      >
        <Power size={14} />
        <span className="run-action-label">Shut down</span>
      </Button>
      <ShutdownDialog
        blocked={
          blocked ??
          (launched === undefined
            ? `Reading who launched ${runId}…`
            : undefined)
        }
        onConfirm={(grace, force) =>
          runs !== undefined && shutdown.confirm(runs, grace, force)
        }
        onOpenChange={setOpen}
        open={open}
        runId={runId}
        runs={runs}
        scope="run"
      />
    </>
  );
}

/**
 * The run shutdown, wired to the route of the run on screen when it is
 * confirmed. Held above the run's own view, so a request that is out stays on
 * screen — and its control stays withheld — while the reader looks at another.
 */
export function useRunShutdown(
  client: TelemetryClient,
  runId: string | undefined,
): Shutdown {
  return useShutdown(
    "run",
    useCallback(
      (options) =>
        runId === undefined
          ? Promise.reject(new Error("No run is open to shut down"))
          : client.shutdownRun(runId, options),
      [client, runId],
    ),
  );
}

/** The session's and the host's shutdowns, each wired to the one route. */
export function useHostShutdowns(client: TelemetryClient): {
  readonly mine: Shutdown;
  readonly host: Shutdown;
} {
  return {
    mine: useShutdown(
      "mine",
      useCallback((options) => client.shutdown("mine", options), [client]),
    ),
    host: useShutdown(
      "host",
      useCallback((options) => client.shutdown("host", options), [client]),
    ),
  };
}

/**
 * The listing's own controls: *Shut down all my runs* and *Shut down the
 * entire host*.
 *
 * Each dialog names the runs off the listing this view holds, read whole first
 * — a listing still paged would name some of what the engine is about to act on
 * — and the acting session off a fresh unwatched report taken as it opens.
 */
export function HostShutdownButtons({
  client,
  list,
  loadMore,
  loadingMore,
  shutdowns,
}: {
  readonly client: TelemetryClient;
  readonly list?: RunList;
  readonly loadMore: () => Promise<void>;
  readonly loadingMore: boolean;
  readonly shutdowns: { readonly mine: Shutdown; readonly host: Shutdown };
}) {
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
  const unreadable = list?.unreadable ?? [];
  const opener = (scope: HostShutdownScope) => () => {
    setOpenings((count) => count + 1);
    setOpen(scope);
  };
  const busy =
    shutdowns.mine.state.phase === "sending" ||
    shutdowns.host.state.phase === "sending";
  return (
    <section aria-label="Host shutdown" className="host-shutdown">
      <p className="eyebrow">This host</p>
      <div className="host-shutdown-actions">
        <Button
          disabled={busy}
          onClick={opener("mine")}
          size="sm"
          type="button"
          variant="outline"
        >
          <Power size={14} /> Shut down all my runs
        </Button>
        <Button
          disabled={busy}
          onClick={opener("host")}
          size="sm"
          type="button"
          variant="destructive"
        >
          <Power size={14} /> Shut down the entire host
        </Button>
      </div>
      {(["mine", "host"] as const).map((scope) => (
        <ShutdownDialog
          blocked={blocked ?? whole.blocked}
          key={scope}
          onConfirm={(grace, force) =>
            runs !== undefined && shutdowns[scope].confirm(runs, grace, force)
          }
          onOpenChange={(next) => setOpen(next ? scope : undefined)}
          open={open === scope}
          runs={open === scope ? runs : undefined}
          scope={scope}
          unreadable={unreadable.length}
        />
      ))}
    </section>
  );
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
