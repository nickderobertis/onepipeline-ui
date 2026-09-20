import { Badge, Button, Card, CardContent, Skeleton } from "@oneharness/ui";
import type { AgentSession } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useState } from "react";
import { Timestamp } from "../../lib/Timestamp";
import type { Read } from "../../lib/useRead";
import { Outcome } from "../control/Outcome";
import { StoredArtifact } from "../timeline/StoredArtifact";
import {
  agentCountLabel,
  groupAgentSessions,
  groupLabel,
  sessionFacts,
} from "./agents-model";

/**
 * Every agent a run, one of its nodes, or a project launched: one entry per
 * oneharness session, grouped by which launch of the run it was written under
 * and, for a dispatch, which attempt.
 *
 * Each entry shows what a reader wants to tell the sessions apart — the node,
 * the step, and whatever the repository stamped, such as a `role` — the harness
 * runs it recorded with their configured harness ids, and when it started; and
 * each harness run opens to its transcript through the conversation view the
 * app already has for a `oneharness_session` artifact. The transcripts stay in
 * each oneharness's own store: nothing here names one, and the entry's own
 * fields are what the server resolves the record through.
 */
export function AgentsPanel({
  client,
  title,
  agents,
  count,
  runId,
}: {
  readonly client: TelemetryClient;
  readonly title: string;
  readonly agents: Read<{
    readonly sessions: readonly AgentSession[];
    readonly skipped: number;
  }>;
  /**
   * The count the run detail or the project group carries beside the listing,
   * where the caller has one: shown so a reader can hold the two to each other.
   */
  readonly count?: number;
  /**
   * The run every entry is under, where the listing is one run's. A project's
   * union names the run on each entry instead.
   */
  readonly runId?: string;
}) {
  const sessions = agents.value?.sessions ?? [];
  const groups = groupAgentSessions(sessions);
  return (
    <section aria-label={title} className="channel-section agents-panel">
      <h3>
        {title}
        {count !== undefined && (
          <Badge variant="secondary">{agentCountLabel(count)}</Badge>
        )}
      </h3>
      {agents.error && (
        <Outcome
          label={title}
          outcome={{ kind: "refused", title, error: agents.error }}
        />
      )}
      {agents.loading ? (
        <div aria-live="polite" className="loading-state">
          <Skeleton className="h-2 w-48" />
          Loading agents…
        </div>
      ) : agents.value === undefined ? null : sessions.length === 0 ? (
        <p className="channel-empty">No agents launched.</p>
      ) : (
        <div className="channel-list agents-groups">
          {groups.map((group) => (
            <div key={groupLabel(group)}>
              <h4>{groupLabel(group)}</h4>
              <ul aria-label={groupLabel(group)}>
                {group.sessions.map((session) => (
                  <li key={session.history_session}>
                    <AgentSessionCard
                      client={client}
                      runId={session.run_id ?? runId}
                      session={session}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {agents.value !== undefined && agents.value.skipped > 0 && (
        <p className="channel-empty">
          {agents.value.skipped} {agents.value.skipped === 1 ? "line" : "lines"}{" "}
          of the pointer file could not be read.
        </p>
      )}
    </section>
  );
}

/** One session: its facts, its harness runs, and the transcript of whichever run the reader opened. */
function AgentSessionCard({
  client,
  runId,
  session,
}: {
  readonly client: TelemetryClient;
  readonly runId?: string;
  readonly session: AgentSession;
}) {
  const [opened, setOpened] = useState<string>();
  return (
    <Card className="channel-card">
      <CardContent>
        <div className="channel-card-head">
          <strong>{session.name}</strong>
          {sessionFacts(session).map(([key, value]) => (
            <Badge key={key} variant="outline">
              {key} {value}
            </Badge>
          ))}
          <span className="channel-age">
            started <Timestamp at={session.started} relative />
          </span>
        </div>
        <ul
          aria-label={`Harness runs of ${session.name}`}
          className="agent-runs"
        >
          {session.runs.map((run) => {
            const open = opened === run.history_id;
            return (
              <li key={run.history_id}>
                <div className="channel-card-head">
                  <Badge variant="secondary">{run.harness_id}</Badge>
                  <span className="channel-age">
                    <Timestamp at={run.started} />
                  </span>
                  {/* Opened under the run the entry is under: an entry a
                      project's union could not name a run for has no route
                      to open it through, and says so rather than guessing. */}
                  {runId === undefined ? (
                    <span className="channel-age">
                      This session names no run to open its transcript under.
                    </span>
                  ) : (
                    <Button
                      aria-expanded={open}
                      onClick={() =>
                        setOpened(open ? undefined : run.history_id)
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {open ? "Close transcript" : "Open transcript"}
                    </Button>
                  )}
                </div>
                {open && runId !== undefined && (
                  <StoredArtifact
                    artifactId={run.history_id}
                    client={client}
                    heading="Oneharness conversation"
                    missing="This run named no conversation."
                    noun="conversation"
                    runId={runId}
                    unreadable="The history store holds no readable copy of that conversation."
                  />
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
