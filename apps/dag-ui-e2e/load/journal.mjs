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
 * corpus, the load writer and the journeys append through this one, which keeps
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

/** The receipt beside one journal. */
export function receiptPath(journal) {
  return journal.replace(/\.jsonl$/u, ".append.json");
}

/** `SystemTime` as serde writes it, from a nanosecond count. */
function systemTime(nanoseconds) {
  return {
    secs_since_epoch: Number(nanoseconds / 1_000_000_000n),
    nanos_since_epoch: Number(nanoseconds % 1_000_000_000n),
  };
}

/** The journal's metadata, as the engine's `Stamp` reads it. */
export function stampOf(journal) {
  const about = statSync(journal, { bigint: true });
  const stamp = {
    len: Number(about.size),
    modified: systemTime(about.mtimeNs),
  };
  // `metadata.created()` is the birth time where the filesystem records one,
  // and absent where it does not — which Node reports as the epoch.
  if (about.birthtimeNs > 0n) stamp.created = systemTime(about.birthtimeNs);
  stamp.identity = [
    Number(about.dev),
    Number(about.ino),
    Number(about.ctimeNs / 1_000_000_000n),
    Number(about.ctimeNs % 1_000_000_000n),
  ];
  return stamp;
}

function sameStamp(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readReceipt(journal) {
  const path = receiptPath(journal);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeReceipt(journal, receipt) {
  const path = receiptPath(journal);
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(staged, path);
}

/**
 * Start a receipt for a journal written whole, as a writer that has just
 * appended its last record leaves one.
 */
export function receiptFor(journal) {
  writeReceipt(journal, {
    schema_version: 1,
    epoch: `load-${process.pid}-${process.hrtime.bigint()}`,
    stamp: stampOf(journal),
  });
}

/**
 * Append `records` (objects, one line each) to `journal` in one write, and
 * publish the receipt the engine's writer would. The epoch continues only when
 * the receipt on disk describes the journal as this write found it.
 */
export function appendRecords(journal, records) {
  const before = stampOf(journal);
  const previous = readReceipt(journal);
  const epoch =
    previous?.schema_version === 1 && sameStamp(previous.stamp, before)
      ? previous.epoch
      : `load-${process.pid}-${process.hrtime.bigint()}`;
  appendFileSync(
    journal,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  writeReceipt(journal, {
    schema_version: 1,
    epoch,
    stamp: stampOf(journal),
  });
}
