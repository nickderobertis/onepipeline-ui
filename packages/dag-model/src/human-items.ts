// llmlint: ignore-file[code_lands_in_the_domain_that_owns_it] this repository keeps every read-API record's parser in `@onepipeline-ui/dag-model` and every route call in `@onepipeline-ui/telemetry-client` — the runs, channel, host, agents and subscription records live here the same way, and `docs/dag-ui.md` holds the app to declaring no schema or API path of its own — and the plan names these two packages as the ones this change touches. A human-item package of its own would be the only API domain split out of that layout.
import { z } from "zod";
import {
  HUMAN_ITEM_PRIORITIES,
  type HumanItem,
  type HumanItemDetail,
  type HumanItemReceipt,
  type HumanItemView,
} from "./human-items.generated.js";

/**
 * The human-item routes (`docs/contract.md`, "Human items"): the engine's own
 * records, unenveloped. Their types are generated from the engine's exported
 * schemas; the parsers below are annotated with those generated types, so a
 * parser that drifted from the engine's shape is a type error here rather than a
 * second reading of the wire.
 */
export * from "./human-items.generated.js";

export const HUMAN_ITEM_PATHS = {
  list: "/api/human-items",
  item: (id: string) => `/api/human-items/${encodeURIComponent(id)}`,
  answer: (id: string) => `/api/human-items/${encodeURIComponent(id)}/answer`,
  complete: (id: string) =>
    `/api/human-items/${encodeURIComponent(id)}/complete`,
  dismiss: (id: string) => `/api/human-items/${encodeURIComponent(id)}/dismiss`,
} as const;

const nullableString = z.string().nullable();
// Every record is closed, as the engine's `deny_unknown_fields` closes it: a
// field this release does not declare is a refusal, never silently dropped.
/** Prose the engine refuses blank: at least one character that is not space. */
const prose = z.string().regex(/\S/u);

const owner = z.strictObject({
  session: z.string(),
  run: nullableString,
  plan: nullableString,
});

const block = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("nothing") }),
  z.strictObject({
    scope: z.literal("work"),
    run: z.string(),
    node: z.string(),
  }),
  z.strictObject({ scope: z.literal("plan"), plan: z.string() }),
  z.strictObject({ scope: z.literal("host") }),
]);

const resolution = z.strictObject({
  actor: z.string(),
  on_behalf_of: nullableString,
  text: nullableString,
  reason: nullableString,
});

/**
 * Whether `item`'s kind, state, resolution and approval agree, as the engine's
 * own decoder rules: an open item has no resolution and a resolved one has one;
 * a task is completed and a question answered, never the reverse; an answer
 * carries text and no reason, a completion neither, a dismissal no text; and
 * only a task carries an approval reference.
 */
function lifecycleProblem(item: {
  kind: string;
  state: string;
  approval: unknown;
  resolution: z.infer<typeof resolution> | null;
}): string | undefined {
  const { kind, state, resolution: settled } = item;
  if (kind === "question" && item.approval !== null)
    return "approval is only valid on tasks";
  if (state === "open")
    return settled === null ? undefined : "an open item has no resolution";
  if (settled === null) return "a resolved item carries its resolution";
  if (state === "answered")
    return kind === "question" &&
      settled.text !== null &&
      /\S/u.test(settled.text) &&
      settled.reason === null
      ? undefined
      : "an answer is a question's, with text and no reason";
  if (state === "completed")
    return kind === "task" && settled.text === null && settled.reason === null
      ? undefined
      : "a completion is a task's, with no text or reason";
  return settled.text === null ? undefined : "a dismissal carries no text";
}

export const humanItemSchema: z.ZodType<HumanItem> = z
  .strictObject({
    schema_version: z.literal(1),
    id: z.string().min(1),
    dedup_key: z.string(),
    kind: z.enum(["task", "question"]),
    title: prose,
    body: prose,
    priority: z.enum(HUMAN_ITEM_PRIORITIES),
    owner,
    block,
    approval: z
      .strictObject({ board_copy: z.string(), key: z.string() })
      .nullable(),
    state: z.enum(["open", "answered", "completed", "dismissed"]),
    resolution: resolution.nullable(),
    tracker: z.strictObject({ task: z.string(), url: z.url() }).nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .superRefine((item, context) => {
    const problem = lifecycleProblem(item);
    if (problem !== undefined)
      context.addIssue({ code: "custom", message: problem });
  });

const node = z.strictObject({
  run: z.string(),
  node: z.string(),
  title: z.string(),
});

const blockedPlan = z.strictObject({
  plan: z.string(),
  count: z.number().int().nonnegative(),
  preview: z.array(node).max(3),
});

const blocked = z.strictObject({
  total: z.number().int().nonnegative(),
  plans: z.array(blockedPlan),
});

/**
 * Whether an impact agrees with its item, as the engine's decoder rules: a
 * non-blocking item reports nothing blocked, each plan appears once with a
 * preview of its first three steps, and the plans' counts sum to the total.
 */
function impactProblem(
  item: HumanItem,
  impact: z.infer<typeof blocked>,
): string | undefined {
  const blocking = item.state === "open" && item.block.scope !== "nothing";
  if (!blocking && (impact.total !== 0 || impact.plans.length > 0))
    return "a non-blocking item reports nothing blocked";
  const plans = new Set(impact.plans.map(({ plan }) => plan));
  if (plans.size !== impact.plans.length) return "a blocked plan appears twice";
  if (
    impact.plans.some(
      ({ count, preview }) => preview.length !== Math.min(count, 3),
    )
  )
    return "a preview is the first three affected steps of its plan";
  const sum = impact.plans.reduce((total, { count }) => total + count, 0);
  return sum === impact.total
    ? undefined
    : "the blocked total is the plans' counts";
}

export const humanItemViewSchema: z.ZodType<HumanItemView> = z
  .strictObject({ item: humanItemSchema, blocked })
  .superRefine(({ item, blocked: impact }, context) => {
    const problem = impactProblem(item, impact);
    if (problem !== undefined)
      context.addIssue({ code: "custom", message: problem });
  });

/**
 * A detail's steps, grouped by the impact's plans in order: as many steps as
 * the total, none twice, and each plan's preview the first steps of its group —
 * which is what lets a reader slice the steps by the counts.
 */
function nodesProblem(detail: {
  blocked: z.infer<typeof blocked>;
  nodes: z.infer<typeof node>[];
}): string | undefined {
  const { blocked: impact, nodes } = detail;
  if (nodes.length !== impact.total) return "the steps are the blocked total";
  const keys = new Set(nodes.map(({ run, node: id }) => `${run}\u0000${id}`));
  if (keys.size !== nodes.length) return "a blocked step appears twice";
  let offset = 0;
  for (const { count, preview } of impact.plans) {
    const group = nodes.slice(offset, offset + count);
    if (
      preview.some(
        (step, index) =>
          group[index]?.run !== step.run || group[index]?.node !== step.node,
      )
    )
      return "a preview is the first steps of its plan's group";
    offset += count;
  }
  return undefined;
}

export const humanItemDetailSchema: z.ZodType<HumanItemDetail> = z
  .strictObject({ item: humanItemSchema, blocked, nodes: z.array(node) })
  .superRefine((detail, context) => {
    const problem =
      impactProblem(detail.item, detail.blocked) ?? nodesProblem(detail);
    if (problem !== undefined)
      context.addIssue({ code: "custom", message: problem });
  });

export const humanItemReceiptSchema: z.ZodType<HumanItemReceipt> =
  z.strictObject({
    item: humanItemViewSchema,
    event_id: z.string(),
  });

export const humanItemListSchema = z.strictObject({
  items: z.array(humanItemViewSchema),
});

export type HumanItemList = z.infer<typeof humanItemListSchema>;
