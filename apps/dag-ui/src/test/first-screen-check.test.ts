import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  liveRunDetailSchema,
  nodeStatusSchema,
  runTimelineSchema,
  subscribedSchema,
  timelineReferenceKindSchema,
  timelineSpanKindSchema,
  transportRoleSchema,
} from "@onepipeline-ui/dag-model";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  checkFirstAnswer,
  type DeclaredField,
  declaredFields,
  EXEMPLAR_KEY,
  exemplarAnswer,
  FirstAnswerContractError,
  NODE_STATUSES,
  REFERENCE_KINDS,
  SPAN_KINDS,
  TRANSPORT_ROLES,
} from "../first-screen/check";
import listed from "../first-screen/fields.json" with { type: "json" };

/**
 * The first screen's own check of its answer, field by field: over the answers the
 * server is pinned to serve (`tests/fixtures/subscriptions.json`, the subscription the
 * contract's golden journey writes, and that detail beside the complete timeline
 * `tests/fixtures/run-timeline.json` pins, as an Overall or node answer carries one),
 * and over the check's own exemplar, which holds every field it reads.
 */

/** One of the server's pinned goldens, by name. */
const golden = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../../tests/fixtures", name),
      "utf8",
    ),
  );
const subscribed = golden("subscriptions.json") as {
  initial: { snapshot: { visible: Record<string, unknown> } };
};
const timelineAnswer = {
  ...subscribed,
  initial: {
    ...subscribed.initial,
    snapshot: {
      ...subscribed.initial.snapshot,
      visible: {
        ...subscribed.initial.snapshot.visible,
        type: "timeline",
        scope: "run",
        timeline: golden("run-timeline.json"),
      },
    },
  },
};

const VISIBLE = "answer.initial.snapshot.visible";
const DECLARED = declaredFields();

type Json = Record<string | number, unknown>;

/** Where `field` is in the exemplar: its first item of each list, its one entry of each record. */
const inExemplar = (field: string): (string | number)[] =>
  field
    .replace(/\[0\]/gu, ".0")
    .split(".")
    .slice(1)
    .map((step) => (step === "0" ? 0 : step === "*" ? EXEMPLAR_KEY : step));

/** How the check names a field at `path`. */
const named = (path: readonly (string | number)[]) =>
  path.reduce<string>(
    (name, step) =>
      typeof step === "number" ? `${name}[${step}]` : `${name}.${step}`,
    "answer",
  );

/** `answer` with the value at `path` replaced, or removed where `value` is `undefined`. */
function altered(
  answer: unknown,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  const copy = structuredClone(answer) as Json;
  let at: Json = copy;
  for (const step of path.slice(0, -1)) at = at[step] as Json;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

/** The reason the check refuses `answer` for, which a passing answer has none of. */
const refusal = (answer: unknown): string | undefined => {
  const checked = checkFirstAnswer(answer);
  return checked instanceof FirstAnswerContractError
    ? checked.reason
    : undefined;
};

/** Whether `reason` names `field`, and not a field whose name begins with it. */
const names = (reason: string | undefined, field: string) =>
  reason !== undefined && reason.startsWith(`${field} `);

it.each([
  ["detail", subscribed],
  ["timeline", timelineAnswer],
])(
  "a served first %s answer is one the full contract reads, and the check passes",
  (_, answer) => {
    expect(() => subscribedSchema.parse(answer)).not.toThrow();
    expect(checkFirstAnswer(answer)).toBe(answer);
  },
);

it("lists in fields.json exactly the fields the check reads, and an answer it takes", () => {
  expect(listed.fields).toEqual(JSON.parse(JSON.stringify(DECLARED)));
  expect(listed.exemplar).toEqual(exemplarAnswer());
  expect(refusal(exemplarAnswer())).toBeUndefined();
  expect(DECLARED.map((field) => field.field)).toContain(
    `${VISIBLE}.timeline.spans[0].events[0].dispatch_group.order`,
  );
});

describe.each(DECLARED.map((field) => [field.field, field] as const))(
  "%s",
  (_, field) => {
    const path = inExemplar(field.field);
    const name = field.names ?? named(path);
    it("is refused, named, with a value of another type", () => {
      expect(refusal(altered(exemplarAnswer(), path, field.wrong))).toSatisfy(
        (reason: string | undefined) => names(reason, name),
      );
    });
    it.runIf(field.unfit !== undefined)(
      "is refused, named, with a value of its type it never holds",
      () => {
        expect(refusal(altered(exemplarAnswer(), path, field.unfit))).toSatisfy(
          (reason: string | undefined) => names(reason, name),
        );
      },
    );
    it.runIf(field.required)("is refused, named, where it is missing", () => {
      const reason = refusal(altered(exemplarAnswer(), path, undefined));
      if (field.names === undefined) expect(reason).toBe(`${name} is missing`);
      else
        expect(reason).toSatisfy((held: string | undefined) =>
          names(held, name),
        );
    });
  },
);

it("refuses what is not an answer at all, naming where it stopped", () => {
  expect(checkFirstAnswer(null)).toEqual(
    new FirstAnswerContractError("answer is null, not an object"),
  );
  expect(
    (checkFirstAnswer({ initial: { snapshot: {} } }) as Error).message,
  ).toBe(
    "The first answer failed contract validation: answer.initial.snapshot.visible is missing",
  );
});

// The check's words are copies, kept out of the first-screen chunk with zod: each is
// held to the contract's own declaration of it.
it("holds the contract's own words for each enumerated field", () => {
  expect([...NODE_STATUSES].sort()).toEqual(
    [...nodeStatusSchema.options].sort(),
  );
  expect([...SPAN_KINDS].sort()).toEqual(
    [...timelineSpanKindSchema.options].sort(),
  );
  expect([...REFERENCE_KINDS].sort()).toEqual(
    [...timelineReferenceKindSchema.options].sort(),
  );
  expect([...TRANSPORT_ROLES].sort()).toEqual(
    [...transportRoleSchema.options].sort(),
  );
});

/**
 * The check's copy of the contract, held to the contract: each field it reads is found
 * in `@onepipeline-ui/dag-model`'s own schema for it, of the type the check holds it to,
 * taking `null` and leaving it out exactly where that schema does — but where the screen
 * needs more than the schema promises, as named here.
 */
const STRICTER: Readonly<Record<string, string>> = {
  // The full parse defaults it to `{}`; the screen reads `node_details[id]` before
  // any parse, so an answer without it would throw rather than draw.
  "answer.initial.snapshot.visible.detail.node_details":
    "required where the schema defaults it",
};

/**
 * Where the check takes less than the schema it is held to, because one check reads
 * every view's answer: a detail view's carries no timeline, which the timeline view's
 * schema requires.
 */
const LOOSER: Readonly<Record<string, string>> = {
  "answer.initial.snapshot.visible.timeline":
    "optional where only the timeline view's schema requires it",
};

/** A zod schema's own definition, as zod 4 holds it. */
interface Definition {
  readonly type: string;
  readonly shape?: Record<string, z.ZodType>;
  readonly element?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly getter?: () => z.ZodType;
  readonly entries?: Record<string, string>;
  readonly values?: readonly unknown[];
  readonly options?: readonly z.ZodType[];
}

const definition = (schema: z.ZodType): Definition =>
  (schema as unknown as { _zod: { def: Definition } })._zod.def;

/** `schema` with its wrappers taken off, and what they said. */
function unwrapped(schema: z.ZodType): {
  schema: z.ZodType;
  optional: boolean;
  nullable: boolean;
} {
  let at = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    const def = definition(at);
    if (def.type === "optional" || def.type === "default") optional = true;
    else if (def.type === "nullable") nullable = true;
    else if (def.type === "pipe" && def.in !== undefined) {
      at = def.in;
      continue;
    } else if (def.type === "lazy" && def.getter !== undefined) {
      at = def.getter();
      continue;
    } else if (def.type !== "prefault" && def.type !== "readonly")
      return { schema: at, optional, nullable };
    at = def.innerType as z.ZodType;
  }
}

/** The schema at `pattern`, from the root its first steps name. */
function schemaAt(pattern: string): z.ZodType | undefined {
  const root = `${VISIBLE}.`;
  if (!pattern.startsWith(root)) return undefined;
  const [part, ...steps] = pattern
    .slice(root.length)
    .replace(/\[0\]/gu, ".[0]")
    .split(".");
  let at: z.ZodType | undefined =
    part === "detail"
      ? liveRunDetailSchema
      : part === "timeline"
        ? runTimelineSchema
        : undefined;
  for (const step of steps) {
    if (at === undefined) return undefined;
    const def = definition(unwrapped(at).schema);
    // Through a union, the alternative that holds the step.
    const shape =
      def.type === "union"
        ? (def.options ?? [])
            .map((option) => definition(unwrapped(option).schema).shape)
            .find((held) => held?.[step] !== undefined)
        : def.shape;
    at =
      step === "[0]"
        ? def.element
        : step === "*"
          ? def.valueType
          : shape?.[step];
  }
  return at;
}

/** The zod types each of the check's kinds is held to. */
const ZOD_TYPES: Readonly<Record<DeclaredField["kind"], readonly string[]>> = {
  string: ["string"],
  timestamp: ["string"],
  boolean: ["boolean"],
  number: ["number"],
  integer: ["number"],
  enum: ["enum"],
  true: ["literal"],
  union: ["union"],
  object: ["object"],
  array: ["array"],
  record: ["record"],
  anything: [],
};

it.each(
  DECLARED.filter((field) => field.field.startsWith(`${VISIBLE}.`)).map(
    (field) => [field.field, field] as const,
  ),
)("holds %s as the contract's schema declares it", (pattern, field) => {
  const declared = schemaAt(pattern);
  expect(declared, `the contract declares ${pattern}`).toBeDefined();
  const { schema, optional, nullable } = unwrapped(declared as z.ZodType);
  const def = definition(schema);
  if (field.kind !== "anything")
    expect(ZOD_TYPES[field.kind]).toContain(def.type);
  expect(field.nullable, `${pattern} takes null`).toBe(nullable);
  // A record holds any key or none, so no entry of one is ever required.
  if (pattern.endsWith(".*")) expect(field.required).toBe(false);
  else if (STRICTER[pattern] !== undefined)
    expect(field.required && optional).toBe(true);
  else if (LOOSER[pattern] !== undefined)
    expect(!field.required && !optional).toBe(true);
  else expect(field.required, `${pattern} may be left out`).toBe(!optional);
  if (field.kind === "enum")
    expect([...(field.words ?? [])].sort()).toEqual(
      Object.values(def.entries ?? {}).sort(),
    );
  if (field.kind === "true") expect(def.values).toEqual([true]);
  if (field.kind === "union")
    expect(
      (def.options ?? [])
        .map((option) => definition(unwrapped(option).schema).type)
        .sort(),
    ).toEqual(
      (field.alternatives ?? [])
        .map((kind) => ZOD_TYPES[kind][0] ?? kind)
        .sort(),
    );
});
