import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FIXTURE_WORKSPACE } from "./playwright.config";

/**
 * What the fixture wrote, read from the file it publishes beside its runs.
 *
 * `e2e/fixtures/runs.mjs` is the one source of these ids; naming them again
 * in a spec would be a second one that drifts the moment the fixture changes.
 */
const fixtureSchema = z.object({
  runs: z.object({
    live: z.string().min(1),
    history: z.string().min(1),
    outcomes: z.string().min(1),
    legacy: z.string().min(1),
    sibling: z.string().min(1),
    unattributed: z.string().min(1),
    eventless: z.string().min(1),
    busy: z.string().min(1),
  }),
  foundation_pr: z.string().min(1),
  /** The one kind the store holds that this build has no category rule for. */
  unfiled_kind: z.string().min(1),
  /**
   * The boundary the reading collapses a run of consecutive rows at, and the two
   * nodes the corpus is written around it: one records one short of it and one
   * records exactly it, each as a run of dispatched sessions and a run of journal
   * records.
   */
  collapse: z.object({
    threshold: z.number().int().min(2),
    narrow_node: z.string().min(1),
    wide_node: z.string().min(1),
    /** A node whose reading is a long list of uniform rows and nothing else. */
    dense_node: z.string().min(1),
    dense_records: z.number().int().min(20),
  }),
  /**
   * The two hold reasons no other run in this corpus carries: a node waiting on a
   * sibling's release, and a node held for a reason written by an engine newer
   * than the app reading it — which every hold looks like from a build one release
   * behind, and which must reach a reader as its own reason rather than as a hold
   * with nothing in it.
   */
  holds: z.object({
    adopting_node: z.string().min(1),
    awaits: z.string().min(1),
    unread_kind: z.string().min(1),
  }),
  /**
   * What the live run's scheduler recorded about the nodes it was not running:
   * the node it held behind other work and what was ahead of it each time that
   * changed, the node held for reasons that are not concurrency, and a node the
   * run said nothing at all about — which is the state a queued span must never
   * be invented for.
   */
  queue: z.object({
    behind_node: z.string().min(1),
    ahead: z.array(z.array(z.string().min(1)).min(1)).min(2),
    held_node: z.string().min(1),
    decision_reference: z.string().min(1),
    quiet_node: z.string().min(1),
  }),
  remote_open_pr: z.string().min(1),
  foundation_commit: z.string().min(1),
  /**
   * The release the foundation node's work went out in, and the sibling release
   * that node was held on before it could start — including the action a person
   * had to perform, which is the wait a reader has to be able to pick out.
   */
  release: z.object({
    version: z.string().min(1),
    target: z.string().min(1),
    identity: z.string().min(1),
    dep_identity: z.string().min(1),
    dep_version: z.string().min(1),
    human_action: z.string().min(1),
    human_actor: z.string().min(1),
    /** The human step the run named a person for but no action. */
    unspoken_target: z.string().min(1),
  }),
  sessions: z.object({
    worker: z.string().min(1),
    lint: z.string().min(1),
    foundation: z.string().min(1),
    judge: z.string().min(1),
    check_in: z.string().min(1),
    run_check_in: z.string().min(1),
    orchestrator: z.string().min(1),
    orphan: z.string().min(1),
  }),
  /** The two planner notes the live run carries, and the words it refused one with. */
  redirection: z.object({
    live_note: z.string().min(1),
    deferred_note: z.string().min(1),
    no_control_reason: z.string().min(1),
  }),
  artifacts: z.object({
    gate: z.string().min(1),
    missing: z.string().min(1),
    hook: z.string().min(1),
    check: z.string().min(1),
    report: z.string().min(1),
    unretained_report: z.string().min(1),
    /** By its history id: its bytes are in oneharness's store, not the run's. */
    harness_session: z.string().min(1),
    swept_harness_session: z.string().min(1),
    /** These two carry a separator, so no route can be asked for them. */
    unaskable_report: z.string().min(1),
    unaskable_harness_session: z.string().min(1),
  }),
  harness_session_text: z.string().min(1),
});

export type FixtureFacts = z.infer<typeof fixtureSchema>;

let cached: FixtureFacts | undefined;

/** Everything the fixture published about the runs it is serving. */
export function fixture(): FixtureFacts {
  if (cached === undefined) {
    cached = fixtureSchema.parse(
      JSON.parse(
        readFileSync(join(FIXTURE_WORKSPACE, "fixture-facts.json"), "utf8"),
      ),
    );
  }
  return cached;
}

/** Every run the fixture wrote, and nothing else. */
export function runs(): FixtureFacts["runs"] {
  return fixture().runs;
}
