import { useCallback, useState } from "react";
import { outcomeOf, type VerbOutcome } from "./Outcome";

export interface Verb<A extends readonly unknown[]> {
  /** Call the verb; the outcome is kept whether it answered or refused. */
  readonly run: (...args: A) => Promise<VerbOutcome>;
  /** Whether a call is out, so a control can refuse a second one meanwhile. */
  readonly pending: boolean;
  /** What the last call came back with, as the API returned it. */
  readonly outcome?: VerbOutcome;
}

/**
 * One wrapped verb as a control calls it: the call, whether one is in flight,
 * and what the last one came back with.
 *
 * Every mutation on the supervising surface is this shape — a call that either
 * answers with the engine's receipt or refuses with the engine's words — and
 * keeping the pending flag and the outcome here is what keeps that shape out of
 * every component that offers one. `onAnswered` runs only for an answer: a
 * refusal changed nothing, so nothing is re-read for it.
 */
export function useVerb<A extends readonly unknown[]>(
  title: string | ((...args: A) => string),
  verb: (...args: A) => Promise<unknown>,
  onAnswered?: () => void,
): Verb<A> {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<VerbOutcome>();
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      const answered = await outcomeOf(
        typeof title === "string" ? title : title(...args),
        () => verb(...args),
      );
      setOutcome(answered);
      setPending(false);
      if (answered.kind === "answered") onAnswered?.();
      return answered;
    },
    [title, verb, onAnswered],
  );
  return { run, pending, outcome };
}
