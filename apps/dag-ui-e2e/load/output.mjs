/**
 * Tool output for the load workload's records, compressible the way real tool
 * output is.
 *
 * A tool call's output is the text an agent's `cat`, `grep`, `cargo` or `curl`
 * printed: source code, prose and JSON. The output is drawn from this
 * repository's committed text of each kind: the server's Rust source, the
 * contract document, and the JSON its routes serve as fixtures. Each record
 * takes `OUTPUT_CHARS` characters, starting at a place far from where the last
 * record started. So a compressor sees text that compresses like real text, and
 * nothing repeated in a pattern no real host would write. Without this, every
 * record carried one character repeated, which any encoding shrinks to almost
 * nothing, and a figure measured over it would flatter real traffic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

/** The committed text the output is drawn from: code, prose, and JSON. */
export const OUTPUT_SOURCES = [
  "src/payload.rs",
  "docs/contract.md",
  "tests/fixtures/run.json",
  "tests/fixtures/run-timeline.json",
  "tests/fixtures/run-transcript.json",
];

/** How long one record's output is: the size of a real tool call's output. */
export const OUTPUT_CHARS = 900;

const POOL = OUTPUT_SOURCES.map((source) =>
  readFileSync(join(REPOSITORY, source), "utf8"),
).join("\n");

/** How far apart consecutive records start: a prime, so every start is reached. */
const STRIDE = 104_729;

/** The `n`th record's tool output. */
export function toolOutput(n) {
  const start = (n * STRIDE) % (POOL.length - OUTPUT_CHARS);
  return POOL.slice(start, start + OUTPUT_CHARS);
}
