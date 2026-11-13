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
  readonly kind: Kind;
  /** Whether `null` is taken. */
  readonly nullable: boolean;
  /** The words an `enum` takes, and only those. */
  readonly words?: readonly string[];
  /** The types a `union` takes, one per alternative. */
  readonly alternatives?: readonly Kind[];
  /** The least value a `number` or `integer` takes, which it takes. */
  readonly least?: number;
}

/**
 * One field the check reads, wherever an answer holds it: what `fields.json` lists and
 * a journey alters, one at a time, to watch each refused.
 */
export interface DeclaredField extends Holds {
  /**
   * Where it is in any answer, as {@link namedPath} names it, with `[0]` for any item of
   * a list and `*` for any entry of a record.
   */
  readonly field: string;
  /** Whether the contract requires it where what holds it is there. */
  readonly required: boolean;
  /** A value of a type the field never holds, which the check refuses. */
  readonly wrong: unknown;
  /** A value of the field's type the check still refuses, where there is one. */
  readonly unfit?: unknown;
  /**
   * The field a refusal names, where it is not this one: a member of one of a union's
   * alternatives is refused as the union.
   */
  readonly names?: string;
}

/** One value's check: why it fails at `path`, the fields it reads, and a value it takes. */
interface Check extends Holds {
  /** The reason `value` fails, or `undefined`. */
  readonly check: (value: unknown, path: string) => string | undefined;
  /** Every field under this value, at `pattern`, whatever any answer holds. */
  readonly declare: (
    pattern: string,
    out: DeclaredField[],
    names: string | undefined,
  ) => void;
  /** A value this check takes, holding every field it reads. */
  readonly exemplar: () => unknown;
  /** A value of a type this check refuses. */
  readonly wrong: unknown;
  /** A value of its type this check refuses, where there is one. */
  readonly unfit?: unknown;
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

/** What `check` holds, as the field holding it lists it. */
const held = (check: Check): Holds => ({
  kind: check.kind,
  nullable: check.nullable,
  ...(check.words === undefined ? {} : { words: check.words }),
  ...(check.alternatives === undefined
    ? {}
    : { alternatives: check.alternatives }),
  ...(check.least === undefined ? {} : { least: check.least }),
});

const nothingUnder: Check["declare"] = () => undefined;

/** A check of a value with no fields of its own. */
const leaf = (
  kind: Kind,
  holds: (value: unknown) => boolean,
  wanted: string,
  values: { exemplar: unknown; wrong: unknown; unfit?: unknown },
  words?: readonly string[],
  least?: number,
): Check => ({
  check: (value, path) =>
    holds(value) ? undefined : wrong(path, wanted, value),
  declare: nothingUnder,
  exemplar: () => values.exemplar,
  wrong: values.wrong,
  ...(values.unfit === undefined ? {} : { unfit: values.unfit }),
  kind,
  nullable: false,
  ...(words === undefined ? {} : { words }),
  ...(least === undefined ? {} : { least }),
});

const string = leaf(
  "string",
  (value) => typeof value === "string",
  "a string",
  {
    exemplar: "x",
    wrong: 42,
  },
);

const boolean = leaf(
  "boolean",
  (value) => typeof value === "boolean",
  "a boolean",
  { exemplar: true, wrong: "yes" },
);

const number = leaf(
  "number",
  (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  "a non-negative number",
  { exemplar: 1, wrong: "many", unfit: -1 },
  undefined,
  0,
);

const counter = leaf(
  "integer",
  (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
  "a non-negative integer",
  { exemplar: 1, wrong: "many", unfit: 1.5 },
  undefined,
  0,
);

/** An instant `Date.parse` reads, which is how the screen places it. */
const timestamp = leaf(
  "timestamp",
  (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
  "a timestamp",
  { exemplar: "2026-01-01T00:00:00.000Z", wrong: 42, unfit: "not a time" },
);

const oneOf = (words: readonly string[]): Check =>
  leaf(
    "enum",
    (value) => typeof value === "string" && words.includes(value),
    `one of ${words.join(", ")}`,
    { exemplar: words[0], wrong: 42, unfit: "not-one-of-them" },
    words,
  );

const isTrue = leaf("true", (value) => value === true, "true", {
  exemplar: true,
  wrong: "yes",
  unfit: false,
});

/** A field an answer may leave out, and which is checked where it is there. */
const optional = (inner: Check): Check => ({
  ...inner,
  check: (value, path) =>
    value === undefined ? undefined : inner.check(value, path),
});

const nullable = (inner: Check): Check => ({
  ...inner,
  nullable: true,
  check: (value, path) =>
    value === null ? undefined : inner.check(value, path),
});

/** One of two checks; the second's exemplar, which holds its fields, stands for it. */
const either = (first: Check, second: Check, wanted: string): Check => ({
  check: (value, path) =>
    first.check(value, path) === undefined ||
    second.check(value, path) === undefined
      ? undefined
      : wrong(path, wanted, value),
  // A member of an alternative is refused as the union it is part of.
  declare: (pattern, out, names) => {
    first.declare(pattern, out, names ?? pattern);
    second.declare(pattern, out, names ?? pattern);
  },
  exemplar: second.exemplar,
  wrong: "some",
  kind: "union",
  nullable: false,
  alternatives: [first.kind, second.kind],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a member's check lets it be left out. */
const optionalMembers = new WeakSet<Check>();

/** One field, as the object or record holding it lists it, and every field under it. */
function declared(
  check: Check,
  field: string,
  required: boolean,
  out: DeclaredField[],
  names: string | undefined,
): void {
  out.push({
    ...held(check),
    field,
    required,
    wrong: check.wrong,
    ...(check.unfit === undefined ? {} : { unfit: check.unfit }),
    ...(names === undefined ? {} : { names }),
  });
  check.declare(field, out, names);
}

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
  declare: (pattern, out, names) => {
    for (const [name, member] of Object.entries(members))
      declared(
        member,
        `${pattern}.${name}`,
        !optionalMembers.has(member),
        out,
        names,
      );
  },
  exemplar: () =>
    Object.fromEntries(
      Object.entries(members).map(([name, member]) => [
        name,
        member.exemplar(),
      ]),
    ),
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
  // Any item of a list is a field of its own, which a list may hold none of.
  declare: (pattern, out, names) => {
    if (each.kind !== "anything")
      declared(each, `${pattern}[0]`, false, out, names);
  },
  exemplar: () => [each.exemplar()],
  wrong: "a list",
  kind: "array",
  nullable: false,
});

/** The key a record's exemplar holds its one entry under. */
export const EXEMPLAR_KEY = "x";

const record = (each: Check): Check => ({
  check: (value, path) => {
    if (!isObject(value)) return wrong(path, "an object", value);
    for (const [key, item] of Object.entries(value)) {
      const failed = each.check(item, `${path}.${key}`);
      if (failed !== undefined) return failed;
    }
    return undefined;
  },
  // A record may hold any key or none, so an entry of one is never required.
  declare: (pattern, out, names) => {
    if (each.kind !== "anything")
      declared(each, `${pattern}.*`, false, out, names);
  },
  exemplar: () => ({ [EXEMPLAR_KEY]: each.exemplar() }),
  wrong: "an object",
  kind: "record",
  nullable: false,
});

/** A value the screen reads only the presence of. */
const anything: Check = {
  check: () => undefined,
  declare: nothingUnder,
  exemplar: () => ({}),
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
  kind: maybe(oneOf(["agent", "human", "command"])),
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

/** Every field {@link checkFirstAnswer} reads, wherever an answer holds it. */
export function declaredFields(): DeclaredField[] {
  const out: DeclaredField[] = [];
  answer.declare("answer", out, undefined);
  return out;
}

/** An answer {@link checkFirstAnswer} takes, holding every field it reads. */
export function exemplarAnswer(): unknown {
  return answer.exemplar();
}

/** How {@link checkFirstAnswer} names the field at `path`. */
export function namedPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (named, step) =>
      typeof step === "number" ? `${named}[${step}]` : `${named}.${step}`,
    "answer",
  );
}
