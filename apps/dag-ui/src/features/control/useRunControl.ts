import type { RunStatus, Stopped } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useState } from "react";
import { type Read, useRead } from "../../lib/useRead";

const STATUS_POLL_MS = 10_000;

export interface RunControl {
  readonly status: Read<RunStatus>;
  readonly stop: (force: boolean) => Promise<Stopped>;
}

/** Read process liveness periodically: a driver dying need not write a record. */
export function useRunControl(
  client: TelemetryClient,
  runId: string | undefined,
  invalidations: number,
): RunControl {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (runId === undefined) return;
    const timer = setInterval(
      () => setTicks((value) => value + 1),
      STATUS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [runId]);
  const status = useRead(
    runId,
    () => client.getStatus(runId ?? ""),
    invalidations + ticks,
  );
  const stop = useCallback(
    (force: boolean) => client.stop(runId ?? "", force),
    [client, runId],
  );
  return { status, stop };
}
