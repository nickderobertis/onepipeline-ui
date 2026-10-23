/**
 * Appending to a run's journal the way the engine's own writer does.
 *
 * The engine's writer publishes an **append receipt** beside the journal
 * (`events.append.json`) after every record it appends: the journal's metadata
 * after the write, under an epoch that survives only a write whose starting
 * metadata matches the previous receipt. A long-lived `RunView::refresh` reads
 * only the appended records when the receipt continues the one it last saw, and
 * reads the whole journal again (`Reread`) whenever it does not — so a fixture
 * that appended bare lines would make every live update a whole re-read, which is
 * not what a run the engine drives costs. The engine exports no appender, so the
 * corpus, the load writer, the browser fixtures and the crate's journeys
 * (`tests/support/live_journal.rs`, through the command below) all append
 * through this one — the single fixture writer, whose receipts
 * `tests/e2e/live.rs` holds field for field to ones the engine wrote — which keeps
 * the receipt as the engine's writer keeps it (`onepipeline::appendstamp`,
 * `tests/golden/append-receipt-v1.json` in that crate). It is a cache the engine
 * reads, never an authority: a receipt this writes that the engine does not
 * accept costs a `Reread`, and the journeys that count refresh outcomes say so.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** `SystemTime` as serde writes it. */
const systemTimeSchema = z.object({
  secs_since_epoch: z.number().int().nonnegative(),
  nanos_since_epoch: z.number().int().nonnegative(),
});
/** The journal's metadata, as the engine's `Stamp` reads it. */
const stampSchema = z.object({
  len: z.number().int().nonnegative(),
  modified: systemTimeSchema,
  created: systemTimeSchema.optional(),
  identity: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional(),
});
/** A receipt, as the engine's `appendstamp::Receipt` writes one. */
const receiptSchema = z.object({
  schema_version: z.literal(1),
  epoch: z.string().min(1),
  stamp: stampSchema,
});
type Stamp = z.infer<typeof stampSchema>;
type Receipt = z.infer<typeof receiptSchema>;

/** The receipt beside one journal. */
export function receiptPath(journal: string): string {
  return journal.replace(/\.jsonl$/u, ".append.json");
}

/** `SystemTime` as serde writes it, from a nanosecond count. */
function systemTime(nanoseconds: bigint) {
  return {
    secs_since_epoch: Number(nanoseconds / 1_000_000_000n),
    nanos_since_epoch: Number(nanoseconds % 1_000_000_000n),
  };
}

/** The journal's metadata, as the engine's `Stamp` reads it. */
export function stampOf(journal: string): Stamp {
  const about = statSync(journal, { bigint: true });
  return {
    len: Number(about.size),
    modified: systemTime(about.mtimeNs),
    // `metadata.created()` is the birth time where the filesystem records one,
    // and absent where it does not — which Node reports as the epoch.
    ...(about.birthtimeNs > 0n
      ? { created: systemTime(about.birthtimeNs) }
      : {}),
    // The engine stamps a file's identity on unix alone, so a receipt that
    // carried one on Windows would never match the journal it describes.
    ...(process.platform === "win32"
      ? {}
      : {
          identity: [
            Number(about.dev),
            Number(about.ino),
            Number(about.ctimeNs / 1_000_000_000n),
            Number(about.ctimeNs % 1_000_000_000n),
          ] as [number, number, number, number],
        }),
  };
}

function sameStamp(left: Stamp, right: Stamp): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The receipt on disk, or `undefined` for none — and for one this writer would
 * not have written, which, like the engine, it reads as no continuity at all.
 */
function readReceipt(journal: string): Receipt | undefined {
  const path = receiptPath(journal);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = receiptSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeReceipt(journal: string, receipt: Receipt): void {
  const path = receiptPath(journal);
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(staged, path);
}

const freshEpoch = () => `load-${process.pid}-${process.hrtime.bigint()}`;

/**
 * Start a receipt for a journal written whole, as a writer that has just
 * appended its last record leaves one.
 */
export function receiptFor(journal: string): void {
  writeReceipt(journal, {
    schema_version: 1,
    epoch: freshEpoch(),
    stamp: stampOf(journal),
  });
}

/**
 * Append `records` (objects, one line each) to `journal` in one write, and
 * publish the receipt the engine's writer would. The epoch continues only when
 * the receipt on disk describes the journal as this write found it.
 */
export function appendRecords(
  journal: string,
  records: readonly Record<string, unknown>[],
): void {
  appendLines(
    journal,
    records.map((record) => JSON.stringify(record)),
  );
}

/** {@link appendRecords}, for lines already serialized: each is written as given. */
export function appendLines(journal: string, lines: readonly string[]): void {
  const before = stampOf(journal);
  const previous = readReceipt(journal);
  const epoch =
    previous !== undefined && sameStamp(previous.stamp, before)
      ? previous.epoch
      : freshEpoch();
  appendFileSync(journal, lines.map((line) => `${line}\n`).join(""));
  writeReceipt(journal, { schema_version: 1, epoch, stamp: stampOf(journal) });
}

/** What `append` reads on standard input: each journal and its lines, in order. */
const appendsSchema = z.record(
  z.string().endsWith(".jsonl"),
  z.array(
    z
      .string()
      .min(1)
      .refine((line) => !line.includes("\n")),
  ),
);

/**
 * The command the crate's journeys append through, so a record they append is
 * written by this module and no other:
 *
 *     node journal.ts append    < {"JOURNAL": ["line", …], …}
 *     node journal.ts receipt JOURNAL…
 *
 * `append` takes one JSON object on standard input naming each journal and the
 * lines to append to it, in order, each journal in one write; `receipt` leaves
 * a fresh receipt for journals written whole. The script is recognised as run
 * by comparing URLs, because a Windows path prefixed with `file://` is not how
 * `import.meta.url` spells it, and a command that never ran exits `0`.
 */
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [verb, ...journals] = process.argv.slice(2);
  const usage = (why: string): never => {
    console.error(
      `journal.ts: ${why}\nusage: journal.ts append < {journal: [lines]} | receipt JOURNAL…`,
    );
    process.exit(2);
  };
  if (verb === "receipt" && journals.length > 0) {
    for (const journal of journals) receiptFor(journal);
  } else if (verb === "append" && journals.length === 0) {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      usage("standard input is not JSON");
    }
    const appends = appendsSchema.safeParse(input);
    if (!appends.success) usage(appends.error.message);
    else
      for (const [journal, lines] of Object.entries(appends.data))
        appendLines(journal, lines);
  } else {
    usage("no such command");
  }
}
