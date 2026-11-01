import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  TurnCard,
} from "@oneharness/ui";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { TriangleAlert } from "lucide-react";
import { useRead } from "./useRead";

/**
 * The conversation one oneharness invocation had — the prompt it ran, every tool
 * it called, the text it finished on — read whole by the server out of the
 * history file through the engine's transcript resolver, and drawn as the
 * conversation turn it was through the design system's own `TurnCard`. A pointer
 * at a transcript the store no longer holds is said in the server's own words,
 * naming the file and why, never shown as an empty conversation.
 *
 * In `lib` because two features open one: the timeline's detail panel opens the
 * session a record relayed, and the agents panel opens the session a pointer line
 * names. Each asks by the opaque history id and never by a path.
 */
export function HarnessConversation({
  artifactId,
  client,
  runId,
}: {
  readonly artifactId: string;
  readonly client: TelemetryClient;
  readonly runId: string;
}) {
  // A run id never holds a slash, so the pair cannot spell another pair.
  const artifact = useRead(
    `${runId}/${artifactId}`,
    () => client.getArtifact(runId, artifactId),
    0,
  );
  const turns = artifact.value?.turns ?? [];
  return (
    <>
      <h3 className="detail-heading">Oneharness conversation</h3>
      {artifact.loading ? (
        <p aria-live="polite" className="detail-note">
          Loading conversation…
        </p>
      ) : artifact.value === undefined ? (
        <p aria-live="polite" className="detail-note">
          The history store holds no readable copy of that conversation.
        </p>
      ) : artifact.value.unavailable !== undefined ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Transcript unavailable</AlertTitle>
          <AlertDescription>{artifact.value.unavailable}</AlertDescription>
        </Alert>
      ) : (
        <Card className="gap-0 py-3">
          <CardContent className="px-3">
            {turns.map((turn) => (
              <TurnCard key={turn.id} turn={turn} />
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
