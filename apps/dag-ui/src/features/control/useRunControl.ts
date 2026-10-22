import type { RunStatus, Stopped } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback } from "react";
import { type Read, useRead } from "../../lib/useRead";

export interface RunControl {
  readonly status: Read<RunStatus>;
  readonly stop: (force: boolean) => Promise<Stopped>;
}

/**
 * The run's status, read once when the run is opened — its liveness and the
 * summary the run details show — and the stop verb. Nothing re-reads it on a
 * timer or on a change: what the run records reaches the page as pushed
 * patches, and the status is the one reading of how it is being driven.
 */
export function useRunControl(
  client: TelemetryClient,
  runId: string | undefined,
): RunControl {
  const status = useRead(runId, () => client.getStatus(runId ?? ""), 0);
  const stop = useCallback(
    (force: boolean) => client.stop(runId ?? "", force),
    [client, runId],
  );
  return { status, stop };
}
