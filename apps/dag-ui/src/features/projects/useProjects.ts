import type { ProjectGroup, ProjectList } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useEffect, useState } from "react";
import { NO_PROJECT_KEY } from "../../lib/useUrlSelection";
import { groupForKey } from "./project-model";

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
  const [state, setState] = useState<ProjectsState>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: `invalidations` is not read by this effect — it is what asks for the same list to be read again when the stream says a run moved, exactly as `revision` does in useDagTelemetry. Dropping it would leave the projects showing the first read.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    client
      .listProjects()
      .then((list) => {
        if (current) setState({ list });
      })
      .catch((caught: unknown) => {
        if (current)
          setState((previous) => ({ ...previous, error: asError(caught) }));
      });
    return () => {
      current = false;
    };
  }, [client, invalidations, enabled]);
  return state;
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
  const [state, setState] = useState<{
    readonly key?: string;
    readonly group?: ProjectGroup;
    readonly error?: Error;
  }>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: `invalidations` is not read by this effect — it is what asks for the same group to be read again when the stream says a run moved, exactly as `revision` does in useDagTelemetry.
  useEffect(() => {
    if (projectKey === undefined) return;
    let current = true;
    const read =
      projectKey === NO_PROJECT_KEY
        ? client.listProjects().then((list) => {
            const group = groupForKey(list.projects, NO_PROJECT_KEY);
            if (group === undefined)
              throw new Error("no runs without a project");
            return group;
          })
        : client.getProject(projectKey);
    read
      .then((group) => {
        if (current) setState({ key: projectKey, group });
      })
      .catch((caught: unknown) => {
        if (current)
          setState((previous) => ({
            // A group already on screen stays while a re-read fails; a different
            // project's group never stands in for the one asked for.
            ...(previous.key === projectKey ? previous : {}),
            key: projectKey,
            error: asError(caught),
          }));
      });
    return () => {
      current = false;
    };
  }, [client, projectKey, invalidations]);
  const shown = state.key === projectKey ? state : undefined;
  return {
    group: shown?.group,
    error: shown?.error,
    loading:
      projectKey !== undefined &&
      shown?.group === undefined &&
      shown?.error === undefined,
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
