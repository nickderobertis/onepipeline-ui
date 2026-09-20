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
  /**
   * The post-launch verbs, wrapped: every route below `events` is a thin call
   * into `onepipeline::verbs`, one row of the contract's verb table each. A run
   * is reached by these once a plan is running — launching one and driving its
   * planning stage are outside this API, so no path here starts anything.
   */
  projects: "/api/v2/projects",
  /**
   * One project's group. The id is `<source>:<native>` and is **path-encoded on
   * the wire** — `local-md%3Aproject` — which `encodeURIComponent` spells for it,
   * so the route reads the id back through its own parser rather than splitting
   * a path segment on the colon.
   */
  project: (projectId: string) =>
    `/api/v2/projects/${encodeURIComponent(projectId)}`,
  channel: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/channel`,
  channelNext: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/channel/next`,
  channelReply: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/channel/reply`,
  channelSurface: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/channel/surface`,
  attest: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/attest`,
  stop: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/stop`,
  adopt: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/adopt`,
  watch: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/watch`,
  unwatched: "/api/v2/unwatched",
  host: "/api/v2/host",
  status: (runId: string) => `/api/v2/runs/${encodeURIComponent(runId)}/status`,
  results: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/results`,
  goals: "/api/v2/goals",
  runGoals: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/goals`,
  transcript: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/transcript`,
  telemetry: (runId: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/telemetry`,
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
   * Which runs the run-list route answers about, by name: a comma-separated list
   * of run ids. It answers the same rows in the same order, names the ones it
   * could not find in `missing`, and returns no cursor — so it is how one row is
   * refreshed for one invalidation rather than by refetching the first page.
   *
   * It is a selection *instead of* a page, so the server refuses it beside
   * `include_settled`, `limit` or `cursor`; nothing here may send both.
   */
  select: "select",
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
  /**
   * The question a reply's verdict answers, on `POST .../channel/reply`. Parsed by
   * the bus's own correlation parser server-side and refused as
   * `422 invalid_correlation` where it is not one, so nothing here shapes it.
   */
  correlation: "correlation",
  /**
   * What ends a watch, beside the run finishing and nothing driving it: the CLI's
   * own conditions — `settled`, `surface`, `nothing-driving`, `node-settled`,
   * `node=<ID>` — repeatable, defaulting to `surface`.
   */
  until: "until",
  /** How long a watch waits: whole seconds, `0` to read once, `none` to never give up. */
  timeout: "timeout",
  /** The heartbeat interval of a watch in whole seconds, `0` to turn it off. */
  tick: "tick",
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
 * back and was cleared. `detailed` is detailed activity: the whole merged stream,
 * all three sources, which is what an observer of a run reads. Both are the
 * engine's own shipped names — it named the second `monitor` until it stopped
 * naming an observer member at all, and ships no alias — so a run launched with
 * a profile called `monitor` serves it as that launch's own, passed through like
 * any other launch-defined name.
 */
export const API_V2_FILTER_PROFILES = {
  planner: "planner",
  detailed: "detailed",
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
 *
 * `15` is what the run list stops hiding. The payload gains two optional
 * companions to `runs` and `next_cursor` — `unreadable`, one entry per run root
 * the server refused with that root's path and its own reason, and `missing`,
 * the run ids a named `?select=` asked about and did not find — and both are
 * absent rather than empty when there is nothing to report. Every field `14`
 * served is served with the same meaning, so nothing rendered here changes; the
 * literal moves because a client that has never seen `unreadable` is one reading
 * a run list that may be shorter than the host it is about.
 *
 * `16` is what each judge of a stacked panel decided. A conversation turn a panel
 * judged gains `judges`, one `{judge, kind, decision, reason}` per judge in the
 * panel's order, and absent rather than empty on a turn nothing decided on. Every
 * field `15` served is served with the same meaning; the literal moves because a
 * client that has never seen `judges` shows a panel's dispatch as though no judge
 * had said anything about any of its turns.
 *
 * `17` opens the `agent_role` vocabulary. Under `16` a session's `agent_role` — on
 * a run's session links and on a conversation's attribution — was one of five
 * words the server kept, and a member a run recorded under any other name was
 * mapped onto one of them or dropped. Under `17` it is the member name the run
 * recorded for the session, served where the run's own recorded graph
 * declarations name that member, and held only to `oneagentgraph`'s member-name
 * grammar; a conversation's `attribution.agentRole` is optional, because a session
 * the run recorded no declared member for carries none. The literal moves because
 * a client that switched on the closed vocabulary exhaustively misreads an open
 * one.
 *
 * `18` is what a run-list row says about where a run belongs and whether
 * anything is waiting on it. Four additive fields on every row: `project`, the
 * qualified project id the run was launched with, absent where its summary
 * recorded none; `project_name`, the plan's name as recorded, absent where none
 * was; `liveness`, the server's own word for how the run is being driven —
 * `ACTIVE`, `DRIVER DEAD`, `PARKED` or `UNDRIVEN`, the reading `onepipeline
 * runs` prints; and `unread_surfaces`, the surfaces the run raised that nobody
 * has read, counted off its channel. Every field `17` served is served with the
 * same meaning; the literal moves because a client that has never seen
 * `liveness` shows a run holding an unanswered question as one nothing is
 * happening to, and one that has never seen `project` cannot group the list the
 * way the CLI does. A `run.changed` frame names the `project` of the run that
 * moved beside its `run_id`, on the same terms.
 */
export const TELEMETRY_SCHEMA_VERSION = 18;

/**
 * The timeline payload's own version, which moves independently.
 *
 * `3` is where a `rollup` span stopped implying a dispatch: one may now carry no
 * roles and stand for the waits a publication spent blocked on a lock, named by
 * the kind it summarizes.
 *
 * `10` is where a span's `agent_role` became the member name the run's own graphs
 * declared, as telemetry `17` is for the same field elsewhere. A server on `9`
 * serves one of five words it keeps and the observer's `monitor` member as
 * `orchestrator`; a server on `10` serves the run's own word for every session
 * whose member a graph of that run declared, and no word at all for one none
 * did. The lanes a reader sees are therefore the run's members under the run's
 * names, one per distinct role a payload serves, in the order it serves them;
 * the `run` span the engine's own driving is drawn under keeps its kind.
 *
 * `7` is where an event began carrying the release it was about. A server on `6`
 * serves the six release kinds as a kind and a stamp alone, so a node held on a
 * machine and a node held on a **person** draw as the same row with the same word
 * on it — and the reader with something to go and do cannot tell that they have it.
 *
 * `9` is where an event began carrying what a surface said. A server on `8`
 * serves a `planner-surface-queued` and a `planner-surfaced` as a kind and a stamp
 * alone, so a reader sees that something was raised to somebody and not what was
 * asked, by whom, or whether anything waited on the answer. The surface's `kind`
 * and `source` are open words: a host defines its own kinds and its own channel
 * authors, and the engine relays both as recorded.
 *
 * `8` is where a ready node says what it was waiting for. A server on `7` serves
 * the interval between a node becoming ready and its dispatch as empty space,
 * which reads as the harness having done nothing — when the node was queued behind
 * the operator's own other work. No `queued` span and no `reasons` array exist
 * under `7`, so a reader on `8` meeting a run recorded then sees the same gap it
 * always showed rather than an invented span.
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
export const TIMELINE_SCHEMA_VERSION = 10;

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
 * span. `transportRole` is the party oneharness recorded, and it is closed — a
 * dispatch has an agent side, a judge side and a lint side and no other.
 * `agentRole` is the member name the run recorded for the session, served where a
 * graph of that run declared it, and it is **open**: the words are the run's own,
 * and the one thing held here is `oneagentgraph`'s grammar for a member's name —
 * `config::is_member_name`, as `MemberName::parse` states it — because a member's
 * name is a path component in that library's run directory. Letters, digits,
 * hyphens and underscores, and at least one of them; not the empty string, not a
 * separator, not whitespace, not `..`.
 */
export const MEMBER_NAME = /^[A-Za-z0-9_-]+$/;
export const agentRoleSchema = z
  .string()
  .regex(
    MEMBER_NAME,
    "a member name: letters, digits, hyphens and underscores",
  );
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

/**
 * The server's word for how a run is being driven, on the list row under schema 18.
 *
 * Open rather than a closed enum, on the terms `state` is: the vocabulary is the
 * engine's — `ACTIVE`, `DRIVER DEAD`, `PARKED`, `UNDRIVEN` today — and a word a
 * later engine adds has to reach a reader as itself rather than fail the whole
 * list. Served whether or not the run has settled; `state` folds the settled case.
 */
export const runLivenessSchema = z.string().min(1);

/**
 * The liveness words under which nothing is driving the run — the two the
 * engine's own `adopt` will take over. `ACTIVE` is a driver holding the run and
 * `PARKED` a live driver that has gone quiet, and neither is one an adoption may
 * displace; a client offering one there is offering the engine's refusal.
 */
export const RUN_LIVENESS_NOTHING_DRIVING: readonly string[] = [
  "DRIVER DEAD",
  "UNDRIVEN",
];

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
  /**
   * The qualified onetaskgraph project id the run was launched with — the group
   * `GET /api/v2/projects` lists it under — absent for a run whose summary
   * recorded none, which the server lists under the `(no project)` group.
   */
  project: z.string().min(1).optional(),
  /** The plan's name as the run recorded it, absent where none was. */
  project_name: z.string().min(1).optional(),
  /** How the run is being driven, in the engine's own word. */
  liveness: runLivenessSchema.optional(),
  /** How many surfaces the run has raised that nobody has read. */
  unread_surfaces: counter.optional(),
});

/**
 * A run root the server refused, as it reported it.
 *
 * `reason` is the *reader's* own wording and is rendered rather than
 * reinterpreted: the server states, once, why it would not serve that directory,
 * and a second wording here would be a second thing to keep true. What a reader
 * needs from it is that the directory exists and is not on the list — because a
 * run root silently dropped is indistinguishable from a host with nothing
 * running, which is how a third of a host's runs once went missing unnoticed.
 */
export const unreadableRunRootSchema = openObject({
  path: z.string().min(1),
  reason: z.string().min(1),
});
export type UnreadableRunRoot = z.infer<typeof unreadableRunRootSchema>;

export const runListSchema = openObject({
  api_version: z.literal(2),
  telemetry_schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  observed_at: timestamp,
  runs: z.array(runSummarySchema),
  next_cursor: z.string().min(1).optional(),
  /**
   * The run roots the server could not read, absent when it refused none.
   *
   * Optional because it is additive at schema 15 and because absent is the
   * ordinary answer — a list with no `unreadable` is a list of everything the
   * host holds.
   */
  unreadable: z.array(unreadableRunRootSchema).optional(),
  /**
   * The run ids a `?select=` named and the server did not find, absent when it
   * found them all.
   *
   * Only ever present on the answer to a selection: a run that went away between
   * the invalidation naming it and the refetch asking for it is a normal race,
   * and a caller that asked about a run by name has to be told it is gone rather
   * than handed a shorter list to diff.
   */
  missing: z.array(z.string().min(1)).optional(),
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
 * What one judge of a stacked panel decided on the turn it is served on: its label
 * within the panel, its provider kind, the decision in onejudge's own spelling, and
 * its own reason. Words rather than enums, because every one of them is a
 * producer's vocabulary released on its own schedule.
 */
export const conversationJudgeDecisionSchema = openObject({
  judge: z.string(),
  kind: z.string(),
  decision: z.string(),
  reason: z.string(),
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
  /** Each judge's decision on this turn; absent on a turn no judge decided on. */
  judges: z.array(conversationJudgeDecisionSchema).optional(),
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
    // Absent for a session the run recorded no declared member for, which is
    // what a session under a persona no graph declared is.
    agentRole: agentRoleSchema.optional(),
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
  "queued",
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
 * node it was for — and, where the engine recorded which party of the running
 * conversation took the note, `reached`, whose one word for nobody is `carried`.
 * `reason` is never carried beside a delivered redirection, so one can never be
 * read as having had a reason it failed.
 */
export const redirectionSchema = openObject({
  delivered: z.boolean(),
  delivery: z.enum(["live", "deferred"]).optional(),
  reached: z
    .enum(["queued", "worker", "supervisor", "judged-with", "carried"])
    .optional(),
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
 * What one surface record said about the surface, on a `planner-surface-queued`
 * and on the `planner-surfaced` that consumed it.
 *
 * `kind` is an **open** word on the terms `timelineEventSchema.kind` is: the engine
 * declares and acts on `check-in` and `finding`, raises `edit-applied` of its own
 * when an author other than the planner applies an edit, and relays every other
 * well-formed kind a host defines unchanged — so a kind this build has never seen
 * is a surface a host raised, not a payload to refuse. `source` is the author that
 * raised it, in the word the run's bus configuration declared for it, and open for
 * the same reason. Every field is present exactly where the record carried it, on
 * the discipline `redirection` and `release` keep.
 */
export const timelineSurfaceSchema = openObject({
  kind: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  blocking: z.boolean().optional(),
}).superRefine((surface, context) => {
  // A surface that says nothing is not a surface record: the server serves no
  // `surface` at all for a record that carried none of these, so an empty one is
  // a payload this client cannot render rather than one it renders as nothing.
  if (Object.values(surface).every((fact) => fact === undefined)) {
    context.addIssue({
      code: "custom",
      message: "a surface record carries at least one recorded fact",
    });
  }
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
/**
 * `kind` is an open string on purpose: it is the journal event kind that produced
 * the item, or `conversation-turn` for a turn, and the journal owns that vocabulary.
 *
 * `redirection` appears only on the records that are one — a `turn-interrupted`, or
 * an `edit-committed` that added context to a node — and is deliberately not *keyed*
 * on those two names here, for the same reason `kind` is open at all.
 */
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
  /**
   * What a surface said, on the two kinds that raise and consume one and on no
   * other. Not *keyed* on those two names here, for the reason `release` is not
   * keyed on its six: `kind` is the journal event kind and the journal owns it.
   */
  // llmlint: ignore[boundary_inputs_validated] the pairing of `surface` with a `kind` is the same constraint this parser may not enforce as the `release` pairing above, and for the same reason: the surface kinds are `onepipeline`'s, released on its own schedule, so a conforming server relaying one of them under a name this build has never seen would have its whole timeline refused over a field it filled correctly. What `surface` itself carries is validated above, down to refusing one that carries nothing.
  surface: timelineSurfaceSchema.optional(),
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
 * One reason the loop was not running a node it had not settled, off a `queued` span.
 *
 * `kind` is an **open** string on the terms `timelineEventSchema.kind` is: the
 * vocabulary is `onepipeline`'s, released on its own schedule, so a reason a later
 * engine writes has to reach a reader as its own distinct reason — refusing it would
 * turn a node held by two things into a timeline this client will not render at all.
 * The four that engine writes today are `dependencies` (`blocking`), `concurrency`
 * (`ahead`, `limit`), `decision` (`reference`) and `release` (`awaiting`); every
 * field beside `kind` is present exactly where the record carried it, because a
 * field defaulted here would be this client inventing what no record said.
 */
export const timelineHoldReasonSchema = openObject({
  kind: z.string().min(1),
  blocking: z.array(z.string().min(1)).min(1).optional(),
  ahead: z.array(z.string().min(1)).min(1).optional(),
  limit: counter.optional(),
  reference: z.string().min(1).optional(),
  awaiting: z.array(z.string().min(1)).min(1).optional(),
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
  /**
   * Why the loop was not running this node: one entry per thing holding it at that
   * moment, so a node held by more than one is told apart from a node held by one
   * from the array alone.
   *
   * Keyed to the `queued` kind below, unlike `redirection` and `release` on an
   * event. Those two are paired with a *journal* kind, which the journal owns and
   * this parser may not close over; a span's kind is this contract's own closed
   * vocabulary, so "a hold belongs to a hold span" is an invariant this side owns
   * and may hold a server to.
   */
  reasons: z.array(timelineHoldReasonSchema).min(1).optional(),
}).superRefine((span, context) => {
  if (span.reasons !== undefined && span.kind !== "queued") {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "only a queued span carries the reasons a node was held",
    });
  }
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

/**
 * Whether a string is a qualified project id: `<source>:<native>`, the source
 * under onetaskgraph's grammar and the native id a bare identifier — ASCII
 * letters, digits, `-`, `_` and `.`, not starting with `.`, at most 128
 * characters, and carrying no second `:`. The same grammar the route reads an
 * id back through, so a client refuses what the server would.
 */
export function isProjectId(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator === -1) return false;
  const source = value.slice(0, separator);
  const native = value.slice(separator + 1);
  return (
    /^[a-z0-9][a-z0-9-]*$/u.test(source) &&
    native.length > 0 &&
    native.length <= 128 &&
    !native.startsWith(".") &&
    /^[A-Za-z0-9._-]+$/u.test(native)
  );
}

/**
 * A project group of `GET /api/v2/projects`, and the body of
 * `GET /api/v2/projects/{project}`: `{project, name, last_write_at, runs}`.
 *
 * `project` is `null` for the **`(no project)` group** — an ordinary group whose
 * runs recorded no project, ordered by its own recency and never hidden or last by
 * rule — and it is not addressable by id, because it has none. `name` is the plan's
 * name off the newest run that recorded one. `last_write_at` is the newest write in
 * the group in milliseconds since the epoch, or `null` where none of its runs has
 * written. Each row is **the same row `GET /api/v2/runs` serves**, so it carries the
 * run's settlement, node counts, liveness, unread surfaces and last write.
 */
export const projectGroupSchema = openObject({
  project: z.string().min(1).nullable(),
  name: z.string().min(1).nullable(),
  last_write_at: nonnegative.nullable(),
  runs: z.array(runSummarySchema),
});

/**
 * `GET /api/v2/projects`: the SDK's own grouping, newest activity first — by the
 * group's `last_write_at`, then by project id — with each group's runs newest
 * first, exactly as the flat listing orders them. The order is the server's and a
 * client never recomputes it.
 */
export const projectListSchema = openObject({
  api_version: z.literal(2),
  telemetry_schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  observed_at: timestamp,
  projects: z.array(projectGroupSchema),
  unreadable: z.array(unreadableRunRootSchema).optional(),
});

/** `GET /api/v2/projects/{project}`: one group, enveloped. */
export const projectDetailSchema = projectGroupSchema.extend({
  api_version: z.literal(2),
  telemetry_schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  observed_at: timestamp,
});

/**
 * The envelope every wrapped verb answers under, beside the run it is about.
 *
 * Every mutation and every rendered read carries these, so a client can hold a
 * receipt to the schema it was served under exactly as it holds a list.
 */
const verbEnvelope = {
  api_version: z.literal(2),
  telemetry_schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  observed_at: timestamp,
} as const;

/**
 * One surface the run raised, as the engine's own channel records it.
 *
 * `kind` and `source` are the host's own words, relayed as recorded: the engine
 * relays any well-formed kind a host's observer binding defines and any author its
 * launch declared, so neither is an enum here. `blocking` says whether the run is
 * waiting on the answer — a blocking surface is a decision point holding the
 * subtree under `workstream`. `abandoned` is set when the process serving the
 * surface exited without an answer, and omitted from the wire while false.
 */
export const channelSurfaceSchema = openObject({
  id: counter,
  kind: z.string().min(1),
  message: z.string(),
  source: z.string().min(1),
  blocking: z.boolean(),
  queued_at: nonnegative,
  workstream: z.string().min(1).optional(),
  abandoned: z.boolean().optional(),
});

/**
 * The reply envelope, as the engine's `Reply` schema states it.
 *
 * Two halves with two readers. The **verdict** — `completion`, `message`,
 * `reason` — answers a pending surface; the **commands** are the reconciler's,
 * reconciled against the graph in order. An envelope carrying commands must name
 * `version` {@link REPLY_ENVELOPE_VERSION}, which the engine refuses otherwise; a
 * verdict alone needs none. `author` omitted is `planner`, and any other author
 * is judged by the run's launch configuration inside the engine.
 *
 * Declared here rather than in the browser because the composer's shortcuts
 * render to it: a shape this client did not declare is one it cannot hold a form
 * to. The engine still reads the bytes it is sent, not this parse — a client
 * sends the envelope verbatim and shows the engine's refusal verbatim.
 */
export const REPLY_ENVELOPE_VERSION = 3;

/** Who a note is for: the worker's task, the supervisor's, or both parties. */
export const noteAddresseeSchema = z.enum(["worker", "supervisor", "both"]);
/** Whether a note is attempted on the running turn (`live`) or held for the next dispatch. */
export const noteDeliverSchema = z.enum(["live", "next"]);
/**
 * What a dropped node's direct dependents become. Detaching first: a form that
 * offers the two in this order defaults to the one that loses nothing.
 */
export const dropDependentsSchema = z.enum(["detach", "drop"]);
/** How a `settle` closes a node out. */
export const settleOutcomeSchema = z.enum(["done", "failed"]);

/**
 * One graph edit, discriminated on `op`, with exactly the required fields the
 * engine's `Command` declares. Every object is closed: the engine refuses a field
 * it does not declare by name, and a composer that let one through would be
 * composing a refusal.
 */
export const replyCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), node: planTaskSchema }).strict(),
  z
    .object({
      op: z.literal("drop"),
      id: z.string().min(1),
      dependents: dropDependentsSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("reparent"),
      id: z.string().min(1),
      deps: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      op: z.literal("retry"),
      id: z.string().min(1),
      node: planTaskSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("cancel"),
      id: z.string().min(1),
      reason: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("requeue"),
      id: z.string().min(1),
      amend: arbitraryRecord.optional(),
    })
    .strict(),
  z.object({ op: z.literal("attest"), ref: z.string().min(1) }).strict(),
  z.object({ op: z.literal("complete"), reason: z.string().min(1) }).strict(),
  z
    .object({
      op: z.literal("amend"),
      id: z.string().min(1),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("note"),
      id: z.string().min(1),
      addressee: noteAddresseeSchema,
      text: z.string().min(1),
      criterion: z.string().min(1).optional(),
      deliver: noteDeliverSchema.optional(),
      persist: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("finding"),
      message: z.string().min(1),
      blocking: z.boolean().optional(),
      id: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("settle"),
      id: z.string().min(1),
      outcome: settleOutcomeSchema,
      evidence: z.string().min(1),
      landing: z.string().min(1).optional(),
      release: z
        .object({ target: z.string().min(1), version: z.string().min(1) })
        .strict()
        .optional(),
    })
    .strict(),
]);

/** The ops the envelope may carry, in the order the composer offers them. */
export const REPLY_OPS = replyCommandSchema.options.map(
  (option) => option.shape.op.value,
);

export const replyEnvelopeSchema = z
  .object({
    version: counter.optional(),
    author: z.string().min(1).optional(),
    completion: z.boolean().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
    commands: z.array(replyCommandSchema).optional(),
  })
  .strict()
  // An edit envelope is read at exactly the version the engine writes: a
  // `commands` array under any other `version`, or none, is refused by the
  // engine with "an edit envelope requires version 3", so it is refused here
  // first. An envelope carrying neither half is deliberately *not* refused —
  // the engine answers one, naming no verdict — and a verdict alone names no
  // version, so nothing else is required.
  .superRefine((envelope, context) => {
    if (
      envelope.commands !== undefined &&
      envelope.commands.length > 0 &&
      envelope.version !== REPLY_ENVELOPE_VERSION
    ) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: `an edit envelope requires version ${REPLY_ENVELOPE_VERSION}`,
      });
    }
  });

/**
 * One reply the planner wrote, as the channel keeps it: the envelope, when, and
 * the question it was bound to where it was.
 *
 * The recorded envelope is read **open** rather than through
 * {@link replyEnvelopeSchema}: it is what an earlier build wrote, possibly under a
 * vocabulary this one does not spell, and a queue that fails to parse for one old
 * reply is a queue nobody can read.
 */
export const queuedReplySchema = openObject({
  id: counter,
  reply: arbitraryRecord,
  at: nonnegative,
  correlation: z.string().min(1).optional(),
});

/** One submitted edit envelope awaiting the reconciler: its author and its commands, open. */
export const queuedCommandsSchema = openObject({
  id: counter,
  author: z.string().min(1).optional(),
  commands: z.array(arbitraryRecord),
});

/** What became of one command of an envelope, in the reconciler's own words. */
export const commandResultSchema = openObject({
  op: z.string().min(1).optional(),
  outcome: z.string().min(1).optional(),
  reason: z.string().optional(),
});

/**
 * The reconciler's answer to one envelope: all-or-nothing on `applied`, with one
 * entry per command in `results` where this build writes them.
 */
export const commandOutcomeSchema = openObject({
  id: counter,
  applied: z.boolean(),
  reason: z.string().optional(),
  results: z.array(commandResultSchema).optional(),
});

/**
 * `GET /api/v2/runs/{run}/channel`: the queue, read and never consumed — every
 * surface raised, the ones nobody has read, whatever the pending slot holds, every
 * reply written, the edit envelopes the reconciler has not claimed, and its answers
 * to the ones it has.
 */
export const channelQueueSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  surfaces: z.array(channelSurfaceSchema),
  waiting: z.array(channelSurfaceSchema),
  held: channelSurfaceSchema.nullable(),
  replies: z.array(queuedReplySchema),
  commands: z.array(queuedCommandsSchema),
  outcomes: z.array(commandOutcomeSchema),
});

/** Whether `next` claimed a surface, and if not, whether the run is over. */
export const nextStatusSchema = z.enum(["surface", "running", "finished"]);

/**
 * `POST /api/v2/runs/{run}/channel/next`: the channel's only consumer. `surface`
 * is the one claimed by this read, and `events` the run's store shaped through
 * the reader's profile — the engine's own machine records, passed through.
 */
export const channelNextSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  status: nextStatusSchema,
  surface: channelSurfaceSchema.nullable(),
  events: z.array(arbitraryRecord),
});

/**
 * The receipt `reply` and `attest` answer with — entry 64 of the engine's
 * divergence record — under `receipt`, with the engine's `advice` beside it as
 * the sentences its binary prints, in order.
 *
 * `state` is the engine's word for what the envelope became, and `verdict` and
 * `commands` are present exactly when that half was carried. Open words, because
 * they are the engine's to extend and a receipt is shown as served.
 */
export const replyReceiptSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  receipt: openObject({
    reply: counter,
    state: z.string().min(1),
    verdict: z.string().min(1).optional(),
    commands: z.string().min(1).optional(),
  }),
  advice: z.array(z.string()),
});

/** `POST /api/v2/runs/{run}/channel/surface`: the queued surface's id and `queued`. */
export const surfacedSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  surface: counter,
  state: z.string().min(1),
});

/**
 * `POST /api/v2/runs/{run}/stop`: `verbs::Stopped`. `owner` is the owner as the
 * engine names it to the caller — `[mine]` for the acting session's own run, and
 * the launcher with a digest for another's, never the raw session. `stopped` is
 * whether every process the run named was reached or none was left to; a teardown
 * that was not clean is not a stop and is refused as `409 not_stopped` instead.
 */
export const stoppedSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  stopped: z.boolean(),
  owner: z.string().min(1),
  forced: z.boolean(),
  teardown: z.string().min(1),
});

/** `POST /api/v2/runs/{run}/adopt`: the retained driver's pid. */
export const adoptedSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  pid: counter.positive(),
});

/**
 * The three frames `GET /api/v2/runs/{run}/watch` streams, by their SSE `event`
 * name: one meaningful event, a heartbeat, and the ending that closes the stream.
 */
export const watchEventNameSchema = z.enum(["event", "tick", "returned"]);

/**
 * A run's unread accounting as a watch frame carries it: how many surfaces nobody
 * has read, the age of the oldest in seconds — `null` rather than zero where
 * there is none — and the count per kind.
 */
export const watchUnreadSchema = openObject({
  count: counter,
  oldest_seconds: nonnegative.nullable(),
  kinds: z.array(openObject({ kind: z.string().min(1), count: counter })),
});

/**
 * The data of each frame, discriminated on the engine's own `watch` tag — the
 * record `onepipeline watch` prints on standard output for that frame, rendered
 * by the SDK, so a client of this stream and a script reading that verb read one
 * shape. The event under an `event` frame is the engine's machine record, open.
 */
export const watchFrameDataSchema = z.discriminatedUnion("watch", [
  openObject({ watch: z.literal("event"), event: arbitraryRecord }),
  openObject({
    watch: z.literal("heartbeat"),
    run_id: z.string().min(1),
    unread: watchUnreadSchema,
  }),
  openObject({
    watch: z.literal("return"),
    run_id: z.string().min(1),
    condition: z.string().min(1),
    exit: z.number().int(),
    node: z.string().min(1).optional(),
    cursor: z.string().min(1),
    unread: watchUnreadSchema,
  }),
]);

/**
 * `GET /api/v2/unwatched`: one entry per run the acting session owns that is not
 * proven settled and that nothing is watching, and what could not be resolved in
 * the engine's words. An unattributed server owns no run and reports none.
 */
export const unwatchedSchema = openObject({
  ...verbEnvelope,
  reported: z.array(
    openObject({
      run: z.string().min(1),
      standing: z.string().min(1),
      why_not_watched: z.string(),
    }),
  ),
  unresolved: z.array(z.string()),
});

/**
 * A verb rendered over the whole root — `host`, and `goals` given no run: the
 * SDK's own text, byte for byte what the binary prints, with the roots it refused
 * beside it on the terms the run list names one.
 */
export const renderedRootSchema = openObject({
  ...verbEnvelope,
  rendered: z.string(),
  unreadable: z.array(unreadableRunRootSchema).optional(),
});

/** A verb rendered over one run — `results`, and `goals` given a run. */
export const renderedRunSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  rendered: z.string(),
});

/**
 * `GET /api/v2/runs/{run}/status`: the run's driver liveness in the engine's own
 * word, its unread surfaces, every node's status as the run last settled it, its
 * one-line summary, and the text `onepipeline status RUN` prints.
 */
export const runStatusSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  liveness: runLivenessSchema,
  unread_surfaces: openObject({
    count: counter,
    oldest_seconds: nonnegative.nullable(),
  }),
  node_status: z.record(z.string(), z.string().min(1)),
  summary: z.string(),
  rendered: z.string(),
});

/**
 * `GET /api/v2/runs/{run}/transcript?node=ID`: the CLI's rendering of a node's
 * transcript. A node the run never dispatched is the engine's refusal, never an
 * empty rendering.
 */
export const runTranscriptSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  node: z.string().min(1).nullable().optional(),
  rendered: z.string(),
});

/**
 * `GET /api/v2/runs/{run}/telemetry`: the SDK's own document for the run, the one
 * `onepipeline telemetry RUN` prints, carrying its own `schema_version`. Open past
 * that, because the document is the engine's and is shown as served.
 */
export const runTelemetryDocumentSchema = openObject({
  ...verbEnvelope,
  run_id: z.string().min(1),
  telemetry: openObject({ schema_version: counter }),
});

export type Timing = z.infer<typeof timingSchema>;
export type FailureClass = z.infer<typeof failureClassSchema>;
export type Failure = z.infer<typeof failureSchema>;
export type NodeState = z.infer<typeof nodeStateSchema>;
export type NodeStatus = z.infer<typeof nodeStatusSchema>;
/**
 * The two role vocabularies a dispatch is served with: the transport's, closed, so a
 * consumer can key a table on it and have a party added here fail to compile there;
 * and the agent's, open, which is a member name the run itself chose and no table
 * here can be keyed on.
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
/** What one surface record said about the surface it raised or consumed. */
export type TimelineSurface = z.infer<typeof timelineSurfaceSchema>;
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
export type TimelineHoldReason = z.infer<typeof timelineHoldReasonSchema>;
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
export type ProjectGroup = z.infer<typeof projectGroupSchema>;
export type ProjectList = z.infer<typeof projectListSchema>;
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
export type ChannelSurface = z.infer<typeof channelSurfaceSchema>;
export type ReplyCommand = z.infer<typeof replyCommandSchema>;
export type ReplyOp = ReplyCommand["op"];
export type ReplyEnvelope = z.infer<typeof replyEnvelopeSchema>;
export type NoteAddressee = z.infer<typeof noteAddresseeSchema>;
export type QueuedReply = z.infer<typeof queuedReplySchema>;
export type QueuedCommands = z.infer<typeof queuedCommandsSchema>;
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;
export type ChannelQueue = z.infer<typeof channelQueueSchema>;
export type ChannelNext = z.infer<typeof channelNextSchema>;
export type ReplyReceipt = z.infer<typeof replyReceiptSchema>;
export type Surfaced = z.infer<typeof surfacedSchema>;
export type Stopped = z.infer<typeof stoppedSchema>;
export type Adopted = z.infer<typeof adoptedSchema>;
export type WatchEventName = z.infer<typeof watchEventNameSchema>;
export type WatchFrameData = z.infer<typeof watchFrameDataSchema>;
export type WatchUnread = z.infer<typeof watchUnreadSchema>;
export type Unwatched = z.infer<typeof unwatchedSchema>;
export type RenderedRoot = z.infer<typeof renderedRootSchema>;
export type RenderedRun = z.infer<typeof renderedRunSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunTranscript = z.infer<typeof runTranscriptSchema>;
export type RunTelemetryDocument = z.infer<typeof runTelemetryDocumentSchema>;
export type FilterProfile =
  (typeof API_V2_FILTER_PROFILES)[keyof typeof API_V2_FILTER_PROFILES];

export const parseRunList = (value: unknown): RunList =>
  runListSchema.parse(value);
export const parseRunDetail = (value: unknown): RunDetail =>
  runDetailSchema.parse(value);
export const parseRunTimeline = (value: unknown): RunTimeline =>
  runTimelineSchema.parse(value);
