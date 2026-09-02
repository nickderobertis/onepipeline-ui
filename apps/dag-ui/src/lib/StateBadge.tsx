import { Badge, cn } from "@oneharness/ui";
import type { DagNodeState } from "@onepipeline-ui/dag-layout";

/**
 * A run or node state, in the orchestrator's own words and the design system's own
 * semantic colours.
 *
 * The package ships `StatusBadge`, and it is the right component wherever the state
 * really is one of the four it knows — a conversation's, for one. A run or a node is
 * not: the ledger settles a node as `done` and a run as `complete`, holds a human
 * action at `waiting`, and abandons work as `cancelled`. `StatusBadge` renders an
 * unrecognized state with no tone at all, so passing these through would leave a
 * finished run and an abandoned one looking alike, and relabelling them to fit its
 * vocabulary would replace the word the ledger actually recorded. Mapping instead
 * keeps both: the recorded word, and a colour that means something.
 */
export function StateBadge({
  className,
  state,
}: {
  readonly className?: string;
  readonly state: string;
}) {
  const tone = stateTone(state);
  return (
    <Badge
      className={cn(
        "gap-1.5 tracking-[.03em] uppercase",
        tone && BADGE_TONE[tone],
        className,
      )}
      variant="outline"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          state === "running" && "animate-pulse",
        )}
      />
      {state}
    </Badge>
  );
}

/**
 * What a run or node state means, before anything decides how to paint it.
 *
 * One table, read by everything that colours a state: the badge above and the run
 * list's own marker, which carries a row's state as the colour of its dot. Two
 * tables would let the same word read as finished in one place and lost in the
 * other.
 */
export type StateTone = "success" | "destructive" | "warning" | "info";

/** The tone a state reads as, or `undefined` for a word no table holds. */
export function stateTone(state: string): StateTone | undefined {
  return TONE[state];
}

/**
 * The dot a surface paints a state with, for a surface that also says the word —
 * the run list's rows, where colour is the second reading of a status and never
 * the only one. A state with no tone still gets a mark rather than an invisible
 * one.
 *
 * The tone lands as `currentColor` and the fill as `bg-current`, so anything drawn
 * around the dot — the halo a live row gives it — is the same colour without a
 * second table saying which.
 */
export const stateDotClass = (state: string): string => {
  const tone = stateTone(state);
  return cn(
    "size-2 shrink-0 rounded-full bg-current",
    tone === undefined ? "text-muted-foreground" : DOT_TONE[tone],
  );
};

const BADGE_TONE: Readonly<Record<StateTone, string>> = {
  success: "border-success bg-success-surface text-success",
  destructive: "border-destructive bg-destructive-surface text-destructive",
  warning: "border-warning bg-warning-surface text-warning",
  info: "border-info bg-info-surface text-info",
};

/**
 * Written out rather than composed, because Tailwind reads these files for the
 * classes it generates and never sees one built from a variable at runtime.
 */
const DOT_TONE: Readonly<Record<StateTone, string>> = {
  success: "text-success",
  destructive: "text-destructive",
  warning: "text-warning",
  info: "text-info",
};

const SETTLED: StateTone = "success";
const LOST: StateTone = "destructive";
const DEPENDENCY_DECIDED: StateTone = "warning";

/** Dependency-decided states warn; unfinished settled work reads as a lost outcome. */
const NODE_TONE: Readonly<Record<DagNodeState, StateTone | undefined>> = {
  blocked: DEPENDENCY_DECIDED,
  cancelled: LOST,
  done: SETTLED,
  failed: LOST,
  "not-completed": LOST,
  // Parked is a planner decision to idle a node whose work is preserved, so it is
  // neither lost nor decided by a dependency — it reads as held, like `waiting`.
  parked: undefined,
  pending: undefined,
  running: "info",
  skipped: DEPENDENCY_DECIDED,
  unknown: undefined,
  waiting: undefined,
};

/**
 * Run- and node-level `blocked` differ, but both use the same held-state tone.
 *
 * A run's state is an open string in the read contract and each executor has its
 * own words — `onepipeline` prints `ACTIVE` and `SETTLED` from its own CLI, and a
 * server that says `running` and `complete` is equally conforming. Each pair reads
 * as one tone. A word no table holds — `driver-dead`, `undriven` — is shown untoned
 * rather than relabelled: it is a real state with no outcome in it.
 */
const TONE: Readonly<Record<string, StateTone | undefined>> = {
  ...NODE_TONE,
  complete: NODE_TONE.done,
  settled: NODE_TONE.done,
  active: NODE_TONE.running,
};
