// llmlint: ignore-file[code_lands_in_the_domain_that_owns_it] generated beside human-items.ts, whose directive gives the reason: every read-API record of this repository is declared in this package.
// Generated from human-items.schema.json by human-items-codegen.ts — do not edit.
// Regenerate: UPDATE_HUMAN_ITEM_TYPES=1 npx vitest run --root packages/dag-model human-items

export type HumanItemSample = {
  readonly schema_version: number;
  readonly items: readonly HumanItemDetail[];
  readonly approval_keys: { readonly [key: string]: string };
  readonly approvals?: readonly HumanItemSampleApproval[];
};
export type HumanItemRefusal =
  | { readonly kind: "unavailable" }
  | { readonly reason: string; readonly kind: "conflict" };
export type HumanItem = {
  readonly schema_version: number;
  readonly id: string;
  readonly dedup_key: string;
  readonly kind: HumanItemKind;
  readonly title: string;
  readonly body: string;
  readonly priority: "urgent" | "high" | "medium" | "low";
  readonly owner: HumanItemOwner;
  readonly block: HumanItemBlock;
  readonly approval: HumanItemApproval | null;
  readonly state: HumanItemState;
  readonly resolution: HumanItemResolution | null;
  readonly tracker: HumanItemTracker | null;
  readonly created_at: string;
  readonly updated_at: string;
};
export type HumanItemInput = {
  readonly schema_version: number;
  readonly dedup_key: string;
  readonly kind: HumanItemKind;
  readonly title: string;
  readonly body: string;
  readonly priority: "urgent" | "high" | "medium" | "low";
  readonly owner: HumanItemOwner;
  readonly block: HumanItemBlock;
  readonly approval: HumanItemApproval | null;
};
export type HumanItemAction =
  | {
      readonly schema_version: number;
      readonly dedup_key: string;
      readonly kind: HumanItemKind;
      readonly title: string;
      readonly body: string;
      readonly priority: "urgent" | "high" | "medium" | "low";
      readonly owner: HumanItemOwner;
      readonly block: HumanItemBlock;
      readonly approval: HumanItemApproval | null;
      readonly action: "raise";
    }
  | {
      readonly id: string;
      readonly text: string;
      readonly actor: string;
      readonly on_behalf_of: string | null;
      readonly action: "answer";
    }
  | {
      readonly id: string;
      readonly actor: string;
      readonly on_behalf_of: string | null;
      readonly action: "complete";
    }
  | {
      readonly id: string;
      readonly reason?: string | null;
      readonly actor: string;
      readonly on_behalf_of: string | null;
      readonly action: "dismiss";
    };
export type HumanItemFilter = {
  readonly kind?: HumanItemKind | null;
  readonly blocking?: boolean | null;
  readonly priority?: null | "urgent" | "high" | "medium" | "low";
  readonly state?: HumanItemState | null;
  readonly session?: string | null;
  readonly run?: string | null;
  readonly plan?: string | null;
  readonly host?: boolean | null;
};
export type HumanItemView = {
  readonly item: HumanItem;
  readonly blocked: HumanItemBlocked;
};
export type HumanItemDetail = {
  readonly item: HumanItem;
  readonly blocked: HumanItemBlocked;
  readonly nodes: readonly HumanItemNode[];
};
export type HumanItemReceipt = {
  readonly item: HumanItemView;
  readonly event_id: string;
};
export type HumanItemMetadata = {
  readonly kind: HumanItemKind;
  readonly priority: "urgent" | "high" | "medium" | "low";
  readonly title: string;
  readonly body: string;
};
export type HumanItemEventPayload = {
  readonly schema_version: number;
  readonly item_id: string;
  readonly owner: HumanItemOwner;
  readonly action: HumanItemEventAction;
  readonly item: HumanItem;
  readonly resolution: HumanItemResolution | null;
};
export type HumanItemApproval = {
  readonly board_copy: string;
  readonly key: string;
};
export type HumanItemBlock =
  | { readonly scope: "nothing" }
  | { readonly run: string; readonly node: string; readonly scope: "work" }
  | { readonly plan: string; readonly scope: "plan" }
  | { readonly scope: "host" };
export type HumanItemBlocked = {
  readonly total: number;
  readonly plans: readonly HumanItemBlockedPlan[];
};
export type HumanItemBlockedPlan = {
  readonly plan: string;
  readonly count: number;
  readonly preview: readonly HumanItemNode[];
};
export type HumanItemEventAction =
  | "human-item-raised"
  | "human-item-answered"
  | "human-item-completed"
  | "human-item-dismissed"
  | "human-item-auto-resolved";
export type HumanItemKind = "task" | "question";
export type HumanItemNode = {
  readonly run: string;
  readonly node: string;
  readonly title: string;
};
export type HumanItemOwner = {
  readonly session: string;
  readonly run: string | null;
  readonly plan: string | null;
};
export type HumanItemResolution = {
  readonly actor: string;
  readonly on_behalf_of: string | null;
  readonly text: string | null;
  readonly reason: string | null;
};
export type HumanItemSampleApproval = {
  readonly approval: HumanItemApproval;
  readonly actor: string;
  readonly on_behalf_of: string | null;
};
export type HumanItemState = "open" | "answered" | "completed" | "dismissed";
export type HumanItemTracker = { readonly task: string; readonly url: string };
/** The wire priorities, most urgent first: the engine's declared order. */
export const HUMAN_ITEM_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
] as const;
/** The display label of each wire priority, as the CLI prints it. */
export const HUMAN_ITEM_PRIORITY_LABELS: {
  readonly [P in HumanItem["priority"]]: string;
} = { urgent: "Critical", high: "High", medium: "Medium", low: "Low" };
