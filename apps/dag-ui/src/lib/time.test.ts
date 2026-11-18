import { format, parseISO } from "date-fns";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatAbsoluteTimestamp,
  formatDuration,
  formatDurationSeconds,
  formatRelativeTimestamp,
  formatTimestamp,
  parseTimestamp,
} from "./time";

/** The instant every reading below is taken from, so "today" is a fixed day. */
const NOW = "2026-07-26T14:30:00Z";

function at(now: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
}

afterEach(() => vi.useRealTimers());

describe("how long something took", () => {
  test("reads a sub-second duration in milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(999)).toBe("999ms");
    // A negative interval is a clock that went backwards between two records, not a
    // duration; it is reported as no elapsed time rather than as "-3s".
    expect(formatDuration(-3000)).toBe("0ms");
  });

  test("reads a duration under a minute in seconds", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(4200)).toBe("4s");
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  test("reads a duration under an hour in minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(724_000)).toBe("12m 4s");
  });

  test("reads an hour or more in hours, minutes and seconds", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(7_510_000)).toBe("2h 5m 10s");
    // Past a day it is still hours of work: a calendar breakdown would report this
    // as "1 day 1 hour" and lose the reading the operator came for.
    expect(formatDuration(90_000_000)).toBe("25h 0m 0s");
  });

  test("reads the seconds the run contract serves the same way", () => {
    expect(formatDurationSeconds(5)).toBe("5s");
    expect(formatDurationSeconds(0.42)).toBe("420ms");
    // The reading an operator was doing arithmetic on before: 58000 raw seconds.
    expect(formatDurationSeconds(58_000)).toBe("16h 6m 40s");
  });
});

describe("when something happened", () => {
  test("reads today's stamp as a clock and an older one with its date", () => {
    at(NOW);
    expect(formatTimestamp("2026-07-26T11:02:03Z")).toBe("11:02:03");
    expect(formatTimestamp("2026-07-19T11:02:03Z")).toBe("Jul 19, 11:02:03");
    // A stamp from another year says which, so two July runs can never read alike.
    expect(formatTimestamp("2025-07-26T11:02:03Z")).toBe(
      "Jul 26 2025, 11:02:03",
    );
  });

  test("backs a compact reading with the whole instant and its zone", () => {
    expect(formatAbsoluteTimestamp("2026-07-26T11:02:03Z")).toBe(
      "Jul 26, 2026, 11:02:03 AM GMT+00:00",
    );
  });

  test("reads a stamp as an age when that is the question being asked", () => {
    at(NOW);
    expect(formatRelativeTimestamp("2026-07-26T14:29:18Z")).toBe(
      "42 seconds ago",
    );
    expect(formatRelativeTimestamp("2026-07-19T14:30:00Z")).toBe("7 days ago");
  });

  test("reads every stamp to the instant parseISO reads it", () => {
    for (const stamp of [
      "2026-07-26T11:02:03Z",
      "2026-07-26T11:02:03.5Z",
      "2026-07-26T11:02:03.12Z",
      "2026-07-26T11:02:03.123Z",
      "2026-07-26T11:02:03.123+05:30",
      "2026-07-26T11:02:03-07:00",
      "2028-02-29T00:00:00Z",
      "2026-07-31T23:59:59.999Z",
      // Shapes the contract does not serve, still read as parseISO reads them.
      "2026-07-26T11:02:03.123456Z",
      "2026-07-26T11:02:03+0530",
      "2026-07-26",
    ])
      expect(parseTimestamp(stamp)?.getTime(), stamp).toBe(
        parseISO(stamp).getTime(),
      );
    // A day no calendar has is no instant, by either reading.
    expect(parseTimestamp("2026-02-29T00:00:00Z")).toBeUndefined();
    expect(parseTimestamp("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(parseTimestamp("2026-04-31T00:00:00Z")).toBeUndefined();
  });

  test("writes each reading exactly as date-fns' format does, in every zone", () => {
    const zone = process.env.TZ;
    try {
      for (const tz of [
        "UTC",
        "America/Chicago",
        "Asia/Kolkata",
        "America/St_Johns",
        "Pacific/Kiritimati",
      ]) {
        process.env.TZ = tz;
        at(NOW);
        for (const stamp of [
          "2026-07-26T00:00:00Z",
          "2026-07-26T11:02:03Z",
          "2026-07-26T12:00:00Z",
          "2026-07-26T23:59:59.999Z",
          "2026-01-01T09:05:07+05:30",
          "2026-03-08T08:30:00Z",
          "2026-11-01T06:30:00Z",
          "2026-12-31T23:00:00-03:30",
          "2025-02-03T04:05:06Z",
          "2031-10-09T13:14:15Z",
        ]) {
          const parsed = parseISO(stamp);
          const where = `${stamp} in ${tz}`;
          expect(formatTimestamp(stamp), where).toBe(
            format(
              parsed,
              format(parsed, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd")
                ? "HH:mm:ss"
                : parsed.getFullYear() === new Date().getFullYear()
                  ? "MMM d, HH:mm:ss"
                  : "MMM d yyyy, HH:mm:ss",
            ),
          );
          expect(formatAbsoluteTimestamp(stamp), where).toBe(
            format(parsed, "PPpp zzzz"),
          );
        }
        vi.useRealTimers();
      }
    } finally {
      process.env.TZ = zone;
    }
  });

  test("hands back a record no clock can read, exactly as recorded", () => {
    expect(parseTimestamp("not-a-time")).toBeUndefined();
    expect(formatTimestamp("not-a-time")).toBe("not-a-time");
    expect(formatAbsoluteTimestamp("not-a-time")).toBe("not-a-time");
    expect(formatRelativeTimestamp("not-a-time")).toBe("not-a-time");
  });
});
