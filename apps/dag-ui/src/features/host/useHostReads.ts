import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useState } from "react";
import { useRead } from "../../lib/useRead";

/** Explicit refresh is the only invalidation for host and unwatched reads. */
export function useHostReads(client: TelemetryClient, onRefresh?: () => void) {
  const [revision, setRevision] = useState(0);
  const host = useRead("host", () => client.host(), revision);
  const unwatched = useRead("unwatched", () => client.unwatched(), revision);
  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
    onRefresh?.();
  }, [onRefresh]);
  return { host, unwatched, refresh };
}
