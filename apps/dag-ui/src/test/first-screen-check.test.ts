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
  FirstAnswerContractError,
  type FirstScreenField,
  firstScreenFields,
  NODE_STATUSES,
  namedPath,
  REFERENCE_KINDS,
  SPAN_KINDS,
  TRANSPORT_ROLES,
} from "../first-screen/check";
import drawn from "../first-screen/fields.json" with { type: "json" };

/**
 * The first screen's own check of its answer, field by field, over the answers the
 * server is pinned to serve: `tests/fixtures/subscriptions.json`, the subscription the
 * contract's golden journey writes, and that detail beside the complete timeline
 * `tests/fixtures/run-timeline.json` pins, as an Overall or node answer carries one.
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
const timeline = golden("run-timeline.json");
const detailAnswer = subscribed;
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
        timeline,
      },
    },
  },
};
const ANSWERS = { detail: detailAnswer, timeline: timelineAnswer } as const;

/**
 * What `FirstScreen` reads of the timeline answer above, directly and through the view
 * models it draws with, stated apart from the check in `first-screen/fields.json`,
 * which the browser journey alters field by field: a field the check stops reading,
 * or one it reads that the list does not name, fails here.
 */
const DRAWN: readonly string[] = drawn.fields;
const VISIBLE = "answer.initial.snapshot.visible";

/** `answer` with the value at `path` replaced, or removed where `value` is `undefined`. */
function altered(
  answer: unknown,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  const copy = structuredClone(answer) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  for (const step of path.slice(0, -1))
    at = at[step] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

describe.each(Object.entries(ANSWERS))("a first %s answer", (_, answer) => {
  const fields = firstScreenFields(answer);

  it("is one the full contract reads, and the first screen's check passes", () => {
    expect(() => subscribedSchema.parse(answer)).not.toThrow();
    expect(checkFirstAnswer(answer)).toBe(answer);
  });

  it("names every field the first screen reads, each list's first standing for the rest", () => {
    const named = fields.map(
      (field) => `${field.pattern}${field.required ? "" : "?"}`,
    );
    expect(named).toEqual(
      answer === timelineAnswer
        ? DRAWN
        : DRAWN.filter((name) => !name.startsWith(`${VISIBLE}.timeline.`)),
    );
  });

  it.each(
    firstScreenFields(answer).map((field) => [namedPath(field.path), field]),
  )("is refused naming %s when it is of the wrong type", (name, field) => {
    const checked = checkFirstAnswer(altered(answer, field.path, field.wrong));
    expect(checked).toBeInstanceOf(FirstAnswerContractError);
    expect((checked as FirstAnswerContractError).reason).toMatch(
      new RegExp(`^${name.replace(/[.[\]]/gu, "\\$&")}(\\.|\\[| )`, "u"),
    );
  });

  it.each(
    firstScreenFields(answer)
      .filter((field) => field.required)
      .map((field) => [namedPath(field.path), field]),
  )("is refused naming %s when it is missing", (name, field) => {
    const checked = checkFirstAnswer(altered(answer, field.path, undefined));
    expect(checked).toBeInstanceOf(FirstAnswerContractError);
    expect((checked as FirstAnswerContractError).message).toBe(
      `The first answer failed contract validation: ${name} is missing`,
    );
  });
});

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
    at =
      step === "[0]"
        ? def.element
        : step === "*"
          ? def.valueType
          : def.shape?.[step];
  }
  return at;
}

/** The zod types each of the check's kinds is held to. */
const ZOD_TYPES: Readonly<Record<FirstScreenField["kind"], readonly string[]>> =
  {
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
  firstScreenFields(timelineAnswer)
    .filter((field) => field.pattern.startsWith(`${VISIBLE}.`))
    .map((field) => [field.pattern, field] as const),
)("holds %s as the contract's schema declares it", (pattern, field) => {
  const declared = schemaAt(pattern);
  expect(declared, `the contract declares ${pattern}`).toBeDefined();
  const { schema, optional, nullable } = unwrapped(declared as z.ZodType);
  const type = definition(schema).type;
  if (field.kind !== "anything") expect(ZOD_TYPES[field.kind]).toContain(type);
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
      Object.values(definition(schema).entries ?? {}).sort(),
    );
});
