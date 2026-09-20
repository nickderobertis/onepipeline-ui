import { REPLY_ENVELOPE_VERSION } from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";
import { composeEnvelope, SHORTCUT_FIELDS, SHORTCUTS } from "./reply-shortcuts";

describe("reply shortcuts", () => {
  test("a verdict is the legacy half and names no version", () => {
    expect(composeEnvelope("approve", { message: "ship it" })).toEqual({
      envelope: { completion: true, message: "ship it" },
      bytes: '{\n  "completion": true,\n  "message": "ship it"\n}',
    });
    expect(
      composeEnvelope("reject", { message: "not yet", reason: "gate is red" }),
    ).toMatchObject({
      envelope: {
        completion: false,
        message: "not yet",
        reason: "gate is red",
      },
    });
    expect(composeEnvelope("continue", { message: "carry on" })).toMatchObject({
      envelope: { message: "carry on" },
    });
  });

  test("every op renders to one command at the version the engine reads edits at", () => {
    const composed = {
      add: composeEnvelope("add", {
        json: '{"id":"docs","task":"Write it","deps":["build"]}',
      }),
      drop: composeEnvelope("drop", { id: "obsolete", dependents: "detach" }),
      reparent: composeEnvelope("reparent", {
        id: "docs",
        deps: "build\nlint\n",
      }),
      retry: composeEnvelope("retry", {
        id: "docs",
        json: '{"id":"docs-2","task":"Write it again"}',
      }),
      cancel: composeEnvelope("cancel", { id: "docs", reason: "superseded" }),
      requeue: composeEnvelope("requeue", {
        id: "docs",
        json: '{"max_turns":3}',
      }),
      attest: composeEnvelope("attest", { reference: "signoff" }),
      complete: composeEnvelope("complete", { reason: "everything landed" }),
      amend: composeEnvelope("amend", { id: "docs", text: "the bar is p99" }),
      note: composeEnvelope("note", {
        id: "docs",
        addressee: "worker",
        text: "measure it too",
        deliver: "next",
        persist: true,
      }),
      finding: composeEnvelope("finding", {
        message: "gate red twice",
        blocking: true,
        id: "docs",
      }),
      settle: composeEnvelope("settle", {
        id: "ship",
        outcome: "done",
        evidence: "landed as #12",
      }),
    };
    for (const [op, result] of Object.entries(composed)) {
      expect(result, op).toHaveProperty("envelope");
      if (!("envelope" in result)) continue;
      expect(result.envelope.version).toBe(REPLY_ENVELOPE_VERSION);
      expect(result.envelope.commands?.[0]?.op).toBe(op);
      // The bytes are the envelope, pretty-printed, and nothing more.
      expect(JSON.parse(result.bytes)).toEqual(result.envelope);
    }
    expect(
      "envelope" in composed.reparent &&
        composed.reparent.envelope.commands?.[0],
    ).toEqual({ op: "reparent", id: "docs", deps: ["build", "lint"] });
    // A live note carrying the defaults spells neither default on the wire.
    expect(
      "envelope" in composed.note && composed.note.envelope.commands?.[0],
    ).toEqual({
      op: "note",
      id: "docs",
      addressee: "worker",
      text: "measure it too",
      deliver: "next",
    });
    expect(Object.keys(composed).sort()).toEqual(
      SHORTCUTS.filter(
        (s) =>
          s in SHORTCUT_FIELDS &&
          !["approve", "reject", "continue"].includes(s),
      ).sort(),
    );
  });

  test("a form that cannot compose an envelope the engine would read says which field", () => {
    expect(composeEnvelope("drop", { id: "", dependents: "detach" })).toEqual({
      problem:
        "commands.0.id: Invalid input: expected string, received undefined",
    });
    expect(composeEnvelope("add", { json: "not json" })).toMatchObject({
      problem: expect.stringMatching(/^node: /),
    });
    expect(composeEnvelope("add", {})).toEqual({
      problem: "node: a node mapping is required",
    });
    expect(
      composeEnvelope("note", { id: "docs", addressee: "everyone", text: "x" }),
    ).toMatchObject({
      problem: expect.stringMatching(/^commands\.0\.addressee: /),
    });
  });
});
