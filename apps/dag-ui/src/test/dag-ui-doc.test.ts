import { describe, expect, it } from "vitest";
import { EVENT_CATEGORIES } from "../features/timeline/event-category";
import { repoFile } from "./repo-file";

/**
 * The drift gate `docs/dag-ui.md` names.
 *
 * That document tabulates two lists it does not own — the viewport matrix, declared
 * in `e2e/viewports.ts`, and the captured surfaces, declared as `SURFACES` in
 * `e2e/gallery.screens.spec.ts` — and states one count it does not own either, the
 * number of categories a journal record's marker can be drawn as. A table is how an
 * operator finds a capture and how a reader learns which widths are held, so a width
 * that reaches the gallery without reaching the table is a promise the document
 * quietly stops keeping; a count written by hand is the same promise with nothing at
 * all watching it. Prose cannot be derived from a declaration at runtime, so this is
 * what ties them together.
 *
 * Both are read as text rather than imported, and for two reasons that arrive at the
 * same place: `SURFACES` is declared inside a Playwright spec, and importing that
 * under vitest would pull a browser test runner into a unit test to read eight
 * strings out of it; and both files belong to `dag-ui-e2e`, a project of its own,
 * whose files this one may no more reach into than a journey may reach into `src/`.
 * What is asserted is the same either way — the declaration these tables are drawn
 * from — because reading a declaration as text is still reading the declaration.
 */

/**
 * How this document spells a small number, which is how a count in its prose can be
 * held to a declaration at all.
 *
 * The document writes its counts as words — "one plot", "three levels", "the four it
 * knows" — so a gate over one has to spell it the same way. Indexed by the number
 * itself, and short on purpose: a count this document states in prose past twenty is
 * a count no reader is holding in their head, and should be a table instead.
 */
const SPELLED = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/**
 * The first column of every row of the Markdown table `heading` opens.
 *
 * Backticks are stripped, because whether a cell is written as code is the table's
 * business rather than the declaration's.
 */
function tableKeys(markdown: string, heading: string): readonly string[] {
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`docs/dag-ui.md has no "${heading}" table`);
  const rows: string[] = [];
  for (const line of markdown.slice(start).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.split("|")[1]?.trim().replaceAll("`", "") ?? "");
  }
  return rows;
}

describe("docs/dag-ui.md", () => {
  const documentation = repoFile("docs/dag-ui.md");

  it("tabulates exactly the viewport matrix the gallery captures at", () => {
    // Every `sized(width, height)` the matrix declares, in the order it declares
    // them, named the way that helper names them.
    const declared = [
      ...repoFile("apps/dag-ui/e2e/viewports.ts").matchAll(
        /^ {2}sized\((\d+), (\d+)\),$/gm,
      ),
    ].map(([, width, height]) => `${width}x${height}`);
    expect(declared.length).toBeGreaterThan(0);
    expect(
      tableKeys(documentation, "| Viewport | What it stands for |"),
    ).toEqual(declared);
  });

  it("states the number of categories a journal marker is drawn as", () => {
    const spelled = SPELLED[EVENT_CATEGORIES.length];
    expect(
      spelled,
      `a scheme of ${EVENT_CATEGORIES.length} belongs in a table rather than in a sentence`,
    ).toBeDefined();
    expect(documentation).toContain(`which of ${spelled} **categories**`);
  });

  it("tabulates exactly the surfaces the gallery photographs", () => {
    const declared = [
      ...repoFile("apps/dag-ui/e2e/gallery.screens.spec.ts").matchAll(
        /^ {4}name: "([^"]+)",$/gm,
      ),
    ].map(([, name]) => name);
    expect(declared.length).toBeGreaterThan(0);
    expect(
      tableKeys(documentation, "| Captured file | What it shows |"),
    ).toEqual(declared);
  });
});
