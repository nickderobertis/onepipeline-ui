import { Button } from "@oneharness/ui";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useEffect, useState } from "react";

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
  const [content, setContent] = useState<string | null>();
  const [artifactFailed, setArtifactFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const servable = servableArtifact(artifactId);
  useEffect(() => {
    let active = true;
    setContent(undefined);
    setArtifactFailed(false);
    setExpanded(false);
    if (servable === undefined) return;
    void client
      .getArtifact(runId, servable)
      .then((artifact) => {
        if (active) setContent(artifact.content);
      })
      .catch(() => {
        if (active) {
          setArtifactFailed(true);
          setContent(null);
        }
      });
    return () => {
      active = false;
    };
  }, [client, runId, servable]);
  return (
    <>
      <h3 className="detail-heading">{heading}</h3>
      {servable === undefined ? (
        <p className="detail-note">{missing}</p>
      ) : content === undefined ? (
        <p aria-live="polite" className="detail-note">
          Loading {noun}…
        </p>
      ) : artifactFailed || content === null ? (
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
              onClick={() => setExpanded(!expanded)}
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
