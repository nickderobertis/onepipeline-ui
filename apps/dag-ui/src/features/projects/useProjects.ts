import type { ProjectGroup, ProjectList } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { groupForKey } from "../../lib/project-model";
import { useRead } from "../../lib/useRead";
import { NO_PROJECT_KEY } from "../../lib/useUrlSelection";

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

export interface ProjectState {
  readonly group?: ProjectGroup;
  readonly error?: Error;
  /** Whether a read is out for a group nothing has been read for yet. */
  readonly loading: boolean;
}

/**
 * One project's page: its group, read from the project route, or — for the
 * `(no project)` group, which has no id and so no route — taken off the grouped
 * listing, which serves it as a group like any other.
 */
export function useProject(
  client: TelemetryClient,
  projectKey: string | undefined,
  invalidations: number,
): ProjectState {
  const { value, error, loading } = useRead(
    projectKey,
    () =>
      projectKey === NO_PROJECT_KEY
        ? client.listProjects().then((list) => {
            const group = groupForKey(list.projects, NO_PROJECT_KEY);
            if (group === undefined)
              throw new Error("no runs without a project");
            return group;
          })
        : client.getProject(projectKey ?? ""),
    invalidations,
  );
  return { group: value, error, loading };
}
