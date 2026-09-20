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
import { useId, useState } from "react";
import { Timestamp } from "../../lib/Timestamp";
import { formatDurationSeconds } from "../../lib/time";
import { isoOfMillis } from "../projects/project-model";
import { Outcome, outcomeOf, type VerbOutcome } from "./Outcome";
import { ReplyComposer } from "./ReplyComposer";
import { opOf } from "./reply-shortcuts";
import { useRead } from "./useRead";

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
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly filter: string;
  /** The decision points the graph holds, for the human actions among them. */
  readonly decisions: readonly Decision[];
  /** When the graph was read, so a surface's age is against the payload's clock. */
  readonly observedAt: string;
  readonly invalidations: number;
}) {
  //: Bumped after every write here, so the queue re-reads without waiting on the stream.
  const [writes, setWrites] = useState(0);
  const queue = useRead(
    runId,
    () => client.getChannel(runId),
    invalidations + writes,
  );
  const wrote = () => setWrites((current) => current + 1);
  const [next, setNext] = useState<VerbOutcome>();
  const [claiming, setClaiming] = useState(false);
  const claim = async () => {
    setClaiming(true);
    const answered = await outcomeOf("Next", () =>
      client.claimNext(runId, filter),
    );
    setNext(answered);
    setClaiming(false);
    wrote();
  };

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
              disabled={claiming}
              onClick={() => void claim()}
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
          <Outcome label="Next" outcome={next} />
        </section>
        <Attestations
          client={client}
          decisions={decisions}
          onWrote={wrote}
          runId={runId}
        />
        <ReplyComposer client={client} onSent={wrote} runId={runId} />
        <SurfaceForm client={client} onRaised={wrote} runId={runId} />
      </div>
    </ScrollArea>
  );
}

/**
 * The queue's four readings of a surface — pending, held and abandoned, waiting
 * and answered — and the replies, commands and outcomes beside them.
 *
 * Derived from the six logs exactly as the engine's own `ChannelQueue` reads
 * them: the pending surface is the held one nobody has given up on, an
 * abandoned one is the held one they have, `waiting` is the engine's own list of
 * the unread, and an answered surface is one raised that is neither.
 */
function Queue({
  queue,
  observedAt,
}: {
  readonly queue: ChannelQueue;
  readonly observedAt: string;
}) {
  const waitingIds = new Set(queue.waiting.map((surface) => surface.id));
  const held = queue.held;
  const pending = held !== null && held.abandoned !== true ? held : undefined;
  const abandoned = held !== null && held.abandoned === true ? held : undefined;
  const answered = queue.surfaces.filter(
    (surface) => !waitingIds.has(surface.id) && surface.id !== held?.id,
  );
  return (
    <div className="channel-queue">
      <SurfaceList
        emptyText="Nothing is waiting on an answer."
        observedAt={observedAt}
        surfaces={pending ? [pending] : []}
        title="Pending"
      />
      <SurfaceList
        emptyText="No unread surfaces."
        observedAt={observedAt}
        surfaces={queue.waiting}
        title="Waiting"
      />
      {abandoned && (
        <SurfaceList
          emptyText=""
          observedAt={observedAt}
          surfaces={[abandoned]}
          title="Abandoned"
        />
      )}
      <SurfaceList
        emptyText="No surface has been answered yet."
        observedAt={observedAt}
        surfaces={answered}
        title="Answered"
      />
      <section aria-label="Replies" className="channel-list">
        <h4>Replies</h4>
        {queue.replies.length === 0 ? (
          <p className="channel-empty">No reply written yet.</p>
        ) : (
          <ul>
            {queue.replies.map((reply) => (
              <li key={reply.id}>
                <Card className="channel-card">
                  <CardContent>
                    <div className="channel-card-head">
                      <Badge variant="outline">reply {reply.id}</Badge>
                      {reply.correlation !== undefined && (
                        <Badge variant="secondary">
                          answers {reply.correlation}
                        </Badge>
                      )}
                      <Timestamp at={isoOfMillis(reply.at)} relative />
                    </div>
                    <pre className="verb-text">
                      {JSON.stringify(reply.reply, null, 2)}
                    </pre>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
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

function SurfaceList({
  title,
  surfaces,
  emptyText,
  observedAt,
}: {
  readonly title: string;
  readonly surfaces: readonly ChannelSurface[];
  readonly emptyText: string;
  readonly observedAt: string;
}) {
  return (
    <section aria-label={`${title} surfaces`} className="channel-list">
      <h4>
        {title} <Badge variant="outline">{surfaces.length}</Badge>
      </h4>
      {surfaces.length === 0 ? (
        <p className="channel-empty">{emptyText}</p>
      ) : (
        <ul>
          {surfaces.map((surface) => (
            <li key={surface.id}>
              <SurfaceCard observedAt={observedAt} surface={surface} />
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <Card className="channel-card">
      <CardContent>
        <div className="channel-card-head">
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
        </div>
        <p className="channel-message">{surface.message}</p>
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
  const [outcome, setOutcome] = useState<VerbOutcome>();
  const [attesting, setAttesting] = useState<string>();
  const attest = async (reference: string) => {
    setAttesting(reference);
    const answered = await outcomeOf(`Attest ${reference}`, () =>
      client.attest(runId, reference),
    );
    setOutcome(answered);
    setAttesting(undefined);
    onWrote();
  };
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
                disabled={attesting !== undefined}
                onClick={() => void attest(decision.id)}
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
      <Outcome label="Attest" outcome={outcome} />
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
  const [kind, setKind] = useState("");
  const [message, setMessage] = useState("");
  const [outcome, setOutcome] = useState<VerbOutcome>();
  const [raising, setRaising] = useState(false);
  const raise = async () => {
    setRaising(true);
    const answered = await outcomeOf("Surface", () =>
      client.surface(runId, { kind, message }),
    );
    setOutcome(answered);
    setRaising(false);
    if (answered.kind === "answered") {
      setMessage("");
      onRaised();
    }
  };
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
          disabled={raising || kind.trim() === ""}
          onClick={() => void raise()}
          size="sm"
          type="button"
          variant="outline"
        >
          Raise surface
        </Button>
      </div>
      <Outcome label="Surface" outcome={outcome} />
    </section>
  );
}
