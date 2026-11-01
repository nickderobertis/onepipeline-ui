import { Button } from "@oneharness/ui";
import type { HostShutdownScope, RunList } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { Power } from "lucide-react";
import { useCallback } from "react";
import { ShutdownDialog } from "./ShutdownDialog";
import { useHostShutdownDialog } from "./useHostShutdownDialog";
import { type Shutdown, useShutdown } from "./useShutdown";

const HOST_SCOPES: readonly HostShutdownScope[] = ["host"];

/** The host shutdown, held while the reader navigates. */
export function useHostShutdowns(client: TelemetryClient): {
  readonly host: Shutdown;
} {
  return {
    host: useShutdown(
      "host",
      useCallback((options) => client.shutdown("host", options), [client]),
    ),
  };
}

/**
 * The listing's host shutdown control.
 *
 * Each dialog names the runs off the listing this view holds, read whole first
 * — a listing still paged would name some of what the engine is about to act on
 * — so the dialog names every run on the host before it can be confirmed.
 */
export function HostShutdownButtons({
  list,
  loadMore,
  loadingMore,
  shutdowns,
}: {
  readonly list?: RunList;
  readonly loadMore: () => Promise<void>;
  readonly loadingMore: boolean;
  readonly shutdowns: { readonly host: Shutdown };
}) {
  const { open, setOpen, opener, runs, blocked, unreadable } =
    useHostShutdownDialog(list, loadMore, loadingMore);
  const busy = shutdowns.host.state.phase === "sending";
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
          onClick={opener("host")}
          size="sm"
          type="button"
          variant="destructive"
        >
          <Power size={14} /> Shut down the entire host
        </Button>
      </div>
      {HOST_SCOPES.map((scope) => (
        <ShutdownDialog
          blocked={blocked}
          key={scope}
          onConfirm={(grace, force) =>
            runs !== undefined && shutdowns.host.confirm(runs, grace, force)
          }
          onOpenChange={(next) => setOpen(next ? scope : undefined)}
          open={open === scope}
          runs={open === scope ? runs : undefined}
          unreadable={unreadable}
        />
      ))}
    </fieldset>
  );
}
