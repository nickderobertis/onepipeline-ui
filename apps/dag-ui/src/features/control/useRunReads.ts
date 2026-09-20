import type {
  RenderedRoot,
  RenderedRun,
  RunTelemetryDocument,
  RunTranscript,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useState } from "react";
import { type Read, useRead } from "./useRead";

/** The rendered reads, in the order the verb table lists them. */
export const READS = {
  status: "Status",
  results: "Results",
  goals: "Goals",
  transcript: "Transcript",
  telemetry: "Telemetry",
  host: "Host",
} as const;
export type ReadName = keyof typeof READS;

export function isReadName(value: string): value is ReadName {
  return Object.hasOwn(READS, value);
}

export interface RunReads {
  readonly read: ReadName;
  readonly setRead: (read: ReadName) => void;
  /** The node the transcript is read for, or the whole run when undefined. */
  readonly node?: string;
  readonly setNode: (node?: string) => void;
  readonly results: Read<RenderedRun>;
  readonly goals: Read<RenderedRun>;
  readonly transcript: Read<RunTranscript>;
  readonly telemetry: Read<RunTelemetryDocument>;
  readonly host: Read<RenderedRoot>;
}

/**
 * Which rendered read is open, and the reads themselves — each keyed by what it
 * is a reading of, and taken only while its panel is the one open: six verbs on
 * every invalidation would be five reads nobody is looking at. The status read
 * is the run's own, held by `useRunControl`, so it is not repeated here.
 */
export function useRunReads(
  client: TelemetryClient,
  runId: string,
  invalidations: number,
): RunReads {
  const [read, setRead] = useState<ReadName>("status");
  const [node, setNode] = useState<string>();
  const results = useRead(
    read === "results" ? runId : undefined,
    () => client.getResults(runId),
    invalidations,
  );
  const goals = useRead(
    read === "goals" ? runId : undefined,
    () => client.getRunGoals(runId),
    invalidations,
  );
  // A run id never holds a slash, so the pair cannot spell another pair.
  const transcript = useRead(
    read === "transcript" ? `${runId}/${node ?? ""}` : undefined,
    () => client.getTranscript(runId, node),
    invalidations,
  );
  const telemetry = useRead(
    read === "telemetry" ? runId : undefined,
    () => client.getTelemetryDocument(runId),
    invalidations,
  );
  const host = useRead(
    read === "host" ? "host" : undefined,
    () => client.host(),
    invalidations,
  );
  return {
    read,
    setRead,
    node,
    setNode,
    results,
    goals,
    transcript,
    telemetry,
    host,
  };
}
