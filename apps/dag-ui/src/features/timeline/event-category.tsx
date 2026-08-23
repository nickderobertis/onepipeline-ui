import {
  Circle,
  ClipboardList,
  GitBranch,
  GitPullRequest,
  Hourglass,
  type LucideIcon,
  MessagesSquare,
  Milestone,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  UserRoundCheck,
} from "lucide-react";

/**
 * What one journal record *is*, in few enough categories to be scanned rather than
 * read.
 *
 * A node's timeline draws one marker per journal record, and with a single glyph on
 * all of them the plot answers only "something happened here" — the reader has to
 * open each one to find the one that matters, which is the opposite of what a
 * timeline is for. A category is the coarse answer a glyph can carry.
 *
 * The vocabulary is derived from the kinds the run store actually holds — four
 * separately versioned producers, currently 70-odd kinds between them — and
 * deliberately smaller than they are: `pr-created`, `change-opened` and
 * `publication-finished` are three producers' spellings of one act, and a scheme
 * that drew them differently would be three glyphs the reader has to learn for one
 * thing. Several of these words are the ones the lane legend and the transcript's
 * eyebrow already use, so this is the same vocabulary applied to records rather
 * than a second one beside it.
 */
export type EventCategory =
  | "recovery"
  | "failure"
  | "human"
  | "planning"
  | "contention"
  | "verification"
  | "publication"
  | "repository"
  | "session"
  | "lifecycle"
  | "activity";

/**
 * The category a kind no rule and no exception names is read as.
 *
 * Every producer here is released on its own schedule, so an unrecognized kind is
 * the *expected* case rather than a defect: this is the honest answer to "a record
 * happened and this build does not know what it was", and it has a glyph of its own
 * so it never borrows a neighbour's meaning or draws as nothing at all.
 */
export const DEFAULT_EVENT_CATEGORY: EventCategory = "activity";

/**
 * The glyph each category is drawn as, keyed by the closed vocabulary above so a
 * category added there fails to compile until it has one of its own.
 */
const CATEGORY_ICONS: Readonly<Record<EventCategory, LucideIcon>> = {
  recovery: RotateCcw,
  failure: TriangleAlert,
  human: UserRoundCheck,
  planning: ClipboardList,
  contention: Hourglass,
  verification: ShieldCheck,
  publication: GitPullRequest,
  repository: GitBranch,
  session: MessagesSquare,
  lifecycle: Milestone,
  activity: Circle,
};

/**
 * Every category there is, as a value rather than as a type.
 *
 * Read off the glyph table rather than written out a second time beside the union:
 * that table is keyed by the union, so this *is* the vocabulary, and a category
 * added to one is added to both. It is what lets a count of the scheme be derived
 * — by the suite, and by the drift gate over the prose in `docs/dag-ui.md`, which
 * would otherwise be a number somebody has to remember to change.
 */
export const EVENT_CATEGORIES = Object.keys(
  CATEGORY_ICONS,
) as readonly EventCategory[];

/**
 * The category as a word, for the readings that have no room to draw its glyph.
 *
 * Capitalized off the vocabulary rather than tabled beside it: every category is one
 * lower-case word already chosen to be the word a reader would use, so a second table
 * would be the same eleven words with somewhere new to drift from.
 */
export function eventCategoryLabel(category: EventCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Which words of a wire kind decide its category, most specific reading first.
 *
 * Rules over the string rather than a lookup of every kind, because the four
 * producers are versioned separately from this app: a table of 70-odd entries would
 * need a new line the first time any of them shipped a kind, and would be stale
 * until someone noticed. The words are matched whole against the kind's own
 * hyphen-separated parts, so `merge` cannot be found inside some unrelated kind that
 * merely spells it.
 *
 * The order is the rule, not an accident of authorship: a record's **outcome** is
 * read before its **subject**, because the outcome is what a reader scans a timeline
 * for. That is what puts `publication-failed` with the failures rather than with the
 * publications, `conflict-resolution-started` with the recoveries rather than with
 * the failures its `conflict` names, and `merge-gate-coverage` with the verifications
 * rather than with the merges.
 */
const CATEGORY_RULES: readonly (readonly [EventCategory, readonly string[]])[] =
  [
    // Course corrections: the run noticing something and doing it differently. `cron`
    // is here because a scheduled fire is how a stalled member is nudged, which is the
    // same act as advancing a fallback rather than a lifecycle step of its own.
    [
      "recovery",
      ["retry", "retried", "fallback", "resolution", "interrupted", "cron"],
    ],
    ["failure", ["failed", "died", "rejected", "exceeded", "conflict"]],
    ["human", ["human"]],
    ["planning", ["planner", "decision"]],
    // `lock-wait` alone is most of the records this store holds, so what a reader sees
    // most is this category — kept apart from the sessions for exactly that reason.
    // `wait` is the word itself rather than any one producer's kind: a node held on
    // a lock and a node held on a dependency's release are the same thing to a
    // reader scanning for why nothing is moving. It sits before the publications so
    // `release-wait` reads as the wait it is rather than as the release it is for.
    ["contention", ["lock", "concurrent", "quiet", "wait"]],
    // `check` and `checks` are both here because the producers spell the same act
    // both ways — `onevcs` writes one `change-check` per check it observed, the
    // older unattributed records a single `pr-checks-observed` — and a word is
    // matched whole, so one spelling does not reach the other.
    ["verification", ["verification", "gate", "check", "checks", "coverage"]],
    // `release` joins this line rather than opening a twelfth category: publishing a
    // crate and merging the change that will be in it are one act to a reader
    // scanning a run, and a glyph they had to learn to tell apart would be the
    // legend this scheme exists not to be. The wait is the exception above, because
    // a wait is what a reader scans for.
    [
      "publication",
      [
        "pr",
        "publication",
        "published",
        "release",
        "merge",
        "merged",
        "change",
        "drafting",
      ],
    ],
    ["repository", ["edit", "fetch", "push", "branch", "commit"]],
    // Both an agent's conversation and a workspace session: each is a unit of work
    // that was opened, ran, and closed, and the reader meets them the same way.
    ["session", ["turn", "member", "session", "heartbeat", "conversation"]],
    // `cross` and `upstream` are the cross-DAG edges: a dependency on another run
    // resolving, or that run moving on afterwards. Both are facts about the shape
    // of the graph rather than about work, which is what the rest of this line is.
    [
      "lifecycle",
      [
        "run",
        "graph",
        "node",
        "round",
        "step",
        "edge",
        "setup",
        "cleanup",
        "driver",
        "cross",
        "upstream",
      ],
    ],
  ];

/**
 * The kinds the rules above would misfile, and nothing else.
 *
 * Both of these are pipeline records whose words no rule names — they would land in
 * the default category, which is the right answer for a kind this build has never
 * seen and the wrong one for a kind it has. Adding their words to a rule instead
 * would be a rule that generalises to nothing.
 */
const CATEGORY_EXCEPTIONS: Readonly<Record<string, EventCategory>> = {
  // Asking a run to complete is a boundary of the run, not a plan being edited.
  "completion-requested": "lifecycle",
  // The PR body could not be drafted, which is a fact about the publication.
  "body-not-drafted": "publication",
};

/** The hyphen-separated words of one wire kind, which the rules match against. */
function words(kind: string): readonly string[] {
  return kind
    .toLowerCase()
    .split("-")
    .filter((word) => word.length > 0);
}

/** The category one journal record's wire kind is read under. */
export function eventCategory(kind: string): EventCategory {
  const excepted = CATEGORY_EXCEPTIONS[kind];
  if (excepted !== undefined) return excepted;
  const parts = words(kind);
  const matched = CATEGORY_RULES.find(([, tokens]) =>
    tokens.some((token) => parts.includes(token)),
  );
  return matched?.[0] ?? DEFAULT_EVENT_CATEGORY;
}

/**
 * One category's glyph, wherever the reader meets a record of it.
 *
 * Presentational on purpose: the marker it sits in is a button that already carries
 * the record's own name, and the transcript row beside it is an article with the
 * same name, so an accessible name here would announce the same record twice and say
 * nothing the label does not.
 *
 * It carries no attribute naming its category either. There would be nothing for a
 * reader in one, and a journey that read it would be asserting the label rather than
 * the drawing — passing on a glyph swapped for the wrong one. So the journeys compare
 * the shapes drawn inside the `svg`, which is what the reader is actually looking at.
 */
export function EventCategoryIcon({
  category,
  className = "size-3",
}: {
  readonly category: EventCategory;
  readonly className?: string;
}) {
  const Icon = CATEGORY_ICONS[category];
  return <Icon aria-hidden="true" className={className} />;
}
