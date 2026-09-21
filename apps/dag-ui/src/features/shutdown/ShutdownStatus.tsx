import { Alert, AlertDescription, AlertTitle, Button } from "@oneharness/ui";
import type { RunSummary, ShutdownReport } from "@onepipeline-ui/dag-model";
import { CheckCircle2, Loader2, TriangleAlert, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../../lib/time";
import {
  clockTime,
  graceWords,
  progressOf,
  type SentShutdown,
  SHUTDOWN_RECORDS,
  type ShutdownState,
} from "./shutdown-model";

/** How often the in-flight clock is read again, in milliseconds. */
const TICK_MS = 1000;

/**
 * What one shutdown control's request is doing, or came back with.
 *
 * In flight it says so with evidence rather than a spinner: the time since it
 * went against the grace it carries, and every run in scope whose row on the
 * live listing has moved to one of the shutdown's own records. A request that
 * ended without an answer is *lost* — named as such, with no report — because
 * the engine may still be carrying it out; one the server refused shows the
 * server's words; and an answer is the engine's report, read as incomplete
 * whenever the engine says it was.
 *
 * `label` names the control it belongs to, so two of them on one screen are
 * two regions a reader can tell apart.
 */
export function ShutdownStatus({
  label,
  state,
  rows,
  onDismiss,
}: {
  readonly label: string;
  readonly state: ShutdownState;
  /** The live listing, which the in-flight state reads its evidence off. */
  readonly rows: readonly RunSummary[];
  readonly onDismiss: () => void;
}) {
  if (state.phase === "idle") return null;
  return (
    <section aria-label={label} className="shutdown-status">
      {state.phase === "sending" ? (
        <InFlight rows={rows} sent={state.sent} />
      ) : state.phase === "lost" ? (
        <Alert aria-label={`${label} lost`} variant="destructive">
          <Unplug />
          <AlertTitle>Shutdown lost: no answer came back</AlertTitle>
          <AlertDescription>
            <p>
              The request sent at {clockTime(state.sent.sentAt)} ended without
              an answer ({state.error.message}). The engine may still be
              carrying out the shutdown — check the runs before sending another.
            </p>
            <SentLine sent={state.sent} />
          </AlertDescription>
        </Alert>
      ) : state.phase === "refused" ? (
        <Alert aria-label={`${label} refused`} variant="destructive">
          <TriangleAlert />
          <AlertTitle>
            Shutdown refused · {state.error.status} {state.error.code}
          </AlertTitle>
          <AlertDescription>
            <pre className="verb-text">{state.error.message}</pre>
            <p>Nothing was signalled and nothing was pushed.</p>
          </AlertDescription>
        </Alert>
      ) : (
        <Report label={label} report={state.report} />
      )}
      {state.phase !== "sending" && (
        <div className="composer-actions">
          <Button onClick={onDismiss} size="sm" type="button" variant="outline">
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}

/** Which request this is: its scope, its grace and its force, as sent. */
function SentLine({ sent }: { readonly sent: SentShutdown }) {
  return (
    <p className="channel-age">
      Sent {clockTime(sent.sentAt)} · scope {sent.scope} · grace{" "}
      {graceWords(sent.grace)}
      {sent.force ? " · forced" : ""} · {sent.runs.length}{" "}
      {sent.runs.length === 1 ? "run" : "runs"} in scope
    </p>
  );
}

/**
 * The request while it is out: how long it has been, where the grace stands,
 * and what the runs in scope have recorded of it on the live listing.
 */
function InFlight({
  sent,
  rows,
}: {
  readonly sent: SentShutdown;
  readonly rows: readonly RunSummary[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // The rows as they stood when the request went, so an earlier shutdown's
  // record on a run is not read as this one's progress.
  const before = useRef(
    new Map(
      rows
        .filter((row) => sent.runs.some(({ runId }) => runId === row.run_id))
        .map((row) => [row.run_id, row]),
    ),
  );
  const progress = progressOf(sent, before.current, rows);
  const done = progress.filter(
    ({ recorded }) => recorded === SHUTDOWN_RECORDS.hostShutdown,
  ).length;
  const deadline = sent.sentAt + sent.grace * 1000;
  const asks = !sent.force && sent.grace > 0;
  return (
    <div aria-live="polite" className="shutdown-inflight" role="status">
      <p className="shutdown-inflight-head">
        <Loader2 aria-hidden="true" className="animate-spin" size={14} />
        <strong>Shutdown in progress</strong> — still waiting for the engine's
        answer, {formatDuration(Math.max(0, now - sent.sentAt))} after it was
        sent.
      </p>
      <SentLine sent={sent} />
      <p>
        {!asks
          ? "Forced: nothing is asked or waited for; the engine is tearing the runs down and pushing their branches."
          : now < deadline
            ? `Waiting out the ${graceWords(sent.grace)} grace until ${clockTime(deadline)} (${formatDuration(deadline - now)} left) for each live dispatch to end itself; runs are worked through one after another, each with its own grace.`
            : `The first grace ran out at ${clockTime(deadline)}; the engine is tearing down what is still standing and pushing branches, run by run.`}
      </p>
      <p>
        {done} of {sent.runs.length}{" "}
        {sent.runs.length === 1 ? "run has" : "runs have"} recorded their
        shutdown.
      </p>
      {progress.length > 0 && (
        <ul aria-label="Recorded so far">
          {progress.map(({ runId, recorded }) => (
            <li key={runId}>
              {runId}:{" "}
              {recorded === SHUTDOWN_RECORDS.hostShutdown
                ? "put down — host-shutdown recorded after its teardown and pushes"
                : "its dispatches are stopping — dispatch-stopped recorded"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Words for a branch's preservation, with where it went. */
function branchWords(
  branch: ShutdownReport["runs"][number]["branches"][number],
): string {
  const where = branch.remote === null ? "" : ` to ${branch.remote}`;
  const at = branch.commit === null ? "" : ` at ${branch.commit}`;
  switch (branch.result) {
    case "pushed":
      return `pushed${where}${at}`;
    case "already-on-origin":
      return `already on its origin${where}${at}; nothing was pushed`;
    case "no-remote":
      return `not pushed: this identity has no origin${at}`;
    case "refused":
      return `could not be preserved${at}`;
  }
}

/** The engine's report, run by run, and its verdict on the whole. */
function Report({
  label,
  report,
}: {
  readonly label: string;
  readonly report: ShutdownReport;
}) {
  return (
    <Alert
      aria-label={`${label} report`}
      variant={report.complete ? "default" : "destructive"}
    >
      {report.complete ? <CheckCircle2 /> : <TriangleAlert />}
      <AlertTitle>
        {report.complete ? "Shutdown complete" : "Shutdown incomplete"}
      </AlertTitle>
      <AlertDescription className="shutdown-report">
        {!report.complete && (
          <p>
            Not everything went as asked: a dispatch was killed at the deadline
            or is still running, a teardown was not clean, or a branch could not
            be preserved. Read the runs below.
          </p>
        )}
        <p className="channel-age">
          Scope {report.scope} · grace {graceWords(report.grace_seconds)}
          {report.forced ? " · forced" : ""} · runs root {report.root}
        </p>
        {report.runs.length === 0 ? (
          <p>No run was selected: nothing was signalled.</p>
        ) : (
          report.runs.map((run) => (
            <section
              aria-label={`Shutdown of ${run.run_id}`}
              className="shutdown-report-run"
              key={run.run_id}
            >
              <h4>
                {run.run_id} · owner {run.owner}
                {run.forced_over_owner &&
                  " — another session's run, acted on over its owner"}
              </h4>
              {run.dispatches.length === 0 ? (
                <p>No live dispatch to interrupt.</p>
              ) : (
                <ul aria-label={`Dispatches of ${run.run_id}`}>
                  {run.dispatches.map((dispatch) => (
                    <li key={`${dispatch.node}-${dispatch.pid}`}>
                      {dispatch.node} (pid {dispatch.pid}): interrupt{" "}
                      {dispatch.interrupt}; ended {dispatch.ended} after{" "}
                      {formatDuration(dispatch.waited_ms)}
                      <span className="channel-age"> — {dispatch.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p>Teardown: {run.teardown}</p>
              {run.branches.length === 0 ? (
                <p>No branch this run's records name.</p>
              ) : (
                <ul aria-label={`Branches of ${run.run_id}`}>
                  {run.branches.map((branch) => (
                    <li key={`${branch.identity}@${branch.branch}`}>
                      {branch.identity}@{branch.branch}: {branchWords(branch)}
                      <span className="channel-age"> — {branch.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))
        )}
        {report.not_pushed_unread !== null ? (
          <p>
            Other unpublished branches on this host: not read —{" "}
            {report.not_pushed_unread}. This is not a count of zero: there may
            be work on this host nothing outside it carries.
          </p>
        ) : report.not_pushed.length === 0 ? (
          <p>Other unpublished branches on this host: none.</p>
        ) : (
          <>
            <p>
              Other unpublished branches on this host, which this shutdown did
              not push ({report.not_pushed.length}):
            </p>
            <ul aria-label="Branches not pushed">
              {report.not_pushed.map(({ identity, branch }) => (
                <li key={`${identity}@${branch}`}>
                  {identity}@{branch}
                </li>
              ))}
            </ul>
          </>
        )}
        <details>
          <summary>The engine's own report</summary>
          <pre className="verb-text">{report.rendered}</pre>
        </details>
      </AlertDescription>
    </Alert>
  );
}
