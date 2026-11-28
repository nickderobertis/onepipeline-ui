// llmlint: ignore-file[stateful_logic_extracted_to_hooks] this app was copied whole from
// the repository it was written in, and its implementation is the spec — see
// apps/dag-ui/AGENTS.md. Its effects and subscriptions sit beside render because that is
// where they were written; lifting them into hooks would be rewriting behaviour this
// repository imported precisely so as not to reimplement it, with nothing but the copied
// journeys to catch what moved. The two hooks it does have — useConversation and
// useStickyBottom — are the ones that were extracted upstream.
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  type ConversationFocus,
  ConversationTimeline,
  ScrollArea,
  Separator,
  Skeleton,
  StatusBadge,
  TurnCard,
  useTimelineScrollSync,
} from "@oneharness/ui";
import type {
  AgentRole,
  ConversationItem,
  DagConversation,
  NodeStatus,
  Redirection as RedirectionRecord,
  TimelineEvent,
  TimelineReference,
  TimelineRelease,
  TimelineSurface,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { ExternalLink, Gavel, ListTree, TriangleAlert } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { changeRequestId } from "../../lib/change-request";
import { argvOf, commandLine } from "../../lib/command-line";
import { HarnessConversation } from "../../lib/HarnessConversation";
import type { NodeView } from "../../lib/run-model";
import { StoredArtifact, servableArtifact } from "../../lib/StoredArtifact";
import { Timestamp } from "../../lib/Timestamp";
import { formatDuration } from "../../lib/time";
import { useRead } from "../../lib/useRead";
import { ItemHeading } from "./item-reading";
import { ReleaseRecord } from "./release";
import { spikeJudgeFocus } from "./spike-grouped";
import {
  JUDGED_DISPATCH,
  THIRD_DISPATCH,
  conclusionText,
  judgeText,
  judgeTurnKind,
  useJudgeHistories,
} from "./spike";
import { ConversationPlotHover } from "./TimelinePopover";
import {
  dispatchRoleLabel,
  editAuthor,
  holdReasonLabel,
  holdReasonsOf,
  surfaceStatus,
  type TimelineRow,
} from "./timeline-model";
import { useConversation } from "./useConversation";
import { usePinnedHeight } from "./usePinnedHeight";
import { usePlacedBelowPinned } from "./usePlacedBelowPinned";
import { useStickyBottom } from "./useStickyBottom";

/** How many turns of a long transcript are handed to the reader at once. */
const PAGE_SIZE = 25;

/**
 * How often an open transcript is re-read while the turn the reader opened is not
 * in it yet: the row names a turn the history store has not written, and nothing
 * else the panel holds moves when it is.
 */
const AWAITED_TURN_REREAD_MS = 2000;

/**
 * The one timeline item the operator opened, expanded across the working area.
 *
 * Each recorded kind is shown as what it is: a conversation turn through the design
 * system's own `TurnCard`, a verification as its result, bounded output, and readable
 * log, a publication as the PR and the checks that were observed on it,
 * and anything else as the typed record the timeline served.
 */
export function TimelineItemDetail({
  client,
  runId,
  node,
  row,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  /**
   * The node whose record this is. Absent for a run-level session, which the graph
   * view opens here too: those belong to the run rather than to any node, and the
   * publication facts a node contributes are not theirs to show.
   */
  readonly node?: NodeView;
  readonly row?: TimelineRow;
}) {
  const reference = row === undefined ? undefined : referenceOf(row);
  const conversationId =
    reference?.kind === "conversation" ? reference.value : undefined;
  // Moves only while the turn the reader opened is awaited, so the transcript is
  // re-read until it lands; every other row's record stays what it was.
  const [rereads, setRereads] = useState(0);
  const transcript = useConversation(
    client,
    runId,
    conversationId,
    row === undefined ? undefined : `${transcriptFingerprint(row)}|${rereads}`,
  );
  const awaited =
    row !== undefined && absenceOf(row, transcript, node) === "not-yet";
  useEffect(() => {
    if (!awaited) return;
    const timer = setInterval(
      () => setRereads((count) => count + 1),
      AWAITED_TURN_REREAD_MS,
    );
    return () => clearInterval(timer);
  }, [awaited]);
  const stickToLastLine = useStickyBottom(
    conversationId,
    availableTurnCount(row, transcript),
  );
  const harness =
    reference?.kind === "oneharness_session"
      ? servableArtifact(reference.value)
      : undefined;

  return (
    <section aria-label="Timeline item detail" className="timeline-detail">
      <ScrollArea className="h-full">
        <div className="p-[22px] max-sm:p-3" ref={stickToLastLine}>
          {row === undefined ? (
            <div className="detail-placeholder">
              <ListTree size={30} />
              <p>Select an item in the timeline to read what it recorded.</p>
            </div>
          ) : opensConversation(reference) ? (
            // One view per item, decided from what the row carries before
            // anything is read: a conversation item is read in its conversation
            // alone — no heading, badge or field list — before, during and after
            // its transcript loads.
            <Session
              client={client}
              runId={runId}
              conversationId={reference?.value ?? ""}
              {...(node === undefined ? {} : { node })}
              row={row}
              transcript={transcript}
            />
          ) : harness !== undefined ? (
            <HarnessConversation
              artifactId={harness}
              client={client}
              focusFirstPrompt
              runId={runId}
            />
          ) : (
            <>
              <ItemHeading row={row} />
              <Separator className="my-4" />
              <Body
                client={client}
                runId={runId}
                node={node}
                reference={reference}
                row={row}
              />
              {row.rowKind === "event" && (
                <RecordContent
                  client={client}
                  event={row.event}
                  {...(row.event.kind === "edit-rejected"
                    ? { shown: REFUSAL_SHOWN }
                    : {})}
                />
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

type Transcript = ReturnType<typeof useConversation>;
type Turn = DagConversation["conversation"]["turns"][number];

function Body({
  client,
  runId,
  row,
  node,
  reference,
}: {
  readonly row: TimelineRow;
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly node?: NodeView;
  readonly reference?: TimelineReference;
}) {
  if (row.rowKind === "event" && row.event.kind === "edit-rejected")
    return (
      <Refusal
        client={client}
        event={row.event}
        reference={reference}
        runId={runId}
      />
    );
  const redirection = redirectionOf(row);
  if (redirection !== undefined)
    return <Redirection redirection={redirection} row={row} />;
  // Before every reference below, because a release record is what it says it is:
  // a node held on a person, the acknowledgement that ended that wait, the release
  // arriving and the versions being adopted are four different facts, and reading
  // any of them as the artifact it happened to store would answer a question
  // nobody asked in place of the one they did.
  const release = releaseOf(row);
  if (release !== undefined) return <ReleaseRecord release={release} />;
  // And a surface is what it says: the question or the finding a host raised to
  // the planner, in the host's own kind, rather than a record with a reference.
  const surface = surfaceOf(row);
  if (surface !== undefined)
    return <SurfaceRecord row={row} surface={surface} />;
  if (isVerification(row))
    return (
      <Verification
        client={client}
        runId={runId}
        reference={reference}
        row={row}
      />
    );
  // Both branches below are guarded on the id being one this API can be asked
  // for: a reference the server cannot serve is still a reference, and the
  // recorded rendering at the end states it rather than reporting a read that
  // never happened.
  if (
    reference?.kind === "worker_report" &&
    servableArtifact(reference.value) !== undefined
  )
    return (
      <SettledReport
        artifactId={reference.value}
        client={client}
        reference={reference}
        row={row}
        runId={runId}
      />
    );
  if (isPublication(row, reference) && node !== undefined)
    return <Publication node={node} reference={reference} />;
  return <Recorded reference={reference} row={row} />;
}

/**
 * What each judge of a stacked panel decided on one turn: one line per judge,
 * beneath the turn it decided on, in the panel's own order.
 *
 * Nothing at all for a turn no judge decided on, which is every turn of a dispatch
 * a bare provider judged. Named for the turn it belongs to, so a reader moving by
 * landmark hears which turn the decisions are about.
 */
function JudgeDecisions({ turn }: { readonly turn: Turn }) {
  if (turn.judges === undefined || turn.judges.length === 0) return null;
  return (
    <ul aria-label={`Judges on turn ${turn.id}`} className="judge-decisions">
      {turn.judges.map((decision) => (
        <li key={decision.judge}>
          <span className="judge-decision-who">
            {decision.judge} ({decision.kind})
          </span>{" "}
          {decision.decision} — {decision.reason}
        </li>
      ))}
    </ul>
  );
}

/**
 * The conversation item a row stands for (timeline schema 18): the turn and part
 * the server read off the record itself, or a span's first turn's prompt.
 */
function conversationItemOf(row: TimelineRow): ConversationItem | undefined {
  if (row.rowKind === "event") return row.event.conversation_item;
  if (row.rowKind === "span") return row.span.conversation_item;
  return undefined;
}

/**
 * The conversation turn an event row opens: the turn the server names for it, the
 * turn a tool event was published inside, and a turn record's own id otherwise.
 */
function turnOf(event: TimelineEvent): string {
  return event.conversation_item?.turn ?? event.tool?.turn ?? event.id;
}

/**
 * Where opening a row puts the reader in its conversation: on the tool call a
 * `turn-activity` record is, by the identity the harness minted for it where the
 * served turn carries that identity, and by the producer's index otherwise — the
 * turn's answer for the final message, which the turn serves as its answer; on
 * the part of its turn any other turn-level row or conversation span names. The
 * focus is kept even where the transcript lacks that turn, because the note that
 * stands in its place is what is marked until it arrives.
 */
function focusOf(
  row: TimelineRow,
  turns: readonly Turn[],
): ConversationFocus | undefined {
  if (row.rowKind === "event" && row.event.tool !== undefined) {
    const opened = turnOf(row.event);
    const turn = turns.find(({ id }) => id === opened);
    const { index, tool_call_id: toolCallId } = row.event.tool;
    if (turn === undefined) return { turnId: opened, eventIndex: index };
    if (
      toolCallId !== undefined &&
      turn.tools.some((tool) => tool.toolCallId === toolCallId)
    )
      return { turnId: turn.id, toolCallId };
    // The turn's last message is served as its answer rather than as an entry,
    // so the message no entry holds is that answer.
    const entry =
      turn.tools.some((tool) => tool.index === index) ||
      (turn.agentEvents ?? []).some((event) => event.index === index);
    return !entry && row.event.fields?.kind === "message"
      ? { turnId: turn.id, part: "answer" }
      : { turnId: turn.id, eventIndex: index };
  }
  const item = conversationItemOf(row);
  return item === undefined
    ? undefined
    : { turnId: item.turn, part: item.part };
}

/**
 * Why the transcript does not hold the turn a row opens, or `undefined` where it
 * does (or the row opens none, or nothing is read yet). A turn is *not yet* in a
 * conversation still recording — a live turn the history store has not written,
 * or one whose place a later turn holds (`gap`) — and *no longer* in one that
 * has stopped, which no later read will bring back.
 */
function absenceOf(
  row: TimelineRow,
  transcript: Transcript,
  node: NodeView | undefined,
): "not-yet" | "no-longer" | undefined {
  const served = transcript.conversation?.conversation;
  if (served === undefined) return undefined;
  const item = conversationItemOf(row);
  const opened = row.rowKind === "event" ? turnOf(row.event) : item?.turn;
  if (opened === undefined) return undefined;
  const held =
    item?.gap !== true && served.turns.some(({ id }) => id === opened);
  if (held) return undefined;
  if (item?.gap === true) return "not-yet";
  // Past every turn the conversation serves, in one still recording: a turn the
  // history store has not written yet. Anywhere before them, or in one that has
  // stopped, a turn the store no longer holds.
  const position = Number(opened.slice(opened.lastIndexOf(".") + 1));
  return Number.isInteger(position) &&
    position >= served.turns.length &&
    recording(served.state, node)
    ? "not-yet"
    : "no-longer";
}

/**
 * Whether a session at a node in each status may still record a turn: every
 * status the server serves is classified here, so the type checker refuses a new
 * one until it is.
 */
const MAY_RECORD: Readonly<Record<NodeStatus, boolean>> = {
  pending: true,
  ready: true,
  running: true,
  waiting: true,
  blocked: true,
  parked: true,
  unknown: true,
  done: false,
  failed: false,
  cancelled: false,
  skipped: false,
  "not-completed": false,
  "complete-but-draft": false,
  "complete-but-held": false,
};

/**
 * Whether the conversation a row opens may still record a turn: one whose member
 * has not settled, at a node still being worked — a run-level session's is the
 * run's own, which is still recording.
 */
function recording(state: string, node: NodeView | undefined): boolean {
  if (state === "member-settled") return false;
  return node === undefined || MAY_RECORD[node.status];
}

/**
 * What stands in the place of a turn the transcript lacks: the marked item until
 * the turn arrives, placed below the pinned card as the turn would be. Its box
 * keeps room below it, so the turn that replaces it is placed where it stood.
 */
function AbsentTurn({
  turnId,
  absence,
}: {
  readonly turnId: string;
  readonly absence: "not-yet" | "no-longer";
}) {
  const note = useRef<HTMLParagraphElement>(null);
  usePlacedBelowPinned(note, `${turnId}|${absence}`);
  return (
    <div className="conversation-turn-absent" data-turn-id={turnId}>
      <p
        aria-current="true"
        className="detail-note conversation-focus-highlight"
        ref={note}
        role="note"
      >
        {absence === "not-yet"
          ? "This turn is not in the recorded transcript yet."
          : "This turn is no longer part of the recorded transcript."}
      </p>
    </div>
  );
}

/**
 * What the recorder cut from a turn of a run recorded before turn records pointed
 * at their transcript, said where the turn is read.
 *
 * The server serves these flags only when neither the member's report nor a
 * history file the run names holds the whole text, so the copy below is all
 * there is — and a prompt cut mid-sentence must not read as one the agent was
 * given cut. Nothing at all on a turn read whole, which is every turn of a run
 * recorded with references.
 */
function RecorderCut({ turn }: { readonly turn: Turn }) {
  const cut = [
    turn.unknown.instruction_truncated === true ? "its prompt" : undefined,
    turn.unknown.truncated === true ? "its reply" : undefined,
    turn.tools.some((tool) => tool.output_truncated === true)
      ? "a tool's output"
      : undefined,
    turn.tools.some((tool) => tool.input_truncated === true)
      ? "a tool's input"
      : undefined,
  ].filter((part): part is string => part !== undefined);
  if (cut.length === 0) return null;
  return (
    <Alert className="mb-3" role="note">
      <TriangleAlert />
      <AlertTitle>Cut by the recorder</AlertTitle>
      <AlertDescription>
        The run's recorder cut {cut.join(", ")} to its bound, and no whole copy
        exists: neither the member's report nor a history file this run names
        holds it.
      </AlertDescription>
    </Alert>
  );
}

/**
 * A dispatched session: the turn that was opened, or the whole conversation, with
 * the item the row stands for marked and placed below the pinned timeline.
 *
 * Its header is drawn from the first frame, from what the row already carries,
 * and keeps its height when the transcript arrives, so nothing above the turns
 * moves under the reader.
 */
function Session({
  client,
  runId,
  conversationId,
  node,
  row,
  transcript,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly conversationId: string;
  readonly node?: NodeView;
  readonly row: TimelineRow;
  readonly transcript: Transcript;
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const served = transcript.conversation;
  const servedTurns = served?.conversation.turns ?? [];
  // SPIKE: a judge turn read back from its own history, labelled by its kind.
  const judgeConversation = conversationId.endsWith(".judge");
  const histories = useJudgeHistories(client, runId, conversationId, servedTurns);
  // Read off the served turns, before the mock clears what it has shown as text.
  const judgeKinds = new Map(
    servedTurns.map((turn) => [turn.id, judgeTurnKind(turn)] as const),
  );
  const availableTurns = useMemo(
    () =>
      judgeConversation
        ? servedTurns.map((turn) => {
            const { kind } = judgeTurnKind(turn);
            if (kind === "Conclusion")
              return {
                ...turn,
                spikeNoPrompt: true,
                assistant: conclusionText(turn.unknown),
                unknown: {},
              };
            const read = histories.get(turn.id);
            return read === undefined
              ? turn
              : ({
                  ...turn,
                  spikeCollapsePrompt: true,
                  unknown: {},
                  user: read.user ?? turn.user,
                  assistant: judgeText(read.assistant) ?? turn.assistant,
                  tools: read.tools ?? turn.tools,
                  ...(read.agentEvents === undefined
                    ? {}
                    : { agentEvents: read.agentEvents }),
                } as Turn);
          })
        : servedTurns,
    [judgeConversation, servedTurns, histories],
  );
  const opened = row.rowKind === "event" ? turnOf(row.event) : undefined;
  const absence = absenceOf(row, transcript, node);
  // SPIKE: a judge row of the grouped list opens the judge conversation on its turn.
  const judgeFocus =
    judgeConversation &&
    spikeJudgeFocus.current?.turnId.startsWith(`${conversationId}.`) === true
      ? spikeJudgeFocus.current
      : undefined;
  const turns: readonly Turn[] =
    judgeFocus !== undefined
      ? availableTurns.filter(({ id }) => id === judgeFocus.turnId)
      : opened === undefined
      ? availableTurns
      : absence === undefined
        ? availableTurns.filter(({ id }) => id === opened)
        : [];
  // While the opened turn is not there, the pinned plot draws the turns that are,
  // so it stands at the height it keeps once the turn arrives and replaces the note.
  const plotted = turns.length === 0 ? availableTurns : turns;
  const sync = useTimelineScrollSync(
    plotted.map((turn) => ({ id: turn.id, time: Date.parse(turn.timestamp) })),
  );
  const pinned = usePinnedHeight("--conversation-focus-offset");
  const focus =
    judgeFocus === undefined ? focusOf(row, plotted) : (judgeFocus as ConversationFocus);
  // The turn whose place the note stands in, when the transcript lacks it.
  const missing = absence === undefined ? undefined : (opened ?? focus?.turnId);
  const author =
    served === undefined
      ? dispatchRoleLabel(row.role, row.transport)
      : roleLabel(
          served.attribution.agentRole,
          served.attribution.transportRole,
        );
  const persona = served?.attribution.persona;
  // The turns sit on the design system's own card surface rather than straight on
  // the page: `TurnCard` paints its own bubbles and nothing behind them.
  return (
    <Card className="gap-0 py-3">
      <CardContent className="px-3">
        <header className="transcript-header">
          <div>
            {/* The dispatch first, then this session's own role inside it: an
                operator reading a judge transcript has to be able to see which
                dispatch it supervised without leaving the panel. */}
            <p className="eyebrow">
              {row.dispatch === undefined ? "" : `${row.dispatch.label} · `}
              {author}
              {persona ? ` · ${persona}` : ""}
            </p>
            <h4>{served?.conversation.name ?? conversationId}</h4>
          </div>
          {served === undefined ? (
            <Skeleton className="transcript-state-placeholder" />
          ) : (
            <StatusBadge state={served.conversation.state} />
          )}
        </header>
        <Separator className="my-2.5" />
        {transcript.loading ? (
          <div className="conversation-loading">
            <div className="conversation-timeline-sticky conversation-timeline-placeholder">
              <Skeleton className="h-full w-full" />
            </div>
            <div aria-live="polite" className="loading-inline">
              <Skeleton className="h-2 w-40" />
              <Skeleton className="h-2 w-24" />
              Loading transcript…
            </div>
          </div>
        ) : served === undefined ? (
          // Only when there is nothing to read: a revalidation that failed leaves
          // the transcript already on screen there, which is the whole point of
          // re-reading it underneath the reader rather than in place of them.
          // llmlint: ignore[changed_behavior_has_e2e] a conforming server cannot produce this state — it names a transcript in a timeline it just served, so a transcript it then refuses only comes from a peer that raced or broke between the two reads. App.test.tsx proves it against the real telemetry client at its browser boundary.
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Transcript unavailable</AlertTitle>
            <AlertDescription>
              <p>
                {transcript.error?.message ??
                  "The server recorded no transcript."}
              </p>
              {/* What the record itself holds, so nothing is lost while its
                  conversation cannot be read — inside this state, never as a
                  second view beside it. */}
              {row.rowKind === "event" &&
                Object.keys(row.event.fields ?? {}).length > 0 && (
                  <FieldList value={row.event.fields ?? {}} />
                )}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* SPIKE: a judge row opens its turn without the pinned chart, as the mockup does. */}
            <div
              className="conversation-timeline-sticky"
              hidden={judgeFocus !== undefined}
              ref={pinned}
            >
              <ConversationPlotHover>
                <ConversationTimeline
                  cursor={sync.cursor}
                  {...(focus === undefined
                    ? {}
                    : absence === undefined
                      ? { focus }
                      : // Expanded as a focus draws it, so the card keeps its
                        // height when the turn arrives and takes the focus.
                        { expanded: true })}
                  onSelectTurn={sync.scrollTo}
                  turns={[...plotted]}
                />
              </ConversationPlotHover>
            </div>
            <div className="conversation-turns" ref={sync.containerRef}>
              {absence !== undefined && missing !== undefined && (
                <AbsentTurn absence={absence} turnId={missing} />
              )}
              {turns.slice(0, visible).map((turn) => (
                <div
                  key={turn.id}
                  ref={(element) => sync.register(turn.id, element)}
                >
                  {judgeFocus !== undefined && (
                    <SpikeJudgeHeading
                      conversationId={conversationId}
                      turn={turn}
                      {...(judgeKinds.has(turn.id)
                        ? { judged: judgeKinds.get(turn.id) }
                        : {})}
                    />
                  )}
                  <SessionTurn
                    // SPIKE: remounted once a judge history lands, so a focus opens its item.
                    key={`${turn.id}:${turn.tools.length}`}
                    author={
                      judgeConversation
                        ? `${judgeKinds.get(turn.id)?.kind ?? "Judge"}${judgeKinds.get(turn.id)?.index === undefined ? "" : ` · on worker turn ${judgeKinds.get(turn.id)?.index}`}`
                        : author
                    }
                    {...(focus?.turnId === turn.id ? { focus } : {})}
                    turn={turn}
                  />
                  {judgeFocus === undefined && <SpikeTurnLink
                    conversationId={conversationId}
                    judge={judgeConversation}
                    settled={
                      conversationId.startsWith(JUDGED_DISPATCH) ||
                      conversationId.startsWith(THIRD_DISPATCH)
                    }
                    {...(judgeKinds.has(turn.id)
                      ? { judged: judgeKinds.get(turn.id) }
                      : {})}
                    turn={turn}
                  />}
                </div>
              ))}
              {/* Room below a single opened turn, so the item it opened on can be
                  placed below the pinned card however short the turn is — and
                  stays where it was placed when the turn replaces its note. */}
              {opened !== undefined && (
                <div aria-hidden="true" className="conversation-focus-room" />
              )}
            </div>
            {turns.length > visible && (
              <Button
                onClick={() => setVisible(visible + PAGE_SIZE)}
                size="sm"
                type="button"
                variant="outline"
              >
                Show more of {turns.length} turns
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * SPIKE: the link between a worker turn and the judge turn that ruled on it.
 * A worker turn `<session>.<n>` was judged by `<session>.judge.<n>`.
 */
function SpikeTurnLink({
  conversationId,
  judge,
  judged,
  settled,
  turn,
}: {
  readonly conversationId: string;
  readonly judge: boolean;
  readonly judged?: ReturnType<typeof judgeTurnKind>;
  readonly settled: boolean;
  readonly turn: Turn;
}) {
  const index = Number(turn.id.split(".").at(-1));
  if (judge) {
    const { kind, index: on } = judged ?? judgeTurnKind(turn);
    if (kind === "Verdict judge") {
      // The verdict judge follows one supervisor turn per worker turn, so its
      // 0-based index is the number of the worker turn it ruled on.
      const ruled = Number(turn.id.split(".").at(-1));
      return (
        <a className="spike-turn-link" href={`#${conversationId.replace(/\.judge$/, "")}.${ruled - 1}`}>
          ← Worker turn {ruled}, which this ruled on
        </a>
      );
    }
    if (kind !== "Supervisor" || on === undefined) return null;
    return (
      <a className="spike-turn-link" href={`#${conversationId.replace(/\.judge$/, "")}.${on - 1}`}>
        ← Worker turn {on}, which this judged
      </a>
    );
  }
  if (!settled || !Number.isFinite(index)) return null;
  return (
    <a className="spike-turn-link" href={`#${conversationId}.judge.${index}`}>
      Judged by supervisor turn {index + 1} →
    </a>
  );
}

/** SPIKE: a judge turn opened from the grouped list, headed as the list names it. */
function SpikeJudgeHeading({
  conversationId,
  judged,
  turn,
}: {
  readonly conversationId: string;
  readonly judged?: ReturnType<typeof judgeTurnKind>;
  readonly turn: Turn;
}) {
  const position = Number(turn.id.split(".").at(-1));
  const verdict = judged?.kind === "Verdict judge";
  const ruled = verdict ? position : position + 1;
  return (
    <div className="spike-judge-heading">
      <Gavel aria-hidden="true" className="size-3.5" />
      <strong>{verdict ? `Final verdict on turn ${ruled}` : `Judge ruling on turn ${ruled}`}</strong>
      <span>{verdict ? "verdict judge" : "supervisor"} · codex</span>
      <a href={`#${conversationId.replace(/\.judge$/, "")}.${ruled - 1}`}>
        Worker turn {ruled} →
      </a>
    </div>
  );
}

interface SessionTurnProps {
  readonly author: string;
  readonly focus?: ConversationFocus;
  readonly turn: Turn;
}

/** Whether two focuses name the same item: `focusOf` builds a new one each render. */
function sameFocus(was?: ConversationFocus, now?: ConversationFocus): boolean {
  return (
    was === now ||
    (was !== undefined &&
      now !== undefined &&
      was.turnId === now.turnId &&
      was.part === now.part &&
      was.eventIndex === now.eventIndex &&
      was.toolCallId === now.toolCallId)
  );
}

/**
 * One turn of an open session, drawn again only when the turn, its author or the
 * item marked in it changed.
 *
 * `TurnCard` highlights every unlabelled code block by trying every language
 * highlight.js knows, and the panel re-renders on every page and stream chunk of a
 * busy node, so an unchanged turn is not drawn again.
 */
const SessionTurn = memo(
  function SessionTurn({ author, focus, turn }: SessionTurnProps) {
    return (
      <>
        <RecorderCut turn={turn} />
        <TurnCard
          author={{ label: author }}
          {...(focus === undefined ? {} : { focus })}
          turn={turn}
        />
        <JudgeDecisions turn={turn} />
      </>
    );
  },
  (was, now) =>
    was.turn === now.turn &&
    was.author === now.author &&
    sameFocus(was.focus, now.focus),
);

function Verification({
  row,
  client,
  runId,
  reference,
}: {
  readonly row: TimelineRow;
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly reference?: TimelineReference;
}) {
  const detail = row.rowKind === "span" ? row.span.detail : undefined;
  const artifactId =
    detail?.artifact_id ??
    (reference?.kind === "gate_log" ? reference.value : undefined);
  return (
    <>
      <h3 className="detail-heading">Verification record</h3>
      <dl className="facts">
        <div>
          <dt>Result</dt>
          <dd>
            {detail?.ok === undefined
              ? (row.status ?? "in progress")
              : detail.ok
                ? "passed"
                : "failed"}
          </dd>
        </div>
      </dl>
      {detail?.output_tail && (
        <>
          <h3 className="detail-heading">Output</h3>
          <pre>{detail.output_tail}</pre>
        </>
      )}
      <StoredArtifact
        artifactId={artifactId}
        client={client}
        heading="Full log"
        missing="No readable log was recorded."
        noun="log"
        runId={runId}
        unreadable="No readable log was recorded."
      />
      <p className="detail-note">Verification {row.status ?? "in progress"}.</p>
    </>
  );
}

/**
 * The report a settled member left behind: the judge's ruling against each
 * acceptance criterion, the follow-ups the worker surfaced, and why it stopped.
 */
function SettledReport({
  artifactId,
  client,
  reference,
  row,
  runId,
}: {
  readonly artifactId: string;
  readonly client: TelemetryClient;
  readonly reference: TimelineReference;
  readonly row: TimelineRow;
  readonly runId: string;
}) {
  return (
    <>
      <StoredArtifact
        artifactId={artifactId}
        client={client}
        heading="Worker report"
        missing="This settlement recorded no report."
        noun="report"
        runId={runId}
        unreadable="This run kept no readable copy of that report."
      />
      <Recorded reference={reference} row={row} />
    </>
  );
}

function Publication({
  node,
  reference,
}: {
  readonly node: NodeView;
  readonly reference?: TimelineReference;
}) {
  const checks = node.detail?.verification.checks ?? [];
  const publication = node.detail?.publication;
  return (
    <>
      <h3 className="detail-heading">Publication</h3>
      {publication?.pr_url && (
        <Reference
          fallback=""
          reference={{ kind: "pr", value: publication.pr_url }}
        />
      )}
      {publication?.merged && publication.commit_url ? (
        <p className="detail-link">
          <a href={publication.commit_url} rel="noreferrer" target="_blank">
            Merged commit {publication.commit?.slice(0, 8)}{" "}
            <ExternalLink size={13} />
          </a>
        </p>
      ) : publication?.branch_url ? (
        <p className="detail-link">
          <a href={publication.branch_url} rel="noreferrer" target="_blank">
            Branch {publication.branch} <ExternalLink size={13} />
          </a>
        </p>
      ) : (
        !publication?.pr_url && (
          <Reference
            fallback="No publication was recorded."
            reference={reference}
          />
        )
      )}
      <h3 className="detail-heading">Observed checks</h3>
      {checks.length === 0 ? (
        <p className="detail-note">No checks were observed on this node.</p>
      ) : (
        <dl className="facts">
          {checks.map((check) => (
            <div key={check.name}>
              <dt>{check.name}</dt>
              <dd>
                {check.url ? (
                  <a href={check.url} rel="noreferrer" target="_blank">
                    {check.state}
                  </a>
                ) : (
                  check.state
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/**
 * The moment a planner redirected this node, read as what it changed.
 *
 * Whether the note reached the turn that was already running is the whole of it, so
 * it is the first line and it is a word rather than a flag: `live` means the worker
 * acted on the correction inside the turn a reader is looking at, and `deferred`
 * means it did not and the note is owed to the node's next dispatch. A refusal
 * carries the producing library's own reason, which is the sentence that says
 * whether waiting would have helped.
 */
function Redirection({
  redirection,
  row,
}: {
  readonly redirection: RedirectionRecord;
  readonly row: TimelineRow;
}) {
  return (
    <>
      <dl className="facts">
        <div>
          <dt>Delivery</dt>
          <dd>
            {redirection.delivered
              ? "Live — into the turn that was already running"
              : "Deferred — onto the node's next dispatch"}
          </dd>
        </div>
        {/* Only where the record says: a planner who asked for the turn to be
            left to end reads whether it was, and a record written before the
            engine said so has nothing to show here. */}
        {redirection.turn !== undefined && (
          <div>
            <dt>Turn</dt>
            <dd>
              {redirection.turn === "turn-end"
                ? "Left to end — the note reached it as it ended"
                : "Interrupted — its replacement opened on the note"}
            </dd>
          </div>
        )}
        <div>
          <dt>Redirected at</dt>
          <dd>
            <Timestamp at={row.startedAt} relative />
          </dd>
        </div>
        {/* Only where the record carries them. The two producers describe the
            same act from different sides — the lever names the member it
            addressed and the bytes it offered, the compiled edit names neither —
            so a row reading "Not recorded" would report a gap where there is
            only a different record. */}
        {redirection.member !== undefined && (
          <div>
            <dt>Member</dt>
            <dd>{redirection.member}</dd>
          </div>
        )}
        {redirection.input_bytes !== undefined && (
          <div>
            <dt>Note</dt>
            <dd>{redirection.input_bytes} bytes offered</dd>
          </div>
        )}
        <Author row={row} />
      </dl>
      {redirection.reason !== undefined && (
        <>
          <h3 className="detail-heading">Why it was not delivered</h3>
          <p className="detail-note">{redirection.reason}</p>
        </>
      )}
    </>
  );
}

/**
 * Who submitted a live edit, where the record says.
 *
 * One row, only on an edit that carries an author: the run's bus configuration
 * declares every author beside the planner and grants each its own operations,
 * so the planner's decision and an observer's self-applied fix are two different
 * facts about the same graph, and the word is shown exactly as the run recorded
 * it — this app keeps no list of the authors a host may declare.
 */
function Author({ row }: { readonly row: TimelineRow }) {
  const author = row.rowKind === "event" ? editAuthor(row.event) : undefined;
  if (author === undefined) return null;
  return (
    <div>
      <dt>Author</dt>
      <dd>{author}</dd>
    </div>
  );
}

/**
 * A refused edit, as the engine recorded it: who sent it, the one line it was
 * summarised in, the node it concerned, the command exactly as sent, and the whole
 * refusal — every line of it, read from the artifact the engine kept beside the
 * record through the read API's artifact route, never rebuilt from `reason`. A
 * record written before the engine kept one has its `reason` and nothing more.
 */
function Refusal({
  client,
  event,
  reference,
  runId,
}: {
  readonly client: TelemetryClient;
  readonly event: TimelineEvent;
  readonly reference?: TimelineReference;
  readonly runId: string;
}) {
  const fields = event.fields ?? {};
  const said = (key: string) =>
    typeof fields[key] === "string" ? fields[key] : undefined;
  const author = editAuthor(event);
  const summary = said("summary");
  const node = said("node");
  const reason = said("reason");
  const stated: readonly (readonly [string, string | undefined])[] = [
    ["Author", author],
    ["Summary", summary],
    ["Node", node],
  ];
  const kept =
    said("full_reason") !== undefined && reference?.kind === "refusal"
      ? servableArtifact(reference.value)
      : undefined;
  return (
    <section aria-label="Refused edit" className="refusal">
      <dl className="facts">
        <div>
          <dt>Recorded at</dt>
          <dd>
            <Timestamp at={event.at} relative />
          </dd>
        </div>
        {stated
          .filter(([, value]) => value !== undefined)
          .map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        {fields.command !== undefined && (
          <div>
            <dt>Command as sent</dt>
            <dd>
              <FieldValue value={fields.command} />
            </dd>
          </div>
        )}
      </dl>
      {kept === undefined ? (
        reason === undefined ? (
          <p className="detail-note">The record holds no reason.</p>
        ) : (
          <figure className="refusal-figure">
            <figcaption className="detail-heading">Refusal</figcaption>
            <pre className="refusal-text">{reason}</pre>
          </figure>
        )
      ) : (
        <FullRefusal
          artifactId={kept}
          client={client}
          cut={fields.full_reason_truncated === true}
          runId={runId}
        />
      )}
    </section>
  );
}

/**
 * The fields {@link Refusal} states, which the record's remaining fields leave out:
 * `full_reason` is where the complete refusal is kept, not something to read.
 */
const REFUSAL_SHOWN: ReadonlySet<string> = new Set([
  "author",
  "summary",
  "node",
  "command",
  "reason",
  "full_reason",
  "full_reason_truncated",
]);

/** The complete refusal the engine kept, read once through the artifact route. */
function FullRefusal({
  artifactId,
  client,
  cut,
  runId,
}: {
  readonly artifactId: string;
  readonly client: TelemetryClient;
  readonly cut: boolean;
  readonly runId: string;
}) {
  // A run id never holds a slash, so the pair cannot spell another pair; a kept
  // refusal does not change, so nothing invalidates the read.
  const artifact = useRead(
    `${runId}/${artifactId}`,
    () => client.getArtifact(runId, artifactId),
    0,
  );
  const content = artifact.value?.content;
  return (
    <>
      {cut && (
        <p className="detail-note" role="note">
          The hook wrote more than the engine reads, so its output was cut at
          the engine's read bound.
        </p>
      )}
      {artifact.loading ? (
        <p aria-live="polite" className="detail-note">
          Loading the complete refusal…
        </p>
      ) : content === undefined ? (
        <p aria-live="polite" className="detail-note">
          This run holds no readable copy of the complete refusal.
        </p>
      ) : (
        <figure className="refusal-figure">
          <figcaption className="detail-heading">Complete refusal</figcaption>
          <pre className="refusal-text">{content}</pre>
        </figure>
      )}
    </>
  );
}

/**
 * What one surface said, in the fields the record carried.
 *
 * The kind is the host's own word, shown as spelled: the engine relays any
 * well-formed kind a host raises, so a kind this app has never seen is a surface
 * to draw rather than a record to fall back from. Whether it holds dependents
 * back is the fact a reader scanning a paused run came for, so it is stated as a
 * sentence rather than a flag — and only where the record said either way.
 */
function SurfaceRecord({
  surface,
  row,
}: {
  readonly surface: TimelineSurface;
  readonly row: TimelineRow;
}) {
  const stated: readonly (readonly [string, string | undefined])[] = [
    ["Kind", surface.kind],
    ["Raised by", surface.source],
    [
      "Blocking",
      surface.blocking === undefined
        ? undefined
        : surface.blocking
          ? "yes — dependents wait on the answer"
          : "no — nothing waits on it",
    ],
  ];
  const facts = stated.filter(([, value]) => value !== undefined);
  return (
    <>
      <dl className="facts">
        <div>
          <dt>Recorded at</dt>
          <dd>
            <Timestamp at={row.startedAt} relative />
          </dd>
        </div>
        {facts.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {surface.message !== undefined && (
        <>
          <h3 className="detail-heading">Message</h3>
          <p className="detail-note">{surface.message}</p>
        </>
      )}
    </>
  );
}

/** Whatever the timeline recorded, in the fields the contract gives it. */
function Recorded({
  row,
  reference,
}: {
  readonly row: TimelineRow;
  readonly reference?: TimelineReference;
}) {
  if (row.rowKind === "event") {
    return (
      <>
        <dl className="facts">
          <div>
            <dt>Recorded at</dt>
            <dd>
              <Timestamp at={row.startedAt} relative />
            </dd>
          </div>
        </dl>
        {reference !== undefined && (
          <Reference reference={reference} fallback="No recorded artifact." />
        )}
      </>
    );
  }
  const located = row.rowKind === "group" ? undefined : row;
  const rollup =
    row.rowKind === "span" && row.span.count !== undefined
      ? `${row.span.count} records`
      : undefined;
  const held = (row.rowKind === "span" ? row.span.reasons : undefined) ?? [];
  return (
    <>
      <dl className="facts">
        {/* Both stamps are read as ages here — how recent this record is, is what a
            reader wants from a fact list — with the moment itself one hover away and
            the recorded ISO value on the element's own `datetime`. */}
        <div>
          <dt>Recorded at</dt>
          <dd>
            <Timestamp at={row.startedAt} relative />
          </dd>
        </div>
        {row.rowKind === "span" &&
          (row.endedAt !== null || row.status === "running") && (
            <div>
              <dt>Ended</dt>
              <dd>
                {row.endedAt === null ? (
                  "Still running"
                ) : (
                  <Timestamp at={row.endedAt} relative />
                )}
              </dd>
            </div>
          )}
        <div>
          <dt>Status</dt>
          <dd>{row.status ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {row.durationMs === null
              ? "Not recorded"
              : formatDuration(row.durationMs)}
          </dd>
        </div>
        {rollup !== undefined && (
          <div>
            <dt>Aggregated</dt>
            <dd>{rollup}</dd>
          </div>
        )}
        {/* Why the loop was not running this node, one term per thing holding it
            at that moment. Listed rather than joined into the row's own phrase,
            because this is where a reader who wants the whole set — the three
            nodes that were ahead of it, by name — comes to read it. */}
        {held.length > 0 && (
          <div>
            <dt>Waiting on</dt>
            <dd>{held.map(holdReasonLabel).join(" and ")}</dd>
          </div>
        )}
        <div>
          <dt>Step</dt>
          <dd>{stepOf(located) ?? "None"}</dd>
        </div>
        <Author row={row} />
      </dl>
      <h3 className="detail-heading">Reference</h3>
      <Reference
        fallback={
          // A dispatch names its conversation whenever the run recorded one, so a
          // dispatch naming none is one whose transcript this run does not hold —
          // said in words, rather than left as a panel with no conversation in it.
          row.rowKind === "span" && row.span.kind === "dispatch"
            ? "No transcript was recorded for this dispatch."
            : "This item points at no recorded artifact."
        }
        reference={reference}
      />
    </>
  );
}

function Reference({
  reference,
  fallback,
}: {
  readonly reference?: TimelineReference;
  readonly fallback: string;
}) {
  if (reference === undefined) return <p className="detail-note">{fallback}</p>;
  if (reference.value.startsWith("http"))
    return (
      <p className="detail-link">
        <a href={reference.value} rel="noreferrer" target="_blank">
          {reference.kind === "pr"
            ? changeRequestId(reference.value)
            : reference.value}{" "}
          <ExternalLink size={13} />
        </a>
      </p>
    );
  return (
    <p className="detail-note">
      <span className="detail-reference-kind">{reference.kind}</span>
      <code>{reference.value}</code>
    </p>
  );
}

/**
 * What the served timeline says the session behind this row has recorded.
 *
 * The server folds one dispatch span per relayed session, carrying that
 * transcript's state, its end, and one event per recorded turn — so this string moves
 * exactly when the transcript does. It is what decides whether an open transcript is
 * re-read at all: a session that has stopped recording keeps one value forever, and no
 * amount of activity elsewhere in the run costs a read of it.
 *
 * A row that is one recorded turn cannot grow, so its own identity is its record.
 */
function transcriptFingerprint(row: TimelineRow): string {
  if (row.rowKind !== "span") return row.id;
  const last = row.span.events.at(-1);
  return [
    row.span.id,
    row.span.status ?? "",
    row.span.ended_at ?? "",
    row.span.events.length,
    last?.id ?? "",
    last?.at ?? "",
    last?.status ?? "",
  ].join("|");
}

/**
 * How many turns this panel has to show: one, for a row that is a single recorded
 * turn, and the whole transcript otherwise. Paging decides how many of them reach the
 * page; it is this that an appended turn lengthens.
 */
function availableTurnCount(
  row: TimelineRow | undefined,
  transcript: Transcript,
): number {
  if (transcript.conversation === undefined) return 0;
  if (row?.rowKind === "event") return 1;
  return transcript.conversation.conversation.turns.length;
}

/** The redirection one row is, when it is one. Only an event row can be. */
function redirectionOf(row: TimelineRow): RedirectionRecord | undefined {
  return row.rowKind === "event" ? row.event.redirection : undefined;
}

/**
 * The release facts one row carried, when it carried any.
 *
 * Only an event row can: a release is a moment the run recorded rather than an
 * interval it spent, so the six kinds are events and never spans.
 */
function releaseOf(row: TimelineRow): TimelineRelease | undefined {
  return row.rowKind === "event" ? row.event.release : undefined;
}

/**
 * What a surface record said, when the row is one. Only an event row can be: a
 * surface is a moment the run raised something, never an interval.
 */
function surfaceOf(row: TimelineRow): TimelineSurface | undefined {
  return row.rowKind === "event" ? row.event.surface : undefined;
}

/** Whether a row opens in the conversation view alone: its reference is one. */
function opensConversation(reference: TimelineReference | undefined): boolean {
  return reference?.kind === "conversation";
}

function referenceOf(row: TimelineRow): TimelineReference | undefined {
  if (row.rowKind === "span") return row.span.reference;
  if (row.rowKind === "event") return row.event.reference;
  return undefined;
}

function stepOf(row?: TimelineRow): string | undefined {
  if (row?.rowKind === "span") return row.span.step_id;
  if (row?.rowKind === "event") return row.event.step_id;
  return undefined;
}

function isVerification(row: TimelineRow): boolean {
  return row.kind === "verification" || row.kind.startsWith("verification-");
}

function isPublication(
  row: TimelineRow,
  reference?: TimelineReference,
): boolean {
  return (
    reference?.kind === "pr" ||
    row.kind === "publication" ||
    row.kind.startsWith("pr-") ||
    row.kind.startsWith("publication-")
  );
}

type Attribution = DagConversation["attribution"];

/**
 * What this session is called, from the lane vocabulary that names it in the plot.
 *
 * The word is not chosen here: `dispatchRoleLabel` is what names the lane the
 * session is plotted in — the member word the run's own graph declared, or the
 * party it ran as where the run recorded no declared member — so an opened
 * conversation cannot head itself with one word while the segment that opened it
 * carries another.
 */
function roleLabel(
  agentRole: AgentRole | undefined,
  transportRole: Attribution["transportRole"],
): string {
  return dispatchRoleLabel(agentRole, transportRole);
}

/**
 * Everything one record holds, below whatever its kind is shown as: the readings a
 * kind needs said in its own words — who resolved a human item, why a node was
 * held, what an edit did, which command ran, where a surface stands — and then
 * every field of the record, nested as it was recorded.
 */
function RecordContent({
  client,
  event,
  shown,
}: {
  readonly client: TelemetryClient;
  readonly event: TimelineEvent;
  /**
   * The fields the view above already states, left out here; where nothing is left
   * the block is not drawn at all rather than saying the record holds nothing.
   */
  readonly shown?: ReadonlySet<string>;
}) {
  const fields =
    shown === undefined
      ? (event.fields ?? {})
      : Object.fromEntries(
          Object.entries(event.fields ?? {}).filter(([key]) => !shown.has(key)),
        );
  if (shown !== undefined && Object.keys(fields).length === 0) return null;
  const argv =
    event.kind === "command-started" ? argvOf(fields.command) : undefined;
  return (
    <section aria-label="Recorded fields" className="record-content">
      {event.surface_state !== undefined && (
        <SurfaceSteps state={event.surface_state} />
      )}
      {event.kind === "human-attested" && (
        <AttestedItem client={client} item={fields.item} />
      )}
      {(event.kind === "node-held" || event.kind === "node-unheld") && (
        <HoldReasons event={event} />
      )}
      {(event.kind === "edit-committed" ||
        event.kind === "command-accepted") && (
        <Operations operations={fields.operations} />
      )}
      {argv !== undefined && (
        <dl className="facts">
          <div>
            <dt>Command</dt>
            <dd>
              <code className="command-line">{commandLine(argv)}</code>
            </dd>
          </div>
        </dl>
      )}
      {Object.keys(fields).length === 0 ? (
        <p className="detail-note">This record holds no fields.</p>
      ) : (
        <>
          <h3 className="detail-heading">Recorded fields</h3>
          <FieldList
            value={
              argv === undefined
                ? fields
                : Object.fromEntries(
                    Object.entries(fields).filter(([key]) => key !== "command"),
                  )
            }
          />
        </>
      )}
    </section>
  );
}

/** A wire key as a reader reads it: `timeout_seconds` is "Timeout seconds". */
export function fieldLabel(key: string): string {
  const words = key.replaceAll(/[_-]+/gu, " ").trim();
  return words.length === 0
    ? key
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function FieldList({
  value,
}: {
  readonly value: Readonly<Record<string, unknown>>;
}) {
  return (
    <dl className="facts record-fields">
      {Object.entries(value).map(([key, field]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>
            <FieldValue value={field} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One recorded value, readably: text as text, a list as the list it is and an
 * object as nested label and value pairs, however deep — never the JSON spelling
 * of either.
 */
function FieldValue({ value }: { readonly value: unknown }) {
  if (value === null || value === undefined)
    return <span className="record-none">None</span>;
  if (typeof value === "string")
    return <span className="record-text">{value}</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <>{String(value)}</>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="record-none">None</span>;
    return (
      <ol className="record-list">
        {value.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a recorded list's identity is its position.
          <li key={index}>
            <FieldValue value={entry} />
          </li>
        ))}
      </ol>
    );
  }
  const fields = objectOf(value);
  if (fields !== undefined) return <FieldList value={fields} />;
  return <>{String(value)}</>;
}

function objectOf(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function textOf(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

/**
 * Where one surface stands, step by step: when it was raised, when a reader took
 * it, and when it was answered and with what — folded by the server from every
 * record of the surface, whichever of them this row is.
 */
function SurfaceSteps({
  state,
}: {
  readonly state: NonNullable<TimelineEvent["surface_state"]>;
}) {
  const { status } = surfaceStatus(state);
  const reply = state.reply;
  const steps: readonly (readonly [string, string | undefined])[] = [
    ["Queued", state.queued_at],
    ["Read", state.read_at],
    ["Answered", state.replied_at],
  ];
  return (
    <>
      <h3 className="detail-heading">Surface {state.id}</h3>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{status}</dd>
        </div>
        {steps.map(([step, at]) => (
          <div key={step}>
            <dt>{step}</dt>
            <dd>{at === undefined ? "Not yet" : <Timestamp at={at} />}</dd>
          </div>
        ))}
        {state.correlation !== undefined && (
          <div>
            <dt>Correlation</dt>
            <dd>
              <code>{state.correlation}</code>
            </dd>
          </div>
        )}
      </dl>
      {reply !== undefined && (
        <>
          <h3 className="detail-heading">Reply</h3>
          <FieldList value={reply} />
        </>
      )}
    </>
  );
}

/**
 * Who resolved the human item that attested a node, in the words the engine
 * recorded: the person, whom they acted for, whose words those were, the choice
 * they picked by its title and what they wrote. The title is read from the item
 * itself, because the record names the choice by its id.
 */
function AttestedItem({
  client,
  item,
}: {
  readonly client: TelemetryClient;
  readonly item: unknown;
}) {
  const attested = objectOf(item);
  const id = textOf(attested, "id");
  const resolution = objectOf(attested?.resolution);
  const choice = textOf(resolution, "choice");
  const read = useRead(
    choice === undefined ? undefined : id,
    () => client.getHumanItem(id ?? ""),
    0,
  );
  if (attested === undefined)
    return (
      <p className="detail-note">
        Attested with no human item resolved: the planner attested it itself.
      </p>
    );
  const title = read.value?.item.choices?.find(
    (offered) => offered.id === choice,
  )?.title;
  const facts: readonly (readonly [string, string | undefined])[] = [
    ["Item", id],
    ["Action", textOf(attested, "action")],
    ["By", textOf(resolution, "actor")],
    ["On behalf of", textOf(resolution, "on_behalf_of")],
    ["Provenance", textOf(resolution, "provenance") ?? "manager"],
    [
      "Choice",
      choice === undefined
        ? undefined
        : title === undefined
          ? choice
          : `${title} (${choice})`,
    ],
    ["Reason", textOf(resolution, "reason")],
  ];
  const text = textOf(resolution, "text");
  return (
    <>
      <h3 className="detail-heading">Human item</h3>
      <dl className="facts">
        {facts
          .filter(([, value]) => value !== undefined)
          .map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {text !== undefined && (
        <>
          <h3 className="detail-heading">Words</h3>
          <p className="detail-note record-text">{text}</p>
        </>
      )}
    </>
  );
}

/** Why a node was held, or what released it, one reason a line. */
function HoldReasons({ event }: { readonly event: TimelineEvent }) {
  const reasons = holdReasonsOf(event);
  if (reasons.length === 0) return null;
  return (
    <>
      <h3 className="detail-heading">
        {event.kind === "node-held" ? "Held because" : "Released from"}
      </h3>
      <ul className="hold-reasons">
        {reasons.map((reason, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a reason's identity is its place in the record.
          <li key={index}>{holdReasonLabel(reason)}</li>
        ))}
      </ul>
    </>
  );
}

/** What an edit compiled to, one operation a block, each named by its kind. */
function Operations({ operations }: { readonly operations: unknown }) {
  if (!Array.isArray(operations) || operations.length === 0) return null;
  return (
    <>
      <h3 className="detail-heading">Operations</h3>
      <ol className="record-operations">
        {operations.map((operation, index) => {
          const fields = objectOf(operation);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: an operation's identity is its place in the edit.
            <li key={index}>
              <strong>
                {textOf(fields, "kind") ?? `Operation ${index + 1}`}
              </strong>
              {fields === undefined ? (
                <FieldValue value={operation} />
              ) : (
                <FieldList value={fields} />
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
