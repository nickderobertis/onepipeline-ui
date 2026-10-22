import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  ScrollArea,
  Skeleton,
  Textarea,
} from "@oneharness/ui";
import type {
  ChannelQueue,
  ChannelSurface,
  Decision,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { CheckCheck, Inbox, MessageSquarePlus } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { Outcome } from "../../lib/Outcome";
import { Timestamp } from "../../lib/Timestamp";
import { formatDurationSeconds, isoOfMillis } from "../../lib/time";
import { useRead } from "../../lib/useRead";
import { type CurrentOverrides, ReplyComposer } from "./ReplyComposer";
import { opOf } from "./reply-shortcuts";
import { useChannelConversation } from "./useChannelConversation";
import { useVerb, type Verb } from "./useVerb";

/**
 * The run's channel: the queue as the engine keeps it, the one consumer of it,
 * and the two ways of writing to it.
 *
 * The queue is `GET .../channel`, a reading that consumes nothing. **Next** is
 * the channel's only consumer and shows what it claimed. The composer sends an
 * envelope as typed; **Surface** raises one under a kind; and a ready human
 * action the graph shows can be attested from here. Every receipt and every
 * refusal is shown as the API returned it.
 *
 * Available on every run, a planning run included: the UI launches nothing and
 * authors no plan, and a reply is a post-launch route.
 */
export function ChannelView({
  client,
  runId,
  filter,
  decisions,
  observedAt,
  invalidations,
  overrides,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly filter: string;
  /** The decision points the graph holds, for the human actions among them. */
  readonly decisions: readonly Decision[];
  /** When the graph was read, so a surface's age is against the payload's clock. */
  readonly observedAt: string;
  readonly invalidations: number;
  /** The graph overrides the run holds now, which the composer offers to load. */
  readonly overrides?: CurrentOverrides;
}) {
  const { queue, wrote } = useChannelQueue(client, runId, invalidations);
  const next = useVerb(
    "Next",
    useCallback(() => client.claimNext(runId, filter), [client, runId, filter]),
    wrote,
  );

  return (
    <ScrollArea className="h-full">
      <div className="channel-view">
        <section
          aria-labelledby="channel-queue-heading"
          className="channel-section"
        >
          <div className="section-heading channel-heading">
            <h3 id="channel-queue-heading">
              <Inbox size={15} /> Channel queue
            </h3>
            <Button
              disabled={next.pending}
              onClick={() => void next.run()}
              size="sm"
              type="button"
            >
              Next
            </Button>
          </div>
          {queue.error && (
            <Outcome
              label="Channel"
              outcome={{
                kind: "refused",
                title: "Channel",
                error: queue.error,
              }}
            />
          )}
          {queue.value === undefined && queue.loading ? (
            <div aria-live="polite" className="loading-state">
              <Skeleton className="h-2 w-48" />
              Loading channel…
            </div>
          ) : queue.value ? (
            <Queue observedAt={observedAt} queue={queue.value} />
          ) : null}
          <Outcome label="Next" outcome={next.outcome} />
        </section>
        <Attestations
          client={client}
          decisions={decisions}
          onWrote={wrote}
          runId={runId}
        />
        <ReplyComposer
          client={client}
          onSent={wrote}
          overrides={overrides}
          runId={runId}
        />
        <SurfaceForm client={client} onRaised={wrote} runId={runId} />
      </div>
    </ScrollArea>
  );
}

/**
 * The queue as `GET .../channel` serves it, read again on the stream and after
 * every write made from this view — a surface raised, a claim, a reply, an
 * attest — so what the reader wrote is on screen without waiting for the stream
 * to say so.
 */
function useChannelQueue(
  client: TelemetryClient,
  runId: string,
  invalidations: number,
) {
  //: Bumped after every write here, so the queue re-reads without waiting on the stream.
  const [writes, setWrites] = useState(0);
  const queue = useRead(
    runId,
    () => client.getChannel(runId),
    invalidations + writes,
  );
  const wrote = useCallback(() => setWrites((current) => current + 1), []);
  return { queue, wrote };
}

/**
 * Questions and answers joined by the correlation the producer recorded.
 * Consumption is separate from answering: a claimed surface with no correlated
 * reply still waits for an answer. Uncorrelated replies remain readable below.
 */
function Queue({
  queue,
  observedAt,
}: {
  readonly queue: ChannelQueue;
  readonly observedAt: string;
}) {
  const { exchanges, otherReplies } = useChannelConversation(queue);
  return (
    <div className="channel-queue">
      <section aria-label="Surfaces" className="channel-list">
        <h4>Conversation</h4>
        {queue.surfaces.length === 0 && (
          <p className="channel-empty">No surfaces yet.</p>
        )}
        <ul>
          {exchanges.map(({ surface, replies }) => (
            <li key={surface.id} aria-label={`Surface ${surface.id}`}>
              <SurfaceCard observedAt={observedAt} surface={surface} />
              {replies.length === 0 ? (
                <p className="channel-empty">Waiting for reply</p>
              ) : (
                replies.map((reply) => (
                  <ReplyCard key={reply.id} reply={reply} />
                ))
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Replies" className="channel-list">
        <h4>Other replies</h4>
        {otherReplies.map((reply) => (
          <ReplyCard key={reply.id} reply={reply} />
        ))}
      </section>
      <section aria-label="Queued commands" className="channel-list">
        <h4>Queued commands</h4>
        {queue.commands.length === 0 ? (
          <p className="channel-empty">Nothing awaits the reconciler.</p>
        ) : (
          <ul>
            {queue.commands.map((envelope) => (
              <li key={envelope.id}>
                <Card className="channel-card">
                  <CardContent>
                    <div className="channel-card-head">
                      <Badge variant="outline">envelope {envelope.id}</Badge>
                      <Badge variant="secondary">
                        {envelope.author ?? "planner"}
                      </Badge>
                      <span>{envelope.commands.map(opOf).join(", ")}</span>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Command outcomes" className="channel-list">
        <h4>Command outcomes</h4>
        {queue.outcomes.length === 0 ? (
          <p className="channel-empty">
            The reconciler has answered nothing yet.
          </p>
        ) : (
          <ul>
            {queue.outcomes.map((outcome) => (
              <li key={outcome.id}>
                <Card className="channel-card">
                  <CardContent>
                    <div className="channel-card-head">
                      <Badge variant="outline">envelope {outcome.id}</Badge>
                      <Badge
                        variant={outcome.applied ? "default" : "destructive"}
                      >
                        {outcome.applied ? "applied" : "not applied"}
                      </Badge>
                    </div>
                    {outcome.reason !== undefined && (
                      <pre className="verb-text">{outcome.reason}</pre>
                    )}
                    {outcome.results !== undefined &&
                      outcome.results.length > 0 && (
                        <pre className="verb-text">
                          {JSON.stringify(outcome.results, null, 2)}
                        </pre>
                      )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Message({
  text,
  children,
  meta,
  label,
}: {
  readonly text: string;
  readonly meta: React.ReactNode;
  readonly label: string;
  readonly children?: React.ReactNode;
}) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  return (
    <details aria-label={label} className="channel-message-details">
      <summary aria-label={`${label}: ${firstLine}`}>
        <span className="channel-message-meta">{meta}</span>
        <span className="channel-message-preview">{firstLine}…</span>
      </summary>
      <pre className="verb-text">{text}</pre>
      {children}
    </details>
  );
}

function ReplyCard({
  reply,
}: {
  readonly reply: ChannelQueue["replies"][number];
}) {
  const text =
    typeof reply.reply.message === "string"
      ? reply.reply.message
      : "Reply without message";
  return (
    <Card className="channel-card py-2">
      <CardContent>
        <Message
          label={`Reply ${reply.id} message`}
          text={text}
          meta={
            <>
              <Badge variant="outline">reply {reply.id}</Badge>
              <Timestamp at={isoOfMillis(reply.at)} relative />
            </>
          }
        >
          <details aria-label={`Raw envelope for reply ${reply.id}`}>
            <summary>Raw envelope</summary>
            <pre className="verb-text">
              {JSON.stringify(reply.reply, null, 2)}
            </pre>
          </details>
        </Message>
      </CardContent>
    </Card>
  );
}

/** One surface: its kind, source, blocking flag and age, then what it said. */
function SurfaceCard({
  surface,
  observedAt,
}: {
  readonly surface: ChannelSurface;
  readonly observedAt: string;
}) {
  const ageSeconds = Math.max(
    0,
    (Date.parse(observedAt) - surface.queued_at) / 1000,
  );
  return (
    <Card className="channel-card py-2">
      <CardContent>
        <Message
          label={`Surface ${surface.id} message`}
          text={surface.message}
          meta={
            <>
              <Badge>{surface.kind}</Badge>
              <Badge variant="secondary">from {surface.source}</Badge>
              {surface.blocking ? (
                <Badge variant="destructive">blocking</Badge>
              ) : (
                <Badge variant="outline">non-blocking</Badge>
              )}
              {surface.workstream !== undefined && (
                <Badge variant="outline">node {surface.workstream}</Badge>
              )}
              <span className="channel-age">
                surface {surface.id} · {formatDurationSeconds(ageSeconds)} old
              </span>
            </>
          }
        />
      </CardContent>
    </Card>
  );
}

/**
 * Every ready human action the graph shows, each with its attest.
 *
 * The graph's `decisions` carry every decision point holding a subtree back;
 * the ones a person clears are the human actions, and `attest` takes the
 * reference the decision carries — the node's id — exactly as
 * `onepipeline attest RUN REF` does.
 */
function Attestations({
  client,
  runId,
  decisions,
  onWrote,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly decisions: readonly Decision[];
  readonly onWrote: () => void;
}) {
  const attest = useAttest(client, runId, onWrote);
  return (
    <section aria-labelledby="attest-heading" className="channel-section">
      <h3 id="attest-heading">
        <CheckCheck size={15} /> Ready human actions
      </h3>
      {decisions.length === 0 ? (
        <p className="channel-empty">No decision point is holding the graph.</p>
      ) : (
        <ul className="attest-list">
          {decisions.map((decision) => (
            <li className="attest-row" key={decision.id}>
              <span>
                <Badge variant="outline">{decision.kind}</Badge>{" "}
                <span className="attest-reference">{decision.id}</span>
                {decision.unblocks.length > 0 && (
                  <span className="channel-age">
                    {" "}
                    · unblocks {decision.unblocks.join(", ")}
                  </span>
                )}
              </span>
              <Button
                disabled={attest.pending}
                onClick={() => void attest.run(decision.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                Attest {decision.id}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Outcome label="Attest" outcome={attest.outcome} />
    </section>
  );
}

/** Raise a surface: a kind under the engine's grammar, and a message. */
function SurfaceForm({
  client,
  runId,
  onRaised,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly onRaised: () => void;
}) {
  const id = useId();
  const { kind, setKind, message, setMessage, raise } = useSurfaceForm(
    client,
    runId,
    onRaised,
  );
  return (
    <section aria-labelledby={`${id}-heading`} className="channel-section">
      <h3 id={`${id}-heading`}>
        <MessageSquarePlus size={15} /> Surface
      </h3>
      <div className="composer-fields">
        <div className="composer-field">
          <Label htmlFor={`${id}-kind`}>Kind</Label>
          <Input
            id={`${id}-kind`}
            onChange={(event) => setKind(event.target.value)}
            placeholder="finding"
            value={kind}
          />
        </div>
        <div className="composer-field">
          <Label htmlFor={`${id}-message`}>Message</Label>
          <Textarea
            id={`${id}-message`}
            onChange={(event) => setMessage(event.target.value)}
            rows={2}
            value={message}
          />
        </div>
      </div>
      <div className="composer-actions">
        <Button
          disabled={raise.pending || kind.trim() === ""}
          onClick={() => void raise.run()}
          size="sm"
          type="button"
          variant="outline"
        >
          Raise surface
        </Button>
      </div>
      <Outcome label="Surface" outcome={raise.outcome} />
    </section>
  );
}

/**
 * The planner's own `attest` of a ready human action, by its reference: the
 * receipt it answers is the one a reply carries, and the queue is read again on
 * it because the attestation is a write to the channel.
 */
function useAttest(
  client: TelemetryClient,
  runId: string,
  onWrote: () => void,
): Verb<[reference: string]> {
  return useVerb(
    (reference: string) => `Attest ${reference}`,
    useCallback(
      (reference: string) => client.attest(runId, reference),
      [client, runId],
    ),
    onWrote,
  );
}

/**
 * The surface form's state and the verb that raises one: the kind stays for
 * the next surface — a manager raising two findings raises two of one kind —
 * and the message clears once the engine has queued it.
 */
function useSurfaceForm(
  client: TelemetryClient,
  runId: string,
  onRaised: () => void,
) {
  const [kind, setKind] = useState("");
  const [message, setMessage] = useState("");
  const raise = useVerb(
    "Surface",
    useCallback(
      () => client.surface(runId, { kind, message }),
      [client, runId, kind, message],
    ),
    useCallback(() => {
      setMessage("");
      onRaised();
    }, [onRaised]),
  );
  return { kind, setKind, message, setMessage, raise };
}
