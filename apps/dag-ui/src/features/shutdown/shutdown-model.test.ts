import type { RunSummary } from "@onepipeline-ui/dag-model";
import { TelemetryClientError } from "@onepipeline-ui/telemetry-client";
import { describe, expect, test } from "vitest";
import { runList } from "../../test/fixtures";
import {
  DEFAULT_GRACE,
  graceSeconds,
  graceWords,
  ownedBy,
  progressOf,
  type SentShutdown,
  settleFailure,
} from "./shutdown-model";

const rows = runList.runs as unknown as RunSummary[];
const [live, history] = rows;

const sent: SentShutdown = {
  scope: "host",
  runs: rows.map((row) => ({
    runId: row.run_id,
    owner: "x",
    mine: false,
    unowned: false,
  })),
  grace: 600,
  force: false,
  sentAt: 0,
};

describe("shutdown model", () => {
  test("offers the engine's default grace as ten minutes, and sends whole seconds", () => {
    expect(DEFAULT_GRACE).toEqual({ amount: "10", unit: "minutes" });
    expect(graceSeconds(DEFAULT_GRACE)).toBe(600);
    expect(graceSeconds({ amount: "90", unit: "seconds" })).toBe(90);
    expect(graceSeconds({ amount: "0", unit: "minutes" })).toBe(0);
    for (const amount of ["", "1.5", "-1", "ten", "1e3"])
      expect(graceSeconds({ amount, unit: "minutes" })).toBeUndefined();
  });

  test("reads a grace in the words a person reads it in", () => {
    expect(graceWords(0)).toBe("no grace");
    expect(graceWords(1)).toBe("1 second");
    expect(graceWords(60)).toBe("1 minute");
    expect(graceWords(600)).toBe("10 minutes");
    expect(graceWords(90)).toBe("1 minute 30 seconds");
  });

  test("owns a run only by the one session its launch recorded", () => {
    const key = live?.launch?.session_key ?? "";
    expect(ownedBy(live?.launch, key)).toBe(true);
    expect(ownedBy(history?.launch, key)).toBe(false);
    // An unattributed server owns nothing, and a run with no session is nobody's.
    expect(ownedBy(live?.launch, null)).toBe(false);
    expect(ownedBy(undefined, key)).toBe(false);
  });

  test("reads progress only off rows that moved to the shutdown's own records since it was sent", () => {
    if (live === undefined || history === undefined) throw new Error("rows");
    const before = new Map([
      [live.run_id, live],
      [
        history.run_id,
        { ...history, last_event: "host-shutdown", last_progress_at: 1 },
      ],
    ]);
    const now = [
      { ...live, last_event: "dispatch-stopped", last_progress_at: 5 },
      // The same record it carried before: an earlier shutdown's, not this one's.
      { ...history, last_event: "host-shutdown", last_progress_at: 1 },
      { ...live, run_id: "out-of-scope", last_event: "host-shutdown" },
    ];
    expect(progressOf(sent, before, now)).toEqual([
      { runId: live.run_id, recorded: "dispatch-stopped" },
    ]);
  });

  test("a failure is the server's refusal only when it answered its error envelope", () => {
    const refused = new TelemetryClientError("not yours", 409, "not_owner");
    expect(settleFailure(sent, refused).phase).toBe("refused");
    expect(
      settleFailure(sent, new TelemetryClientError("Telemetry request failed"))
        .phase,
    ).toBe("lost");
    expect(
      settleFailure(
        sent,
        new TelemetryClientError("invalid JSON", 502, undefined),
      ).phase,
    ).toBe("lost");
    expect(settleFailure(sent, "gone").phase).toBe("lost");
  });
});
