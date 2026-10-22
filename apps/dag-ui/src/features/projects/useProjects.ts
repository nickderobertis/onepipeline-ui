import type { ProjectList } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useRead } from "../../lib/useRead";

export interface ProjectsState {
  readonly list?: ProjectList;
  readonly error?: Error;
}

/**
 * The grouped listing, read once and again whenever the stream says a run moved.
 *
 * `invalidations` is the telemetry hook's count of announced changes, so the
 * projects refresh on the same stream every other live surface refreshes on rather
 * than opening a second one. The order shown is the server's — newest activity
 * first — and is never recomputed here.
 */
export function useProjects(
  client: TelemetryClient,
  invalidations: number,
  enabled: boolean,
): ProjectsState {
  const { value, error } = useRead(
    enabled ? "projects" : undefined,
    () => client.listProjects(),
    invalidations,
  );
  return { list: value, error };
}
