import {
  HUMAN_ITEM_PRIORITIES,
  HUMAN_ITEM_PRIORITY_LABELS,
  type HumanItem,
  type HumanItemDetail,
  type HumanItemFilter,
  type HumanItemNode,
  type HumanItemView,
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

export type TrackerProvider = "GitHub" | "Linear" | "tracker";

/** Which tracker an issue is on, by its address; any other host is a tracker. */
export function trackerProvider(url: string): TrackerProvider {
  const host = URL.canParse(url) ? new URL(url).hostname : "";
  if (host === "github.com") return "GitHub";
  if (host === "linear.app") return "Linear";
  return "tracker";
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
