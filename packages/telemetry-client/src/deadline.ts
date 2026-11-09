/**
 * The one deadline this client gives the server: a first answer, a page of history and
 * opening the stream each get this long, which fires before a proxy's 524 at about
 * 100 s. While the stream is open the rest of a run has no client deadline.
 *
 * A module of its own, with no imports, so the first-screen chunk can name it without
 * pulling the schemas in.
 */
export const READ_DEADLINE_MS = 30_000;

export class TelemetryDeadlineError extends Error {
  constructor(readonly what: string) {
    super(
      `${what} got no answer within ${READ_DEADLINE_MS / 1000} seconds, so nothing here is up to date.`,
    );
    this.name = "TelemetryDeadlineError";
  }
}
