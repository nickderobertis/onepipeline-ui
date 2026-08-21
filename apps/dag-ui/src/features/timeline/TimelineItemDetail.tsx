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
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { ExternalLink, ListTree, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { NodeView } from "../../lib/run-model";
import { Timestamp } from "../../lib/Timestamp";
import { formatDuration } from "../../lib/time";
import { ItemHeading } from "./item-reading";
import {
  dispatchRoleLabel,
  LLMLINT_TRANSPORT,
  type TimelineRow,
} from "./timeline-model";
import { useConversation } from "./useConversation";
import { useStickyBottom } from "./useStickyBottom";

/** How many turns of a long transcript are handed to the reader at once. */
const PAGE_SIZE = 25;

/** How much of a stored artifact is shown before the reader asks for the rest. */
const ARTIFACT_PREVIEW_CHARS = 4000;

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
function StoredArtifact({
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
function servableArtifact(artifactId?: string): string | undefined {
  if (artifactId === undefined || /[/?#]/u.test(artifactId)) return undefined;
  return artifactId;
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
        <div>
          <dt>Step</dt>
          <dd>{stepOf(located) ?? "None"}</dd>
        </div>
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
 * The word is not chosen here: `dispatchRoleLabel` derives it from the lane the role
 * is plotted in, so an opened conversation cannot head itself with one word while the
 * segment that opened it carries another. It is keyed
 * on the contract's closed `agentRole` enum, so a role added there fails to compile
 * until it has been given a lane rather than rendering as its raw identifier.
 */
function roleLabel(
  agentRole: AgentRole,
  transportRole: Attribution["transportRole"],
): string {
  // Nested lint work is grouped under its worker, so its transport is what names it.
  return dispatchRoleLabel(
    transportRole === LLMLINT_TRANSPORT ? LLMLINT_TRANSPORT : agentRole,
  );
}
