import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { repoFile } from "../../test/repo-file";
import {
  DEFAULT_EVENT_CATEGORY,
  EVENT_CATEGORIES,
  type EventCategory,
  EventCategoryIcon,
  eventCategory,
  eventCategoryLabel,
} from "./event-category";

/**
 * The wire vocabulary a run store holds, and what each kind is read as.
 *
 * A copy, because nothing a browser can read declares it; `apps/dag-ui/AGENTS.md`
 * has why, and which side each gate sits on. Two of them hold these keys:
 * `tests/contract.rs` fails when `onepipeline` or `oneagentgraph` declares a kind
 * they do not have, and the second test below fails when the served store writes
 * one.
 *
 * The *category* is not gated and cannot be — which of the eleven a kind reads
 * under is a decision rather than a fact about the producer — so a kind reaching
 * either gate is one nobody has decided yet, not a defect. An unrecognized kind
 * draws under an explicit default and always did.
 *
 * Kinds no current producer declares stay: a run store is append-only, and one
 * written by last year's engine is still one a reader opens.
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
  "cross-dag-satisfied": "lifecycle",
  "upstream-modified": "lifecycle",
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
  "turn-message": "session",
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
  "change-check": "verification",
  "change-merged": "publication",
  "sync-conflict": "failure",
  // The releases, across the two producers that record them: `onevcs` probes,
  // acknowledges and observes, `onepipeline` holds a node, sees the release arrive
  // and adopts the versions. The wait is the one filed apart from the rest, because
  // what a reader scans a stalled run for is the wait rather than what it is for.
  "release-probed": "publication",
  "release-acknowledged": "publication",
  "release-observed": "publication",
  "release-wait": "contention",
  "release-arrived": "publication",
  "release-adopted": "publication",
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

/**
 * A kind no rule and no exception names — invented here, and deliberately not one
 * the corpus holds, because the whole point is what happens to a word this build has
 * never seen. Its shape is a plausible one: a producer that grew a throttle would
 * spell it about like this.
 */
const FUTURE_KIND = "capacity-throttled";

/**
 * The shapes inside one category's glyph — the whole of what a reader sees of it.
 *
 * The drawing rather than the element: an `svg`'s own attributes carry the class the
 * icon set names it with, so comparing elements would report two categories as drawn
 * apart whatever was actually drawn in them.
 */
function drawing(category: EventCategory): string {
  const { container, unmount } = render(
    <EventCategoryIcon category={category} />,
  );
  const shapes = container.querySelector("svg")?.innerHTML ?? "";
  unmount();
  return shapes;
}

/**
 * Every kind the run store the browser journeys are served holds, and the one it
 * writes on purpose for the app not to recognise.
 *
 * Read out of the fixture as text rather than by importing it: that module writes a
 * run directory when it is evaluated, and building one per run of this suite to read
 * a couple of dozen strings is not what a unit test is for. It is the same reading
 * `src/test/dag-ui-doc.test.ts` takes of the gallery's surface list.
 */
function servedStore(): { kinds: readonly string[]; unknown: string } {
  const source = repoFile("apps/dag-ui/e2e/fixtures/runs.mjs");
  // A kind is written either as the literal it is or as a constant that module
  // declares, and both reach the store, so both are read here.
  const declared = new Map(
    [...source.matchAll(/^export const ([A-Z_]+) = "([a-z0-9-]+)";$/gm)].map(
      ([, name, value]) => [name, value],
    ),
  );
  const emitted = [
    ...source.matchAll(/\bemit\(\s*"[a-z]+",\s*(?:"([a-z0-9-]+)"|([A-Z_]+))/gs),
  ].map(([, literal, named]) => literal ?? declared.get(named ?? ""));
  const unknown = declared.get("UNFILED_KIND");
  // Every reading here is of a call or a declaration shape, so a fixture rewritten
  // in another shape would otherwise gate nothing at all.
  expect(emitted.length).toBeGreaterThan(0);
  expect(emitted).not.toContain(undefined);
  expect(unknown).toBeDefined();
  return {
    kinds: [...new Set(emitted.filter((kind) => kind !== undefined))],
    unknown: unknown ?? "",
  };
}

/**
 * The word each category reads as where there is no room to draw its glyph.
 *
 * Written out rather than derived from the function under test, for the reason the
 * glyph expectations in `dag-ui.spec.ts` are: an expectation computed the way the
 * implementation computes it agrees with any rule at all, including one that stopped
 * capitalizing or started abbreviating. Keyed by the closed vocabulary, so a category
 * added to the scheme fails to compile until it has been given a word here too.
 */
const EXPECTED_CATEGORY_WORD: Readonly<Record<EventCategory, string>> = {
  recovery: "Recovery",
  failure: "Failure",
  human: "Human",
  planning: "Planning",
  contention: "Contention",
  verification: "Verification",
  publication: "Publication",
  repository: "Repository",
  session: "Session",
  lifecycle: "Lifecycle",
  activity: "Activity",
};

describe("the category one journal record is read under", () => {
  test("files every kind the run store holds", () => {
    expect(
      Object.fromEntries(
        Object.keys(CORPUS).map((kind) => [kind, eventCategory(kind)]),
      ),
    ).toEqual(CORPUS);
  });

  test("files every kind the served store writes bar the unknown one", () => {
    // What the two producers that declare nothing a reader can reach are gated
    // against: a record reaching the app for real with no category decided for it.
    // The one exception is named rather than counted, so a producer shipping a kind
    // cannot be absorbed by the fixture's own unrecognized record going missing.
    const store = servedStore();
    expect(store.kinds.filter((kind) => !(kind in CORPUS))).toEqual([
      store.unknown,
    ]);
  });

  test("stays small enough to be scanned, and draws each category apart", () => {
    // Between eight and twelve: fewer and the scheme says little more than one pin
    // did; more and it is a legend the reader has to learn rather than recognise.
    expect(EVENT_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(EVENT_CATEGORIES.length).toBeLessThanOrEqual(12);
    // Distinct *glyphs*, not merely distinct names: two categories drawn the same
    // way are one category as far as a reader scanning the plot is concerned.
    const drawn = EVENT_CATEGORIES.map(drawing);
    expect(drawn.every((shapes) => shapes.length > 0)).toBe(true);
    expect(new Set(drawn).size).toBe(EVENT_CATEGORIES.length);
  });

  test("still draws a kind that no rule and no exception names", () => {
    // The four producers release on their own schedules, so this is the ordinary
    // case rather than a defect: it reaches the default category by name...
    expect(eventCategory(FUTURE_KIND)).toBe(DEFAULT_EVENT_CATEGORY);
    // ...and the default is one of the categories, drawn with shapes of its own —
    // never a blank, and never quietly borrowed from a neighbour a rule reached.
    expect(EVENT_CATEGORIES).toContain(DEFAULT_EVENT_CATEGORY);
    const fallback = drawing(eventCategory(FUTURE_KIND));
    expect(fallback.length).toBeGreaterThan(0);
    expect(
      EVENT_CATEGORIES.filter(
        (category) => category !== DEFAULT_EVENT_CATEGORY,
      ).map(drawing),
    ).not.toContain(fallback);
  });

  test("names every category for the readings that cannot draw it", () => {
    // A marker's hover reading says which category the glyph beside it came from,
    // which is the one thing the plot itself says only as a picture.
    expect(
      Object.fromEntries(
        EVENT_CATEGORIES.map((category) => [
          category,
          eventCategoryLabel(category),
        ]),
      ),
    ).toEqual(EXPECTED_CATEGORY_WORD);
    // Told apart in words as well as in drawings: two categories that read the same
    // are one category to a reader the glyph told nothing.
    expect(new Set(Object.values(EXPECTED_CATEGORY_WORD)).size).toBe(
      EVENT_CATEGORIES.length,
    );
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
