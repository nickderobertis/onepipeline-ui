import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_EVENT_CATEGORY,
  EVENT_CATEGORIES,
  type EventCategory,
  EventCategoryIcon,
  eventCategory,
} from "./event-category";

/**
 * A kind this build has no reading for, standing in for every kind the four
 * producers ship after it: what it is *filed* as belongs to
 * `@onepipeline-ui/timeline-categories` and is held there; what it is *drawn* as
 * is this project's, and is held here.
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

describe("the category a journal record is drawn as", () => {
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

  test("draws the glyph as decoration rather than as something to operate", () => {
    render(<EventCategoryIcon category="failure" />);
    // The marker it sits inside is already a button carrying the record's own name,
    // and the transcript row beside it an article carrying the same one. Announced
    // again here it would be the record read twice and understood no better.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
