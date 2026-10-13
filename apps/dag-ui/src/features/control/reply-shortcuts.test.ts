import { REPLY_ENVELOPE_VERSION } from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";
import {
  composeEnvelope,
  SHORTCUT_FIELDS,
  SHORTCUTS,
  type Shortcut,
  type ShortcutFields,
} from "./reply-shortcuts";

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
      "set-node-sets": composeEnvelope("set-node-sets", {
        id: "docs",
        sets: ["members.worker.agent.model=small"],
      }),
      "set-run-node-sets": composeEnvelope("set-run-node-sets", {
        runSets: ["members.worker.agent.model=run"],
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

  test("a graph-override edit sends its whole list in order, and an empty list as `[]`", () => {
    const sets = [
      "members.worker.agent.oneharness_config=./b.toml",
      "members.worker.agent.model=a b, c=d",
    ];
    const node = composeEnvelope("set-node-sets", { id: "docs", sets });
    expect("envelope" in node && node.envelope.commands).toEqual([
      { op: "set-node-sets", id: "docs", sets },
    ]);
    // Cleared, a list is still named: absent would not replace anything.
    const cleared: readonly (readonly [Shortcut, ShortcutFields, unknown])[] = [
      [
        "set-node-sets",
        { id: "docs" },
        { op: "set-node-sets", id: "docs", sets: [] },
      ],
      [
        "set-node-sets",
        { id: "docs", sets: [] },
        { op: "set-node-sets", id: "docs", sets: [] },
      ],
      ["set-run-node-sets", {}, { op: "set-run-node-sets", sets: [] }],
      [
        "set-run-node-sets",
        { runSets: [] },
        { op: "set-run-node-sets", sets: [] },
      ],
    ];
    for (const [shortcut, fields, command] of cleared) {
      const composed = composeEnvelope(shortcut, fields);
      expect("bytes" in composed && JSON.parse(composed.bytes)).toEqual({
        version: REPLY_ENVELOPE_VERSION,
        commands: [command],
      });
    }
    // Neither edit carries the other's list, nor a node id the form still
    // holds: the node list being edited is not the run-wide one.
    const run = composeEnvelope("set-run-node-sets", {
      id: "docs",
      sets: ["members.worker.agent.model=node"],
      runSets: ["members.worker.agent.model=run"],
    });
    expect("envelope" in run && run.envelope.commands).toEqual([
      { op: "set-run-node-sets", sets: ["members.worker.agent.model=run"] },
    ]);
    // `add`, `retry` and `requeue` carry the node's `sets` as typed, `[]` too.
    const carried: readonly (readonly [Shortcut, ShortcutFields, unknown])[] = [
      [
        "add",
        { json: '{"id":"docs","task":"Write it","sets":[]}' },
        { op: "add", node: { id: "docs", task: "Write it", sets: [] } },
      ],
      [
        "retry",
        {
          id: "docs",
          json: `{"id":"docs-2","task":"Again","sets":${JSON.stringify(sets)}}`,
        },
        {
          op: "retry",
          id: "docs",
          node: { id: "docs-2", task: "Again", sets },
        },
      ],
      [
        "requeue",
        { id: "docs", json: '{"sets":[]}' },
        { op: "requeue", id: "docs", amend: { sets: [] } },
      ],
    ];
    for (const [shortcut, fields, command] of carried) {
      const composed = composeEnvelope(shortcut, fields);
      expect("envelope" in composed && composed.envelope.commands).toEqual([
        command,
      ]);
    }
  });

  test("a graph-override edit that cannot be read says which entry or field", () => {
    expect(
      composeEnvelope("set-node-sets", {
        id: "docs",
        sets: ["members.worker.agent.model=a", "  "],
      }),
    ).toEqual({ problem: "sets.1: an override needs a PATH=VALUE" });
    expect(
      composeEnvelope("set-node-sets", {
        sets: ["members.worker.agent.model=a"],
      }),
    ).toMatchObject({ problem: expect.stringMatching(/^commands\.0\.id: /) });
    expect(
      composeEnvelope("requeue", { id: "docs", json: '{"sets":"a=1"}' }),
    ).toMatchObject({
      problem: expect.stringMatching(/^commands\.0\.amend\.sets: /),
    });
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
