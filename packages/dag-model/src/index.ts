import { z } from "zod";

// llmlint: ignore-file[contracts_have_one_source_or_a_drift_gate] docs/contract.md is the
// authoritative API contract and assigns these exported schemas to this package; the Rust read
// server projects the same contract from the onepipeline SDK's own records and cannot consume Zod;
// model.e2e.test.ts therefore parses this repository's own served goldens — the bytes
// tests/contract.rs pins — through these very parsers, which is the drift gate between them.
// llmlint: ignore-file[changed_behavior_has_e2e] model.e2e.test.ts exercises every top-level API
// parser plus populated telemetry, projection, provenance, timeline, and conversation attribution
// through the package export. Nested Zod records compose those same tested boundaries; exhaustively
// repeating every nested optional combination as an e2e would duplicate their focused unit tests.

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const counter = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });
/**
 * The kind of a run's most recent journal event, shared by the list row and the run
 * telemetry that both carry it. Null — never an empty string — for a run that has
 * recorded no event yet, which is how a just-launched run reads on disk.
 */
const lastEvent = z.string().min(1).nullable();
const openObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).catchall(z.unknown());

// Const assertions preserve route/query literals for consumers; widening these
// shared constants to `string` would discard the closed transport vocabulary.
export const API_V2_PATHS = {
  runs: "/api/v2/runs",
  run: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}`,
  timeline: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/timeline`,
  conversation: (runId: string, conversationId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/conversations/${encodeURIComponent(conversationId)}`,
  artifact: (runId: string, artifactId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
  events: "/api/v2/events",
} as const;
export const API_V2_QUERY = {
  includeSettled: "include_settled",
  /**
   * Opt out of run-detail transcripts. `false` serves `conversations` as an empty
   * array — an opt-out, not a schema change: the field stays required and present,
   * so `api_version` is untouched and a client reading the timeline instead simply
   * stops refetching megabytes of transcript on every live update.
   */
  includeConversations: "include_conversations",
  runId: "run_id",
  after: "after",
  cursor: "cursor",
  limit: "limit",
  /**
   * Which node a `scope=node` timeline is for. `docs/contract.md` names the pair —
   * `?scope=node&node=ID` — and the server refuses a scope that names no node, so
   * the two are always sent together.
   */
  node: "node",
  scope: "scope",
  /**
   * Which events a reading carries: a named profile, or an inline spec in the
   * stack's shared filter grammar.
   *
   * It shapes the response and never the run — every node status, settlement and
   * count is folded from the whole journal whatever this says — so switching it is
   * a change of attention rather than a different account of what happened.
   */
  filter: "filter",
} as const;
export const API_V2_TIMELINE_SCOPES = {
  run: "run",
  node: "node",
} as const;

/**
 * The filter profiles the read API defines for every run, whatever it was
 * launched with. A run's own launch config may define further names, which are
 * this client's to pass through rather than to enumerate.
 *
 * `planner` is the decisions-level view: onepipeline's own event vocabulary is a
 * closed set and it is exactly the decision vocabulary — a node became ready, was
 * dispatched, settled; an edit was committed; a decision began holding dependents
 * back and was cleared. `monitor` is detailed activity: the whole merged stream,
 * all three sources, which is what the monitor persona's own contract says it
 * reads.
 */
export const API_V2_FILTER_PROFILES = {
  planner: "planner",
  monitor: "monitor",
} as const;

/**
 * The telemetry schema this client reads, pinned as a literal so a payload on
 * another meaning is refused rather than rendered as though it agreed.
 *
 * `11` is where an unmeasured timing became `null` instead of `0`. A server on
 * `10` served a measured-looking zero for every lane nothing reports, which is
 * the reading this client must never show.
 *
 * `12` is where the payload began saying, per node in flight, whether that
 * node's turn can be redirected. A server on `11` carries no `node_control` at
 * all, and the only safe reading of an absent entry is "cannot be corrected" —
 * which sends a planner to cancel every node that could have been corrected.
 *
 * `13` is the removal of rounds. Execution in onepipeline is continuous and
 * dependency-driven — a node dispatches the moment its dependencies settle, and
 * nothing batches them — so the `rounds` array is replaced by one `graph` object
 * describing the run's whole state, and no `round` survives anywhere in a
 * payload. A server on `12` serves the array this client no longer has a shape
 * for, which is why the literal is pinned rather than ranged.
 *
 * `14` is the transcript a dispatch really had. A conversation turn is assembled
 * from the settled member's stored onejudge report rather than from journal
 * envelopes alone: `user` is the prompt the simulated user gave rather than the
 * dispatch's persona name, `assistant` is the reply that turn wrote, a tool call
 * carries what it returned, and `usage`/`durationMs` are that turn's own rather
 * than the run's total. Every field was already declared here and is already
 * rendered — a server on `13` fills none of them and puts a persona name where
 * the prompt belongs, which is why the literal moves with the server.
 */
export const TELEMETRY_SCHEMA_VERSION = 14;

/**
 * The timeline payload's own version, which moves independently.
 *
 * `3` is where a `rollup` span stopped implying a dispatch: one may now carry no
 * roles and stand for the waits a publication spent blocked on a lock, named by
 * the kind it summarizes.
 *
 * `7` is where an event began carrying the release it was about. A server on `6`
 * serves the six release kinds as a kind and a stamp alone, so a node held on a
 * machine and a node held on a **person** draw as the same row with the same word
 * on it — and the reader with something to go and do cannot tell that they have it.
 *
 * `6` is where a span says what one lane was doing, and when. A server on `5`
 * gives every `dispatch` span of a node the node's own bounds and every `rollup`
 * the node's dispatch and settlement, so a node dispatched three times draws three
 * spans over one identical interval and a drafting turn that took a minute is drawn
 * across the hours of work it drafted for. It also opens a `publication` where the
 * dispatch's worktree was cut rather than where publishing began, so a node that
 * never published is drawn publishing for its whole life; and it reads a span's
 * `agent_role` off the persona, which drops every session a host named after
 * anything but a role. No member joins `agentRoleSchema` or `timelineSpanKindSchema`
 * under `6`.
 *
 * `5` is where the timeline became continuous: the run is one root span rather
 * than a stack of rounds, no span carries a `round`, and every span id is keyed
 * by what it identifies rather than by a round number. It is also where a span's
 * events may be narrowed by `?filter=` while the span's own bounds and status
 * stay what the run recorded.
 *
 * `4` is where an event began carrying the redirection it was. A server on `3`
 * serves a `turn-interrupted` as its kind and its stamp alone, so the moment a
 * planner changed what a running turn was doing is indistinguishable from any
 * other journal record — and the turn after it reads as a worker inexplicably
 * switching tasks.
 */
export const TIMELINE_SCHEMA_VERSION = 7;

export const timingQualitySchema = z.enum(["complete", "partial", "legacy"]);
export const linkageQualitySchema = z.enum(["native", "labelled", "inferred"]);
export const timingPresenceSchema = openObject({
  agent_model_ms: z.boolean(),
  judge_model_ms: z.boolean(),
  llmlint_model_ms: z.boolean(),
  tool_ms: z.boolean(),
});

/**
 * A measured span, or `null` where nothing measured it.
 *
 * Schema 11's whole change: under 10 every one of these was a required number, so
 * a lane no producer reports — a judge chain that never ran, the time inside a
 * tool call, which nothing times — arrived as `0` and read as a measurement. A
 * run whose cost cannot be answered must not read as a run that was free, so the
 * absence is on the wire rather than inferred from a sidecar.
 */
const measured = nonnegative.nullable();
const measuredCount = counter.nullable();

export const timingSchema = openObject({
  agent_seconds: measured,
  judge_seconds: measured,
  llmlint_seconds: measured,
  gate_seconds: measured,
  publication_wait_seconds: measured,
  lock_wait_seconds: measured,
  setup_seconds: measured,
  scheduling_seconds: measured,
  wall_seconds: measured,
  agent_model_ms: measuredCount,
  judge_model_ms: measuredCount,
  llmlint_model_ms: measuredCount,
  tool_ms: measuredCount,
  idle_orchestration_ms: measuredCount,
  unattributed_ms: measuredCount,
  wall_ms: measuredCount,
  fractions: openObject({
    agent_model: measured,
    judge_model: measured,
    llmlint_model: measured,
    tool: measured,
    idle_orchestration: measured,
    lock_wait: measured,
    setup: measured,
    scheduling: measured,
  }),
});

/**
 * The two role vocabularies, declared once here because three payloads carry them:
 * a conversation's attribution, a node's session links, and a timeline dispatch
 * span. `transportRole` is the party oneharness recorded; `agentRole` is what the
 * dispatch was for.
 */
export const agentRoleSchema = z.enum([
  "orchestrator",
  "worker",
  "judge",
  "check-in",
  "pr-author",
]);
export const transportRoleSchema = z.enum(["agent", "judge", "llmlint"]);

const usageValue = nonnegative.nullable();
export const usagePartySchema = openObject({
  input_tokens: usageValue,
  output_tokens: usageValue,
  cache_read_tokens: usageValue,
  cache_write_tokens: usageValue,
  cost_usd: usageValue,
});
export const usageSchema = openObject({
  agent: usagePartySchema,
  judge: usagePartySchema,
  llmlint: usagePartySchema,
  total: usagePartySchema,
});

/**
 * One session that did a node's work: the transport party in `role`, and the
 * semantic role beside it in `agent_role` so a client can label and group sessions
 * without fetching a transcript for each one.
 */
export const sessionLinkSchema = openObject({
  session_id: z.string().min(1),
  history_id: z.string().min(1).nullable().optional(),
  role: transportRoleSchema,
  agent_role: agentRoleSchema.optional(),
  turn_index: counter.nullable().optional(),
  started_at: timestamp.optional(),
  finished_at: timestamp.nullable().optional(),
});

const arbitraryRecord = z.record(z.string(), z.unknown());

/**
 * How a recorded outcome failed, classified once on the server.
 *
 * `src/payload.rs`'s `failure_class` derives this vocabulary from the outcome
 * word a run recorded, and `tests/contract.rs` reconciles it against the served
 * goldens. It is `class`, not `kind`, because that is the key the wire carries.
 */
export const failureClassSchema = z.enum([
  "agent",
  "gate",
  "checks",
  "publication",
  "timeout",
  "provider",
  "configuration",
  "unknown",
]);
/**
 * Which side of onejudge's two-party conversation the provider refused.
 *
 * A conforming server owns this vocabulary; nothing a onepipeline journal records
 * fills it yet, so this repository's server never serves one. A planner reading
 * "quota" needs it first: the two sides prefer different identities, so a fix aimed
 * at the wrong one changes nothing.
 */
export const conversationSideSchema = z.enum(["agent", "judge", "llmlint"]);

/**
 * Why the provider refused, closed so a client can switch on it exhaustively.
 *
 * A conforming server owns this vocabulary; this repository's own has no record to
 * derive it from and serves none.
 * `quota_at_launch` fell through to the next identity in the chain;
 * `quota_mid_conversation` could not, because the conversation was already bound
 * to the identity that refused it.
 */
export const providerFailureCauseSchema = z.enum([
  "quota_at_launch",
  "quota_mid_conversation",
  "stale_session_resume",
  "rate_limit",
  "harness_exit",
]);

/**
 * A provider refusal, as served on a failure record.
 *
 * A conforming server owns this shape. Every
 * field is optional: only a failure that reached a provider carries any of them,
 * and the evidence a harness gives varies.
 */
export const providerFailureSchema = openObject({
  side: conversationSideSchema.optional(),
  harness: z.string().optional(),
  variant: z.string().optional(),
  identity: z.string().optional(),
  cause: providerFailureCauseSchema.optional(),
  raw_tail: z.string().optional(),
  reset_time: z.string().optional(),
  missing_session_id: z.string().optional(),
  wait_seconds: z.number().nonnegative().optional(),
  failure_kind: z.string().optional(),
  structured_error: arbitraryRecord.optional(),
  judge_unrecorded: z.boolean().optional(),
});

/** The classification, plus whatever a provider refusal recorded beside it. */
export const failureSchema = providerFailureSchema.extend({
  class: failureClassSchema,
  detail: z.string().optional(),
});

export const nodeTelemetrySchema = openObject({
  node: z.string().min(1),
  status: z.string().min(1),
  outcome: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  comparison_remote: z.string().min(1).optional(),
  comparison_base: z.string().min(1).optional(),
  checkpoint: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  retry_lineage: arbitraryRecord.optional(),
  gate_attestation: arbitraryRecord.optional(),
  /** How this node's own outcome failed; omitted for a node that did not fail. */
  failure: failureSchema.optional(),
  timing: timingSchema.optional(),
  usage: usageSchema.optional(),
  sessions: z.array(sessionLinkSchema),
  tool_commands: z.record(z.string(), counter).optional(),
  turns: counter,
  lint: counter,
  timing_quality: timingQualitySchema,
  linkage_quality: linkageQualitySchema,
  timing_presence: timingPresenceSchema,
});

export const runTelemetrySchema = openObject({
  run_id: z.string().min(1),
  state: z.string().min(1),
  phase: z.string().min(1),
  last_event: lastEvent,
  last_progress_at: nonnegative.optional(),
  timing: timingSchema,
  nodes: z.array(nodeTelemetrySchema),
  providers: z.array(arbitraryRecord).optional(),
  failure: failureSchema.optional(),
  check_rollup: arbitraryRecord.optional(),
  usage: usageSchema,
  timing_quality: timingQualitySchema,
  linkage_quality: linkageQualitySchema,
  timing_presence: timingPresenceSchema,
  sources: z.array(z.string()),
  node_work_ms: openObject({
    agent_model_ms: measuredCount,
    judge_model_ms: measuredCount,
    llmlint_model_ms: measuredCount,
    tool_ms: measuredCount,
    wall_ms: measuredCount,
  }),
  turns: counter,
  lint: counter,
});

/**
 * A read-only provider capacity snapshot, served beside a run list or detail.
 *
 * Every configured identity is present whether or not its probe answered — one that
 * did not carries `availability.state = "unknown"` rather than being dropped, so a
 * client can never mistake an unprobed identity for one that is not configured. The
 * per-identity shape is upstream oneharness's and is deliberately not restated here.
 */
export const providerHealthSchema = openObject({
  schema_version: z.union([z.string(), z.number()]).optional(),
  observed_at: z.string().optional(),
  identities: z.array(arbitraryRecord),
});

/**
 * A run's attribution to its launching session, on both the list row and the detail.
 *
 * It is omitted for a run that recorded no `launch_id`. `session_key` is the opaque,
 * stable, irreversible name of the launching session and is served by default, so a
 * consumer groups runs by the planner that launched them from the list itself —
 * without fetching a single run's transcripts, and without the raw
 * `launcher_session_id`, which appears only when the server is configured to expose
 * it. A run that named no session (a plain shell, or a record predating the key) has
 * no `session_key`.
 */
export const runLaunchSchema = openObject({
  launch_id: z.string().min(1),
  launcher: z.enum(["claude-code", "codex", "unknown"]),
  session_key: z.string().min(1).optional(),
  launcher_session_id: z.string().min(1).optional(),
});

export const runSummarySchema = openObject({
  run_id: z.string().min(1),
  state: z.string().min(1),
  phase: z.string().min(1),
  last_event: lastEvent,
  last_progress_at: nonnegative.optional(),
  timing_quality: timingQualitySchema,
  linkage_quality: linkageQualitySchema,
  timing: timingSchema,
  node_counts: z.record(z.string(), counter),
  launch: runLaunchSchema.optional(),
});

export const runListSchema = openObject({
  api_version: z.literal(2),
  telemetry_schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  observed_at: timestamp,
  runs: z.array(runSummarySchema),
  next_cursor: z.string().min(1).optional(),
  provider_health: providerHealthSchema.optional(),
});

const planStepSchema = openObject({
  id: z.string().min(1),
  kind: z.enum(["agent", "human"]).optional(),
  persona: z.string().min(1).optional(),
  task: z.string().min(1),
  deps: z.array(z.string().min(1)).optional(),
  max_turns: counter.positive().optional(),
  expects_no_diff: z.boolean().optional(),
});
/**
 * Where a preserved workstream is picked back up, as the plan records it for the
 * attempt that continues it. Never a boolean: the field this schema types has always
 * carried the executor's own resume metadata, and typing it `boolean` is what made
 * every replanned run fail whole-detail validation in the browser. The committed
 * `e2e/corpus/legacy-runs` plans are the record of what has actually been written.
 *
 * Only the four fields that locate the work are required. A journal written before
 * a later field existed omits it — `completed_steps` and `pr` are absent from the
 * older recorded documents — so requiring them here would sever exactly the history
 * this contract exists to read.
 *
 * `source_round` is gone rather than optional. It named the round a continuation
 * came from, nothing writes a round any more, and no committed corpus document
 * carries it — and because every object here is a passthrough, a historical plan
 * that does still parses, with the field simply untyped rather than refused.
 */
export const planTaskResumeSchema = openObject({
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  pr_base: z.string().min(1),
  checkpoint: z.string().min(1),
  completed_steps: z.array(z.string()).optional(),
  pr: z.string().nullable().optional(),
  mode: z.enum(["pause", "retry", "continue"]).optional(),
  attempts: counter.optional(),
});
/**
 * One anchor a stacked plan node bases on. A *mapping*, never a bare branch name:
 * that is what an executor has always recorded, so typing it as a bare name would
 * have failed whole-detail validation the same way a replanned run did.
 */
export const stackBaseSchema = openObject({
  branch: z.string().min(1),
  repo: z.string().min(1).optional(),
  identity: z.string().min(1).optional(),
  base_branch: z.string().min(1).optional(),
  pr: z.string().min(1).optional(),
  pr_base: z.string().min(1).optional(),
});
/**
 * One top-level plan node. `task` is optional because one legal node shape has never
 * had it: a lifecycle node that delegates to `steps` carries its prose on each step
 * instead, and so carries no `persona` either. The refinement below holds every other
 * shape to non-empty prose, so an agent or human node that lost its task is still a
 * contract violation rather than a silently blank node view.
 */
export const planTaskSchema = planStepSchema
  .extend({
    task: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    steps: z.array(planStepSchema).min(1).optional(),
    session: z.string().min(1).optional(),
    project_dir: z.string().min(1).optional(),
    base_branch: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    verify_cmd: z.string().min(1).optional(),
    skip_verify: z.boolean().optional(),
    verify_via_ci: z.boolean().optional(),
    merge_policy: z.enum(["auto", "direct", "none"]).optional(),
    workflow: z.enum(["local", "remote"]).optional(),
    repo_type: z.enum(["single-owner", "team"]).optional(),
    execution_checkout: z.string().min(1).optional(),
    stack_bases: z.array(stackBaseSchema).optional(),
    resume: planTaskResumeSchema.optional(),
  })
  .superRefine((task, context) => {
    if (task.steps === undefined && task.task === undefined) {
      context.addIssue({
        code: "custom",
        path: ["task"],
        message: "a plan task without `steps` must carry its own `task` prose",
      });
    }
  });
const artifactPathsSchema = openObject({
  gate_log: z.string().optional(),
  worker_report: z.string().optional(),
  oneharness_session: z.string().optional(),
});
const stepResultSchema = openObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  persona: z.string().nullable(),
  status: z.string().min(1),
  telemetry: arbitraryRecord.optional(),
  artifacts: artifactPathsSchema.optional(),
});
const humanActionSchema = openObject({
  ref: z.string().min(1),
  task: z.string(),
  unblocks: z.array(z.string()),
  unblocks_publication: z.boolean(),
});
const resumeSchema = openObject({
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  pr_base: z.string(),
  checkpoint: z.string().min(1),
  completed_steps: z.array(z.string()),
  pr: z.string().nullable(),
  mode: z.string().optional(),
});
/**
 * The release that carried one node's landed work.
 *
 * `style` alone is optional: an envelope written before that field existed carries
 * none, and a node whose release predates it is still a node whose release a reader
 * opens. The other three are what a release *is* — who published it, what was
 * published, and which version — and the server serves no release at all rather
 * than one missing any of them.
 *
 * `style` and `target` are open strings rather than enums for the reason `kind` on
 * a timeline event is: the vocabulary is `onevcs`'s, that library is released on its
 * own schedule, and a conforming server relaying a target this build has never heard
 * of must not have the whole run detail refused over a field it filled correctly.
 */
export const nodeReleaseSchema = openObject({
  identity: z.string().min(1),
  target: z.string().min(1),
  style: z.string().min(1).optional(),
  version: z.string().min(1),
});
export const graphResultItemSchema = openObject({
  kind: z.string().optional(),
  status: z.string().optional(),
  task: z.string().optional(),
  unblocks: z.array(z.string()).optional(),
  blocked_by: z.array(z.string()).optional(),
  human_actions: z.array(humanActionSchema).optional(),
  completed: z.boolean().optional(),
  exit_code: z.number().int().nullable().optional(),
  verdicts: z.array(z.unknown()).optional(),
  usage: arbitraryRecord.optional(),
  telemetry: arbitraryRecord.optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  base_branch: z.string().optional(),
  pr_base: z.string().optional(),
  synthetic_stack_base: z.string().nullable().optional(),
  stack_bases: z.array(arbitraryRecord).optional(),
  repository_type: z.enum(["single-owner", "team"]).nullable().optional(),
  repo_type: z.enum(["single-owner", "team"]).nullable().optional(),
  publication_workflow: z.enum(["local", "remote"]).nullable().optional(),
  workflow: z.enum(["local", "remote"]).nullable().optional(),
  merge_policy: z.enum(["auto", "direct", "none"]).nullable().optional(),
  outcome: z.string().optional(),
  ok: z.boolean().optional(),
  pr: z.string().nullable().optional(),
  /**
   * Optional *and* nullable, exactly as `pr` beside it is: a payload served before
   * this key existed carries neither, and a node the run recorded no release for is
   * served an absent key rather than an empty object.
   */
  release: nodeReleaseSchema.nullable().optional(),
  detail: z.string().optional(),
  follow_ups: z.string().nullable().optional(),
  steps: z.array(stepResultSchema).optional(),
  waiting_steps: z.array(z.string()).optional(),
  resume: resumeSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  retry_lineage: arbitraryRecord.optional(),
  deferred_cleanup: z.array(z.string()).optional(),
  artifacts: artifactPathsSchema.optional(),
});
export const graphPayloadSchema = openObject({
  ok: z.boolean().optional(),
  state: z.string().optional(),
  started_order: z.array(z.string()).optional(),
  results: z.record(z.string(), graphResultItemSchema).optional(),
  schema_version: counter.optional(),
});
export const nodeStateSchema = z.enum([
  "running",
  "done",
  "failed",
  "waiting",
  "parked",
  "cancelled",
]);
/**
 * The one authoritative per-node status. `src/payload.rs`'s `NODE_STATUSES` maps
 * whatever a run recorded onto exactly this set, and `@onepipeline-ui/dag-layout`
 * renders exactly this set; `model.e2e.test.ts` holds the two in agreement.
 *
 * `nodeStateSchema` above is the strict journal fold and is a subset of this: it can
 * only speak for nodes the journal recorded something about, so `pending`, `blocked`
 * and `skipped` appear only here. A consumer renders from `GraphState.node_status`
 * and never from an absent `node_states` entry — inferring one is how the sidebar and
 * the detail view came to disagree about the same node.
 */
export const nodeStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "blocked",
  "skipped",
  "done",
  "not-completed",
  "failed",
  "parked",
  "cancelled",
  "unknown",
]);
/**
 * Whether the run has a turn it can address for one in-flight node.
 *
 * `addressable`, deliberately not `interruptible`: it is the precondition for
 * delivering a planner's note into a running turn, and it is the whole of what a
 * server can prove. Whether the harness will *take* the redirection is onejudge's
 * `control`, which no published component reports for a turn in flight — so a
 * field named for that answer would promise what nothing can supply.
 *
 * Never absent for a node the run has in flight, because "no answer" and "cannot"
 * read the same to a planner and only one of them is true. `reason` is present
 * exactly when `addressable` is false. `member` is the graph member whose turn the
 * run would address.
 */
export const nodeControlSchema = openObject({
  addressable: z.boolean(),
  member: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
}).superRefine((control, context) => {
  if (control.addressable === (control.reason !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "a reason is carried exactly when there is no turn to address",
    });
  }
});

/**
 * One decision point holding a subtree of dependents back.
 *
 * The only thing that pauses anything in a continuous engine, and it pauses only
 * what depends on it — a ready human action nobody has attested, or a blocking
 * surface nobody has answered. Independent branches keep running beside it, so a
 * run carrying one of these is *waiting on a person*, never stalled.
 */
export const decisionSchema = openObject({
  id: z.string().min(1),
  kind: z.string(),
  unblocks: z.array(z.string().min(1)),
});

/**
 * The run's whole graph state, as one object.
 *
 * There is exactly one of these per run. Under telemetry schema 12 this was one
 * entry of a `rounds` array and carried the round it described; execution is
 * continuous, so the graph a run is converging toward is one graph, with every
 * committed live edit applied to it.
 */
export const graphStateSchema = openObject({
  run_id: z.string().min(1),
  plan: openObject({
    tasks: z.array(planTaskSchema),
    schema_version: counter.optional(),
    concurrency: counter.positive().optional(),
    name: z.string().min(1).optional(),
    goal: openObject({
      id: z.string().min(1),
      text: z.string().min(1),
    }).optional(),
  }),
  node_states: z.record(z.string(), nodeStateSchema),
  /** One entry per plan task, so a client never invents a status for a node. */
  node_status: z.record(z.string(), nodeStatusSchema),
  /**
   * The plan node ids gating each `blocked` or `skipped` node, in plan order; every
   * other node is absent. Not `GraphResultItem.blocked_by`, which names human action
   * refs on a settled result.
   */
  node_gated_by: z.record(z.string(), z.array(z.string().min(1))),
  /**
   * One entry for every node in flight, and for no other: a node with no turn has
   * nothing to redirect.
   */
  node_control: z.record(z.string(), nodeControlSchema),
  node_results: z.record(z.string(), graphResultItemSchema),
  /** Every decision point currently holding a subtree back; empty when none is. */
  decisions: z.array(decisionSchema),
  attestations: z.array(z.string()),
  result: graphPayloadSchema.nullable(),
  last_seq: counter,
}).superRefine((graph, context) => {
  const taskIds = new Set(graph.plan.tasks.map((task) => task.id));
  const statusIds = new Set(Object.keys(graph.node_status));
  if (
    taskIds.size !== graph.plan.tasks.length ||
    taskIds.size !== statusIds.size ||
    [...taskIds].some((taskId) => !statusIds.has(taskId))
  ) {
    context.addIssue({
      code: "custom",
      path: ["node_status"],
      message: "must contain exactly one entry for every plan task",
    });
  }
  const invalidGate = Object.entries(graph.node_gated_by).find(
    ([nodeId, blockers]) =>
      !taskIds.has(nodeId) || blockers.some((blocker) => !taskIds.has(blocker)),
  );
  if (invalidGate) {
    context.addIssue({
      code: "custom",
      path: ["node_gated_by"],
      message: "must name only nodes in this graph's plan",
    });
  }
  // A subset rather than an equality, which is the whole of what can be required
  // here: a run whose driver died with a node still recorded `running` has nothing
  // in flight to report, and this repository's own server serves exactly that — an
  // empty `node_control` beside a `running` status. Demanding an entry would refuse
  // the payload of every run that ended that way.
  // llmlint: ignore[boundary_inputs_validated] the missing direction is not a validation this contract can state: `node_status` is what the run *recorded* and `node_control` is what is *in flight now*, and a run whose driver died has the first without the second. `src/payload.rs`'s `graph_state` is where the two are decided together, and `tests/e2e/server.rs` holds it to serving one entry per running node and none for a node with no turn.
  const invalidControl = Object.keys(graph.node_control).find(
    (nodeId) => graph.node_status[nodeId] !== "running",
  );
  if (invalidControl !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["node_control"],
      message: "must name only nodes the run has in flight",
    });
  }
});

export const conversationUsageSchema = openObject({
  cacheReadTokens: usageValue.optional(),
  cacheWriteTokens: usageValue.optional(),
  costUsd: usageValue.optional(),
  inputTokens: usageValue.optional(),
  outputTokens: usageValue.optional(),
});
export const conversationToolEventSchema = openObject({
  index: counter,
  input: z.unknown().optional(),
  kind: z.string(),
  name: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
});
/**
 * `timestamp` is when the record was *written*, which is when the turn finished.
 * The five optional timing fields are the turn's own measurements, present exactly
 * when the history record carried them: a harness that measures no wall interval
 * records `startedAt`/`finishedAt` as null and only a `durationMs`.
 */
export const conversationTurnSchema = openObject({
  assistant: z.string().nullable(),
  durationMs: usageValue.optional(),
  failureKind: z.string().nullable(),
  finishedAt: timestamp.nullable().optional(),
  harness: z.string(),
  id: z.string(),
  model: z.string().nullable(),
  modelMs: usageValue.optional(),
  reasoning: z.string().nullable(),
  startedAt: timestamp.nullable().optional(),
  status: z.string(),
  timestamp,
  toolMs: usageValue.optional(),
  tools: z.array(conversationToolEventSchema),
  unknown: arbitraryRecord,
  usage: conversationUsageSchema,
  user: z.string(),
});
export const conversationSchema = openObject({
  canContinue: z.boolean(),
  harnesses: z.array(z.string()),
  id: z.string().min(1),
  name: z.string(),
  project: z.string(),
  startedAt: timestamp,
  state: z.string(),
  turns: z.array(conversationTurnSchema),
});
export const dagConversationSchema = openObject({
  conversation: conversationSchema,
  attribution: openObject({
    runId: z.string().optional(),
    nodeId: z.string().optional(),
    stepId: z.string().optional(),
    launchId: z.string().optional(),
    launcher: z.enum(["claude-code", "codex", "unknown"]).optional(),
    transportRole: transportRoleSchema,
    agentRole: agentRoleSchema,
    parentConversationId: z.string().optional(),
    persona: z.string().optional(),
    finishedAt: timestamp.nullable().optional(),
    inferred: z.literal(true).optional(),
    timing: timingSchema.optional(),
  }),
});
export const nodeConversationsSchema = openObject({
  node: z.string().optional(),
  conversations: z.array(dagConversationSchema),
});

/**
 * `RunDetail.conversations`, accepting both recorded shapes and yielding one.
 *
 * `docs/contract.md` fixes the served shape as a flat `DagConversation[]`, and
 * that is what `src/payload.rs::conversations` returns — each transcript carries its own
 * `attribution.nodeId`, so a consumer that wants them per node groups by it. Payloads
 * that group transcripts under `nodeConversationsSchema` entries stay valid and are
 * flattened into the same list, so a producer or recorded fixture written against
 * that shape keeps parsing.
 */
export const runConversationsSchema = z.union([
  z.array(dagConversationSchema),
  z
    .array(nodeConversationsSchema)
    .transform((groups) => groups.flatMap((group) => group.conversations)),
]);

const verificationCheckSchema = openObject({
  name: z.string(),
  state: z.string(),
  required: z.boolean(),
  url: z.string().url().optional(),
});
const verificationRecordSchema = openObject({
  ok: z.boolean(),
  output_tail: z.string(),
  artifact_id: z.string().min(1).optional(),
});
export const nodeDetailSchema = openObject({
  verification: openObject({
    pre_push_hook: z.boolean().optional(),
    required_checks: z.array(z.string()).optional(),
    required_checks_status: z.string().optional(),
    expected_gate: z.array(z.string()).optional(),
    checks: z.array(verificationCheckSchema).optional(),
    records: z.array(verificationRecordSchema),
  }),
  publication: openObject({
    pr_url: z.string().url().optional(),
    branch: z.string().optional(),
    branch_url: z.string().url().optional(),
    merged: z.boolean(),
    base_branch: z.string().optional(),
    commit: z.string().optional(),
    commit_url: z.string().url().optional(),
  }).optional(),
});
export const runDetailSchema = openObject({
  api_version: z.literal(2),
  telemetry_schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  observed_at: timestamp,
  run: runTelemetrySchema,
  graph: graphStateSchema.nullable(),
  conversations: runConversationsSchema,
  node_details: z.record(z.string(), nodeDetailSchema).optional().default({}),
  launch: runLaunchSchema.optional(),
  provider_health: providerHealthSchema.optional(),
});

export const timelineReferenceKindSchema = z.enum([
  "conversation",
  "gate_log",
  "worker_report",
  "oneharness_session",
  "pr",
]);
export const timelineSpanKindSchema = z.enum([
  "run",
  "node",
  "step",
  "dispatch",
  "verification",
  "publication",
  "pr-drafting",
  "conflict-resolution",
  "human-wait",
  "rollup",
]);
/**
 * Which part of its loop the launched orchestrator is in. Derived by the server from
 * what the run itself recorded — never asserted by the agent, which cannot report that
 * it has stopped talking.
 */
export const supervisoryPhaseSchema = z.enum([
  "starting",
  "dispatching",
  "deciding",
  "surfacing",
  "waiting",
  "settled",
  "finished",
]);
/**
 * Where one timeline item's heavy content lives. The payload never inlines a
 * transcript, a gate log, or a report body, so a consumer fetches only what it opens.
 */
export const timelineReferenceSchema = openObject({
  kind: timelineReferenceKindSchema,
  value: z.string().min(1),
});
/**
 * The moment a planner redirected a node, as the two records that describe it agree.
 *
 * `delivered` is the one field both fill and the one a reader of a turn that changed
 * behaviour is asking: did the note reach the turn that was already running.
 * `oneagentgraph`'s `turn-interrupted` adds the member it addressed, the bytes it
 * offered, and — exactly when the turn did not take them — why; `onepipeline`'s
 * `edit-committed` adds `delivery`, its own word for where the note ended up, and the
 * node it was for. `reason` is never carried beside a delivered redirection, so one
 * can never be read as having had a reason it failed.
 */
export const redirectionSchema = openObject({
  delivered: z.boolean(),
  delivery: z.enum(["live", "deferred"]).optional(),
  member: z.string().min(1).optional(),
  input_bytes: counter.optional(),
  reason: z.string().min(1).optional(),
  node_id: z.string().min(1).optional(),
}).superRefine((redirection, context) => {
  if (redirection.delivered && redirection.reason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "a delivered redirection carries no reason it did not land",
    });
  }
  // The two fields are one fact read by the two producers that record it, so a
  // payload where they disagree is not a redirection this client can render: it
  // would have to choose which half to believe, and either choice is a lie about
  // where the planner's note went.
  if (
    redirection.delivery !== undefined &&
    redirection.delivered !== (redirection.delivery === "live")
  ) {
    context.addIssue({
      code: "custom",
      path: ["delivery"],
      message:
        "`delivery` is `live` exactly when the running turn took the note",
    });
  }
});

/**
 * `kind` is an open string on purpose: it is the journal event kind that produced
 * the item, or `conversation-turn` for a turn, and the journal owns that vocabulary.
 *
 * `redirection` appears only on the records that are one — a `turn-interrupted`, or
 * an `edit-committed` that added context to a node — and is deliberately not *keyed*
 * on those two names here, for the same reason `kind` is open at all.
 */
/**
 * One thing a node is being held on, from a `release-wait` record.
 *
 * `action` is what somebody has to go and do, and it is carried on **human-step**
 * entries and no others — which is what lets a client draw the waits that need a
 * person told apart from the waits that will clear themselves. `last_answer` is the
 * producer's own word for what the last look found: `not-released`,
 * `awaiting-human-step`, `not-answered` or `not-landed`.
 *
 * Only `dep` is required, because only `dep` says *what* is being waited on; every
 * other field is one the producer fills where it has it, and a server that filled
 * fewer of them has told a reader less rather than told them something wrong.
 */
export const releaseAwaitedSchema = openObject({
  dep: z.string().min(1),
  identity: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  since: timestamp.optional(),
  waited_seconds: counter.optional(),
  last_answer: z.string().min(1).optional(),
});
/**
 * What one release record said about itself, under one shape for all six kinds.
 *
 * The six are two producers' halves of one sequencing — `onepipeline` records a node
 * being held, the release arriving and the versions being adopted; `onevcs` records
 * the probe, the acknowledgement and the observation — and a reader meets them in
 * one timeline, so they are served as one object rather than six. Every field is
 * optional and each is present exactly when the record carried it, on the discipline
 * `redirection` above already keeps: the two producers know different halves, and a
 * field defaulted here would be this client inventing what no record said.
 */
export const timelineReleaseSchema = openObject({
  identity: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  landing_commit: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  superseded: z.boolean().optional(),
  form: z.string().min(1).optional(),
  outcome: z.string().min(1).optional(),
  elapsed_ms: counter.optional(),
  dep: z.string().min(1).optional(),
  delivery: z.string().min(1).optional(),
  awaiting: z.array(releaseAwaitedSchema).min(1).optional(),
  versions: z
    .array(
      openObject({
        identity: z.string().min(1),
        target: z.string().min(1),
        version: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
}).superRefine((release, context) => {
  // A release that says nothing is not a release record: the server serves no
  // `release` at all for a record that carried none of these, because an empty
  // object would reach a reader as a release nobody could name — a heading over
  // a blank panel. So an empty one is a payload this client cannot render rather
  // than one it renders as nothing.
  if (Object.values(release).every((fact) => fact === undefined)) {
    context.addIssue({
      code: "custom",
      message: "a release record carries at least one recorded fact",
    });
  }
});
// llmlint: ignore[boundary_inputs_validated] the pairing of `redirection` with a `kind` is not a constraint this parser may enforce: `kind` is the journal event kind and the journal owns that vocabulary, so a conforming server relaying another producer's interrupt record under a name this build has never seen would have its whole timeline refused over a field it filled correctly. What `redirection` itself carries is fully validated above, which is the part this contract does own.
export const timelineEventSchema = openObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  at: timestamp,
  node_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  /**
   * Who submitted an accepted live edit, on an `edit-committed`. The run enforces
   * a per-author op allowlist — a planner may issue every op and a monitor a
   * narrower set — so an observer's self-applied fix and the planner's own
   * decision are two different facts about the same graph.
   */
  author: z.string().min(1).optional(),
  redirection: redirectionSchema.optional(),
  /**
   * The release facts a record carried, on the six kinds that carry any and on no
   * other. Not *keyed* on those six names here, for the same reason `redirection`
   * is not keyed on its two: `kind` is the journal event kind and the journal owns
   * that vocabulary.
   */
  // llmlint: ignore[boundary_inputs_validated] the pairing of `release` with a `kind` is the same constraint this parser may not enforce as the `redirection` pairing above, and for the same reason: the six release kinds are `onevcs`'s and `onepipeline`'s, both released on their own schedules, so a conforming server relaying a seventh release record — or relaying one of these six under a name this build has never seen — would have its whole timeline refused over a field it filled correctly. What `release` itself carries is fully validated above, down to refusing one that carries nothing, and that is the part this contract owns.
  release: timelineReleaseSchema.optional(),
  reference: timelineReferenceSchema.optional(),
});
/**
 * One discrete wait a `rollup` span absorbed, so a client can draw the stalls a run
 * actually took instead of one bar across the whole contention window.
 */
export const timelineIntervalSchema = openObject({
  started_at: timestamp,
  ended_at: timestamp,
});
/**
 * One interval of recorded work. `ended_at` is null for work the recorded stream
 * never closed — an in-flight run, not an error — and `parent_id` links spans into
 * the tree the recorded nesting implies. `count`, `total_duration_ms` and
 * `intervals` appear only on a `rollup` span, which stands in for thousands of
 * high-frequency records, and `dispatch_id` — the key that groups the several
 * oneharness sessions of one onejudge dispatch — only on a `dispatch` one. The role
 * pair appears on a dispatch and on a `scope=run` rollup of dispatches, which carries
 * the pair every session it summarizes shares: that pair, not either half of it, is
 * the category such a rollup stands for.
 */
export const timelineSpanSchema = openObject({
  id: z.string().min(1),
  kind: timelineSpanKindSchema,
  label: z.string(),
  started_at: timestamp,
  ended_at: timestamp.nullable(),
  events: z.array(timelineEventSchema),
  parent_id: z.string().min(1).optional(),
  node_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  count: counter.optional(),
  total_duration_ms: counter.optional(),
  intervals: z.array(timelineIntervalSchema).optional(),
  agent_role: agentRoleSchema.optional(),
  transport_role: transportRoleSchema.optional(),
  dispatch_id: z.string().min(1).optional(),
  reference: timelineReferenceSchema.optional(),
  detail: openObject({
    ok: z.boolean().optional(),
    output_tail: z.string().optional(),
    artifact_id: z.string().optional(),
  }).optional(),
  phase: supervisoryPhaseSchema.optional(),
});
export const artifactContentSchema = openObject({
  id: z.string().min(1),
  kind: timelineReferenceKindSchema,
  content: z.string(),
  truncated: z.boolean(),
});
/**
 * The timeline envelope, which carries a version of its own beside the API's.
 *
 * `api_version` says which API this is; `timeline_schema_version` says which *meaning*
 * of the payload under it this is, and moves on its own. Version 1 was the unversioned
 * shape, where the role pair appeared only on a `dispatch` span — so a client could
 * read "carries roles" as "is a dispatch". Version 2 served that pair on a `scope=run`
 * rollup too, naming the category it summarizes, and that inference no longer held.
 * Version 3 serves a rollup that is not a dispatch at all: one carrying no roles,
 * standing for the waits a publication spent blocked on a lock and named by the kind
 * it summarizes, so a client reads the label rather than assuming the kind.
 * Pinned as a literal so a payload from a server on another meaning is refused here
 * rather than rendered as though it agreed.
 */
export const runTimelineSchema = openObject({
  api_version: z.literal(2),
  timeline_schema_version: z.literal(TIMELINE_SCHEMA_VERSION),
  observed_at: timestamp,
  run_id: z.string().min(1),
  spans: z.array(timelineSpanSchema),
});

export const apiErrorSchema = openObject({
  error: openObject({ code: z.string(), message: z.string() }),
});

export const launchProvenanceSchema = openObject({
  schema_version: z.literal(1),
  launch_id: z.string().min(1),
  launcher: z.enum(["claude-code", "codex"]),
  launcher_session_id: z.string().min(1),
  started_at: timestamp,
  repository_identity: z.string().min(1),
});

export const sseEventNameSchema = z.enum([
  "snapshot",
  "run.changed",
  "conversation.changed",
  "activity.changed",
  "run.removed",
]);
export const sseEventDataSchema = arbitraryRecord;

export interface LiveActivity {
  node: string;
  step?: string;
  at: number;
  kind: string;
  name: string;
  detail: string;
  events: number;
}
export const liveActivitySchema: z.ZodType<LiveActivity> = z.object({
  node: z.string().min(1),
  step: z.string().min(1).optional(),
  at: z.number().finite(),
  kind: z.string(),
  name: z.string(),
  detail: z.string(),
  events: z.number().int().nonnegative(),
});
export const liveActivityListSchema = z.array(liveActivitySchema);

export type Timing = z.infer<typeof timingSchema>;
export type FailureClass = z.infer<typeof failureClassSchema>;
export type Failure = z.infer<typeof failureSchema>;
export type NodeState = z.infer<typeof nodeStateSchema>;
export type NodeStatus = z.infer<typeof nodeStatusSchema>;
/**
 * The two closed role vocabularies a dispatch is served with. Exported so a consumer
 * can key a table on them rather than restating their members as strings — which is
 * what makes a role added here fail to compile there instead of falling through.
 */
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type TransportRole = z.infer<typeof transportRoleSchema>;
export type UsageParty = z.infer<typeof usagePartySchema>;
export type Usage = z.infer<typeof usageSchema>;
export type SessionLink = z.infer<typeof sessionLinkSchema>;
export type NodeTelemetry = z.infer<typeof nodeTelemetrySchema>;
export type RunTelemetry = z.infer<typeof runTelemetrySchema>;
export type RunLaunch = z.infer<typeof runLaunchSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunList = z.infer<typeof runListSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
export type GraphResultItem = z.infer<typeof graphResultItemSchema>;
export type GraphPayload = z.infer<typeof graphPayloadSchema>;
export type GraphState = z.infer<typeof graphStateSchema>;
/** One decision point holding a subtree of dependents back. */
export type Decision = z.infer<typeof decisionSchema>;
/** Whether the run has a turn it can address for one in-flight node. */
export type NodeControl = z.infer<typeof nodeControlSchema>;
/** The moment a planner redirected a node's running turn. */
export type Redirection = z.infer<typeof redirectionSchema>;
/** The release that carried one node's landed work. */
export type NodeRelease = z.infer<typeof nodeReleaseSchema>;
/** One thing a node is being held on until a release is out. */
export type ReleaseAwaited = z.infer<typeof releaseAwaitedSchema>;
/** What one release record said about itself. */
export type TimelineRelease = z.infer<typeof timelineReleaseSchema>;
export type DagConversation = z.infer<typeof dagConversationSchema>;
export type NodeConversations = z.infer<typeof nodeConversationsSchema>;
export type RunConversations = z.infer<typeof runConversationsSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type NodeDetail = z.infer<typeof nodeDetailSchema>;
export type ArtifactContent = z.infer<typeof artifactContentSchema>;
export type TimelineReferenceKind = z.infer<typeof timelineReferenceKindSchema>;
export type TimelineSpanKind = z.infer<typeof timelineSpanKindSchema>;
export type SupervisoryPhase = z.infer<typeof supervisoryPhaseSchema>;
export type TimelineReference = z.infer<typeof timelineReferenceSchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type TimelineInterval = z.infer<typeof timelineIntervalSchema>;
export type TimelineSpan = z.infer<typeof timelineSpanSchema>;
export type RunTimeline = z.infer<typeof runTimelineSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type LaunchProvenance = z.infer<typeof launchProvenanceSchema>;
export type SseEventName = z.infer<typeof sseEventNameSchema>;
/**
 * A built-in filter profile. Deliberately not the type of the `filter` query — a
 * run's launch config may define names this client has never heard of, and those
 * are passed through as the strings they are.
 */
export type FilterProfile =
  (typeof API_V2_FILTER_PROFILES)[keyof typeof API_V2_FILTER_PROFILES];

export const parseRunList = (value: unknown): RunList =>
  runListSchema.parse(value);
export const parseRunDetail = (value: unknown): RunDetail =>
  runDetailSchema.parse(value);
export const parseRunTimeline = (value: unknown): RunTimeline =>
  runTimelineSchema.parse(value);
