import {
  type DagConversation,
  dagConversationSchema,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FirstTranscript } from "../../main";

/**
 * The transcript the page's entry read for the conversation its address opens,
 * taken over once, by the first panel that opens that conversation.
 */
export interface FirstTranscriptHandoff {
  readonly transcript?: FirstTranscript;
  taken: boolean;
}

export const FirstTranscriptContext = createContext<FirstTranscriptHandoff>({
  taken: true,
});

/** The entry's body, parsed as the client parses one, where it had landed. */
function landedFor(
  first: FirstTranscript | undefined,
): DagConversation | undefined {
  if (first?.landed === undefined) return undefined;
  const parsed = dagConversationSchema.safeParse(first.landed.body);
  return parsed.success ? parsed.data : undefined;
}

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
 *
 * The first panel to open the conversation the page's address names takes over the
 * read the page's entry made of it ({@link FirstTranscriptContext}): drawn in its
 * first frame where it had landed, and waited on rather than asked again where not.
 */
export function useConversation(
  client: TelemetryClient,
  runId?: string,
  conversationId?: string,
  record?: string,
): ConversationState {
  // Serialized rather than joined on a separator: both halves are server-chosen
  // identifiers, and no separator is guaranteed to be absent from either.
  const key =
    runId === undefined || conversationId === undefined
      ? undefined
      : JSON.stringify([runId, conversationId]);
  const handoff = useContext(FirstTranscriptContext);
  // The entry's read, where it is this panel's to take: claimed in the effect that
  // takes it, so a render React discards claims nothing.
  const [offered] = useState(() =>
    handoff.taken || handoff.transcript === undefined
      ? undefined
      : key ===
          JSON.stringify([
            handoff.transcript.runId,
            handoff.transcript.conversationId,
          ])
        ? handoff.transcript
        : undefined,
  );
  // What the entry read already, drawn in this panel's first frame: the read it
  // stands for is this panel's first, so it is not asked again.
  const [fetched, setFetched] = useState<Fetched | undefined>(() => {
    const conversation = landedFor(offered);
    return conversation === undefined || key === undefined
      ? undefined
      : { key, conversation };
  });
  const reads = useRef<{ key?: string; asked: number; shown: number }>({
    asked: 0,
    shown: 0,
  });
  const drawnFromEntry = useRef(fetched !== undefined);

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
    // The entry's read is this panel's first: drawn already, or still landing.
    const first =
      offered !== undefined &&
      !handoff.taken &&
      key === JSON.stringify([offered.runId, offered.conversationId])
        ? offered
        : undefined;
    if (first !== undefined) handoff.taken = true;
    if (first !== undefined && drawnFromEntry.current) {
      drawnFromEntry.current = false;
      order.key = key;
      return;
    }
    // Every read asked so far was for another transcript, so none of them may land.
    if (order.key !== key) order.shown = order.asked;
    order.key = key;
    order.asked += 1;
    const asked = order.asked;
    const lands = () => order.key === key && asked > order.shown;
    // The entry's read still landing is this panel's first read rather than a
    // second request. One that failed, or whose body the contract refuses, is
    // asked again through the client, whose error says why in the app's words.
    const reread = () => client.getConversation(runId, conversationId);
    const answer =
      first === undefined
        ? reread()
        : first.read.then((body) => {
            const parsed = dagConversationSchema.safeParse(body);
            return parsed.success ? parsed.data : reread();
          }, reread);
    void answer
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
  }, [client, runId, conversationId, key, record, offered, handoff]);

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
