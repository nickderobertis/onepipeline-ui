import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FIXTURE_WORKSPACE } from "../playwright.config";

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
  remote_open_pr: z.string().min(1),
  foundation_commit: z.string().min(1),
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
    /** The report a settled node's member left, served from the run's own copy. */
    report: z.string().min(1),
    /** A settlement naming a report this run kept no copy of. */
    unretained_report: z.string().min(1),
    /**
     * The oneharness conversation one member's invocation was written down as,
     * by its history id. Its bytes are in oneharness's own store, not the run's.
     */
    harness_session: z.string().min(1),
  }),
  /** What that conversation ended on, which is what reading it must show. */
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
