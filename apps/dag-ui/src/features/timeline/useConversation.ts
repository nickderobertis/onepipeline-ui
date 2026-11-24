import type { DagConversation } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useEffect, useMemo, useRef, useState } from "react";

export interface ConversationState {
  readonly conversation?: DagConversation;
  /**
   * True only while the *first* read of this transcript is in flight.
   *
   * A revalidation of a transcript already on screen is deliberately not loading:
   * an operator reading a live run must not have the page they are reading replaced
   * by a skeleton every time the run records something.
   */
  readonly loading: boolean;
  readonly error?: Error;
}

interface Fetched {
  readonly key: string;
  readonly conversation?: DagConversation;
  readonly error?: Error;
}

/**
 * One transcript, fetched only while something is showing it, and re-read only when
 * the run has recorded something new in it.
 *
 * A run's transcripts are the bulk of its recorded state, so nothing downloads them
 * wholesale: the timeline names each session by id, and this reads the one the
 * operator opened. Selecting another moment of the same session changes nothing here,
 * so stepping through a conversation's turns costs one read, not one per turn.
 *
 * `record` is what the served timeline says this session has recorded — its state, its
 * end, and its turns. It is the whole revalidation rule: a live session's record moves
 * as turns land and this re-reads it, while a session that has stopped recording keeps
 * one record forever and is never read again, however busy the rest of the run is.
 * Reads are stale-while-revalidate — the transcript already served stays until the
 * next one arrives, and a revalidation that fails leaves it in place rather than
 * replacing a readable page with an error.
 *
 * A read already asked is never thrown away because the record moved while it was in
 * flight: it still answers for the same transcript, and the newer read lands after it.
 * Opening a session pages the rest of its span in, and every page moves the record,
 * so discarding the read in flight made the first paint of a long transcript wait for
 * every page and then one more whole read. Answers land in the order they were asked
 * instead — one asked before an answer already shown is dropped, so an older reading
 * never replaces a newer one — and an answer for another transcript never lands.
 */
export function useConversation(
  client: TelemetryClient,
  runId?: string,
  conversationId?: string,
  record?: string,
): ConversationState {
  const [fetched, setFetched] = useState<Fetched>();
  const reads = useRef<{ key?: string; asked: number; shown: number }>({
    asked: 0,
    shown: 0,
  });
  // Serialized rather than joined on a separator: both halves are server-chosen
  // identifiers, and no separator is guaranteed to be absent from either.
  const key =
    runId === undefined || conversationId === undefined
      ? undefined
      : JSON.stringify([runId, conversationId]);

  useEffect(() => {
    if (
      key === undefined ||
      runId === undefined ||
      conversationId === undefined
    ) {
      // Nothing is open, so no read asked before now may land.
      reads.current.key = undefined;
      return;
    }
    // Read so each change of the served record asks for the open transcript again;
    // the value itself is immaterial.
    void record;
    const order = reads.current;
    // Every read asked so far was for another transcript, so none of them may land.
    if (order.key !== key) order.shown = order.asked;
    order.key = key;
    order.asked += 1;
    const asked = order.asked;
    const lands = () => order.key === key && asked > order.shown;
    void client
      .getConversation(runId, conversationId)
      .then((conversation) => {
        if (!lands()) return;
        order.shown = asked;
        setFetched({ key, conversation });
      })
      .catch((caught: unknown) => {
        if (!lands()) return;
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        setFetched((current) =>
          current?.key === key && current.conversation !== undefined
            ? current
            : { key, error },
        );
      });
  }, [client, runId, conversationId, key, record]);

  // A transcript read for a session that is no longer open is not this one's, so the
  // panel reports a first load rather than rendering one session's turns under
  // another's name.
  const current = fetched?.key === key ? fetched : undefined;
  return useMemo(
    () => ({
      conversation: current?.conversation,
      error: current?.error,
      loading: key !== undefined && current === undefined,
    }),
    [current, key],
  );
}
