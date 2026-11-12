import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nodeStatusSchema,
  subscribedSchema,
  timelineReferenceKindSchema,
  timelineSpanKindSchema,
  transportRoleSchema,
} from "@onepipeline-ui/dag-model";
import { describe, expect, it } from "vitest";
import {
  checkFirstAnswer,
  FirstAnswerContractError,
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
