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

const owner = z.object({
  session: z.string(),
  run: nullableString,
  plan: nullableString,
});

const block = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("nothing") }),
  z.object({ scope: z.literal("work"), run: z.string(), node: z.string() }),
  z.object({ scope: z.literal("plan"), plan: z.string() }),
  z.object({ scope: z.literal("host") }),
]);

export const humanItemSchema: z.ZodType<HumanItem> = z.object({
  schema_version: z.number().int(),
  id: z.string().min(1),
  dedup_key: z.string(),
  kind: z.enum(["task", "question"]),
  title: z.string().min(1),
  body: z.string().min(1),
  priority: z.enum(HUMAN_ITEM_PRIORITIES),
  owner,
  block,
  approval: z.object({ board_copy: z.string(), key: z.string() }).nullable(),
  state: z.enum(["open", "answered", "completed", "dismissed"]),
  resolution: z
    .object({
      actor: z.string(),
      on_behalf_of: nullableString,
      text: nullableString,
      reason: nullableString,
    })
    .nullable(),
  tracker: z.object({ task: z.string(), url: z.url() }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const node = z.object({ run: z.string(), node: z.string(), title: z.string() });

const blocked = z.object({
  total: z.number().int().nonnegative(),
  plans: z.array(
    z.object({
      plan: z.string(),
      count: z.number().int().nonnegative(),
      preview: z.array(node).max(3),
    }),
  ),
});

export const humanItemViewSchema: z.ZodType<HumanItemView> = z.object({
  item: humanItemSchema,
  blocked,
});

export const humanItemDetailSchema: z.ZodType<HumanItemDetail> = z.object({
  item: humanItemSchema,
  blocked,
  nodes: z.array(node),
});

export const humanItemReceiptSchema: z.ZodType<HumanItemReceipt> = z.object({
  item: humanItemViewSchema,
  event_id: z.string(),
});

export const humanItemListSchema = z.object({
  items: z.array(humanItemViewSchema),
});

export type HumanItemList = z.infer<typeof humanItemListSchema>;
