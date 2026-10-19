import type { AgentSession } from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";
import { groupAgentSessions, groupLabel } from "./agents-model";

/** One session as the agents listing serves it, stamped with `labels`. */
function session(name: string, labels: Record<string, string>): AgentSession {
  return {
    history_session: `${name}-session`,
    name,
    history_dir: "/home/operator/.oneharness/history",
    history_project: "a-project",
    history_file: `${name}.jsonl`,
    project: "a-project",
    started: "2026-07-26T11:57:00Z",
    labels,
    runs: [],
  };
}

describe("agent groups", () => {
  test("a review reply's drafting is read under its own heading, after the change request's author", () => {
    const groups = groupAgentSessions([
      session("replier", {
        "onepipeline.scope": "review-reply",
        "onepipeline.node": "dashboard",
        "onepipeline.attempt": "1",
      }),
      session("author", {
        "onepipeline.scope": "pr-author",
        "onepipeline.node": "dashboard",
        "onepipeline.attempt": "1",
      }),
      session("monitor", { "onepipeline.scope": "observer" }),
    ]);
    expect(groups.map(groupLabel)).toEqual([
      "Observer",
      "Change request author · attempt 1",
      "Review reply author · attempt 1",
    ]);
  });

  test("a scope word the engine never declared is grouped under that word, after every declared one", () => {
    const groups = groupAgentSessions([
      session("stranger", { "onepipeline.scope": "a-later-scope" }),
      session("replier", {
        "onepipeline.scope": "review-reply",
        "onepipeline.attempt": "2",
      }),
    ]);
    expect(groups.map(groupLabel)).toEqual([
      "Review reply author · attempt 2",
      "a-later-scope",
    ]);
  });
});
