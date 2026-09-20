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
  DagConversation,
  Redirection as RedirectionRecord,
  TimelineReference,
  TimelineRelease,
  TimelineSurface,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { ExternalLink, ListTree, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { NodeView } from "../../lib/run-model";
import { Timestamp } from "../../lib/Timestamp";
import { formatDuration } from "../../lib/time";
import { ItemHeading } from "./item-reading";
import { ReleaseRecord } from "./release";
import { StoredArtifact, servableArtifact } from "./StoredArtifact";
import {
  dispatchRoleLabel,
  editAuthor,
  holdReasonLabel,
  type TimelineRow,
} from "./timeline-model";
import { useConversation } from "./useConversation";
import { useStickyBottom } from "./useStickyBottom";

/** How many turns of a long transcript are handed to the reader at once. */
const PAGE_SIZE = 25;

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
  const transcript = useConversation(
    client,
    runId,
    conversationId,
    row === undefined ? undefined : transcriptFingerprint(row),
  );
  const stickToLastLine = useStickyBottom(
    conversationId,
    availableTurnCount(row, transcript),
  );

  return (
    <section aria-label="Timeline item detail" className="timeline-detail">
      <ScrollArea className="h-full">
        <div className="p-[22px] max-sm:p-3" ref={stickToLastLine}>
          {row === undefined ? (
            <div className="detail-placeholder">
              <ListTree size={30} />
              <p>Select an item in the timeline to read what it recorded.</p>
            </div>
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
                transcript={transcript}
              />
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
  transcript,
}: {
  readonly row: TimelineRow;
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly node?: NodeView;
  readonly reference?: TimelineReference;
  readonly transcript: Transcript;
}) {
  // Before the conversation reading: a redirection names the session it happened
  // in, and opening it as that session's whole transcript would answer a question
  // nobody asked in place of the one they did.
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
  if (reference?.kind === "conversation")
    return <Session row={row} transcript={transcript} />;
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
  if (
    reference?.kind === "oneharness_session" &&
    servableArtifact(reference.value) !== undefined
  )
    return (
      <HarnessSession
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

/** A dispatched session: the turn that was opened, or the whole conversation. */
function Session({
  row,
  transcript,
}: {
  readonly row: TimelineRow;
  readonly transcript: Transcript;
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const availableTurns = transcript.conversation?.conversation.turns ?? [];
  const turns: readonly Turn[] =
    row.rowKind === "event"
      ? availableTurns.filter(({ id }) => id === row.event.id)
      : availableTurns;
  const sync = useTimelineScrollSync(
    turns.map((turn) => ({ id: turn.id, time: Date.parse(turn.timestamp) })),
  );
  if (transcript.loading)
    return (
      <div aria-live="polite" className="loading-inline">
        <Skeleton className="h-2 w-40" />
        <Skeleton className="h-2 w-24" />
        Loading transcript…
      </div>
    );
  // Only when there is nothing to read: a revalidation that failed leaves the
  // transcript already on screen there, which is the whole point of re-reading it
  // underneath the reader rather than in place of them.
  // llmlint: ignore[changed_behavior_has_e2e] a conforming server cannot produce this state — it names a transcript in a timeline it just served, so a transcript it then refuses only comes from a peer that raced or broke between the two reads. App.test.tsx proves it against the real telemetry client at its browser boundary.
  if (transcript.conversation === undefined)
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Transcript unavailable</AlertTitle>
        <AlertDescription>
          {transcript.error?.message ?? "The server recorded no transcript."}
        </AlertDescription>
      </Alert>
    );
  const { conversation, attribution } = transcript.conversation;
  const author = roleLabel(attribution.agentRole, attribution.transportRole);
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
              {attribution.persona ? ` · ${attribution.persona}` : ""}
            </p>
            <h4>{conversation.name}</h4>
          </div>
          <StatusBadge state={conversation.state} />
        </header>
        <Separator className="my-2.5" />
        <div className="conversation-timeline-sticky">
          <ConversationTimeline
            cursor={sync.cursor}
            onSelectTurn={sync.scrollTo}
            turns={[...turns]}
          />
        </div>
        {/* llmlint: ignore[changed_behavior_has_e2e] the same unproducible state as
            above, from the other side: a served timeline names this turn, so only a
            history store rewritten between the two reads drops it. */}
        {turns.length === 0 ? (
          <p className="detail-note">
            This turn is no longer part of the recorded transcript.
          </p>
        ) : (
          <>
            <div ref={sync.containerRef}>
              {turns.slice(0, visible).map((turn) => (
                <div
                  key={turn.id}
                  ref={(element) => sync.register(turn.id, element)}
                >
                  <TurnCard author={{ label: author }} turn={turn} />
                  <JudgeDecisions turn={turn} />
                </div>
              ))}
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

/**
 * The conversation one oneharness invocation had: the prompt it ran, the text it
 * finished on, what it cost — what the agent actually did, which raw event kinds
 * are a poor substitute for.
 */
function HarnessSession({
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
        heading="Oneharness conversation"
        missing="This record named no conversation."
        noun="conversation"
        runId={runId}
        unreadable="The history store holds no readable copy of that conversation."
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
        fallback="This item points at no recorded artifact."
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
          {reference.value} <ExternalLink size={13} />
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
