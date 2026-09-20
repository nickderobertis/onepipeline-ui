import { ScrollArea } from "@oneharness/ui";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { AgentsPanel } from "./AgentsPanel";
import { useNodeAgents, useRunAgents } from "./useAgents";

/**
 * The run's Agents view: every session its launches wrote, off its own
 * pointer file, beside the count the run's detail carries.
 */
export function AgentsView({
  client,
  runId,
  count,
  invalidations,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly count?: number;
  readonly invalidations: number;
}) {
  const agents = useRunAgents(client, runId, invalidations);
  return (
    <ScrollArea className="h-full">
      <div className="channel-view">
        <AgentsPanel
          agents={agents}
          client={client}
          count={count}
          runId={runId}
          title="Agents"
        />
      </div>
    </ScrollArea>
  );
}

/** One node's Agents tab: the sessions its dispatches wrote. */
export function NodeAgents({
  client,
  runId,
  nodeId,
  invalidations,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly nodeId: string;
  readonly invalidations: number;
}) {
  const agents = useNodeAgents(client, runId, nodeId, invalidations);
  return (
    <AgentsPanel
      agents={agents}
      client={client}
      runId={runId}
      title={`Agents of ${nodeId}`}
    />
  );
}
