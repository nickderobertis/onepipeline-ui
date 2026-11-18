import {
  formatDistanceToNowStrict,
  hoursToMilliseconds,
  isThisYear,
  isToday,
  isValid,
  millisecondsToHours,
  millisecondsToMinutes,
  millisecondsToSeconds,
  minutesToMilliseconds,
  parseISO,
  secondsToMilliseconds,
} from "date-fns";

/**
 * A duration in the largest units that keep it readable, tiered by how long it ran:
 * `420ms` under a second, `42s` under a minute, `12m 4s` under an hour, and
 * `2h 5m 10s` beyond one.
 */
export function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs));
  if (total < secondsToMilliseconds(1)) return `${total}ms`;
  // Hours are counted off the total rather than read from a calendar breakdown: a
  // node that ran for two days is thirty-odd hours of work, not "1 day 8 hours".
  const hours = millisecondsToHours(total);
  const minutes = millisecondsToMinutes(total - hoursToMilliseconds(hours));
  const seconds = millisecondsToSeconds(
    total - hoursToMilliseconds(hours) - minutesToMilliseconds(minutes),
  );
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The same reading for the durations the read contract serves in seconds. */
export function formatDurationSeconds(seconds: number): string {
  return formatDuration(secondsToMilliseconds(seconds));
}

/**
 * A recorded stamp as a `Date`, or `undefined` when what was recorded is not one.
 *
 * Nothing invents a date for an unreadable record: every formatter below hands the
 * recorded text back unchanged instead, so a journal a peer wrote in some other shape
 * is visible as what it says rather than as "Invalid Date".
 */
export function parseTimestamp(at: string): Date | undefined {
  const parsed = CONTRACT_STAMP.test(at) ? new Date(at) : parseISO(at);
  return isValid(parsed) ? parsed : undefined;
}

/**
 * The stamp the read contract serves — a whole date and time, at most milliseconds,
 * with its offset — on a day every month has. ECMAScript's own date-time format
 * defines that shape, so the engine reads it to the instant `parseISO` would without
 * `parseISO`'s cost: a node's first screen draws a stamp or two a row over hundreds
 * of rows. The engine rolls a day past its month's end over into the next where
 * `parseISO` refuses it, so the 29th to the 31st, like every other shape, are still
 * read by `parseISO`.
 */
const CONTRACT_STAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|1\d|2[0-8])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

/**
 * A stamp as an operator scanning a column reads it: today's work is a clock time,
 * and anything older carries the day — and the year, once it is not this one — so a
 * row can never be read as having happened today when it did not.
 */
export function formatTimestamp(at: string): string {
  const parsed = parseTimestamp(at);
  return parsed === undefined ? at : formatParsedTimestamp(parsed);
}

/** {@link formatTimestamp}'s reading of a stamp already parsed. */
export function formatParsedTimestamp(parsed: Date): string {
  const clock = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
  if (isToday(parsed)) return clock;
  const day = `${MONTHS[parsed.getMonth()]} ${parsed.getDate()}`;
  // llmlint: ignore[changed_behavior_has_e2e] the browser fixture's journal is written by the run that serves it, so every stamp a journey can reach is today's and the dated branches are reachable only by moving the clock, which a live server tier cannot do; the e2e journey asserts every shape this returns across a whole rail, and `time.test.ts` pins this branch against a fixed instant.
  if (isThisYear(parsed)) return `${day}, ${clock}`;
  // llmlint: ignore[changed_behavior_has_e2e] same reason: no served run can carry a stamp from another year, so `time.test.ts` pins this branch against a fixed instant instead.
  return `${day} ${String(parsed.getFullYear()).padStart(4, "0")}, ${clock}`;
}

/**
 * The months as date-fns' English locale abbreviates them. The two readings above
 * and below are written out rather than handed to `format`, which reads its pattern
 * afresh on every call: a node's first screen draws two of them for each of
 * hundreds of rows. `time.test.ts` holds both to `format`'s own output.
 */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const pad = (value: number) => String(value).padStart(2, "0");

/** The whole instant, zone included: what a compact reading is backed by on hover. */
export function formatAbsoluteTimestamp(at: string): string {
  const parsed = parseTimestamp(at);
  return parsed === undefined ? at : formatParsedAbsolute(parsed);
}

/** {@link formatAbsoluteTimestamp}'s reading of a stamp already parsed. */
export function formatParsedAbsolute(parsed: Date): string {
  // `format`'s "PPpp zzzz": "Jul 26, 2026, 11:02:03 AM GMT+00:00".
  const hours = parsed.getHours();
  const offset = parsed.getTimezoneOffset();
  const zone = `GMT${offset > 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${MONTHS[parsed.getMonth()]} ${parsed.getDate()}, ${parsed.getFullYear()}, ${hours % 12 || 12}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())} ${hours < 12 ? "AM" : "PM"} ${zone}`;
}

/** An epoch-millisecond stamp as the ISO instant every `Timestamp` reads. */
export function isoOfMillis(millis: number): string {
  return new Date(millis).toISOString();
}

/** How long ago it happened — the reading that answers "is this still recent?". */
export function formatRelativeTimestamp(at: string): string {
  const parsed = parseTimestamp(at);
  return parsed === undefined ? at : formatParsedRelative(parsed);
}

/** {@link formatRelativeTimestamp}'s reading of a stamp already parsed. */
export function formatParsedRelative(parsed: Date): string {
  return formatDistanceToNowStrict(parsed, { addSuffix: true });
}
