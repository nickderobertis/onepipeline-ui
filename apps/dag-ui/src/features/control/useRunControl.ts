import type { RunStatus, Stopped } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useState } from "react";
import { type Read, useRead } from "../../lib/useRead";

export interface RunControl {
  readonly status: Read<RunStatus>;
  readonly stop: (force: boolean) => Promise<Stopped>;
  /** Read the status again: the reader opened the run details. */
  readonly reread: () => void;
}

/**
 * The run's status — its liveness and the summary the run details show — and
 * the stop verb.
 *
 * The status is read when the run is opened, when the reader opens its details
 * and after a stop this page asked for, and never on a timer or on a change:
 * what the run records reaches the page as pushed patches, and the status is
 * the one reading of how it is being driven, which a reader asks for.
 */
export function useRunControl(
  client: TelemetryClient,
  runId: string | undefined,
): RunControl {
  const [revision, setRevision] = useState(0);
  const reread = useCallback(() => setRevision((current) => current + 1), []);
  const status = useRead(
    runId,
    () => client.getStatus(runId ?? ""),
    revision,
  );
  const stop = useCallback(
    async (force: boolean) => {
      try {
        return await client.stop(runId ?? "", force);
      } finally {
        reread();
      }
    },
    [client, runId, reread],
  );
  return { status, stop, reread };
}
