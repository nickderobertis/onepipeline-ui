//! Projecting the onepipeline SDK's run records onto the wire shapes.
//!
//! The SDK owns the records — the launch record, the merged event store, the
//! folded run state, the per-round plan and result. This module owns only the
//! projection onto what `docs/contract.md` serves: it renames nothing the SDK
//! already names and computes nothing the SDK already computes, and every place
//! it does derive something (the timing buckets, a dispatch key, a session key)
//! is listed in AGENTS.md as a computation proposed for the SDK, where the agent
//! reading the CLI would see it too.
//!
//! Everything here is a pure function of a [`RunView`] plus the run directory,
//! so a payload can be built and asserted without a server.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use onepipeline::event::{Envelope, PipelineKind, Source};
use onepipeline::plan::{Node, Plan};
use onepipeline::views::{liveness_word, RunView};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::contract::{ArtifactId, ConversationId, NodeId, TIMELINE_SCHEMA_VERSION};

/// The bound on an artifact body served in one response.
///
/// A tail rather than the whole file: an artifact is a recorded log, which has
/// no size a producer promised, and a read surface that streams an unbounded one
/// into a browser is a read surface that can be made to exhaust its own memory.
pub const ARTIFACT_TAIL_BYTES: usize = 64 * 1024;

/// The role every dispatch this crate can see was run under.
///
/// onepipeline dispatches its nodes through one transport — the agent graph — so
/// the transport half of the pair is fixed. The semantic half comes from the
/// node's persona when it declared one.
const TRANSPORT_ROLE: &str = "agent";

/// The semantic roles a client may be given, from `agentRoleSchema`.
///
/// A persona outside this set is not served as an `agent_role` at all: the field
/// is a closed vocabulary a client switches on, so a persona it does not know
/// must be absent rather than present and unmatched.
const AGENT_ROLES: [&str; 5] = ["orchestrator", "worker", "judge", "check-in", "pr-author"];

/// Now, as the envelope's `observed_at`.
#[must_use]
pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

/// An RFC 3339 timestamp as epoch milliseconds, or `None` if it is not one.
#[must_use]
pub fn millis_of(ts: &str) -> Option<i128> {
    OffsetDateTime::parse(ts, &Rfc3339)
        .ok()
        .map(|at| at.unix_timestamp_nanos() / 1_000_000)
}

/// The opaque, stable, irreversible name of the session that launched a run.
///
/// The raw launching session id may be sensitive and is never served; this is
/// what lets a client group runs by the planner that launched them without it.
fn session_key(session: &str) -> String {
    let digest = Sha256::digest(session.as_bytes());
    digest[..6].iter().fold(String::new(), |mut out, byte| {
        out.push_str(&format!("{byte:02x}"));
        out
    })
}

/// A launcher name from the closed vocabulary a client switches on.
fn launcher_word(launcher: &str) -> &'static str {
    match launcher {
        "claude-code" => "claude-code",
        "codex" => "codex",
        _ => "unknown",
    }
}

/// The per-node statuses the wire's vocabulary holds, and exactly those.
///
/// Closed because a client switches on it exhaustively: a word outside this set
/// has no rendering, and one round's recorded result can hold any word at all.
const NODE_STATUSES: [&str; 11] = [
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
];

/// The status word a client renders, from whatever the run recorded.
///
/// One translation: the SDK's `ready` — eligible now, nothing dispatched — has
/// no member in the client's vocabulary, and `pending` is what that vocabulary
/// calls a node that has not started. Anything else the vocabulary does not hold
/// is `unknown`, rather than passed through for a client to fail on or mapped
/// onto a neighbouring meaning it does not have. The word itself is not lost:
/// `node_counts` reports what the run actually wrote.
fn status_word(status: &str) -> &str {
    if status == "ready" {
        return "pending";
    }
    if NODE_STATUSES.contains(&status) {
        status
    } else {
        "unknown"
    }
}

/// Whether a status is one the journal can record for a node, as opposed to one
/// derived on every read. Only recorded ones belong in `node_states`.
fn is_recorded_state(status: &str) -> bool {
    matches!(
        status,
        "running" | "done" | "failed" | "waiting" | "parked" | "cancelled"
    )
}

/// The key that groups the sessions of one node's dispatch within one round.
///
/// Derived rather than recorded: the SDK's journal stamps a dispatch with its
/// run, round, and node but mints no id for it, and schema 10 serves one. The
/// three together identify the dispatch exactly, so the derived key is stable
/// across reads and across processes.
fn dispatch_key(run: &str, round: u64, node: &str) -> String {
    format!("{run}.{round:02}.{node}")
}

/// Read one JSON document, or `None` if it is missing or unreadable.
///
/// A run directory is recorded, not curated: a half-written round result is a
/// file this read skips, not a run it refuses to serve.
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// One run, as `GET /api/v2/runs` lists it.
#[must_use]
pub fn run_summary(view: &RunView) -> Value {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for recorded in recorded_statuses(view).values() {
        *counts.entry(recorded.status.clone()).or_insert(0) += 1;
    }
    let mut summary = Map::new();
    summary.insert("run_id".into(), json!(view.paths.run));
    summary.insert("state".into(), json!(state_word(view)));
    summary.insert("phase".into(), json!(phase_word(view)));
    summary.insert("last_event".into(), last_event(view));
    if let Some(at) = view.state.last_write_at {
        summary.insert("last_progress_at".into(), json!(at / 1_000));
    }
    summary.insert("timing_quality".into(), json!(timing_quality(view)));
    summary.insert("linkage_quality".into(), json!("labelled"));
    summary.insert("timing".into(), timing(view));
    summary.insert("node_counts".into(), json!(counts));
    summary.insert("launch".into(), launch(view));
    Value::Object(summary)
}

/// Every node's status as the run itself last wrote it, in the run's own words.
///
/// The same derivation the round payload renders from, so a list row and the
/// graph it opens cannot describe different graphs — the disagreement an
/// operator would otherwise see between the two. An *open* round is the live
/// fold; a closed one is its own recorded result, which is the only account of
/// it that survives the next round starting, and which is all a run predating
/// the journal ever had. The words are unmapped on purpose: a count reports what
/// the run wrote, where a status a client switches on cannot.
fn recorded_statuses(view: &RunView) -> BTreeMap<String, Recorded> {
    let folded = || -> BTreeMap<String, Recorded> {
        view.state
            .statuses()
            .into_iter()
            .map(|(node, status)| {
                let outcome = view.state.outcomes.get(&node).cloned();
                (
                    node,
                    Recorded {
                        status: status.as_str().to_owned(),
                        outcome,
                    },
                )
            })
            .collect()
    };
    if view.state.round_open {
        return folded();
    }
    // `max(1)` because a run predating the journal has no round-started event to
    // fold at all: its round number is zero and its result is still on disk.
    let recorded: BTreeMap<String, Recorded> =
        read_json(&view.paths.round_result(view.state.round.max(1)))
            .and_then(|result| result["nodes"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|node| {
                Some((
                    node["id"].as_str()?.to_owned(),
                    Recorded {
                        status: node["status"].as_str()?.to_owned(),
                        outcome: node["outcome"].as_str().map(str::to_owned),
                    },
                ))
            })
            .collect();
    if recorded.is_empty() {
        folded()
    } else {
        recorded
    }
}

/// What one node's last account of itself said: its status word, and the outcome
/// word beside it when it recorded one.
#[derive(Debug, Clone)]
struct Recorded {
    status: String,
    outcome: Option<String>,
}

/// The run's own attribution to the session that launched it.
fn launch(view: &RunView) -> Value {
    let mut record = Map::new();
    record.insert("launch_id".into(), json!(view.paths.run));
    record.insert(
        "launcher".into(),
        json!(launcher_word(&view.launch.launcher)),
    );
    if !view.launch.session.is_empty() {
        record.insert(
            "session_key".into(),
            json!(session_key(&view.launch.session)),
        );
    }
    Value::Object(record)
}

/// How the run is being driven, as one lowercase word.
fn state_word(view: &RunView) -> String {
    liveness_word(view).to_lowercase().replace(' ', "-")
}

/// Which part of its loop the run is in, derived from what it recorded.
fn phase_word(view: &RunView) -> &'static str {
    if view.state.stopped {
        return "finished";
    }
    if view.state.round_open {
        return "driving-round";
    }
    if view.state.round == 0 {
        return "starting";
    }
    if view.state.surfaces_queued > view.state.surfaces_read {
        return "surfacing";
    }
    "reviewing-results"
}

/// The kind of the run's most recent event, or `null` for a run that has
/// recorded none — which is how a just-launched run reads on disk.
fn last_event(view: &RunView) -> Value {
    view.events
        .last()
        .map_or(Value::Null, |event| json!(event.kind.0))
}

/// How completely the run's own clock is accounted for.
fn timing_quality(view: &RunView) -> &'static str {
    if view.events.is_empty() {
        "legacy"
    } else if view.state.round_open {
        "partial"
    } else {
        "complete"
    }
}

/// One span of the run's wall clock, named by what the run was doing across it.
#[derive(Debug, Default, Clone, Copy)]
struct Buckets {
    dispatching_ms: u64,
    awaiting_planner_ms: u64,
    awaiting_human_ms: u64,
    orchestrating_ms: u64,
    wall_ms: u64,
}

/// Attribute the run's wall clock, one span between consecutive events at a
/// time, so the parts add up to the whole.
///
/// This is the SDK's own `telemetry` fold, which is behind its contract surface
/// rather than on it. Recomputing it here is one of the computations AGENTS.md
/// proposes moving into the SDK; the mapping onto the wire's eight-way timing is
/// documented on [`timing`].
fn buckets(view: &RunView) -> Buckets {
    let stamps: Vec<(i128, &Envelope)> = view
        .events
        .iter()
        .filter_map(|event| millis_of(&event.ts).map(|ms| (ms, event)))
        .collect();
    let Some((first, _)) = stamps.first().copied() else {
        return Buckets::default();
    };
    let last = stamps.last().map_or(first, |(ms, _)| *ms);

    let mut totals = Buckets {
        wall_ms: u64::try_from(last.saturating_sub(first)).unwrap_or(0),
        ..Buckets::default()
    };
    let mut in_flight: u64 = 0;
    let mut awaiting_planner = false;
    let mut awaiting_human: u64 = 0;
    let mut previous = first;

    for (ms, event) in &stamps {
        let span = u64::try_from(ms.saturating_sub(previous)).unwrap_or(0);
        if in_flight > 0 {
            totals.dispatching_ms += span;
        } else if awaiting_planner {
            totals.awaiting_planner_ms += span;
        } else if awaiting_human > 0 {
            totals.awaiting_human_ms += span;
        } else {
            totals.orchestrating_ms += span;
        }
        previous = *ms;

        if event.source != Source::Pipeline {
            continue;
        }
        match PipelineKind::from_wire(&event.kind) {
            Some(PipelineKind::NodeDispatched) => in_flight += 1,
            Some(PipelineKind::NodeSettled) => {
                in_flight = in_flight.saturating_sub(1);
                if event.payload.get("status").and_then(Value::as_str) == Some("waiting") {
                    awaiting_human += 1;
                }
            }
            Some(PipelineKind::HumanAttested) => awaiting_human = awaiting_human.saturating_sub(1),
            Some(PipelineKind::PlannerSurfaced) => {
                awaiting_planner = event
                    .payload
                    .get("blocking")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
            Some(PipelineKind::PlannerReplied) => awaiting_planner = false,
            _ => {}
        }
    }

    // The invariant, enforced rather than asserted: any residue from a clock
    // that moved backwards between two events lands in `orchestrating`, so the
    // parts still add up to the whole.
    let counted = totals.dispatching_ms
        + totals.awaiting_planner_ms
        + totals.awaiting_human_ms
        + totals.orchestrating_ms;
    if let Some(residue) = totals.wall_ms.checked_sub(counted) {
        totals.orchestrating_ms += residue;
    } else {
        totals.orchestrating_ms = totals
            .orchestrating_ms
            .saturating_sub(counted - totals.wall_ms);
    }
    totals
}

/// The run's timing, in the eight-way breakdown the wire carries.
///
/// The SDK attributes a run's wall clock four ways — dispatching, awaiting a
/// planner, awaiting a human, and orchestrating — and the wire's breakdown is
/// finer than that. Rather than invent numbers for the parts the journal cannot
/// distinguish, each SDK bucket lands whole in the wire bucket that means the
/// same thing and the rest are served as zero: dispatching is agent time, the
/// two waits are idle orchestration, and orchestrating is scheduling. A judge or
/// lint breakdown is not something a onepipeline journal records, so serving a
/// non-zero one would be a claim nothing supports.
fn timing(view: &RunView) -> Value {
    let totals = buckets(view);
    let idle_ms = totals.awaiting_planner_ms + totals.awaiting_human_ms;
    let wall = totals.wall_ms;
    let fraction = |part: u64| {
        if wall == 0 {
            0.0
        } else {
            #[allow(clippy::cast_precision_loss)]
            // A millisecond count; f64 is exact well past any run's.
            let ratio = part as f64 / wall as f64;
            ratio
        }
    };
    let seconds = |ms: u64| ms / 1_000;
    json!({
        "agent_seconds": seconds(totals.dispatching_ms),
        "judge_seconds": 0,
        "llmlint_seconds": 0,
        "gate_seconds": 0,
        "publication_wait_seconds": 0,
        "lock_wait_seconds": 0,
        "setup_seconds": 0,
        "scheduling_seconds": seconds(totals.orchestrating_ms),
        "wall_seconds": seconds(wall),
        "agent_model_ms": totals.dispatching_ms,
        "judge_model_ms": 0,
        "llmlint_model_ms": 0,
        "tool_ms": 0,
        "idle_orchestration_ms": idle_ms,
        "unattributed_ms": 0,
        "wall_ms": wall,
        "fractions": {
            "agent_model": fraction(totals.dispatching_ms),
            "judge_model": 0.0,
            "llmlint_model": 0.0,
            "tool": 0.0,
            "idle_orchestration": fraction(idle_ms),
            "lock_wait": 0.0,
            "setup": 0.0,
            "scheduling": fraction(totals.orchestrating_ms),
        },
    })
}

/// A usage party with nothing recorded. Present rather than absent: the shape is
/// required, and a missing party would read as "no cost" rather than "unknown".
fn unknown_usage() -> Value {
    json!({
        "agent": null_party(),
        "judge": null_party(),
        "llmlint": null_party(),
        "total": null_party(),
    })
}

fn null_party() -> Value {
    json!({
        "input_tokens": null,
        "output_tokens": null,
        "cache_read_tokens": null,
        "cache_write_tokens": null,
        "cost_usd": null,
    })
}

/// Which measured timings the records actually carried.
fn timing_presence() -> Value {
    json!({
        "agent_model_ms": true,
        "judge_model_ms": false,
        "llmlint_model_ms": false,
        "tool_ms": false,
    })
}

/// The sessions the merged event store shows doing one node's work.
///
/// A relayed agent-graph envelope carries the session it came from in its
/// labels; that is the whole of what the journal links, so a session appears
/// here exactly when one is recorded and never inferred from anything else.
fn sessions_of(view: &RunView, node: &str) -> Vec<Value> {
    let mut seen: BTreeMap<String, Value> = BTreeMap::new();
    for event in &view.events {
        if event.source != Source::Agentgraph || event.labels.node.as_deref() != Some(node) {
            continue;
        }
        let Some(session) = event
            .labels
            .extra
            .get("session")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        seen.entry(session.to_owned()).or_insert_with(|| {
            let mut link = Map::new();
            link.insert("session_id".into(), json!(session));
            link.insert("role".into(), json!(TRANSPORT_ROLE));
            if let Some(role) = agent_role(event.labels.persona.as_deref()) {
                link.insert("agent_role".into(), json!(role));
            }
            link.insert("started_at".into(), json!(event.ts));
            Value::Object(link)
        });
    }
    seen.into_values().collect()
}

/// The semantic role a persona names, when it names one the client knows.
fn agent_role(persona: Option<&str>) -> Option<&'static str> {
    let persona = persona?;
    AGENT_ROLES.into_iter().find(|role| *role == persona)
}

/// The statuses that mean this node's own work ran, or was cut short, without
/// finishing — the ones a reader is owed a reason for.
fn is_lost(status: &str) -> bool {
    matches!(status, "failed" | "not-completed" | "cancelled")
}

/// How a lost outcome failed, from the closed vocabulary a client switches on.
///
/// Derived from the outcome word the run recorded, because that is the only
/// classification a onepipeline journal carries: the categories a run can name
/// are what the wire's own `failureClassSchema` calls `gate`, `checks`,
/// `publication` and `timeout`. Anything else that ran and stopped is the
/// dispatch's own failure, and anything that never ran is `unknown` rather than
/// a category this crate picked for it.
///
/// This is one of the computations AGENTS.md proposes moving into the SDK: the
/// agent reading the CLI sees the outcome word and not the class.
fn failure_class(view: &RunView, node: &str, recorded: &Recorded) -> Option<&'static str> {
    if !is_lost(status_word(&recorded.status)) {
        return None;
    }
    Some(match recorded.outcome.as_deref() {
        Some("gate-failed") => "gate",
        Some("checks-failed") => "checks",
        Some("publication-failed") => "publication",
        Some("timed-out") => "timeout",
        _ if view.state.dispatched_at.contains_key(node) => "agent",
        _ => "unknown",
    })
}

/// One node's telemetry row.
fn node_telemetry(view: &RunView, node: &str, recorded: &Recorded) -> Value {
    let mut row = Map::new();
    row.insert("node".into(), json!(node));
    row.insert("status".into(), json!(status_word(&recorded.status)));
    if let Some(outcome) = &recorded.outcome {
        row.insert("outcome".into(), json!(outcome));
    }
    if let Some(branch) = view.state.branches.get(node) {
        row.insert("branch".into(), json!(branch));
    }
    if let Some(class) = failure_class(view, node, recorded) {
        // The classification alone: onepipeline records no classified *detail*, so
        // serving one would be this crate writing the sentence. A client falls
        // through to the prose the settlement itself recorded instead.
        row.insert("failure".into(), json!({ "class": class }));
    }
    row.insert("sessions".into(), json!(sessions_of(view, node)));
    row.insert("turns".into(), json!(0));
    row.insert("lint".into(), json!(0));
    row.insert("timing_quality".into(), json!(timing_quality(view)));
    row.insert("linkage_quality".into(), json!("labelled"));
    row.insert("timing_presence".into(), timing_presence());
    Value::Object(row)
}

/// The run's own telemetry document, as `GET /api/v2/runs/{run}` serves it.
fn run_telemetry(view: &RunView) -> Value {
    let statuses = recorded_statuses(view);
    let nodes: Vec<Value> = statuses
        .iter()
        .map(|(node, recorded)| node_telemetry(view, node, recorded))
        .collect();
    let totals = buckets(view);
    let mut run = Map::new();
    run.insert("run_id".into(), json!(view.paths.run));
    run.insert("state".into(), json!(state_word(view)));
    run.insert("phase".into(), json!(phase_word(view)));
    run.insert("last_event".into(), last_event(view));
    if let Some(at) = view.state.last_write_at {
        run.insert("last_progress_at".into(), json!(at / 1_000));
    }
    run.insert("timing".into(), timing(view));
    run.insert("nodes".into(), Value::Array(nodes));
    run.insert("usage".into(), unknown_usage());
    run.insert("timing_quality".into(), json!(timing_quality(view)));
    run.insert("linkage_quality".into(), json!("labelled"));
    run.insert("timing_presence".into(), timing_presence());
    run.insert("sources".into(), json!(["events.jsonl", "launch.json"]));
    run.insert(
        "node_work_ms".into(),
        json!({
            "agent_model_ms": totals.dispatching_ms,
            "judge_model_ms": 0,
            "llmlint_model_ms": 0,
            "tool_ms": 0,
            "wall_ms": totals.wall_ms,
        }),
    );
    run.insert("turns".into(), json!(0));
    run.insert("lint".into(), json!(0));
    Value::Object(run)
}

/// One plan node, projected onto the wire's plan-task shape.
///
/// Only the fields the wire's own schema names are carried across, and each is
/// carried as recorded. The SDK's node shape is wider than the wire's — a
/// `resume` there records a branch and the steps a continuation may skip, where
/// the wire's records a base branch and a change request too — so a field whose
/// recorded shape is not the wire's is left out rather than reshaped into a
/// claim the record does not make.
fn plan_task(node: &Node) -> Value {
    let mut task = Map::new();
    task.insert("id".into(), json!(node.id));
    task.insert("kind".into(), json!(kind_word(node)));
    if let Some(persona) = &node.persona {
        task.insert("persona".into(), json!(persona));
    }
    let prose = node.rendered_task();
    if !prose.is_empty() {
        task.insert("task".into(), json!(prose));
    }
    if !node.deps.is_empty() {
        task.insert("deps".into(), json!(node.deps));
    }
    if let Some(done_when) = &node.done_when {
        task.insert("done_when".into(), json!(done_when));
    }
    if let Some(max_turns) = node.max_turns.filter(|turns| *turns > 0) {
        task.insert("max_turns".into(), json!(max_turns));
    }
    if node.expects_no_diff {
        task.insert("expects_no_diff".into(), json!(true));
    }
    if let Some(repo) = &node.repo {
        task.insert("repo".into(), json!(repo));
    }
    if let Some(branch) = &node.branch {
        task.insert("branch".into(), json!(branch));
    }
    if let Some(base) = &node.base_branch {
        task.insert("base_branch".into(), json!(base));
    }
    if let Some(title) = &node.title {
        task.insert("title".into(), json!(title));
    }
    if let Some(checkout) = &node.execution_checkout {
        task.insert("execution_checkout".into(), json!(checkout));
    }
    if let Some(steps) = &node.steps {
        let rendered: Vec<Value> = steps
            .iter()
            .map(|step| {
                let mut out = Map::new();
                out.insert("id".into(), json!(step.id));
                out.insert(
                    "kind".into(),
                    json!(if matches!(
                        serde_json::to_value(step.kind)
                            .ok()
                            .as_ref()
                            .and_then(Value::as_str),
                        Some("human")
                    ) {
                        "human"
                    } else {
                        "agent"
                    }),
                );
                if let Some(persona) = &step.persona {
                    out.insert("persona".into(), json!(persona));
                }
                // The planner's note is about the work, so it is rendered into
                // an agent step and never into a human one: an action a person
                // takes is served as written.
                let prose = if kind_word_of_step(step) == "human" {
                    step.task.clone().unwrap_or_default()
                } else {
                    step.rendered_task(node.context.as_deref())
                };
                // The wire requires prose on every step; a step recorded without
                // any is named by its id rather than served as a blank panel.
                out.insert(
                    "task".into(),
                    json!(if prose.is_empty() {
                        step.id.clone()
                    } else {
                        prose
                    }),
                );
                if !step.deps.is_empty() {
                    out.insert("deps".into(), json!(step.deps));
                }
                Value::Object(out)
            })
            .collect();
        if !rendered.is_empty() {
            task.insert("steps".into(), Value::Array(rendered));
        }
    }
    // A node with neither prose nor steps is one the wire has no shape for; it
    // is named by its id so the graph still draws it.
    if !task.contains_key("task") && !task.contains_key("steps") {
        task.insert("task".into(), json!(node.id.clone()));
    }
    Value::Object(task)
}

fn kind_word(node: &Node) -> &'static str {
    match serde_json::to_value(node.kind)
        .ok()
        .as_ref()
        .and_then(Value::as_str)
    {
        Some("human") => "human",
        _ => "agent",
    }
}

/// The plan a round executed, with every committed live edit applied.
fn round_plan(view: &RunView, round: u64) -> Option<Plan> {
    if round == view.state.round {
        let source = view.state.plan.clone()?;
        return Some(view.state.graph.to_plan(&source));
    }
    Plan::load(&view.paths.round_plan(round)).ok()
}

/// One round of the run, as the detail payload carries it.
fn round(view: &RunView, number: u64) -> Option<Value> {
    let plan = round_plan(view, number)?;
    let task_ids: BTreeSet<&str> = plan.tasks.iter().map(|node| node.id.as_str()).collect();
    let result = read_json(&view.paths.round_result(number));
    // Only an *open* round is described by the live fold. Once it closes, its own
    // recorded result is the sole account of it that survives the next round
    // starting — and it holds outcomes the fold never saw, because a status a
    // round records at its end was never journalled as a settlement.
    let current = number == view.state.round && view.state.round_open;

    // The current round's statuses are the live fold; a finished round's are
    // what its own result recorded, which is the only account of it that
    // survives the next round starting.
    let mut statuses: BTreeMap<String, String> = BTreeMap::new();
    if current {
        for (node, status) in view.state.statuses() {
            statuses.insert(node, status_word(status.as_str()).to_owned());
        }
    } else if let Some(nodes) = result.as_ref().and_then(|r| r["nodes"].as_array()) {
        for node in nodes {
            if let (Some(id), Some(status)) = (node["id"].as_str(), node["status"].as_str()) {
                statuses.insert(id.to_owned(), status_word(status).to_owned());
            }
        }
    }
    // Exactly one entry per plan task, so a client never invents a status for a
    // node or renders one for a node the round did not carry.
    let node_status: Map<String, Value> = plan
        .tasks
        .iter()
        .map(|node| {
            let status = statuses
                .get(&node.id)
                .map_or("unknown", String::as_str)
                .to_owned();
            (node.id.clone(), json!(status))
        })
        .collect();

    let node_states: Map<String, Value> = statuses
        .iter()
        .filter(|(id, status)| task_ids.contains(id.as_str()) && is_recorded_state(status))
        .map(|(id, status)| (id.clone(), json!(status)))
        .collect();

    let node_gated_by: Map<String, Value> = plan
        .tasks
        .iter()
        .filter(|node| matches!(node_status[&node.id].as_str(), Some("blocked" | "skipped")))
        .map(|node| {
            let blockers: Vec<&String> = node
                .deps
                .iter()
                .filter(|dep| task_ids.contains(dep.as_str()))
                .collect();
            (node.id.clone(), json!(blockers))
        })
        .filter(|(_, blockers)| !blockers.as_array().is_some_and(Vec::is_empty))
        .collect();

    let node_results: Map<String, Value> = plan
        .tasks
        .iter()
        .filter_map(|node| node_result(view, node, current, result.as_ref()))
        .collect();

    let mut out = Map::new();
    out.insert("run_id".into(), json!(view.paths.run));
    out.insert("round".into(), json!(number));
    out.insert("plan".into(), plan_document(&plan));
    out.insert("node_states".into(), Value::Object(node_states));
    out.insert("node_status".into(), Value::Object(node_status));
    out.insert("node_gated_by".into(), Value::Object(node_gated_by));
    out.insert("node_results".into(), Value::Object(node_results));
    out.insert(
        "attestations".into(),
        json!(view.state.attestations.iter().collect::<Vec<_>>()),
    );
    out.insert("result".into(), round_result(number, result.as_ref()));
    out.insert("last_seq".into(), json!(last_seq(view, number)));
    Some(Value::Object(out))
}

/// The plan document a round carries, in the wire's shape.
fn plan_document(plan: &Plan) -> Value {
    let mut document = Map::new();
    document.insert(
        "tasks".into(),
        Value::Array(plan.tasks.iter().map(plan_task).collect()),
    );
    document.insert("schema_version".into(), json!(plan.schema_version));
    if plan.concurrency > 0 {
        document.insert("concurrency".into(), json!(plan.concurrency));
    }
    if let Some(name) = plan.name.as_ref().filter(|name| !name.is_empty()) {
        document.insert("name".into(), json!(name));
    }
    if let Some(goal) = plan.goal.as_ref().filter(|goal| !goal.text.is_empty()) {
        // The wire's goal is identified as well as stated; the SDK records the
        // words alone, so the id is the digest of them — stable for the same
        // goal, and different for a goal the planner rewrote.
        document.insert(
            "goal".into(),
            json!({ "id": session_key(&goal.text), "text": goal.text }),
        );
    }
    Value::Object(document)
}

/// The fields of a recorded node result the wire carries, each as recorded.
///
/// Deliberately an allowlist rather than a passthrough: a round's result is a
/// wider record than `graphResultItemSchema` describes, and serving a key the
/// client has no meaning for would be this crate inventing contract.
const RESULT_FIELDS: &[&str] = &[
    "status",
    "outcome",
    "branch",
    "blocked_by",
    "unblocks",
    "human_actions",
    "detail",
    "error",
    "exit_code",
    "ok",
];

/// The payload of the settlement the current round recorded for `node`.
///
/// The last one wins: a node that settled more than once in a round is a node
/// that was retried, and the retry is what happened.
fn settlement(view: &RunView, node: &str) -> Option<Map<String, Value>> {
    view.events
        .iter()
        .rev()
        .find(|event| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
                && event.labels.round == Some(view.state.round)
                && event.labels.node.as_deref() == Some(node)
        })
        .map(|event| event.payload.clone())
}

/// One node's recorded result within a round, when the round recorded one.
fn node_result(
    view: &RunView,
    node: &Node,
    current: bool,
    result: Option<&Value>,
) -> Option<(String, Value)> {
    let mut item = Map::new();
    item.insert("kind".into(), json!(kind_word(node)));
    if let Some(recorded) = result
        .and_then(|r| r["nodes"].as_array())
        .and_then(|nodes| nodes.iter().find(|entry| entry["id"] == json!(node.id)))
    {
        for field in RESULT_FIELDS {
            if let Some(value) = recorded.get(field) {
                item.insert((*field).to_owned(), value.clone());
            }
        }
        if let Some(url) = recorded.get("change_url").and_then(Value::as_str) {
            item.insert("pr".into(), json!(url));
        }
        if let Some(status) = item.get("status").and_then(Value::as_str) {
            let word = status_word(status).to_owned();
            item.insert("completed".into(), json!(word == "done"));
            item.insert("status".into(), json!(word));
        }
    } else if current {
        let status = view.state.recorded.get(&node.id)?;
        item.insert("status".into(), json!(status_word(status.as_str())));
        item.insert(
            "completed".into(),
            json!(status_word(status.as_str()) == "done"),
        );
        // The words the settlement itself carried. The SDK's fold keeps a node's
        // status, outcome and branch but not the prose beside them, and a node
        // that stopped without them is a card that says only "failed" — which
        // tells a reader less than the run already knows.
        if let Some(settled) = settlement(view, &node.id) {
            for field in RESULT_FIELDS {
                if item.contains_key(*field) {
                    continue;
                }
                if let Some(value) = settled.get(*field) {
                    item.insert((*field).to_owned(), value.clone());
                }
            }
        }
        if let Some(outcome) = view.state.outcomes.get(&node.id) {
            item.insert("outcome".into(), json!(outcome));
        }
        if let Some(branch) = view.state.branches.get(&node.id) {
            item.insert("branch".into(), json!(branch));
        }
        if let Some(url) = view.state.change_urls.get(&node.id) {
            item.insert("pr".into(), json!(url));
        }
    } else {
        return None;
    }
    if let Some(finished) = view.state.completed_steps.get(&node.id) {
        let steps: Vec<Value> = node
            .steps
            .iter()
            .flatten()
            .map(|step| {
                json!({
                    "id": step.id,
                    "kind": if matches!(kind_word_of_step(step), "human") { "human" } else { "agent" },
                    "persona": step.persona,
                    "status": if finished.contains(&step.id) { "done" } else { "pending" },
                })
            })
            .collect();
        if !steps.is_empty() {
            item.insert("steps".into(), Value::Array(steps));
        }
    }
    Some((node.id.clone(), Value::Object(item)))
}

fn kind_word_of_step(step: &onepipeline::plan::Step) -> &'static str {
    match serde_json::to_value(step.kind)
        .ok()
        .as_ref()
        .and_then(Value::as_str)
    {
        Some("human") => "human",
        _ => "agent",
    }
}

/// The round's own recorded result document, or `null` while it is still open.
fn round_result(number: u64, result: Option<&Value>) -> Value {
    let Some(result) = result else {
        return Value::Null;
    };
    let mut out = Map::new();
    if let Some(ok) = result.get("ok") {
        out.insert("ok".into(), ok.clone());
    }
    if let Some(state) = result.get("state") {
        out.insert("state".into(), state.clone());
    }
    out.insert("round".into(), json!(number));
    if let Some(nodes) = result["nodes"].as_array() {
        out.insert(
            "started_order".into(),
            json!(nodes
                .iter()
                .filter_map(|node| node["id"].as_str())
                .collect::<Vec<_>>()),
        );
    }
    Value::Object(out)
}

/// The highest per-stream sequence number the round recorded.
fn last_seq(view: &RunView, number: u64) -> u64 {
    view.events
        .iter()
        .filter(|event| event.labels.round == Some(number))
        .map(|event| event.seq)
        .max()
        .unwrap_or(0)
}

/// The whole of `GET /api/v2/runs/{run}`'s payload.
#[must_use]
pub fn run_detail(view: &RunView, include_conversations: bool) -> Value {
    let rounds: Vec<Value> = (1..=view.state.round.max(1))
        .filter_map(|number| round(view, number))
        .collect();
    let mut payload = Map::new();
    payload.insert("run".into(), run_telemetry(view));
    payload.insert("rounds".into(), Value::Array(rounds));
    payload.insert(
        "conversations".into(),
        Value::Array(if include_conversations {
            conversations(view)
        } else {
            Vec::new()
        }),
    );
    payload.insert("node_details".into(), node_details(view));
    payload.insert("launch".into(), launch(view));
    Value::Object(payload)
}

/// The publication and verification evidence each node left behind.
fn node_details(view: &RunView) -> Value {
    let mut details = Map::new();
    for (node, branch) in &view.state.branches {
        let mut publication = Map::new();
        publication.insert("branch".into(), json!(branch));
        publication.insert(
            "merged".into(),
            json!(view
                .state
                .outcomes
                .get(node)
                .is_some_and(|outcome| outcome == "merged")),
        );
        if let Some(url) = view.state.change_urls.get(node) {
            publication.insert("pr_url".into(), json!(url));
        }
        details.insert(
            node.clone(),
            json!({
                "verification": { "records": [] },
                "publication": Value::Object(publication),
            }),
        );
    }
    Value::Object(details)
}

/// Every transcript the merged event store records for the run.
///
/// A conversation is one agent-graph session's relayed envelopes, in order. The
/// journal records what each envelope reported, not the turn text a harness
/// stored, so a turn here carries the event that produced it rather than a
/// transcript body — the body lives with the producing library, which is where
/// AGENTS.md proposes the read for it should land.
#[must_use]
pub fn conversations(view: &RunView) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: BTreeMap<String, Vec<&Envelope>> = BTreeMap::new();
    for event in &view.events {
        if event.source != Source::Agentgraph {
            continue;
        }
        let Some(session) = event
            .labels
            .extra
            .get("session")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if ConversationId::try_from(session).is_err() {
            continue;
        }
        if !grouped.contains_key(session) {
            order.push(session.to_owned());
        }
        grouped.entry(session.to_owned()).or_default().push(event);
    }
    order
        .into_iter()
        .filter_map(|session| {
            let events = grouped.get(&session)?;
            Some(conversation_document(view, &session, events))
        })
        .collect()
}

/// One conversation and its attribution.
fn conversation_document(view: &RunView, session: &str, events: &[&Envelope]) -> Value {
    let first = events.first().copied();
    let last = events.last().copied();
    let started_at = first.map_or_else(now_rfc3339, |event| event.ts.clone());
    let node = first.and_then(|event| event.labels.node.clone());
    let turns: Vec<Value> = events
        .iter()
        .enumerate()
        .map(|(index, event)| {
            json!({
                "assistant": event.payload.get("message").and_then(Value::as_str),
                "failureKind": Value::Null,
                "harness": "oneagentgraph",
                "id": format!("{session}.{index}"),
                "model": event.payload.get("model").and_then(Value::as_str),
                "reasoning": Value::Null,
                "status": event.kind.0,
                "timestamp": event.ts,
                "tools": Vec::<Value>::new(),
                "unknown": Map::new(),
                "usage": Map::new(),
                "user": event.labels.persona.clone().unwrap_or_default(),
            })
        })
        .collect();
    let mut attribution = Map::new();
    attribution.insert("runId".into(), json!(view.paths.run));
    if let Some(round) = first.and_then(|event| event.labels.round) {
        attribution.insert("round".into(), json!(round));
    }
    if let Some(node) = &node {
        attribution.insert("nodeId".into(), json!(node));
    }
    attribution.insert("launchId".into(), json!(view.paths.run));
    attribution.insert(
        "launcher".into(),
        json!(launcher_word(&view.launch.launcher)),
    );
    attribution.insert("transportRole".into(), json!(TRANSPORT_ROLE));
    attribution.insert(
        "agentRole".into(),
        json!(
            agent_role(first.and_then(|event| event.labels.persona.as_deref())).unwrap_or("worker")
        ),
    );
    if let Some(persona) = first.and_then(|event| event.labels.persona.clone()) {
        attribution.insert("persona".into(), json!(persona));
    }
    attribution.insert(
        "finishedAt".into(),
        last.map_or(Value::Null, |event| json!(event.ts)),
    );
    json!({
        "conversation": {
            "canContinue": false,
            "harnesses": ["oneagentgraph"],
            "id": session,
            "name": node.clone().unwrap_or_else(|| view.paths.run.clone()),
            "project": view.paths.run,
            "startedAt": started_at,
            "state": last.map_or("unknown", |event| event.kind.0.as_str()),
            "turns": turns,
        },
        "attribution": Value::Object(attribution),
    })
}

/// One conversation by id, or `None` when the run records none by that name.
#[must_use]
pub fn conversation(view: &RunView, id: &ConversationId) -> Option<Value> {
    conversations(view)
        .into_iter()
        .find(|document| document["conversation"]["id"] == json!(id.as_str()))
}

/// One recorded artifact's bounded tail, or `None` when the run records none.
///
/// The id has already crossed the trust boundary as an [`ArtifactId`], so it is
/// a bare path segment; it is still resolved only against the ids the run's own
/// envelopes recorded, so a well-formed id naming a file the run never produced
/// reads nothing.
#[must_use]
pub fn artifact(view: &RunView, id: &ArtifactId) -> Option<Value> {
    let recorded = view.events.iter().find_map(|event| {
        event
            .artifacts
            .iter()
            .find(|artifact| artifact.id.0 == id.as_str())
    })?;
    let path = view.paths.dir.join("artifacts").join(id.as_str());
    let bytes = fs::read(&path).ok()?;
    let truncated = bytes.len() > ARTIFACT_TAIL_BYTES;
    let tail = &bytes[bytes.len().saturating_sub(ARTIFACT_TAIL_BYTES)..];
    Some(json!({
        "id": id.as_str(),
        "kind": reference_kind(&recorded.kind),
        "content": String::from_utf8_lossy(tail),
        "truncated": truncated,
    }))
}

/// The wire's closed reference vocabulary, from the producing library's own word
/// for the artifact. Anything unrecognized is a log, which is what the producing
/// libraries store.
fn reference_kind(kind: &str) -> &'static str {
    match kind {
        "conversation" => "conversation",
        "worker_report" | "report" => "worker_report",
        "oneharness_session" | "session" => "oneharness_session",
        "pr" => "pr",
        _ => "gate_log",
    }
}

/// The scope a timeline request asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope<'a> {
    /// Every round of the run and the nodes under them.
    Run,
    /// One node's own work.
    Node(&'a NodeId),
}

/// The whole of `GET /api/v2/runs/{run}/timeline`'s payload.
#[must_use]
pub fn timeline(view: &RunView, scope: &Scope<'_>) -> Value {
    let spans = match scope {
        Scope::Run => run_spans(view),
        Scope::Node(node) => node_spans(view, node.as_str()),
    };
    json!({
        "timeline_schema_version": TIMELINE_SCHEMA_VERSION,
        "run_id": view.paths.run,
        "spans": spans,
    })
}

/// One journal envelope as a timeline event.
fn timeline_event(index: usize, event: &Envelope) -> Value {
    let mut item = Map::new();
    item.insert("id".into(), json!(format!("e{index}")));
    item.insert("kind".into(), json!(event.kind.0));
    item.insert("at".into(), json!(event.ts));
    if let Some(node) = &event.labels.node {
        item.insert("node_id".into(), json!(node));
    }
    if let Some(step) = &event.labels.step {
        item.insert("step_id".into(), json!(step));
    }
    if let Some(round) = event.labels.round {
        item.insert("round".into(), json!(round));
    }
    if let Some(status) = event.payload.get("status").and_then(Value::as_str) {
        item.insert("status".into(), json!(status));
    }
    Value::Object(item)
}

/// The rounds of the run, each with the nodes it carried beneath it.
fn run_spans(view: &RunView) -> Vec<Value> {
    let mut spans: Vec<Value> = Vec::new();
    for number in 1..=view.state.round.max(1) {
        let events: Vec<(usize, &Envelope)> = view
            .events
            .iter()
            .enumerate()
            .filter(|(_, event)| event.labels.round == Some(number))
            .collect();
        let Some((_, first)) = events.first() else {
            continue;
        };
        let round_id = format!("round-{number:02}");
        let closed = events.iter().any(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::RoundFinished)
        });
        let ended = if closed {
            events.last().map_or(Value::Null, |(_, e)| json!(e.ts))
        } else {
            Value::Null
        };
        spans.push(json!({
            "id": round_id,
            "kind": "round",
            "label": format!("round {number}"),
            "started_at": first.ts,
            "ended_at": ended,
            "round": number,
            "phase": if closed { "reviewing-results" } else { "driving-round" },
            "events": events
                .iter()
                .filter(|(_, event)| event.labels.node.is_none())
                .map(|(index, event)| timeline_event(*index, event))
                .collect::<Vec<_>>(),
        }));
        let mut nodes: Vec<&str> = events
            .iter()
            .filter_map(|(_, event)| event.labels.node.as_deref())
            .collect();
        nodes.dedup();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for node in nodes {
            if !seen.insert(node) {
                continue;
            }
            spans.push(node_span(view, number, node, Some(&round_id)));
        }
    }
    spans
}

/// One node's span within a round.
fn node_span(view: &RunView, round: u64, node: &str, parent: Option<&str>) -> Value {
    let events: Vec<(usize, &Envelope)> = view
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event.labels.round == Some(round) && event.labels.node.as_deref() == Some(node)
        })
        .collect();
    let started = events
        .first()
        .map_or_else(now_rfc3339, |(_, event)| event.ts.clone());
    let settled = events.iter().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
    });
    let mut span = Map::new();
    span.insert("id".into(), json!(format!("node.{round:02}.{node}")));
    span.insert("kind".into(), json!("node"));
    span.insert("label".into(), json!(node));
    span.insert("started_at".into(), json!(started));
    span.insert(
        "ended_at".into(),
        settled.map_or(Value::Null, |(_, event)| json!(event.ts)),
    );
    if let Some(parent) = parent {
        span.insert("parent_id".into(), json!(parent));
    }
    span.insert("node_id".into(), json!(node));
    span.insert("round".into(), json!(round));
    if let Some(status) = settled
        .and_then(|(_, event)| event.payload.get("status"))
        .and_then(Value::as_str)
    {
        span.insert("status".into(), json!(status_word(status)));
    }
    span.insert(
        "events".into(),
        json!(events
            .iter()
            .map(|(index, event)| timeline_event(*index, event))
            .collect::<Vec<_>>()),
    );
    Value::Object(span)
}

/// One node's own work: the node span, then a dispatch span per attempt.
fn node_spans(view: &RunView, node: &str) -> Vec<Value> {
    let mut spans: Vec<Value> = Vec::new();
    for number in 1..=view.state.round.max(1) {
        let events: Vec<(usize, &Envelope)> = view
            .events
            .iter()
            .enumerate()
            .filter(|(_, event)| {
                event.labels.round == Some(number) && event.labels.node.as_deref() == Some(node)
            })
            .collect();
        if events.is_empty() {
            continue;
        }
        let node_id = format!("node.{number:02}.{node}");
        spans.push(node_span(view, number, node, None));
        let settled = events.iter().find(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
        });

        // A node that settled `waiting` is waiting on a person. The wait is real
        // recorded time and is drawn as its own span rather than as silence —
        // including for a human action, which is never dispatched at all and
        // would otherwise contribute no span but its own settlement.
        if let Some((_, wait_start)) = settled.filter(|(_, event)| {
            event.payload.get("status").and_then(Value::as_str) == Some("waiting")
        }) {
            let attested = view.events.iter().find(|event| {
                event.source == Source::Pipeline
                    && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::HumanAttested)
                    && event.labels.node.as_deref() == Some(node)
            });
            spans.push(json!({
                "id": format!("human-wait.{number:02}.{node}"),
                "kind": "human-wait",
                "label": format!("{node} awaiting a person"),
                "started_at": wait_start.ts,
                "ended_at": attested.map_or(Value::Null, |event| json!(event.ts)),
                "parent_id": node_id,
                "node_id": node,
                "round": number,
                "events": Vec::<Value>::new(),
            }));
        }

        let dispatched = events.iter().find(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeDispatched)
        });
        let Some((_, start)) = dispatched else {
            continue;
        };
        let mut span = Map::new();
        span.insert("id".into(), json!(format!("dispatch.{number:02}.{node}")));
        span.insert("kind".into(), json!("dispatch"));
        span.insert("label".into(), json!(format!("{node} dispatch")));
        span.insert("started_at".into(), json!(start.ts));
        span.insert(
            "ended_at".into(),
            settled.map_or(Value::Null, |(_, event)| json!(event.ts)),
        );
        span.insert("parent_id".into(), json!(node_id));
        span.insert("node_id".into(), json!(node));
        span.insert("round".into(), json!(number));
        span.insert(
            "dispatch_id".into(),
            json!(dispatch_key(&view.paths.run, number, node)),
        );
        span.insert("transport_role".into(), json!(TRANSPORT_ROLE));
        if let Some(role) = agent_role(start.labels.persona.as_deref()) {
            span.insert("agent_role".into(), json!(role));
        }
        if let Some(status) = settled
            .and_then(|(_, event)| event.payload.get("status"))
            .and_then(Value::as_str)
        {
            span.insert("status".into(), json!(status_word(status)));
        }
        span.insert(
            "events".into(),
            json!(events
                .iter()
                .filter(|(_, event)| event.source == Source::Agentgraph)
                .map(|(index, event)| timeline_event(*index, event))
                .collect::<Vec<_>>()),
        );
        spans.push(Value::Object(span));
    }
    spans
}

/// A change token for one run: what a poll compares to decide it moved.
#[must_use]
pub fn signature(view: &RunView) -> (u64, usize, u64) {
    (
        view.state.round,
        view.events.len(),
        view.state.last_write_at.unwrap_or(0),
    )
}

/// A change token for one run's transcripts, so a watcher can tell an edited
/// turn from a new one.
#[must_use]
pub fn conversation_signature(view: &RunView) -> String {
    let mut hasher = Sha256::new();
    for document in conversations(view) {
        hasher.update(document.to_string().as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .take(8)
        .fold(String::new(), |mut out, byte| {
            out.push_str(&format!("{byte:02x}"));
            out
        })
}
