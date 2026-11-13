import {
  HUMAN_ITEM_PRIORITIES,
  HUMAN_ITEM_PRIORITY_LABELS,
  type HumanItem,
  type HumanItemDetail,
  type HumanItemFilter,
  type HumanItemHistoryEntry,
  type HumanItemNode,
  type HumanItemView,
  type Provenance,
} from "@onepipeline-ui/dag-model";

/**
 * What a reader sees of an action item, derived from the engine's record and
 * nothing else: blocking from open state and the declared scope, the words the
 * CLI prints for what an item blocks and where it came from, and the priority
 * label the engine's schema maps each wire priority to.
 */

export const PRIORITY_OPTIONS = HUMAN_ITEM_PRIORITIES.map((wire) => ({
  wire,
  label: HUMAN_ITEM_PRIORITY_LABELS[wire],
}));

export function priorityLabel(item: HumanItem): string {
  return HUMAN_ITEM_PRIORITY_LABELS[item.priority];
}

export function kindLabel(item: HumanItem): string {
  return item.kind === "task" ? "Task" : "Question";
}

const STATE_LABELS: { readonly [S in HumanItem["state"]]: string } = {
  open: "Open",
  answered: "Answered",
  completed: "Completed",
  dismissed: "Dismissed",
};

const STATES = ["open", "answered", "completed", "dismissed"] as const;

export const STATE_OPTIONS = STATES.map((state) => ({
  state,
  label: STATE_LABELS[state],
}));

export function stateLabel(item: HumanItem): string {
  return STATE_LABELS[item.state];
}

/** The engine's one predicate: open, and holding something. */
export function isBlocking(item: HumanItem): boolean {
  return item.state === "open" && item.block.scope !== "nothing";
}

function steps(count: number): string {
  return count === 1 ? "1 step" : `${count} steps`;
}

/**
 * What an item blocks, one phrase per held thing: all work on this host, all of
 * a plan, or so many steps in each plan a work hold reaches. Nothing for an item
 * that blocks nothing.
 */
export function blockedPhrases(view: HumanItemView): string[] {
  const { item, blocked } = view;
  if (!isBlocking(item)) return [];
  switch (item.block.scope) {
    case "host":
      return ["blocks all work on this host"];
    case "plan":
      return [`blocks all of ${item.block.plan}`];
    case "work":
      return blocked.plans.map(
        ({ plan, count }) => `blocks ${steps(count)} in ${plan}`,
      );
    default:
      return [];
  }
}

/**
 * The card's line for what an item blocks: each phrase, a work hold's with the
 * first steps of each plan beside it — the engine's preview — and how many more
 * the detail lists.
 */
export function blockedSummary(view: HumanItemView): string {
  const phrases = blockedPhrases(view);
  if (view.item.block.scope !== "work") return phrases.join("; ");
  return view.blocked.plans
    .map(({ count, preview }, index) => {
      const more = count - preview.length;
      const names = preview.map(({ node }) => node).join(", ");
      return `${phrases[index]}: ${names}${more > 0 ? ` +${more} more` : ""}`;
    })
    .join("; ");
}

/**
 * Where an item came from: the plan and run it was raised in, the manager
 * session for a question raised outside a run, or the host for a host item —
 * in the words the CLI's list prints.
 */
export function sourceWords(item: HumanItem): string {
  if (item.block.scope === "host") return "host";
  const { plan, run, session } = item.owner;
  if (plan !== null && run !== null) return `plan ${plan} / run ${run}`;
  if (plan !== null) return `plan ${plan}`;
  if (run !== null) return `run ${run}`;
  return `session ${session}`;
}

/** Every blocked step of a detail, grouped under the plan phrase it counts toward. */
export function blockedGroups(detail: HumanItemDetail): {
  readonly phrase: string;
  readonly nodes: readonly HumanItemNode[];
}[] {
  const phrases = blockedPhrases(detail);
  if (detail.item.block.scope !== "work")
    return phrases.map((phrase) => ({ phrase, nodes: detail.nodes }));
  let offset = 0;
  return detail.blocked.plans.map(({ count }, index) => {
    const nodes = detail.nodes.slice(offset, offset + count);
    offset += count;
    return { phrase: phrases[index] ?? "", nodes };
  });
}

/**
 * One labelled field of an item's metadata block: words, or a recorded moment
 * the pane shows as an age, with the party whose words it was where the field
 * is a resolution.
 */
export type MetadataField =
  | { readonly label: string; readonly value: string }
  | {
      readonly label: string;
      readonly at: string;
      readonly party?: string;
    };

/**
 * A party in the page's own words: a person reading this page is the user, so
 * the user's words are "you"; the manager's are "the manager".
 */
export function partyWords(provenance: Provenance): string {
  return provenance === "user" ? "you" : "the manager";
}

/** Whose words a resolution was: absent, the manager's, as the engine reads it. */
export function resolutionParty(item: HumanItem): Provenance {
  return item.resolution?.provenance ?? "manager";
}

const HISTORY_ACTIONS: Record<HumanItemHistoryEntry["action"], string> = {
  "human-item-raised": "Raised",
  "human-item-answered": "Answered",
  "human-item-completed": "Completed",
  "human-item-dismissed": "Dismissed",
  "human-item-auto-resolved": "Resolved",
  "human-item-reopened": "Reopened",
  "human-item-noted": "Note",
};

/**
 * What one entry of the engine's history says, in words: its action and whose
 * words it was — "Raised by the manager", "Answered by you", "Note by you".
 */
export function historyWords(entry: HumanItemHistoryEntry): string {
  return `${HISTORY_ACTIONS[entry.action]} by ${partyWords(entry.provenance)}`;
}

/**
 * Everything about an item rather than in it, as the detail's metadata block
 * labels it. The tracker and the blocked steps are the block's own, since
 * those are a link and a list.
 */
export function metadataFields(view: HumanItemView): MetadataField[] {
  const { item } = view;
  const { plan, run } = item.owner;
  const blocks = blockedPhrases(view).join("; ");
  const resolvedLabel: Partial<Record<HumanItem["state"], string>> = {
    answered: "Answered",
    completed: "Completed",
    dismissed: "Dismissed",
  };
  const resolved = resolvedLabel[item.state];
  return [
    { label: "Priority", value: priorityLabel(item) },
    { label: "Kind", value: kindLabel(item) },
    { label: "State", value: stateLabel(item) },
    { label: "Source", value: sourceWords(item) },
    ...(plan === null ? [] : [{ label: "Plan", value: plan }]),
    ...(run === null ? [] : [{ label: "Run", value: run }]),
    { label: "Blocks", value: blocks === "" ? "Nothing" : blocks },
    { label: "Raised", at: item.created_at },
    ...(resolved === undefined
      ? []
      : [
          {
            label: resolved,
            at: item.updated_at,
            party: partyWords(resolutionParty(item)),
          },
        ]),
  ];
}

/**
 * `value` if it is one of `allowed`, else `undefined`: how a `<select>`'s string
 * becomes one of the choices it was rendered from without asserting its type.
 */
export function oneOf<T extends string>(
  allowed: readonly T[],
  value: string,
): T | undefined {
  return allowed.find((choice) => choice === value);
}

export const KIND_CHOICES = ["", "task", "question"] as const;
export const BLOCKING_CHOICES = ["", "yes", "no"] as const;
export const PRIORITY_CHOICES = ["", ...HUMAN_ITEM_PRIORITIES] as const;
export const STATE_CHOICES = STATES;
export const SOURCE_CHOICES = ["", "session", "run", "plan", "host"] as const;

/** The page's selectors, as a reader sets them. Scope is deliberately absent. */
export interface FilterChoice {
  readonly kind: (typeof KIND_CHOICES)[number];
  readonly blocking: (typeof BLOCKING_CHOICES)[number];
  readonly priority: (typeof PRIORITY_CHOICES)[number];
  readonly state: (typeof STATE_CHOICES)[number];
  readonly source: (typeof SOURCE_CHOICES)[number];
  readonly sourceId: string;
}

export const NO_FILTER: FilterChoice = {
  kind: "",
  blocking: "",
  priority: "",
  state: "open",
  source: "",
  sourceId: "",
};

/** The engine's `HumanItemFilter` for a choice: only what was chosen is sent. */
export function toFilter(choice: FilterChoice): HumanItemFilter {
  const id = choice.sourceId.trim();
  return {
    ...(choice.kind === "" ? {} : { kind: choice.kind }),
    ...(choice.blocking === "" ? {} : { blocking: choice.blocking === "yes" }),
    ...(choice.priority === "" ? {} : { priority: choice.priority }),
    ...(choice.state === "open" ? {} : { state: choice.state }),
    ...(choice.source === "host" ? { host: true } : {}),
    ...(choice.source !== "" && choice.source !== "host" && id !== ""
      ? { [choice.source]: id }
      : {}),
  };
}

/** Whether `choice` names any selector beyond the page's defaults, one per field. */
export function changedFilters(choice: FilterChoice): number {
  return (
    Number(choice.kind !== NO_FILTER.kind) +
    Number(choice.blocking !== NO_FILTER.blocking) +
    Number(choice.priority !== NO_FILTER.priority) +
    Number(choice.state !== NO_FILTER.state) +
    Number(choice.source !== NO_FILTER.source)
  );
}

/** The fields the list can be grouped by; `none` is one flat list. */
export const GROUP_CHOICES = [
  "priority",
  "kind",
  "source",
  "blocking",
  "none",
] as const;
export type GroupBy = (typeof GROUP_CHOICES)[number];
/** What the list is grouped by until a reader chooses otherwise. */
export const DEFAULT_GROUP_BY: GroupBy = "priority";

export const GROUP_OPTIONS: readonly {
  readonly value: GroupBy;
  readonly label: string;
}[] = [
  { value: "priority", label: "Priority" },
  { value: "kind", label: "Kind" },
  { value: "source", label: "Source" },
  { value: "blocking", label: "Blocking" },
  { value: "none", label: "None" },
];

/** One heading's items, in the engine's order. */
export interface ItemGroup {
  readonly key: string;
  /** The heading, or `undefined` for the one flat list of `none`. */
  readonly label?: string;
  readonly items: readonly HumanItemView[];
}

/** Where a group sorts among the others: a fixed rank, or first appearance. */
function groupOf(
  view: HumanItemView,
  by: Exclude<GroupBy, "none">,
): { readonly key: string; readonly label: string; readonly rank: number } {
  const { item } = view;
  switch (by) {
    case "priority":
      return {
        key: item.priority,
        label: priorityLabel(item),
        rank: HUMAN_ITEM_PRIORITIES.indexOf(item.priority),
      };
    case "kind":
      return {
        key: item.kind,
        label: kindLabel(item),
        rank: item.kind === "task" ? 0 : 1,
      };
    case "blocking":
      return isBlocking(item)
        ? { key: "blocking", label: "Blocking", rank: 0 }
        : { key: "not-blocking", label: "Not blocking", rank: 1 };
    case "source": {
      const words = sourceWords(item);
      return { key: words, label: `Source: ${words}`, rank: 0 };
    }
  }
}

/**
 * `items` under one heading per value of `by`: priority Critical to Low, tasks
 * before questions, blocking before not, and sources in the order the engine
 * first lists them. Within a heading the engine's own order stands.
 */
export function groupItems(
  items: readonly HumanItemView[],
  by: GroupBy,
): ItemGroup[] {
  if (by === "none") return [{ key: "all", items }];
  const groups = new Map<
    string,
    { label: string; rank: number; first: number; items: HumanItemView[] }
  >();
  items.forEach((view, index) => {
    const { key, label, rank } = groupOf(view, by);
    const held = groups.get(key);
    if (held) held.items.push(view);
    else groups.set(key, { label, rank, first: index, items: [view] });
  });
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.rank - b.rank || a.first - b.first)
    .map(([key, { label, items: grouped }]) => ({
      key,
      label,
      items: grouped,
    }));
}
