import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  firstAddress,
  runPageKind,
  subscriptionView,
} from "../first-screen/address";
import { DETAIL_LEVELS, useUrlSelection } from "../lib/useUrlSelection";

/**
 * The drift gate for the first-screen chunk's reading of the address.
 *
 * `first-screen/address.ts` reads the address without `useUrlSelection`, whose module
 * the first-screen chunk must not load, and copies the two detail words' filter
 * profiles. The app takes the first answer over only when the view it would subscribe
 * equals the one the first screen subscribed, so a reading that drifted would draw a
 * first screen for one view and then read the run again for another. Each address
 * here is read both ways, and the first screen's view is held to the app's.
 */
afterEach(() => window.history.replaceState(null, "", "/"));

/** The view the app subscribes for `search`, read as `App` reads it. */
function appView(search: string) {
  window.history.replaceState(null, "", `/${search}`);
  const { result, unmount } = renderHook(() => useUrlSelection());
  const selection = result.current;
  unmount();
  return {
    runId: selection.runId,
    view: subscriptionView(
      selection.runId,
      runPageKind(selection.view, selection.nodeId),
      selection.nodeId,
      DETAIL_LEVELS[selection.detail].profile,
    ),
  };
}

const filterOf = (search: string): string | undefined => {
  const view = firstAddress(search, "/")?.view;
  return view !== undefined &&
    "filter" in view &&
    typeof view.filter === "string"
    ? view.filter
    : undefined;
};

describe("the first screen subscribes the view the app would", () => {
  // Every address a first screen is drawn for: each page kind, each detail word,
  // a view word this app has no page for, and identifiers at their bounds.
  const drawn = [
    "?run=r",
    "?run=r&view=overall",
    "?run=r&view=graph",
    "?run=r&node=build",
    "?run=r&node=build&view=graph",
    "?run=r&node=build&view=overall",
    "?run=r&node=build&tab=timeline",
    "?run=r&view=elsewhere",
    "?run=r&node=build&view=elsewhere",
    "?run=r&node=build&detail=decisions",
    "?run=r&view=overall&detail=decisions",
    "?run=r&view=graph&detail=activity",
    "?run=r&detail=other",
    `?run=${"r".repeat(512)}&node=${"n".repeat(512)}`,
  ];
  for (const search of drawn)
    it(`for ${search.slice(0, 60)}`, () => {
      const first = firstAddress(search, "/");
      const app = appView(search);
      expect(first, "a first screen is drawn").toBeDefined();
      expect(first?.runId).toBe(app.runId);
      expect(first?.view).toStrictEqual(app.view);
    });

  // Addresses the app reads with no run of its own naming, so no first screen
  // stands in for them: an identifier the read API could never serve, a page that
  // is not a run's, a channel, and a node's tab other than its timeline.
  const notDrawn: readonly (readonly [string, string])[] = [
    ["?view=overall", "/"],
    ["?run=", "/"],
    [`?run=${"r".repeat(513)}`, "/"],
    ["?run=a%2Fb", "/"],
    ["?run=a%3Fb", "/"],
    ["?run=a%01b", "/"],
    ["?run=r&page=host", "/"],
    ["?run=r", "/human-items"],
    ["?run=r&view=channel", "/"],
    ["?run=r&node=build&tab=task", "/"],
  ];
  for (const [search, path] of notDrawn)
    it(`draws none for ${search.slice(0, 40)} at ${path}`, () => {
      expect(firstAddress(search, path)).toBeUndefined();
    });

  it("reads a node id the read API could never serve as no node, as the app does", () => {
    for (const node of ["a%2Fb", "a%23b", "a%09b", "n".repeat(513)]) {
      const search = `?run=r&node=${node}`;
      const first = firstAddress(search, "/");
      expect(first?.nodeId).toBeUndefined();
      expect(first?.view).toStrictEqual(appView(search).view);
    }
  });

  for (const [level, { profile }] of Object.entries(DETAIL_LEVELS))
    it(`under ?detail=${level}, the app's filter profile`, () => {
      expect(filterOf(`?run=r&view=graph&detail=${level}`)).toBe(profile);
    });

  it("with no detail word, the app's default level's", () => {
    // `useUrlSelection` reads an absent or unknown word as `activity`.
    for (const search of ["?run=r&view=overall", "?run=r&detail=other"])
      expect(filterOf(search)).toBe(DETAIL_LEVELS.activity.profile);
  });
});
