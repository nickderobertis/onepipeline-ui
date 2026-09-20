import {
  Badge,
  ScrollArea,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@oneharness/ui";
import type { RunStatus } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import type { ReactNode } from "react";
import type { NodeView } from "../../lib/run-model";
import { Outcome } from "./Outcome";
import type { Read } from "./useRead";
import { isReadName, READS, useRunReads } from "./useRunReads";

/**
 * The read verbs, each a panel: status, results, goals, the transcript per
 * node, telemetry, and the host view. Each shows the SDK's own rendering —
 * byte for byte what the binary prints — because those verbs answer rendered
 * views rather than records, and an agent reading the CLI and a person reading
 * this read one text.
 */
export function ReadsView({
  client,
  runId,
  nodes,
  status,
  invalidations,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly nodes: readonly NodeView[];
  readonly status: Read<RunStatus>;
  readonly invalidations: number;
}) {
  const {
    read,
    setRead,
    node,
    setNode,
    results,
    goals,
    transcript,
    telemetry,
    host,
  } = useRunReads(client, runId, invalidations);
  return (
    <Tabs
      className="reads-view min-h-0 h-full gap-0"
      onValueChange={(value) => {
        if (isReadName(value)) setRead(value);
      }}
      value={read}
    >
      <div className="view-tabs reads-tabs">
        <TabsList aria-label="Reads" variant="line">
          {Object.entries(READS).map(([name, label]) => (
            <TabsTrigger key={name} value={name}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent className="min-h-0" value={read}>
        <ScrollArea className="h-full">
          <div className="channel-view">
            {read === "status" && (
              <Rendered read={status} title="Status">
                {status.value && (
                  <div className="channel-card-head">
                    <Badge variant="outline">{status.value.liveness}</Badge>
                    <Badge variant="secondary">
                      {status.value.unread_surfaces.count} unread
                      {status.value.unread_surfaces.oldest_seconds !== null &&
                        `, oldest ${status.value.unread_surfaces.oldest_seconds}s`}
                    </Badge>
                    <span className="channel-age">{status.value.summary}</span>
                  </div>
                )}
              </Rendered>
            )}
            {read === "results" && <Rendered read={results} title="Results" />}
            {read === "goals" && <Rendered read={goals} title="Goals" />}
            {read === "transcript" && (
              <Rendered read={transcript} title="Transcript">
                <div className="composer-field">
                  <label className="channel-age" htmlFor="transcript-node">
                    Node
                  </label>
                  <select
                    className="composer-select"
                    id="transcript-node"
                    onChange={(event) =>
                      setNode(
                        event.target.value === ""
                          ? undefined
                          : event.target.value,
                      )
                    }
                    value={node ?? ""}
                  >
                    <option value="">Whole run</option>
                    {nodes.map(({ id }) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </div>
              </Rendered>
            )}
            {read === "telemetry" && (
              <section aria-label="Telemetry" className="channel-section">
                <h3>Telemetry</h3>
                {telemetry.error && (
                  <Outcome
                    label="Telemetry"
                    outcome={{
                      kind: "refused",
                      title: "Telemetry",
                      error: telemetry.error,
                    }}
                  />
                )}
                {telemetry.loading ? (
                  <Loading />
                ) : telemetry.value ? (
                  <pre className="verb-text">
                    {JSON.stringify(telemetry.value.telemetry, null, 2)}
                  </pre>
                ) : null}
              </section>
            )}
            {read === "host" && <Rendered read={host} title="Host" />}
          </div>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}

function Rendered({
  title,
  read,
  children,
}: {
  readonly title: string;
  readonly read: Read<{ readonly rendered: string }>;
  readonly children?: ReactNode;
}) {
  return (
    <section aria-label={title} className="channel-section">
      <h3>{title}</h3>
      {children}
      {read.error && (
        <Outcome
          label={title}
          outcome={{ kind: "refused", title, error: read.error }}
        />
      )}
      {read.loading ? (
        <Loading />
      ) : read.value ? (
        <pre className="verb-text">{read.value.rendered}</pre>
      ) : null}
    </section>
  );
}

function Loading() {
  return (
    <div aria-live="polite" className="loading-state">
      <Skeleton className="h-2 w-48" />
      Loading…
    </div>
  );
}
