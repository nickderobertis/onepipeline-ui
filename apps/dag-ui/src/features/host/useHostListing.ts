import type { RunList } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useRead } from "../../lib/useRead";

/**
 * The whole listing the Host page shows and a host shutdown names its runs
 * from: the run list's host facts with every project's runs, read when the
 * Host page opens and on its refresh control. Its caller asks for it again
 * while a host shutdown is out, which is the one time a pushed row moving is
 * reason to read it; otherwise the sidebar's pushed rows keep the rest of the
 * page current.
 */
export function useHostListing(
  client: TelemetryClient,
  open: boolean,
  revision: number,
): { readonly list?: RunList; readonly error?: Error } {
  const { value, error } = useRead(
    open ? "host-listing" : undefined,
    async () => {
      const [list, projects] = await Promise.all([
        client.listRuns(true),
        client.listProjects(),
      ]);
      return {
        ...list,
        runs: projects.projects.flatMap((group) => group.runs),
        next_cursor: undefined,
      };
    },
    revision,
  );
  return open ? { list: value, error } : {};
}
