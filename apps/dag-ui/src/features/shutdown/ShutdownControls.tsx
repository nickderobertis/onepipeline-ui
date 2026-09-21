import { Button } from "@oneharness/ui";
import type { RunLaunch, RunList, Unwatched } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { Power } from "lucide-react";
import { useCallback, useState } from "react";
import type { Read } from "../../lib/useRead";
import { ShutdownDialog } from "./ShutdownDialog";
import { type ScopedRun, scopedRun } from "./shutdown-model";
import { actingOf, useHostShutdownDialog } from "./useHostShutdownDialog";
import { type Shutdown, useShutdown } from "./useShutdown";

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
  const { open, setOpen, opener, runs, blocked, unreadable } =
    useHostShutdownDialog(client, list, loadMore, loadingMore);
  const busy =
    shutdowns.mine.state.phase === "sending" ||
    shutdowns.host.state.phase === "sending";
  return (
    // A fieldset rather than a section: it sits in the runs navigation, whose
    // own sections are the listing's groups, and it is a group of controls
    // rather than a region of the page.
    <fieldset
      aria-label="Shut down runs on this host"
      className="host-shutdown"
    >
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
          blocked={blocked}
          key={scope}
          onConfirm={(grace, force) =>
            runs !== undefined && shutdowns[scope].confirm(runs, grace, force)
          }
          onOpenChange={(next) => setOpen(next ? scope : undefined)}
          open={open === scope}
          runs={open === scope ? runs : undefined}
          scope={scope}
          unreadable={unreadable}
        />
      ))}
    </fieldset>
  );
}
