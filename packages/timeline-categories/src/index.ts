/**
 * The category vocabulary a journal record is read under, and the rules that file
 * one.
 *
 * A package rather than a module of the app because two projects hold it: the app
 * draws a glyph per category, and `dag-ui-e2e`'s journeys count the scheme — "one
 * record of every category is drawn" is counted against `EVENT_CATEGORIES`, and a
 * journey carrying its own copy of that list passes while the app grows a category
 * nobody draws. The drawing stays in the app: there is no React, no icon set and
 * no DOM here.
 */

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
export const EVENT_CATEGORIES = [
  "recovery",
  "failure",
  "human",
  "planning",
  "contention",
  "verification",
  "publication",
  "repository",
  "session",
  "lifecycle",
  "activity",
] as const;

/**
 * One category, as a type.
 *
 * Derived from the list rather than declared beside it: the list is what a
 * consumer counts and what the app's glyph table is keyed by, so a category added
 * to it is one the app fails to compile until it has a glyph of its own, and there
 * is one place to add it.
 */
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

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
    // `requeued` is a dispatch handed back to the queue before any work began:
    // the run doing it again, which is the same act as a retry.
    [
      "recovery",
      [
        "retry",
        "retried",
        // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the producer declares this kind and a drift gate reconciles this table to that declaration: `tests/contract.rs::the_browser_files_every_kind_those_libraries_declare` reads `onepipeline::event::PIPELINE_KINDS` and matches `oneagentgraph::event::EventKind` with no wildcard, and fails naming every kind those libraries declare that this package files no category for. Removing this word's entry from the corpus makes that test fail naming `node-requeued` exactly; the entry exists because the gate demanded it, so this is the reconciled copy rather than a second source.
        // llmlint: ignore[code_lands_in_the_domain_that_owns_it] the producer owns the kind and this package owns the category, which are different facts. `src/index.test.ts` says so where it declares the gate: the category "is not gated and cannot be — which of the eleven a kind reads under is a decision rather than a fact about the producer". Keeping that decision with the producer would put it where nothing draws it, and this shared table is the domain that owns it — the app draws a glyph per category and `dag-ui-e2e` counts the scheme against the same list.
        // llmlint: ignore[changed_behavior_has_e2e] the category decision is pinned by the corpus rather than a journey, uniformly for every kind this table files. `apps/dag-ui-e2e/AGENTS.md` records that split: a journey counts the scheme against `EVENT_CATEGORIES` and must not restate the vocabulary, because "a journey holding its own copy of `EVENT_CATEGORIES` passes while the app grows a category nobody draws". A per-kind journey would be exactly that copy. What the browser tier proves is the drawing, which adding this word does not change.
        "requeued",
        "fallback",
        "resolution",
        "interrupted",
        "cron",
      ],
    ],
    ["failure", ["failed", "died", "rejected", "exceeded", "conflict"]],
    ["human", ["human"]],
    // `note` is a manager's note reaching a running conversation — the planner and
    // the run talking, whichever party of the conversation it reached.
    ["planning", ["planner", "decision", "note"]],
    // `lock-wait` alone is most of the records this store holds, so what a reader sees
    // most is this category — kept apart from the sessions for exactly that reason.
    // `wait` is the word itself rather than any one producer's kind: a node held on
    // a lock and a node held on a dependency's release are the same thing to a
    // reader scanning for why nothing is moving. It sits before the publications so
    // `release-wait` reads as the wait it is rather than as the release it is for.
    // `held` and `unheld` are the engine's own account of why a node it has not
    // settled is not running — one reason per entry — which is the same question a
    // reader scanning for contention came with, so they read here rather than as a
    // lifecycle step of the node they are about.
    ["contention", ["lock", "concurrent", "quiet", "wait", "held", "unheld"]],
    // `check` and `checks` are both here because the producers spell the same act
    // both ways — `onevcs` writes one `change-check` per check it observed, the
    // older unattributed records a single `pr-checks-observed` — and a word is
    // matched whole, so one spelling does not reach the other.
    // `judge` is a judge ruling on the work — one judge of a stacked panel deciding on
    // one turn is a verification of that turn, the same act as a gate's verdict.
    [
      "verification",
      ["verification", "gate", "check", "checks", "coverage", "judge"],
    ],
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
 * Each of these is a pipeline record whose words no rule names — they would land in
 * the default category, which is the right answer for a kind this build has never
 * seen and the wrong one for a kind it has. Adding their words to a rule instead
 * would be a rule that generalises to nothing.
 */
const CATEGORY_EXCEPTIONS: Readonly<Record<string, EventCategory>> = {
  // Asking a run to complete is a boundary of the run, not a plan being edited.
  "completion-requested": "lifecycle",
  // A command the run accepted that committed nothing a reader folds — a finding
  // raised to the planner's surface, or a completion requested — is the planner
  // and the run talking, which is what the rest of that line is. Neither of its
  // words names a rule, and `edit-committed`, the other half of the same split,
  // is filed under the edit it made rather than under the exchange.
  "command-accepted": "planning",
  // The PR body could not be drafted, which is a fact about the publication.
  "body-not-drafted": "publication",
  // One acceptance criterion ruled on. `checked` is not `check`, and a word is
  // matched whole — and adding it to the verification rule would be adding a
  // word that names this kind and no other, which is what this table is for.
  "criterion-checked": "verification",
  // The driver's sweep over the harness identity pool: housekeeping of the run's
  // driving, like an adoption, and no node's work. Neither of its words names a
  // rule, and neither generalises to one.
  // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the producer declares this kind and a drift gate reconciles this table to that declaration: `tests/contract.rs::the_browser_files_every_kind_those_libraries_declare` reads `onepipeline::event::PIPELINE_KINDS` and matches `oneagentgraph::event::EventKind` with no wildcard, and fails naming every kind those libraries declare that this package files no category for. Removing this entry from the corpus makes that test fail naming `pool-maintenance` exactly; the entry exists because the gate demanded it, so this is the reconciled copy rather than a second source.
  // llmlint: ignore[code_lands_in_the_domain_that_owns_it] the producer owns the kind and this package owns the category, which are different facts. `src/index.test.ts` says so where it declares the gate: the category "is not gated and cannot be — which of the eleven a kind reads under is a decision rather than a fact about the producer". This table is the one place that decision is made, and an exception is where a kind goes whose words name no rule — which is a statement about this build's rules, not about the producer.
  // llmlint: ignore[changed_behavior_has_e2e] the category decision is pinned by the corpus rather than a journey, uniformly for every kind this table files. `apps/dag-ui-e2e/AGENTS.md` records that split: a journey counts the scheme against `EVENT_CATEGORIES` and must not restate the vocabulary, because "a journey holding its own copy of `EVENT_CATEGORIES` passes while the app grows a category nobody draws". A per-kind journey would be exactly that copy. What the browser tier proves is the drawing, which adding this exception does not change.
  "pool-maintenance": "lifecycle",
  // A host shutdown's two records: one per live dispatch it acted on, saying how
  // that dispatch was asked and how it ended, and one per run it put down, after
  // its teardown and its pushes. Both are the run being put down mid-flight to be
  // picked up again — the same boundary of the run's driving `run-stopped` and
  // `driver-adopted` are — and no node's work. `stopped`, `dispatch`, `host` and
  // `shutdown` name no rule, and none of them generalises to one: `stopped` alone
  // says nothing of whose stop it was.
  // llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] the producer declares these kinds and a drift gate reconciles this table to that declaration: `tests/contract.rs::the_browser_files_every_kind_those_libraries_declare` reads `onepipeline::event::PIPELINE_KINDS` and fails naming every kind it declares that this package files no category for — it named exactly these two when the engine pin moved to the release that declares them, so these entries are the reconciled copy rather than a second source.
  // llmlint: ignore-block[code_lands_in_the_domain_that_owns_it] the producer owns the kind and this package owns the category, which are different facts. `src/index.test.ts` says so where it declares the gate: the category "is not gated and cannot be — which of the eleven a kind reads under is a decision rather than a fact about the producer". This table is the one place that decision is made.
  // llmlint: ignore-block[changed_behavior_has_e2e] the category decision is pinned by the corpus rather than a journey, uniformly for every kind this table files. `apps/dag-ui-e2e/AGENTS.md` records that split: a journey counts the scheme against `EVENT_CATEGORIES` and must not restate the vocabulary. What the browser tier proves is the drawing, which filing these two kinds does not change.
  "dispatch-stopped": "lifecycle",
  "host-shutdown": "lifecycle",
  // llmlint: ignore-end[changed_behavior_has_e2e]
  // llmlint: ignore-end[code_lands_in_the_domain_that_owns_it]
  // llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
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
