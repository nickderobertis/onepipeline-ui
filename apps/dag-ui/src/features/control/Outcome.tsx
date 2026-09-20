import { Alert, AlertDescription, AlertTitle } from "@oneharness/ui";
import { TelemetryClientError } from "@onepipeline-ui/telemetry-client";
import { CheckCircle2, TriangleAlert } from "lucide-react";

/**
 * What a verb answered, shown as the API returned it.
 *
 * A receipt is the engine's own object and a refusal is the engine's own text,
 * and both reach the reader unaltered: the JSON of the one, and the code and
 * message of the other. Nothing here restates a refusal in friendlier words —
 * the words are the whole of what a manager has to act on.
 */
export type VerbOutcome =
  | {
      readonly kind: "answered";
      readonly title: string;
      readonly payload: unknown;
    }
  | { readonly kind: "refused"; readonly title: string; readonly error: Error };

export function Outcome({
  outcome,
  label,
}: {
  readonly outcome?: VerbOutcome;
  readonly label: string;
}) {
  if (outcome === undefined) return null;
  if (outcome.kind === "refused") {
    const error = outcome.error;
    const code = error instanceof TelemetryClientError ? error.code : undefined;
    const status =
      error instanceof TelemetryClientError ? error.status : undefined;
    return (
      <Alert aria-label={`${label} refused`} variant="destructive">
        <TriangleAlert />
        <AlertTitle>
          {outcome.title}
          {status !== undefined && ` · ${status}`}
          {code !== undefined && ` ${code}`}
        </AlertTitle>
        <AlertDescription>
          <pre className="verb-text">{error.message}</pre>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert aria-label={`${label} receipt`}>
      <CheckCircle2 />
      <AlertTitle>{outcome.title}</AlertTitle>
      <AlertDescription>
        <pre className="verb-text">
          {JSON.stringify(outcome.payload, null, 2)}
        </pre>
      </AlertDescription>
    </Alert>
  );
}

/** Run a verb and keep its answer or its refusal, whichever it was. */
export async function outcomeOf(
  title: string,
  verb: () => Promise<unknown>,
): Promise<VerbOutcome> {
  try {
    return { kind: "answered", title, payload: await verb() };
  } catch (caught) {
    return {
      kind: "refused",
      title,
      error: caught instanceof Error ? caught : new Error(String(caught)),
    };
  }
}
