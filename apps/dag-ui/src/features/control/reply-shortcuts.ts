import {
  REPLY_ENVELOPE_VERSION,
  REPLY_OPS,
  type ReplyCommand,
  type ReplyEnvelope,
  type ReplyOp,
  replyEnvelopeSchema,
} from "@onepipeline-ui/dag-model";

/**
 * The three verdicts, as the engine's legacy verdict half spells them.
 *
 * The half is three optional fields — `completion`, `message`, `reason` — and a
 * verdict word is one setting of them: **approve** says the planner considers the
 * run complete (`completion: true`), **reject** says it does not and why
 * (`completion: false` with the reason), and **continue** carries a message and
 * no claim about completion at all. Nothing here invents a word for the wire:
 * the composed envelope is exactly the fields, and it is shown before it is sent.
 */
export const VERDICT_SHORTCUTS = {
  approve: "Approve",
  reject: "Reject",
  continue: "Continue",
} as const;
export type VerdictShortcut = keyof typeof VERDICT_SHORTCUTS;

/** Every shortcut the composer offers: the verdicts, then every op the engine declares. */
export type Shortcut = VerdictShortcut | ReplyOp;

export const SHORTCUTS: readonly Shortcut[] = [
  "approve",
  "reject",
  "continue",
  ...REPLY_OPS,
];

export function isShortcut(value: string): value is Shortcut {
  return SHORTCUTS.some((shortcut) => shortcut === value);
}

/** What a shortcut's form collects, every field as the text a person typed. */
export interface ShortcutFields {
  readonly message?: string;
  readonly reason?: string;
  readonly id?: string;
  readonly text?: string;
  readonly addressee?: string;
  readonly deliver?: string;
  readonly persist?: boolean;
  readonly criterion?: string;
  readonly dependents?: string;
  /** Dependency references, one per line. */
  readonly deps?: string;
  readonly reference?: string;
  readonly outcome?: string;
  readonly evidence?: string;
  readonly landing?: string;
  readonly blocking?: boolean;
  /** A node mapping or an amendment, as the JSON a person typed. */
  readonly json?: string;
  /**
   * A node's ordered replacement list of graph overrides, one `PATH=VALUE` entry
   * each, in the order the engine applies them. Empty is a list too: it clears.
   */
  readonly sets?: readonly string[];
  /**
   * The run-wide replacement list, on the same terms. A field of its own rather
   * than `sets`, so a node's list being edited is never carried into the edit of
   * every node's, or back.
   */
  readonly runSets?: readonly string[];
}

/**
 * The fields a shortcut's form shows, in order. A field a shortcut does not
 * list is never composed into its envelope, so a form cannot leak a stale value
 * from the last shortcut into this one.
 */
export const SHORTCUT_FIELDS: Readonly<
  Record<Shortcut, readonly (keyof ShortcutFields)[]>
> = {
  approve: ["message", "reason"],
  reject: ["message", "reason"],
  continue: ["message"],
  add: ["json"],
  drop: ["id", "dependents"],
  reparent: ["id", "deps"],
  retry: ["id", "json"],
  cancel: ["id", "reason"],
  requeue: ["id", "json"],
  "set-node-sets": ["id", "sets"],
  "set-run-node-sets": ["runSets"],
  attest: ["reference"],
  complete: ["reason"],
  amend: ["id", "text"],
  note: ["id", "addressee", "text", "criterion", "deliver", "persist"],
  finding: ["message", "blocking", "id"],
  settle: ["id", "outcome", "evidence", "landing"],
};

export type Composed =
  | { readonly envelope: ReplyEnvelope; readonly bytes: string }
  | { readonly problem: string };

/**
 * Render a shortcut and its fields to the envelope the engine's `Reply` schema
 * states, as the bytes the composer places in the editor.
 *
 * Every op envelope names the version the engine reads edits at; a verdict
 * names none, because a verdict alone needs none. The result is held to the
 * grammar before it is offered — a shortcut composing something the grammar
 * refuses is a defect here, and the reader is told rather than handed an
 * envelope the engine would refuse for a reason that is not theirs.
 */
export function composeEnvelope(
  shortcut: Shortcut,
  fields: ShortcutFields,
): Composed {
  const draft = draftEnvelope(shortcut, fields);
  if ("problem" in draft) return draft;
  const parsed = replyEnvelopeSchema.safeParse(draft.envelope);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      problem: `${issue?.path.join(".") || "envelope"}: ${issue?.message ?? "not an envelope"}`,
    };
  }
  return {
    envelope: parsed.data,
    bytes: JSON.stringify(parsed.data, null, 2),
  };
}

function draftEnvelope(
  shortcut: Shortcut,
  fields: ShortcutFields,
): { envelope: unknown } | { problem: string } {
  const text = (key: keyof ShortcutFields): string | undefined => {
    const value = fields[key];
    return typeof value === "string" && value.trim().length > 0
      ? value
      : undefined;
  };
  switch (shortcut) {
    case "approve":
      return {
        envelope: {
          completion: true,
          ...optional("message", text("message")),
          ...optional("reason", text("reason")),
        },
      };
    case "reject":
      return {
        envelope: {
          completion: false,
          ...optional("message", text("message")),
          ...optional("reason", text("reason")),
        },
      };
    case "continue":
      return { envelope: { message: text("message") ?? "" } };
    default: {
      const command = draftCommand(shortcut, fields, text);
      if ("problem" in command) return command;
      return {
        envelope: {
          version: REPLY_ENVELOPE_VERSION,
          commands: [command.command],
        },
      };
    }
  }
}

function draftCommand(
  op: ReplyOp,
  fields: ShortcutFields,
  text: (key: keyof ShortcutFields) => string | undefined,
): { command: unknown } | { problem: string } {
  const id = text("id");
  switch (op) {
    case "add":
    case "retry":
    case "requeue": {
      const mapping = text("json");
      if (mapping === undefined && op !== "requeue")
        return { problem: "node: a node mapping is required" };
      let parsed: unknown;
      if (mapping !== undefined) {
        try {
          parsed = JSON.parse(mapping);
        } catch (caught) {
          return {
            problem: `${op === "requeue" ? "amend" : "node"}: ${caught instanceof Error ? caught.message : "not JSON"}`,
          };
        }
      }
      if (op === "add") return { command: { op, node: parsed } };
      if (op === "retry") return { command: { op, id, node: parsed } };
      return { command: { op, id, ...optional("amend", parsed) } };
    }
    case "set-node-sets":
    case "set-run-node-sets": {
      // The whole replacement list, in order and as typed: an entry is the
      // engine's to read, so none is trimmed, reordered or dropped here — and a
      // blank one is refused by position rather than sent to be refused there.
      const sets = [
        ...((op === "set-node-sets" ? fields.sets : fields.runSets) ?? []),
      ];
      const blank = sets.findIndex((entry) => entry.trim().length === 0);
      if (blank >= 0)
        return { problem: `sets.${blank}: an override needs a PATH=VALUE` };
      return op === "set-node-sets"
        ? { command: { op, id, sets } }
        : { command: { op, sets } };
    }
    case "drop":
      return { command: { op, id, dependents: text("dependents") } };
    case "reparent":
      return {
        command: {
          op,
          id,
          deps: (fields.deps ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        },
      };
    case "cancel":
      return { command: { op, id, ...optional("reason", text("reason")) } };
    case "attest":
      return { command: { op, ref: text("reference") } };
    case "complete":
      return { command: { op, reason: text("reason") } };
    case "amend":
      return { command: { op, id, text: text("text") } };
    case "note":
      return {
        command: {
          op,
          id,
          addressee: text("addressee"),
          text: text("text"),
          ...optional("criterion", text("criterion")),
          ...optional(
            "deliver",
            text("deliver") === "live" ? undefined : text("deliver"),
          ),
          ...(fields.persist === false ? { persist: false } : {}),
        },
      };
    case "finding":
      return {
        command: {
          op,
          message: text("message"),
          ...(fields.blocking === true ? { blocking: true } : {}),
          ...optional("id", id),
        },
      };
    case "settle":
      return {
        command: {
          op,
          id,
          outcome: text("outcome"),
          evidence: text("evidence"),
          ...optional("landing", text("landing")),
        },
      };
    default: {
      const unreachable: never = op;
      return { problem: `op: ${String(unreachable)} is not an op` };
    }
  }
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  const entry: Partial<Record<K, V>> = {};
  if (value !== undefined) entry[key] = value;
  return entry;
}

/** A command's op, for a row of the queue listing what an envelope carried. */
export function opOf(command: Record<string, unknown>): string {
  const op = command.op;
  return typeof op === "string" ? op : "?";
}

/** Whether a command the queue holds is one the grammar spells. */
export const isKnownOp = (op: string): op is ReplyOp =>
  REPLY_OPS.some((known) => known === op);

export type { ReplyCommand };
