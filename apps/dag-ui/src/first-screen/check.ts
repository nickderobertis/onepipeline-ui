/**
 * The first answer, checked before the first screen draws it: every field that screen
 * reads, directly and through the view models it draws with, held to the type
 * `docs/contract.md` gives it, and nothing else.
 *
 * Narrow by design. The full contract parse (`@onepipeline-ui/dag-model`'s zod
 * schemas) is what the app holds the same answer to when it takes it over; here it
 * would put zod and every schema on a large run's first second. So this reads only
 * what `FirstScreen` reads, with no dependency, and names the first field that is
 * missing or of the wrong type, so a screen is never drawn from one.
 *
 * Where the contract allows more than the screen reads (an open object's other
 * members, a span's intervals), nothing here looks; where it is stricter than the
 * screen needs (a string's minimum length), this holds the screen's own need.
 */

import type { FirstAnswer } from "./FirstScreen";

/** The type a check holds a value to. */
export type Kind =
  | "string"
  | "boolean"
  | "number"
  | "integer"
  | "timestamp"
  | "enum"
  | "true"
  | "union"
  | "object"
  | "array"
  | "record"
  | "anything";

/** What a check holds a value to, which its unit test holds to the contract's schema. */
interface Holds {
  /** The type. */
  readonly kind: Kind;
  /** Whether `null` is taken. */
  readonly nullable: boolean;
  /** The words an `enum` takes, and only those. */
  readonly words?: readonly string[];
}

/** One field a check reads, in an answer it was asked to list them for. */
export interface FirstScreenField extends Holds {
  /** Where it is, from the answer, as keys and indices. */
  readonly path: readonly (string | number)[];
  /**
   * Where it is in any answer, as {@link namedPath} names it with a record's entry as
   * `*`: what `fields.json` lists.
   */
  readonly pattern: string;
  /** Whether the contract requires it, so an answer without it is refused. */
  readonly required: boolean;
  /** A value of a type the field never holds, which the check refuses. */
  readonly wrong: unknown;
}

/** One value's check: why it fails at `path`, and the fields it reads in it. */
interface Check extends Holds {
  /** The reason `value` fails, or `undefined`. */
  readonly check: (value: unknown, path: string) => string | undefined;
  /**
   * Every field this check reads in `value`, at `at`: an array's first item's and a
   * record's first entry's, which stand for every other.
   */
  readonly fields: (
    value: unknown,
    at: readonly (string | number)[],
    pattern: string,
    out: FirstScreenField[],
  ) => void;
  /** A value of a type this check refuses. */
  readonly wrong: unknown;
}

/** How a value that is there reads in a reason. */
function shown(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? `"${value.slice(0, 40)}"` : typeof value;
}

const wrong = (path: string, wanted: string, value: unknown) =>
  value === undefined
    ? `${path} is missing`
    : `${path} is ${shown(value)}, not ${wanted}`;

/** What `check` holds, as a field of the object holding it lists it. */
const held = (check: Check): Holds => ({
  kind: check.kind,
  nullable: check.nullable,
  ...(check.words === undefined ? {} : { words: check.words }),
});

/** A check of a value with no fields of its own. */
const leaf = (
  kind: Kind,
  holds: (value: unknown) => boolean,
  wanted: string,
  refused: unknown,
  words?: readonly string[],
): Check => ({
  check: (value, path) =>
    holds(value) ? undefined : wrong(path, wanted, value),
  fields: () => undefined,
  wrong: refused,
  kind,
  nullable: false,
  ...(words === undefined ? {} : { words }),
});

const string = leaf(
  "string",
  (value) => typeof value === "string",
  "a string",
  42,
);

const boolean = leaf(
  "boolean",
  (value) => typeof value === "boolean",
  "a boolean",
  "yes",
);

const number = leaf(
  "number",
  (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  "a non-negative number",
  "many",
);

const counter = leaf(
  "integer",
  (value) => Number.isInteger(value) && (value as number) >= 0,
  "a non-negative integer",
  "many",
);

/** An instant `Date.parse` reads, which is how the screen places it. */
const timestamp = leaf(
  "timestamp",
  (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
  "a timestamp",
  42,
);

const oneOf = (words: readonly string[]): Check =>
  leaf(
    "enum",
    (value) => typeof value === "string" && words.includes(value),
    `one of ${words.join(", ")}`,
    42,
    words,
  );

const isTrue = leaf("true", (value) => value === true, "true", "yes");

/** A field an answer may leave out, and which is checked where it is there. */
const optional = (inner: Check): Check => ({
  ...held(inner),
  check: (value, path) =>
    value === undefined ? undefined : inner.check(value, path),
  fields: inner.fields,
  wrong: inner.wrong,
});

const nullable = (inner: Check): Check => ({
  ...held(inner),
  nullable: true,
  check: (value, path) =>
    value === null ? undefined : inner.check(value, path),
  fields: (value, at, pattern, out) => {
    if (value !== null) inner.fields(value, at, pattern, out);
  },
  wrong: inner.wrong,
});

const either = (first: Check, second: Check, wanted: string): Check => ({
  check: (value, path) =>
    first.check(value, path) === undefined ||
    second.check(value, path) === undefined
      ? undefined
      : wrong(path, wanted, value),
  fields: () => undefined,
  wrong: "some",
  kind: "union",
  nullable: false,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a member's check lets it be left out. */
const optionalMembers = new WeakSet<Check>();

/** An open object: these members checked, any other left alone. */
const object = (members: Readonly<Record<string, Check>>): Check => ({
  check: (value, path) => {
    if (!isObject(value)) return wrong(path, "an object", value);
    for (const [name, member] of Object.entries(members)) {
      const failed = member.check(value[name], `${path}.${name}`);
      if (failed !== undefined) return failed;
    }
    return undefined;
  },
  fields: (value, at, pattern, out) => {
    if (!isObject(value)) return;
    for (const [name, member] of Object.entries(members)) {
      const path = [...at, name];
      const named = `${pattern}.${name}`;
      out.push({
        ...held(member),
        path,
        pattern: named,
        required: !optionalMembers.has(member),
        wrong: member.wrong,
      });
      if (value[name] !== undefined)
        member.fields(value[name], path, named, out);
    }
  },
  wrong: "an object",
  kind: "object",
  nullable: false,
});

const array = (each: Check): Check => ({
  check: (value, path) => {
    if (!Array.isArray(value)) return wrong(path, "an array", value);
    for (const [at, item] of value.entries()) {
      const failed = each.check(item, `${path}[${at}]`);
      if (failed !== undefined) return failed;
    }
    return undefined;
  },
  fields: (value, at, pattern, out) => {
    if (Array.isArray(value) && value.length > 0)
      each.fields(value[0], [...at, 0], `${pattern}[0]`, out);
  },
  wrong: "a list",
  kind: "array",
  nullable: false,
});

const record = (each: Check): Check => ({
  check: (value, path) => {
    if (!isObject(value)) return wrong(path, "an object", value);
    for (const [key, item] of Object.entries(value)) {
      const failed = each.check(item, `${path}.${key}`);
      if (failed !== undefined) return failed;
    }
    return undefined;
  },
  fields: (value, at, pattern, out) => {
    if (!isObject(value)) return;
    const [first] = Object.entries(value);
    if (first === undefined) return;
    const path = [...at, first[0]];
    const named = `${pattern}.*`;
    // A record may hold any key or none, so an entry is never missing.
    if (each !== anything)
      out.push({
        ...held(each),
        path,
        pattern: named,
        required: false,
        wrong: each.wrong,
      });
    each.fields(first[1], path, named, out);
  },
  wrong: "an object",
  kind: "record",
  nullable: false,
});

/** A value the screen reads only the presence of. */
const anything: Check = {
  check: () => undefined,
  fields: () => undefined,
  wrong: undefined,
  kind: "anything",
  nullable: false,
};

/** {@link optional}, marked so the object holding it lists it as optional. */
const maybe = (inner: Check): Check => {
  const made = optional(inner);
  optionalMembers.add(made);
  return made;
};

/** `GraphState.node_status`'s words, which the graph's layout draws and no other. */
export const NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "skipped",
  "done",
  "not-completed",
  "failed",
  "parked",
  "cancelled",
  "complete-but-draft",
  "complete-but-held",
  "unknown",
] as const;

/** A span's kinds, each of which a node's timeline has a lane for. */
export const SPAN_KINDS = [
  "run",
  "node",
  "step",
  "dispatch",
  "verification",
  "publication",
  "pr-drafting",
  "conflict-resolution",
  "human-wait",
  "rollup",
  "queued",
] as const;

/** Where a span's heavy content lives, by kind. */
export const REFERENCE_KINDS = [
  "conversation",
  "gate_log",
  "worker_report",
  "oneharness_session",
  "pr",
] as const;

/** The party a dispatch's transport carries. */
export const TRANSPORT_ROLES = ["agent", "judge", "llmlint"] as const;

const strings = array(string);

const result = object({
  blocked_by: maybe(strings),
  awaiting: maybe(array(object({ producer: string, target: string }))),
  detail: maybe(string),
  error: maybe(nullable(string)),
  outcome: maybe(string),
});

const task = object({
  id: string,
  kind: maybe(oneOf(["agent", "human"])),
  deps: maybe(strings),
});

const detail = object({
  progress: maybe(object({ complete: boolean })),
  node_details: record(anything),
  run: object({
    run_id: string,
    phase: string,
    last_event: nullable(string),
    state: string,
    nodes: array(
      object({
        node: string,
        failure: maybe(object({ detail: maybe(string) })),
        outcome: maybe(string),
      }),
    ),
    timing: object({ wall_seconds: nullable(number) }),
    turns: either(
      counter,
      object({ loading: isTrue }),
      "a count or { loading: true }",
    ),
  }),
  graph: nullable(
    object({
      plan: object({
        tasks: array(task),
        goal: maybe(object({ text: string })),
      }),
      node_status: record(oneOf(NODE_STATUSES)),
      node_results: record(result),
      result: nullable(object({ results: maybe(record(result)) })),
      node_control: record(anything),
      node_gated_by: record(strings),
    }),
  ),
});

const group = object({
  id: string,
  label: string,
  order: counter,
  started_at: timestamp,
});

const event = object({
  id: string,
  record_id: maybe(string),
  step_id: maybe(string),
  kind: string,
  at: timestamp,
  status: maybe(string),
  node_id: maybe(string),
  dispatch_group: maybe(group),
  description: maybe(string),
  author: maybe(string),
  journal_order: maybe(counter),
  redirection: maybe(object({ delivered: boolean })),
  surface: maybe(
    object({
      kind: maybe(string),
      message: maybe(string),
      blocking: maybe(boolean),
    }),
  ),
});

const span = object({
  id: string,
  kind: oneOf(SPAN_KINDS),
  label: string,
  started_at: timestamp,
  ended_at: nullable(timestamp),
  events: array(event),
  events_total: maybe(counter),
  parent_id: maybe(string),
  node_id: maybe(string),
  status: maybe(string),
  count: maybe(counter),
  total_duration_ms: maybe(counter),
  harness_scope: maybe(string),
  agent_role: maybe(string),
  transport_role: maybe(oneOf(TRANSPORT_ROLES)),
  dispatch_group: maybe(group),
  reference: maybe(object({ kind: oneOf(REFERENCE_KINDS), value: string })),
  reasons: maybe(
    array(
      object({
        kind: string,
        ahead: maybe(strings),
        blocking: maybe(strings),
        reference: maybe(string),
        awaiting: maybe(strings),
      }),
    ),
  ),
});

const answer = object({
  initial: object({
    snapshot: object({
      visible: object({
        detail,
        timeline: maybe(object({ spans: array(span), observed_at: string })),
      }),
    }),
  }),
});

/** Why a first answer cannot be drawn: the field it fails at, by its path. */
export class FirstAnswerContractError extends Error {
  constructor(readonly reason: string) {
    // The app's own wording for the same answer failing its full parse.
    super(`The first answer failed contract validation: ${reason}`);
    this.name = "FirstAnswerContractError";
  }
}

/**
 * `answer` as the first screen reads it, or the reason it cannot be: the first field
 * the screen reads that is missing or of the wrong type, by its path from the answer.
 */
export function checkFirstAnswer(
  value: unknown,
): FirstAnswer | FirstAnswerContractError {
  const failed = answer.check(value, "answer");
  return failed === undefined
    ? (value as FirstAnswer)
    : new FirstAnswerContractError(failed);
}

/**
 * Every field {@link checkFirstAnswer} reads in `value`, each list's first item's
 * standing for the rest: what a journey alters, one at a time, to watch each refused.
 */
export function firstScreenFields(value: unknown): FirstScreenField[] {
  const out: FirstScreenField[] = [];
  answer.fields(value, [], "answer", out);
  return out;
}

/** How {@link checkFirstAnswer} names the field at `path`. */
export function namedPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (named, step) =>
      typeof step === "number" ? `${named}[${step}]` : `${named}.${step}`,
    "answer",
  );
}
