import {
  AGENT_LABELS,
  type AgentSession,
  agentSessionSchema,
} from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";

import { groupAgentSessions, groupLabel } from "./agents-model";

/** A session as the SDK serves one, stamped under `scope` and `attempt`. */
const stamped = (
  scope: string,
  attempt: string | undefined,
  historyId: string,
): AgentSession =>
  agentSessionSchema.parse({
    history_session: `session-${historyId}`,
    name: `session-${historyId}`,
    history_dir: "/a-scratch/oneharness-history",
    history_project: "a-recording-host-workspace",
    history_file: `/a-scratch/oneharness-history/a-recording-host-workspace/session-${historyId}.jsonl`,
    project: "/a-recording-host/workspace",
    started: "2026-10-19T12:00:00Z",
    labels: {
      [AGENT_LABELS.runId]: "run-20261019-a1b2c3",
      [AGENT_LABELS.scope]: scope,
      [AGENT_LABELS.node]: "contract-interface",
      ...(attempt === undefined ? {} : { [AGENT_LABELS.attempt]: attempt }),
    },
    runs: [
      {
        history_id: historyId,
        harness: "claude-code",
        harness_id: "claude-code",
        started: "2026-10-19T12:00:00Z",
      },
    ],
    run_id: "run-20261019-a1b2c3",
  });

describe("grouping a run's sessions by the launch that wrote them", () => {
  test("files the review reply drafter after the change request author, by attempt", () => {
    const groups = groupAgentSessions([
      stamped("review-reply", "2", "a"),
      stamped("unknown-launch", undefined, "b"),
      stamped("pr-author", "1", "c"),
      stamped("review-reply", "1", "d"),
      stamped("node", "1", "e"),
    ]);
    expect(groups.map(groupLabel)).toEqual([
      "Node dispatch · attempt 1",
      "Change request author · attempt 1",
      "Review reply drafter · attempt 1",
      "Review reply drafter · attempt 2",
      "unknown-launch",
    ]);
  });
});
