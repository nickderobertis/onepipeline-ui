import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One refused live edit as the engine (onepipeline 0.116.1) records it, in the two
 * records it writes and the file it keeps: the complete refusal, a JSON string in
 * the run's reports directory, named as `Journal::artifact` names it — the
 * artifact kind, the stream and the seq the record takes — and recorded as the
 * `edit-rejected`'s own artifact, which its `full_reason` names by absolute path;
 * the `edit-rejected` itself, labelled with the node its command names; and the
 * reconciler's non-blocking `edit-rejected` surface, whose `rejection` names that
 * record by stream and seq.
 *
 * The one shape both generators write it in — the journeys' fixture runs
 * (`runs.mjs`) and the read-latency large world (`../load/corpus.mjs`) — so a
 * journey and a measurement read one record; `tests/e2e/server.rs` holds what it
 * writes to the linked engine's schema for each kind.
 */

/** The artifact kind the engine keeps a refused edit's complete refusal under. */
export const REFUSAL_ARTIFACT_KIND = "edit-rejected-full-reason";

/**
 * The records of one refusal for the record at `seq` of `stream`, in run `dir`,
 * having written the kept file. `run` is the labels every record carries.
 */
export function refusalRecords(
  dir,
  { stream, seq, run },
  {
    author,
    command,
    node,
    reason,
    summary,
    full,
    truncated = false,
    refused,
    envelope,
    index,
    surface,
  },
) {
  const reports = join(dir, "reports");
  mkdirSync(reports, { recursive: true });
  const kept = join(reports, `${REFUSAL_ARTIFACT_KIND}-${stream}-${seq}.json`);
  const body = JSON.stringify(full);
  writeFileSync(kept, body);
  const raised = {
    surface,
    kind: "edit-rejected",
    message: `reconciler: rejected — ${reason}`,
    source: "reconciler",
    blocking: false,
  };
  return {
    rejected: {
      labels: node === undefined ? run : { ...run, node },
      payload: {
        author,
        command,
        reason,
        ...(envelope === undefined ? {} : { envelope }),
        ...(index === undefined ? {} : { index }),
        ...(refused === undefined ? {} : { refusal: refused }),
        ...(node === undefined ? {} : { node }),
        summary,
        full_reason: kept,
        full_reason_truncated: truncated,
      },
      artifacts: [
        {
          id: kept,
          kind: REFUSAL_ARTIFACT_KIND,
          bytes: Buffer.byteLength(body),
        },
      ],
    },
    raised: {
      labels: run,
      payload: { ...raised, rejection: { stream, seq } },
    },
    surfaced: { labels: run, payload: raised },
  };
}
