import type { EventCategory } from "@onepipeline-ui/timeline-categories";
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
 * The category scheme, re-exported so this app's modules read it from the place
 * they already read the drawing from.
 *
 * The vocabulary itself is `@onepipeline-ui/timeline-categories`, shared with the
 * journeys that count it; what is declared here is what draws it.
 */
// llmlint: ignore-block[feature_code_colocated] the vocabulary is not this feature's to keep: `apps/dag-ui-e2e` reads the same categories to assert what the timeline plots, and a workspace project may not reach into another's source — so a copy here would be a second declaration of one closed set, and the two would drift silently in the direction of a journey that still passes. What is genuinely this feature's, the glyph and the styling each category is drawn as, is declared below and nowhere else.
export {
  DEFAULT_EVENT_CATEGORY,
  EVENT_CATEGORIES,
  type EventCategory,
  eventCategory,
  eventCategoryLabel,
} from "@onepipeline-ui/timeline-categories";

// llmlint: ignore-end[feature_code_colocated]

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
