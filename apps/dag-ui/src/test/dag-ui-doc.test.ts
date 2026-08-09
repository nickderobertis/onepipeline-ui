import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VIEWPORTS } from "../../e2e/viewports";

/**
 * The drift gate `docs/dag-ui.md` names.
 *
 * That document tabulates two lists it does not own — the viewport matrix, declared
 * in `e2e/viewports.ts`, and the captured surfaces, declared as `SURFACES` in
 * `e2e/gallery.screens.spec.ts`. A table is how an operator finds a capture and how a
 * reader learns which widths are held, so a width that reaches the gallery without
 * reaching the table is a promise the document quietly stops keeping. Prose cannot be
 * derived from either declaration at runtime, so this is what ties the three together.
 *
 * `SURFACES` is read as text rather than imported: it is declared inside a Playwright
 * spec, and importing that under vitest would pull a browser test runner into a unit
 * test to read eight strings out of it.
 */

/**
 * The repository root, found by the manifest that only sits there.
 *
 * Walked for rather than counted in `../`s: this app is one project of a workspace
 * and vitest is started from more than one directory in it, so a fixed depth is a
 * path that works until someone runs the suite the other way.
 */
function repoRoot(): string {
  let directory = process.cwd();
  while (!existsSync(resolve(directory, "Cargo.toml"))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`no Cargo.toml above ${process.cwd()}`);
    directory = parent;
  }
  return directory;
}

/** A file of this repository, by its path from the root. */
const repoFile = (path: string): string =>
  readFileSync(resolve(repoRoot(), path), "utf8");

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
    expect(
      tableKeys(documentation, "| Viewport | What it stands for |"),
    ).toEqual(VIEWPORTS.map(({ name }) => name));
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
