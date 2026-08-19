import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Reading a file of this repository by its path from the root.
 *
 * Two suites need it, and both for the same reason: a declaration they have to hold
 * something else to is written in a file no unit test can import — a Markdown
 * document, a Playwright spec, a `.mjs` fixture that writes a run directory when it
 * is evaluated. Reading the text is what lets a gate exist at all.
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
export const repoFile = (path: string): string =>
  readFileSync(resolve(repoRoot(), path), "utf8");
