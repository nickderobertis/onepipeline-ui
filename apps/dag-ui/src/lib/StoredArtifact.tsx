import { Button } from "@oneharness/ui";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useState } from "react";
import { useRead } from "./useRead";

/** How much of a stored artifact is shown before the reader asks for the rest. */
const ARTIFACT_PREVIEW_CHARS = 4000;

/**
 * One recorded artifact's bytes, read through the API's artifact route.
 *
 * Every caller asks by the opaque id its record stored and never by a path, so no
 * location on the producing host reaches the browser (`src/AGENTS.md`). The route
 * serves the *end* of a file rather than all of it, and this shows the end of
 * that again until the reader asks for the rest. A read that failed is *said*,
 * never left blank: the two sentences a caller gives are what tells "nothing was
 * recorded" from "something was, and this run has no readable copy of it".
 *
 * In `lib` because two features open one: the timeline's detail panel opens the
 * report a settlement stored and the session a member's turn relayed, and the
 * agents panel opens the session a pointer line names.
 */
export function StoredArtifact({
  artifactId,
  client,
  heading,
  missing,
  noun,
  runId,
  unreadable,
}: {
  readonly artifactId?: string;
  readonly client: TelemetryClient;
  readonly heading: string;
  /** What to say when the record named no artifact this API can be asked for. */
  readonly missing: string;
  /** What this document is called, in the controls that page through it. */
  readonly noun: string;
  readonly runId: string;
  /** What to say when the artifact was named and the read did not answer. */
  readonly unreadable: string;
}) {
  const servable = servableArtifact(artifactId);
  // A run id never holds a slash, so the pair cannot spell another pair; a
  // stored artifact does not move, so nothing invalidates the read.
  const artifact = useRead(
    servable === undefined ? undefined : `${runId}/${servable}`,
    () => client.getArtifact(runId, servable ?? ""),
    0,
  );
  // Which artifact the reader expanded, so opening another opens it folded.
  const [expandedFor, setExpandedFor] = useState<string>();
  const expanded = expandedFor === servable;
  const content = artifact.value?.content;
  return (
    <>
      <h3 className="detail-heading">{heading}</h3>
      {servable === undefined ? (
        <p className="detail-note">{missing}</p>
      ) : artifact.loading ? (
        <p aria-live="polite" className="detail-note">
          Loading {noun}…
        </p>
      ) : content === undefined ? (
        <p aria-live="polite" className="detail-note">
          {unreadable}
        </p>
      ) : (
        <>
          <pre>
            {expanded ? content : content.slice(-ARTIFACT_PREVIEW_CHARS)}
          </pre>
          {content.length > ARTIFACT_PREVIEW_CHARS && (
            <Button
              onClick={() => setExpandedFor(expanded ? undefined : servable)}
              size="sm"
              type="button"
              variant="outline"
            >
              {expanded ? `Collapse ${noun}` : `Expand ${noun}`}
            </Button>
          )}
        </>
      )}
    </>
  );
}

/**
 * The artifact id a reference names, when the API can be asked for it.
 *
 * An id is opaque to this app and validated at the server's own boundary, so the
 * one thing checked here is that it is a single path segment: a value carrying a
 * separator or a query would be a request for a different route than the one
 * intended, and the reference is shown as the record rather than fetched.
 */
export function servableArtifact(artifactId?: string): string | undefined {
  if (artifactId === undefined || /[/?#]/u.test(artifactId)) return undefined;
  return artifactId;
}
