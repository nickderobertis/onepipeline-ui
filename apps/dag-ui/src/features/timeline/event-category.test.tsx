import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_EVENT_CATEGORY,
  type EventCategory,
  EventCategoryIcon,
  eventCategory,
} from "./event-category";

/**
 * The wire vocabulary the run store actually holds, and what each kind is read as.
 *
 * Enumerated rather than sampled, and counted out of every `runs/*​/events.jsonl`
 * under a real run root rather than written from memory: four separately versioned
 * producers write into one journal, and a scheme that files most of their kinds is a
 * scheme whose gaps are invisible. Regenerate it the same way — walk that directory
 * — rather than trusting this list to have stayed current; `body-not-drafted` was
 * already in the store by the time this was written and absent from the reading it
 * was planned from.
 *
 * These are the *whole* corpus, so this list failing to compile or to match is the
 * signal that a producer shipped a kind nobody has decided a category for.
 */
const CORPUS: Readonly<Record<string, EventCategory>> = {
  // `pipeline` — the orchestrator's own record of a run.
  "run-started": "lifecycle",
  "run-stopped": "lifecycle",
  "driver-adopted": "lifecycle",
  "node-ready": "lifecycle",
  "node-dispatched": "lifecycle",
  "node-settled": "lifecycle",
  "boundary-retried": "recovery",
  "edit-committed": "repository",
  "planner-surface-queued": "planning",
  "planner-surfaced": "planning",
  "planner-replied": "planning",
  "decision-pending": "planning",
  "decision-cleared": "planning",
  "completion-requested": "lifecycle",
  "concurrent-acknowledged": "contention",
  "quiet-worker": "contention",
  "round-started": "lifecycle",
  "round-finished": "lifecycle",
  "round-budget-exceeded": "failure",
  "body-not-drafted": "publication",
  // `agentgraph` — the members and turns under each node.
  "graph-started": "lifecycle",
  "graph-settled": "lifecycle",
  "member-started": "session",
  "member-settled": "session",
  "member-died": "failure",
  "member-heartbeat": "session",
  "turn-started": "session",
  "turn-completed": "session",
  "turn-activity": "session",
  "turn-interrupted": "recovery",
  "fallback-advanced": "recovery",
  "cron-fired": "recovery",
  "cron-reset": "recovery",
  "oneharness-session": "session",
  // `vcs` — the workspace, the branch, and the change.
  "session-opened": "session",
  "session-closed": "session",
  fetch: "repository",
  push: "repository",
  published: "publication",
  "gate-started": "verification",
  "gate-verdict": "verification",
  "lock-wait": "contention",
  "lock-acquired": "contention",
  "merge-queued": "publication",
  "merge-completed": "publication",
  "change-opened": "publication",
  "change-merged": "publication",
  "sync-conflict": "failure",
  // Records written before any producer stamped a `source` on them.
  "setup-finished": "lifecycle",
  "step-started": "lifecycle",
  "step-settled": "lifecycle",
  "pr-checks-observed": "verification",
  "node-added": "lifecycle",
  "node-started": "lifecycle",
  "branch-discovered": "repository",
  "merge-gate-coverage": "verification",
  "edge-added": "lifecycle",
  "node-failed": "failure",
  "verification-started": "verification",
  "verification-finished": "verification",
  "pr-drafting-started": "publication",
  "pr-drafting-finished": "publication",
  "publication-finished": "publication",
  "pr-drafting-fallback": "recovery",
  "pr-created": "publication",
  "publication-failed": "failure",
  "pr-merged": "publication",
  "cleanup-deferred": "lifecycle",
  "human-waiting": "human",
  "conflict-resolution-started": "recovery",
  "conflict-resolution-finished": "recovery",
  "human-attested": "human",
  "edit-rejected": "failure",
};

/** Every category the corpus reaches, plus the default, which it need not. */
const CATEGORIES: readonly EventCategory[] = [
  ...new Set<EventCategory>([...Object.values(CORPUS), DEFAULT_EVENT_CATEGORY]),
];

/**
 * A kind no rule and no exception names — invented here, and deliberately not one
 * the corpus holds, because the whole point is what happens to a word this build has
 * never seen. Its shape is a plausible one: a producer that grew a throttle would
 * spell it about like this.
 */
const FUTURE_KIND = "capacity-throttled";

describe("the category one journal record is read under", () => {
  test("files every kind the run store holds", () => {
    expect(
      Object.fromEntries(
        Object.keys(CORPUS).map((kind) => [kind, eventCategory(kind)]),
      ),
    ).toEqual(CORPUS);
  });

  test("stays small enough to be scanned, and draws each category apart", () => {
    // Between eight and twelve: fewer and the scheme says little more than one pin
    // did; more and it is a legend the reader has to learn rather than recognise.
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(CATEGORIES.length).toBeLessThanOrEqual(12);
    // Distinct *glyphs*, not merely distinct names: two categories drawn the same
    // way are one category as far as a reader scanning the plot is concerned. So
    // what is compared is the drawing itself — the shapes inside the `svg` — and
    // never its attributes, which carry the category name and so differ whatever
    // was drawn.
    const drawn = CATEGORIES.map((category) => {
      const { container, unmount } = render(
        <EventCategoryIcon category={category} />,
      );
      const shapes = container.querySelector("svg")?.innerHTML ?? "";
      unmount();
      return shapes;
    });
    expect(drawn.every((shapes) => shapes.length > 0)).toBe(true);
    expect(new Set(drawn).size).toBe(CATEGORIES.length);
  });

  test("still draws a kind that no rule and no exception names", () => {
    // The four producers release on their own schedules, so this is the ordinary
    // case rather than a defect: it reaches the default category by name...
    expect(eventCategory(FUTURE_KIND)).toBe(DEFAULT_EVENT_CATEGORY);
    // ...and the default is one of the categories, with a glyph of its own — never
    // a blank, and never quietly borrowed from whichever neighbour a rule reached.
    expect(CATEGORIES).toContain(DEFAULT_EVENT_CATEGORY);
    const { container } = render(
      <EventCategoryIcon category={eventCategory(FUTURE_KIND)} />,
    );
    const icon = container.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("data-event-category", DEFAULT_EVENT_CATEGORY);
  });

  test("draws the glyph as decoration rather than as something to operate", () => {
    render(<EventCategoryIcon category="failure" />);
    // The marker it sits inside is already a button carrying the record's own name,
    // and the transcript row beside it an article carrying the same one. Announced
    // again here it would be the record read twice and understood no better.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
