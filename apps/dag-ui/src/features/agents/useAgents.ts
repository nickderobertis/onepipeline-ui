import type { ProjectAgents, RunAgents } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { type Read, useRead } from "../../lib/useRead";

/** Every session the run's launches wrote, re-read whenever the stream says the run moved. */
export function useRunAgents(
  client: TelemetryClient,
  runId: string,
  invalidations: number,
): Read<RunAgents> {
  return useRead(runId, () => client.getAgents(runId), invalidations);
}

/** The sessions one node's dispatches wrote. A run id never holds a slash, so the pair cannot spell another pair. */
export function useNodeAgents(
  client: TelemetryClient,
  runId: string,
  nodeId: string,
  invalidations: number,
): Read<RunAgents> {
  return useRead(
    `${runId}/${nodeId}`,
    () => client.getNodeAgents(runId, nodeId),
    invalidations,
  );
}

/**
 * The union over a project's runs. Read only for a project with an id: the
 * `(no project)` group has none, and so no route.
 */
export function useProjectAgents(
  client: TelemetryClient,
  project: string | undefined,
  invalidations: number,
): Read<ProjectAgents> {
  return useRead(
    project,
    () => client.getProjectAgents(project ?? ""),
    invalidations,
  );
}
