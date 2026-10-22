import type { RunList } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useRead } from "../../lib/useRead";

/**
 * The whole listing the Host page shows and a host shutdown names its runs
 * from: the run list's host facts with every project's runs, read when the
 * Host page opens and on its refresh control, and never on a change — the
 * sidebar's pushed rows are what keep the rest of the page current.
 */
export function useHostListing(
  client: TelemetryClient,
  open: boolean,
  revision: number,
): RunList | undefined {
  const { value } = useRead(
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
  return open ? value : undefined;
}
