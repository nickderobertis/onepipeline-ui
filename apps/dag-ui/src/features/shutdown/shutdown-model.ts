import {
  type RunSummary,
  SHUTDOWN_DEFAULT_GRACE_SECONDS,
  type ShutdownReport,
  type ShutdownScope,
} from "@onepipeline-ui/dag-model";
import { TelemetryClientError } from "@onepipeline-ui/telemetry-client";
import { launchLabel } from "../../lib/run-model";

/**
 * Everything a shutdown control decides before and after the request, kept out of
 * the components so each rule is one function a test can hold.
 *
 * The runs a dialog names are read off the listing the view already holds and
 * the recorded launch each listing row carries — never off a second
 * reading of the root — because the dialog is the reader's only chance to see
 * what the engine is about to act on, and the listing is what they have been
 * reading.
 */

/** The two units a grace is offered in: a person thinks in minutes, a test in seconds. */
export type GraceUnit = "minutes" | "seconds";
export const GRACE_UNITS: Readonly<Record<GraceUnit, number>> = {
  minutes: 60,
  seconds: 1,
};

export const isGraceUnit = (value: string): value is GraceUnit =>
  Object.hasOwn(GRACE_UNITS, value);

/** A grace as the dialog holds it: the text typed, and the unit chosen. */
export interface GraceInput {
  readonly amount: string;
  readonly unit: GraceUnit;
}

/**
 * The engine's own default, in the unit it reads in: ten minutes, shown as ten
 * minutes rather than as six hundred seconds.
 */
export const DEFAULT_GRACE: GraceInput =
  SHUTDOWN_DEFAULT_GRACE_SECONDS % GRACE_UNITS.minutes === 0
    ? {
        amount: String(SHUTDOWN_DEFAULT_GRACE_SECONDS / GRACE_UNITS.minutes),
        unit: "minutes",
      }
    : { amount: String(SHUTDOWN_DEFAULT_GRACE_SECONDS), unit: "seconds" };

/**
 * The grace as the request sends it — whole seconds — or `undefined` for text
 * that is not a whole number of that unit, 0 or more. A fraction of a minute is
 * refused rather than rounded: the number sent is the number the reader read.
 */
export function graceSeconds(grace: GraceInput): number | undefined {
  const text = grace.amount.trim();
  if (!/^\d+$/u.test(text)) return undefined;
  const seconds = Number(text) * GRACE_UNITS[grace.unit];
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/** A number of seconds in the words a person reads a grace in. */
export function graceWords(seconds: number): string {
  if (seconds === 0) return "no grace";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const plural = (count: number, unit: string) =>
    `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (minutes === 0) return plural(rest, "second");
  if (rest === 0) return plural(minutes, "minute");
  return `${plural(minutes, "minute")} ${plural(rest, "second")}`;
}

/** One run a shutdown will act on, and whose it is. */
export interface ScopedRun {
  readonly runId: string;
  /** The owner in this app's words for a launching session. */
  readonly owner: string;
}

/** The host listing names each run by its recorded launcher. */
export function runsInScope(rows: readonly RunSummary[]): ScopedRun[] {
  return rows.map((row) => ({
    runId: row.run_id,
    owner: launchLabel(row.launch),
  }));
}

/** The request as the dialog confirmed it, and when it went. */
export interface SentShutdown {
  readonly scope: ShutdownScope;
  readonly runs: readonly ScopedRun[];
  readonly grace: number;
  readonly force: boolean;
  /** Milliseconds since the epoch, on the browser's clock. */
  readonly sentAt: number;
}

/**
 * Where a shutdown stands, as the control shows it.
 *
 * `refused` is the server answering with its own error — a run another session
 * owns, one that is not there, a body it could not read — and nothing was done.
 * `lost` is the request ending without an answer this app can read: the
 * connection dropped, the server went away, or what came back was not the
 * server's. The engine may still be carrying that one out, so it is never shown
 * as a refusal, let alone as a report.
 */
export type ShutdownState =
  | { readonly phase: "idle" }
  | { readonly phase: "sending"; readonly sent: SentShutdown }
  | {
      readonly phase: "answered";
      readonly sent: SentShutdown;
      readonly report: ShutdownReport;
    }
  | {
      readonly phase: "refused";
      readonly sent: SentShutdown;
      readonly error: TelemetryClientError;
    }
  | {
      readonly phase: "lost";
      readonly sent: SentShutdown;
      readonly error: Error;
    };

/**
 * What a failed request was: the server's own refusal only when it answered one
 * in its error envelope — a status *and* a code — and lost otherwise.
 */
export function settleFailure(
  sent: SentShutdown,
  caught: unknown,
): ShutdownState {
  if (
    caught instanceof TelemetryClientError &&
    caught.status !== undefined &&
    caught.code !== undefined
  )
    return { phase: "refused", sent, error: caught };
  return {
    phase: "lost",
    sent,
    error: caught instanceof Error ? caught : new Error(String(caught)),
  };
}

/** The journal kinds a shutdown writes on each run it acts on. */
export type ShutdownRecord = "dispatch-stopped" | "host-shutdown";
export const SHUTDOWN_RECORDS: {
  readonly dispatchStopped: ShutdownRecord;
  readonly hostShutdown: ShutdownRecord;
} = {
  dispatchStopped: "dispatch-stopped",
  hostShutdown: "host-shutdown",
};

/** What a run in scope has recorded of this shutdown so far. */
export interface RunProgress {
  readonly runId: string;
  readonly recorded: ShutdownRecord;
}

/**
 * The runs in scope whose listing row has moved to one of the shutdown's own
 * records since the request went — the evidence, read off the live listing, that
 * the engine is working through them.
 *
 * Compared against the rows as they stood when the request was sent, so a run
 * whose last record is an earlier shutdown's is not read as this one's progress.
 */
export function progressOf(
  sent: SentShutdown,
  before: ReadonlyMap<string, RunSummary>,
  rows: readonly RunSummary[],
): RunProgress[] {
  const inScope = new Set(sent.runs.map(({ runId }) => runId));
  const kinds: readonly string[] = Object.values(SHUTDOWN_RECORDS);
  return rows.flatMap((row) => {
    if (!inScope.has(row.run_id)) return [];
    const last = row.last_event;
    if (last === null || !kinds.includes(last)) return [];
    const earlier = before.get(row.run_id);
    if (
      earlier !== undefined &&
      earlier.last_event === last &&
      earlier.last_progress_at === row.last_progress_at
    )
      return [];
    return [
      {
        runId: row.run_id,
        recorded:
          last === SHUTDOWN_RECORDS.hostShutdown
            ? SHUTDOWN_RECORDS.hostShutdown
            : SHUTDOWN_RECORDS.dispatchStopped,
      },
    ];
  });
}

/** A clock time on the browser's clock, to the second, 24-hour. */
export function clockTime(millis: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(millis);
}
