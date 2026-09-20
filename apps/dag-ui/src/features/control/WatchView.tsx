import { Badge, Button, ScrollArea } from "@oneharness/ui";
import type { WatchFrame } from "@onepipeline-ui/telemetry-client";
import { Eye, EyeOff } from "lucide-react";
import { Timestamp } from "../../lib/Timestamp";
import { Outcome } from "./Outcome";
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
  onToggle,
}: {
  readonly runId: string;
  readonly watch: WatchState;
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

function Frame({ frame }: { readonly frame: WatchFrame }) {
  const data = frame.data;
  if (data.watch === "event") {
    const event = data.event;
    const kind = typeof event.kind === "string" ? event.kind : "event";
    const ts = typeof event.ts === "string" ? event.ts : undefined;
    const labels =
      typeof event.labels === "object" && event.labels !== null
        ? (event.labels as Record<string, unknown>)
        : {};
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
