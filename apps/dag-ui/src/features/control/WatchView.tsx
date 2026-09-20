import { Badge, Button, ScrollArea } from "@oneharness/ui";
import type { Unwatched } from "@onepipeline-ui/dag-model";
import type { WatchFrame } from "@onepipeline-ui/telemetry-client";
import { Eye, EyeOff } from "lucide-react";
import { Outcome } from "../../lib/Outcome";
import { Timestamp } from "../../lib/Timestamp";
import type { WatchState } from "./useRunControl";

/**
 * The held watch, frame by frame: the events under the reading's profile, the
 * heartbeats with the run's unread accounting, and the condition that ended the
 * wait. While the stream is held this browser is the run's watcher, and the
 * view says so.
 */
export function WatchView({
  runId,
  watch,
  unwatched,
  onToggle,
}: {
  readonly runId: string;
  readonly watch: WatchState;
  /** The acting session's unwatched report, as the header's badge reads it. */
  readonly unwatched?: Unwatched;
  readonly onToggle: () => void;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="channel-view">
        <section aria-labelledby="watch-heading" className="channel-section">
          <div className="section-heading channel-heading">
            <h3 id="watch-heading">
              {watch.held ? <Eye size={15} /> : <EyeOff size={15} />} Watch
            </h3>
            <Button
              aria-pressed={watch.held}
              onClick={onToggle}
              size="sm"
              type="button"
              variant={watch.held ? "default" : "outline"}
            >
              {watch.held ? "Stop watching" : "Watch"}
            </Button>
          </div>
          <p aria-live="polite" className="watch-standing">
            {watch.held
              ? `${runId} is being watched by this browser.`
              : watch.ended
                ? `The wait ended: ${watch.ended.condition}.`
                : "Not watching. Hold the stream to become this run's watcher."}
          </p>
          {unwatched !== undefined && (
            <p className="watch-standing">
              {unwatched.reported.length} unwatched
              {unwatched.reported.some((run) => run.run === runId) &&
                " · this run"}
              {unwatched.reported.length > 0 &&
                `: ${unwatched.reported.map((run) => run.run).join(", ")}`}
            </p>
          )}
          {watch.error && (
            <Outcome
              label="Watch"
              outcome={{ kind: "refused", title: "Watch", error: watch.error }}
            />
          )}
          {watch.frames.length === 0 ? (
            <p className="channel-empty">No frame yet.</p>
          ) : (
            <ol aria-label="Watch frames" className="watch-frames">
              {watch.frames.map((frame) => (
                <li className="watch-frame" key={frame.id}>
                  <Frame frame={frame} />
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

/** A plain object, as the engine's open records are read field by field. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function Frame({ frame }: { readonly frame: WatchFrame }) {
  const data = frame.data;
  if (data.watch === "event") {
    const event = data.event;
    const kind = typeof event.kind === "string" ? event.kind : "event";
    const ts = typeof event.ts === "string" ? event.ts : undefined;
    const labels = isRecord(event.labels) ? event.labels : {};
    const node = typeof labels.node === "string" ? labels.node : undefined;
    return (
      <>
        <Badge variant="outline">event</Badge>
        <span className="watch-kind">{kind}</span>
        {node !== undefined && <span className="channel-age">{node}</span>}
        {ts !== undefined && <Timestamp at={ts} className="channel-age" />}
      </>
    );
  }
  if (data.watch === "heartbeat") {
    return (
      <>
        <Badge variant="secondary">tick</Badge>
        <span className="channel-age">
          {data.unread.count} unread
          {data.unread.oldest_seconds !== null &&
            `, oldest ${data.unread.oldest_seconds}s`}
        </span>
      </>
    );
  }
  return (
    <>
      <Badge>returned</Badge>
      <span className="watch-kind">{data.condition}</span>
      {data.node !== undefined && (
        <span className="channel-age">{data.node}</span>
      )}
      <span className="channel-age">exit {data.exit}</span>
    </>
  );
}
