//! The contract tests: `docs/contract.md` is the source of truth, and these
//! hold the crate's types to it.
//!
//! Beside them are the contracts this crate keeps with the libraries it reads:
//! the vocabulary `oneagentgraph` declares, and the telemetry document
//! `onepipeline` writes — held here as a parser boundary, which is answerable
//! without starting the process that produced the bytes.
//!
//! Each fixture under `tests/fixtures/` is one endpoint's response body. What
//! they pin is the **envelope** — the schema-version preamble and its
//! byte-for-byte serialization. Their payload bodies carry only the payload
//! facts the contract itself names (session attribution on the run list,
//! `dispatch_id` at schema 10, an empty `conversations` for the opt-out) and are
//! not a claim about the onepipeline SDK's record shapes; those land with the
//! SDK, which is where anything presentation-worthy is computed.

use std::fs;
use std::path::{Path, PathBuf};

use clap::Parser;
use onepipeline_ui::api::ReadApi;
use onepipeline_ui::cli::{Cli, Command, ServeArgs, EXIT_SOFTWARE};
use onepipeline_ui::contract::{
    routes, ArtifactId, ConversationId, DispatchId, Envelope, ErrorEnvelope, EventFrame,
    EventsQuery, Health, HealthStatus, NodeId, PageLimit, RunId, RunQuery, RunsQuery, SseEvent,
    TimelineQuery, TimelineScope, API_VERSION, RUNS_PAGE_LIMIT, TELEMETRY_SCHEMA_VERSION,
    TIMELINE_SCHEMA_VERSION,
};
use onepipeline_ui::store::RunStore;
use onepipeline_ui::ApiError;
use serde_json::Value;

#[path = "support/fixture_run.rs"]
mod fixture_run;

/// The fixture file each route's response body is pinned in.
const ROUTE_FIXTURES: [(&str, &str); 7] = [
    (routes::HEALTHZ, "healthz.json"),
    (routes::RUNS, "runs.json"),
    (routes::RUN, "run.json"),
    (routes::RUN_TIMELINE, "run-timeline.json"),
    (routes::RUN_CONVERSATION, "run-conversation.json"),
    (routes::RUN_ARTIFACT, "run-artifact.json"),
    (routes::EVENTS, "events.json"),
];

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn read_fixture(name: &str) -> String {
    let path = fixture_dir().join(name);
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

/// The env var that rewrites the goldens from what the server actually served.
const UPDATE: &str = "UPDATE_CONTRACT_FIXTURES";

/// `observed_at` is the instant of the read, so it is the one field a golden
/// cannot pin. It is replaced by the instant the fixture claims, which keeps the
/// rest of the document — the whole payload — compared byte for byte.
const OBSERVED_AT: &str = "2026-08-07T12:00:00Z";

fn contract_text() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/contract.md");
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

/// Re-serialize `value` the way a fixture is written: pretty, one trailing newline.
fn canonical<T: serde::Serialize>(value: &T) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).expect("serialize")
    )
}

#[test]
fn every_route_the_contract_documents_is_in_the_route_table() {
    let contract = contract_text();
    for route in routes::ALL {
        // The contract writes `{run}` and `{id}` exactly as the route templates do.
        assert!(
            contract.contains(route),
            "docs/contract.md does not document the route {route}"
        );
    }
}

#[test]
fn the_route_table_documents_no_route_the_contract_does_not() {
    let contract = contract_text();
    let documented: Vec<&str> = contract
        .lines()
        .filter_map(|line| line.strip_prefix("GET "))
        .map(|rest| rest.split_whitespace().next().unwrap_or_default())
        .collect();
    assert_eq!(
        documented,
        routes::ALL.to_vec(),
        "the route table and docs/contract.md list different routes, or list them in a different order"
    );
}

#[test]
fn every_route_has_a_fixture() {
    let mapped: Vec<&str> = ROUTE_FIXTURES.iter().map(|(route, _)| *route).collect();
    assert_eq!(
        mapped,
        routes::ALL.to_vec(),
        "a route has no pinned fixture"
    );
    for (route, fixture) in ROUTE_FIXTURES {
        assert!(
            fixture_dir().join(fixture).is_file(),
            "{route} has no fixture at tests/fixtures/{fixture}"
        );
    }
}

/// Serve every route against a real recorded run and hold the result to the
/// checked-in goldens.
///
/// The fixtures are not hand-written claims about the payloads: they are what
/// this server made of the run directory in `tests/support/fixture_run.rs`,
/// which is a directory the onepipeline SDK itself writes. A payload change is
/// therefore a golden change in the same commit, and re-running with
/// `UPDATE_CONTRACT_FIXTURES=1` is how that change is made deliberately.
#[test]
fn every_route_serves_the_payload_its_golden_pins() {
    let root = tempfile::tempdir().expect("temp dir");
    fixture_run::write(root.path(), fixture_run::RUN_ID);
    fixture_run::write(root.path(), fixture_run::OTHER_RUN_ID);
    let runs_root: onepipeline_ui::cli::RunsRoot = root
        .path()
        .to_str()
        .expect("utf-8 path")
        .parse()
        .expect("a readable runs root");
    let store = RunStore::new(&runs_root);
    let run = RunId::try_from(fixture_run::RUN_ID).expect("valid");

    // The timings in these goldens are `onepipeline`'s own document, read through
    // its CLI, and every one of them is `null` when that CLI cannot be asked. So
    // the sibling being missing would quietly rewrite the goldens to say the run
    // had no clock — checked here rather than discovered in a diff.
    let served = store
        .run(
            &run,
            &RunQuery {
                include_conversations: false,
                filter: None,
            },
        )
        .expect("the fixture run serves");
    assert!(
        !served.payload["run"]["timing"]["wall_ms"].is_null(),
        "the sibling that aggregates a run's telemetry did not answer, so every timing here \
         would be pinned absent — run `just bootstrap` to provision the `onepipeline` build \
         the lock pins, or name one with ONEPIPELINE_UI_ONEPIPELINE_BIN"
    );

    let served: [(&str, Value); 6] = [
        (
            "runs.json",
            enveloped(store.runs(&RunsQuery {
                include_settled: true,
                ..RunsQuery::default()
            })),
        ),
        (
            "run.json",
            enveloped(store.run(
                &run,
                &RunQuery {
                    include_conversations: true,
                    filter: None,
                },
            )),
        ),
        (
            "run-timeline.json",
            enveloped(store.timeline(
                &run,
                &TimelineQuery {
                    scope: TimelineScope::Node {
                        node: NodeId::try_from(fixture_run::NODE_ID).expect("valid"),
                    },
                    filter: None,
                },
            )),
        ),
        (
            "run-conversation.json",
            enveloped(store.conversation(
                &run,
                &ConversationId::try_from(fixture_run::CONVERSATION_ID).expect("valid"),
            )),
        ),
        (
            "run-artifact.json",
            enveloped(store.artifact(
                &run,
                &ArtifactId::try_from(fixture_run::ARTIFACT_ID).expect("valid"),
            )),
        ),
        (
            "events.json",
            serde_json::to_value(
                store
                    .events(&EventsQuery::default())
                    .expect("the stream opens")
                    .next()
                    .expect("a fresh snapshot opens every connection"),
            )
            .expect("serialize the frame"),
        ),
    ];

    for (name, document) in served {
        let rendered = canonical(&normalized(document));
        if std::env::var_os(UPDATE).is_some() {
            fs::write(fixture_dir().join(name), &rendered).expect("rewrite the golden");
            continue;
        }
        assert_eq!(
            rendered,
            read_fixture(name),
            "tests/fixtures/{name} is not what the server serves — \
             re-run with {UPDATE}=1 to accept the change deliberately"
        );
    }
}

/// The envelope a route served, as JSON, or the failure that stops the golden
/// being written at all.
fn enveloped(served: Result<Envelope<Value>, ApiError>) -> Value {
    serde_json::to_value(served.expect("the fixture run serves every route")).expect("serialize")
}

/// The same document with the read's own instant replaced, wherever it appears.
fn normalized(document: Value) -> Value {
    match document {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| {
                    if key == "observed_at" {
                        (key, Value::String(OBSERVED_AT.to_owned()))
                    } else {
                        (key, normalized(value))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(normalized).collect()),
        other => other,
    }
}

/// The liveness body, and the release it names.
///
/// The version is the point of the second field: a golden carrying a release
/// this crate no longer links would have a host prove its engine and its reader
/// match against a number nothing kept true, so the SDK pin and this golden move
/// in one change or this fails.
#[test]
fn the_health_body_round_trips_and_names_the_release_this_crate_links() {
    let raw = read_fixture("healthz.json");
    let health: Health = serde_json::from_str(&raw).expect("parse healthz.json");
    assert_eq!(health.status, HealthStatus::Ok);
    assert_eq!(
        health.onepipeline_version,
        onepipeline::VERSION,
        "tests/fixtures/healthz.json pins an `onepipeline` release this crate does not link"
    );
    assert_eq!(canonical(&health), raw);
}

#[test]
fn every_enveloped_fixture_round_trips_byte_for_byte() {
    for (route, fixture) in ROUTE_FIXTURES {
        if route == routes::HEALTHZ || route == routes::EVENTS {
            continue; // Not enveloped, and enveloped one level down, respectively.
        }
        let raw = read_fixture(fixture);
        let envelope: Envelope<Value> =
            serde_json::from_str(&raw).unwrap_or_else(|err| panic!("parse {fixture}: {err}"));
        assert_eq!(envelope.api_version, API_VERSION, "{fixture}");
        assert_eq!(
            envelope.telemetry_schema_version, TELEMETRY_SCHEMA_VERSION,
            "{fixture}"
        );
        assert_eq!(canonical(&envelope), raw, "{fixture} does not round-trip");
    }
}

#[test]
fn the_schema_version_the_envelope_carries_is_the_one_the_contract_names() {
    // The contract names the version in prose; the constant is what is served.
    assert_eq!(TELEMETRY_SCHEMA_VERSION, 13);
    assert!(contract_text().contains(&format!("schema {TELEMETRY_SCHEMA_VERSION}")));
    assert_eq!(API_VERSION, 2);
    assert!(routes::RUNS.starts_with("/api/v2/"));
}

/// The two versions move independently, and the browser client carries a copy of
/// each across the language boundary.
///
/// TypeScript cannot read a Rust constant, so this is the gate between them:
/// bump either here and the client's copy fails until it follows — which is what
/// stops a server serving one meaning while the client renders another.
#[test]
fn the_browser_clients_copy_of_each_schema_version_matches_this_one() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("packages/dag-model/src/index.ts");
    let source = fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "read {}: {err} — the model that carries the copies has moved, so this gate no \
             longer guards anything",
            path.display()
        )
    });
    for declaration in [
        format!("export const TELEMETRY_SCHEMA_VERSION = {TELEMETRY_SCHEMA_VERSION};"),
        format!("export const TIMELINE_SCHEMA_VERSION = {TIMELINE_SCHEMA_VERSION};"),
    ] {
        assert!(
            source.contains(&declaration),
            "{} does not declare `{declaration}`; the client's schema versions have drifted \
             from this crate's",
            path.display()
        );
    }
}

#[test]
fn the_event_frame_round_trips_and_opens_with_a_snapshot() {
    let raw = read_fixture("events.json");
    let frame: EventFrame = serde_json::from_str(&raw).expect("parse events.json");
    assert_eq!(
        frame.id, 0,
        "a connection's first frame is its fresh snapshot"
    );
    assert_eq!(frame.event, SseEvent::Snapshot);
    let snapshot: Envelope<Value> =
        serde_json::from_value(frame.data.clone()).expect("the snapshot is enveloped");
    assert_eq!(snapshot.telemetry_schema_version, TELEMETRY_SCHEMA_VERSION);
    assert!(
        snapshot.payload.get("runs").is_some(),
        "the snapshot carries the state a fresh connection needs"
    );
    assert_eq!(canonical(&frame), raw);
}

#[test]
fn the_run_list_carries_session_attribution() {
    let raw = read_fixture("runs.json");
    let envelope: Envelope<Value> = serde_json::from_str(&raw).expect("parse runs.json");
    let runs = envelope.payload["runs"]
        .as_array()
        .expect("runs is an array");
    assert!(!runs.is_empty());
    for run in runs {
        RunId::try_from(run["run_id"].as_str().expect("run_id is a string")).expect("valid run id");
        let launch = run
            .get("launch")
            .expect("every run carries its session attribution");
        assert!(
            launch["launch_id"].is_string() && launch["launcher"].is_string(),
            "the attribution names the launch and its launcher"
        );
    }
}

#[test]
fn a_dispatch_span_carries_a_dispatch_id_this_crate_can_name() {
    let raw = read_fixture("run-timeline.json");
    let envelope: Envelope<Value> = serde_json::from_str(&raw).expect("parse run-timeline.json");
    let spans = envelope.payload["spans"]
        .as_array()
        .expect("spans is an array");
    let dispatch = spans
        .iter()
        .find(|span| span["kind"] == "dispatch")
        .expect("a node timeline carries the dispatch that did its work")["dispatch_id"]
        .as_str()
        .expect("dispatch_id is a string");
    assert_eq!(
        DispatchId::try_from(dispatch)
            .expect("valid dispatch id")
            .as_str(),
        dispatch
    );
}

#[test]
fn the_error_envelope_round_trips_and_matches_the_error_it_renders() {
    let raw = read_fixture("error.json");
    let envelope: ErrorEnvelope = serde_json::from_str(&raw).expect("parse error.json");
    assert_eq!(canonical(&envelope), raw);
    let error = ApiError::RunNotFound(RunId::try_from("run-20260807-a1b2c3").expect("valid"));
    assert_eq!(error.envelope(), envelope);
}

#[test]
fn every_error_maps_to_its_code_and_status() {
    let reason = "why".to_owned();
    let id = "why-1";
    let cases: [(ApiError, &str, u16); 11] = [
        (
            ApiError::InvalidRequest(reason.clone()),
            "invalid_request",
            422,
        ),
        (
            ApiError::InvalidRunId(reason.clone()),
            "invalid_run_id",
            422,
        ),
        (
            ApiError::InvalidNodeId(reason.clone()),
            "invalid_node_id",
            422,
        ),
        (
            ApiError::InvalidConversationId(reason.clone()),
            "invalid_conversation_id",
            422,
        ),
        (
            ApiError::InvalidArtifactId(reason.clone()),
            "invalid_artifact_id",
            422,
        ),
        (
            ApiError::InvalidDispatchId(reason.clone()),
            "invalid_dispatch_id",
            422,
        ),
        (
            ApiError::RunNotFound(RunId::try_from(id).expect("valid")),
            "run_not_found",
            404,
        ),
        (
            ApiError::ConversationNotFound(ConversationId::try_from(id).expect("valid")),
            "conversation_not_found",
            404,
        ),
        (
            ApiError::ArtifactNotFound(ArtifactId::try_from(id).expect("valid")),
            "artifact_not_found",
            404,
        ),
        (
            ApiError::ProjectionFailed(reason.clone()),
            "projection_error",
            409,
        ),
        (ApiError::Read(reason), "read_error", 500),
    ];
    for (error, code, status) in cases {
        assert_eq!(error.code(), code);
        assert_eq!(error.status(), status);
        let rendered = error.envelope();
        assert_eq!(rendered.error.code, code);
        assert_eq!(rendered.error.message, error.to_string());
        assert!(rendered.error.message.contains("why"));
    }
    // The one failure that names nothing back: a path this server has no route
    // for, which still answers in the same envelope as every other.
    assert_eq!(ApiError::NoSuchRoute.code(), "no_such_route");
    assert_eq!(ApiError::NoSuchRoute.status(), 404);
    assert_eq!(
        ApiError::NoSuchRoute.envelope().error.message,
        "no such route"
    );
}

#[test]
fn identifiers_accept_a_bare_path_segment() {
    for value in ["run-20260807-a1b2c3", "node_1", "a.b", "x"] {
        assert_eq!(RunId::try_from(value).expect("accepted").as_str(), value);
        assert_eq!(RunId::try_from(value).expect("accepted").to_string(), value);
        assert_eq!(
            String::from(RunId::try_from(value).expect("accepted")),
            value
        );
    }
}

#[test]
fn identifiers_reject_anything_that_is_not_one() {
    let too_long = "a".repeat(129);
    let cases: [(&str, &str); 6] = [
        ("", "must not be empty"),
        (&too_long, "at most 128"),
        ("a/b", "ASCII letters"),
        ("../etc", "ASCII letters"),
        ("a b", "ASCII letters"),
        (".hidden", "must not start"),
    ];
    for (value, expected) in cases {
        let error = RunId::try_from(value).expect_err("rejected");
        assert_eq!(error.code(), "invalid_run_id");
        assert!(error.to_string().contains(expected), "{value:?} -> {error}");
    }
    // Each identifier reports itself, so a client learns which one was wrong.
    assert_eq!(
        NodeId::try_from("a/b").expect_err("rejected").code(),
        "invalid_node_id"
    );
    assert_eq!(
        ConversationId::try_from("a/b")
            .expect_err("rejected")
            .code(),
        "invalid_conversation_id"
    );
    assert_eq!(
        ArtifactId::try_from("a/b").expect_err("rejected").code(),
        "invalid_artifact_id"
    );
    assert_eq!(
        DispatchId::try_from("a/b").expect_err("rejected").code(),
        "invalid_dispatch_id"
    );
}

#[test]
fn identifiers_are_validated_when_they_are_deserialized() {
    let ok: RunId = serde_json::from_str("\"run-1\"").expect("accepted");
    assert_eq!(ok.as_str(), "run-1");
    let err = serde_json::from_str::<RunId>("\"../etc\"").expect_err("rejected");
    assert!(err.to_string().contains("invalid run id"), "{err}");
    assert_eq!(serde_json::to_string(&ok).expect("serialize"), "\"run-1\"");
}

#[test]
fn the_run_query_serves_conversations_unless_asked_not_to() {
    let default: RunQuery = serde_json::from_str("{}").expect("parse");
    assert!(default.include_conversations, "the opt-out is opt-in");
    let opted_out: RunQuery =
        serde_json::from_str(r#"{"include_conversations":false}"#).expect("parse");
    assert!(!opted_out.include_conversations);
    assert_eq!(
        serde_json::to_string(&opted_out).expect("serialize"),
        r#"{"include_conversations":false}"#
    );
}

#[test]
fn the_timeline_query_pairs_a_node_with_node_scope_and_only_node_scope() {
    let run: TimelineQuery = serde_json::from_str(r#"{"scope":"run"}"#).expect("parse");
    assert_eq!(run.scope, TimelineScope::Run);
    let node: TimelineQuery =
        serde_json::from_str(r#"{"scope":"node","node":"contract-interface"}"#).expect("parse");
    assert_eq!(
        node.scope,
        TimelineScope::Node {
            node: NodeId::try_from("contract-interface").unwrap()
        }
    );
    assert_eq!(
        serde_json::to_string(&node).expect("serialize"),
        r#"{"scope":"node","node":"contract-interface"}"#
    );
    // `scope=node` with no node, and a scope the contract does not define, are
    // both unrepresentable rather than validated after parsing. `round` is named
    // here on purpose: it was never a scope, and now it is not a thing a run has.
    assert!(serde_json::from_str::<TimelineQuery>(r#"{"scope":"node"}"#).is_err());
    assert!(serde_json::from_str::<TimelineQuery>(r#"{"scope":"round"}"#).is_err());
}

#[test]
fn the_serve_surface_parses_and_defaults_to_loopback() {
    let runs = tempfile::tempdir().expect("temp dir");
    let root = runs.path().to_str().expect("utf-8 path");
    let cli =
        Cli::try_parse_from(["onepipeline-api", "serve", "--runs-root", root]).expect("parse");
    let Command::Serve(args) = &cli.command;
    assert_eq!(args.runs_root.as_path(), runs.path());
    assert_eq!(args.bind.to_string(), "127.0.0.1:8765");
    assert_eq!(cli.command.name(), "serve");

    let bound = Cli::try_parse_from([
        "onepipeline-api",
        "serve",
        "--runs-root",
        root,
        "--bind",
        "0.0.0.0:9000",
    ])
    .expect("parse");
    let Command::Serve(args) = &bound.command;
    assert_eq!(args.bind.to_string(), "0.0.0.0:9000");
}

#[test]
fn the_serve_surface_is_also_the_config_schema() {
    let runs = tempfile::tempdir().expect("temp dir");
    assert_config_names_the_same_root(runs.path());
}

/// A root whose own name is a JSON escape sequence, which the encoded form has
/// to survive. Unix-only because Windows forbids both characters in a file
/// name — but this is exactly the Windows shape, where every separator in
/// `C:\Users\...` is the `\` this covers.
#[cfg(unix)]
#[test]
fn a_runs_root_whose_name_needs_json_escaping_round_trips() {
    let parent = tempfile::tempdir().expect("temp dir");
    let runs = parent.path().join(r#"runs\u0041"quoted"#);
    fs::create_dir(&runs).expect("create the awkwardly named root");
    assert_config_names_the_same_root(&runs);
}

/// A configuration file naming `root` parses to it, defaults its bind address,
/// and re-serializes to the same document.
fn assert_config_names_the_same_root(root: &Path) {
    // Encoded by serde rather than interpolated raw: a root carrying a `\` — a
    // separator in every Windows path — is an escape inside a JSON string, so
    // pasting one in makes this a parse error rather than a schema claim.
    let encoded = serde_json::to_string(root).expect("encode the root as JSON");
    let args: ServeArgs =
        serde_json::from_str(&format!(r#"{{"runs_root":{encoded}}}"#)).expect("parse config");
    assert_eq!(args.runs_root.as_path(), root);
    assert_eq!(args.bind.to_string(), "127.0.0.1:8765");
    assert_eq!(args.poll_interval_ms, onepipeline_ui::cli::DEFAULT_POLL_MS);
    assert_eq!(
        serde_json::to_string(&args).expect("serialize"),
        format!(r#"{{"runs_root":{encoded},"bind":"127.0.0.1:8765","poll_interval_ms":500}}"#)
    );
}

#[test]
fn a_config_file_cannot_name_a_runs_root_the_cli_would_reject() {
    let err = serde_json::from_str::<ServeArgs>(r#"{"runs_root":"/no/such/runs/root"}"#)
        .expect_err("rejected");
    assert!(
        err.to_string().contains("is not a readable directory"),
        "{err}"
    );
}

/// The flag refuses a poll of no milliseconds; a config file is the other way
/// into the same field, and it has to refuse the same number. Clamping it here
/// would leave the two boundaries disagreeing about what `0` means.
#[test]
fn a_config_file_cannot_name_a_poll_interval_the_cli_would_reject() {
    let runs = tempfile::tempdir().expect("temp dir");
    let encoded = serde_json::to_string(runs.path()).expect("encode the root as JSON");
    let err = serde_json::from_str::<ServeArgs>(&format!(
        r#"{{"runs_root":{encoded},"poll_interval_ms":0}}"#
    ))
    .expect_err("rejected");
    assert!(err.to_string().contains("nonzero"), "{err}");
}

/// The page bound is the type's, so it holds on every way into the query rather
/// than only on the one the route happens to parse a field at a time. A
/// `RunsQuery` read whole from JSON must not be a way past it.
#[test]
fn a_run_list_query_cannot_carry_a_page_size_outside_the_bound() {
    for (asked, served) in [("0", 1), ("100000", RUNS_PAGE_LIMIT), ("10", 10)] {
        let query: RunsQuery =
            serde_json::from_str(&format!(r#"{{"limit":{asked}}}"#)).expect("parse the query");
        assert_eq!(query.page(), served, "limit={asked}");
    }
    // And it goes back out as the number it actually serves, not the one asked
    // for: a client reading its own query back has to see the page it will get.
    let query = RunsQuery {
        limit: PageLimit::clamping(100_000),
        ..RunsQuery::default()
    };
    let encoded: Value = serde_json::to_value(&query).expect("serialize the query");
    assert_eq!(encoded["limit"], serde_json::json!(RUNS_PAGE_LIMIT));
}

/// The browser client sends the page bound explicitly so its continuation pages
/// stay the size the first one was, which means it carries its own copy of
/// [`RUNS_PAGE_LIMIT`] across the language boundary. That copy is not derived
/// from this one — TypeScript cannot read a Rust constant — so this is the gate
/// that keeps the two from drifting: raise the bound here and the client's copy
/// fails this test until it follows.
#[test]
fn the_browser_clients_copy_of_the_page_bound_matches_this_one() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("packages/telemetry-client/src/index.ts");
    let source = fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "read {}: {err} — the client that carries the copy has moved, so this gate no longer \
             guards anything",
            path.display()
        )
    });
    let declaration = format!("const RUNS_PAGE_LIMIT = {RUNS_PAGE_LIMIT};");
    assert!(
        source.contains(&declaration),
        "{} does not declare `{declaration}`; the client's page bound has drifted from this \
         crate's RUNS_PAGE_LIMIT = {RUNS_PAGE_LIMIT}",
        path.display()
    );
}

#[test]
fn the_software_failure_status_is_distinct_from_success_and_usage() {
    assert_ne!(EXIT_SOFTWARE, 0);
    assert_ne!(EXIT_SOFTWARE, 2);
}

/// The trait is what the axum server and the SDK-backed store are written
/// against, so it has to be implementable; this proves it is object-safe enough
/// to hold a real store and that its method shapes line up with the contract.
struct Unimplemented;

impl ReadApi for Unimplemented {
    type Events = std::vec::IntoIter<EventFrame>;

    fn health(&self) -> Health {
        Health {
            status: HealthStatus::Ok,
            onepipeline_version: onepipeline::VERSION.to_owned(),
        }
    }

    fn runs(&self, _query: &RunsQuery) -> Result<Envelope<Value>, ApiError> {
        Err(ApiError::Read("not implemented".to_owned()))
    }

    fn run(&self, run: &RunId, _query: &RunQuery) -> Result<Envelope<Value>, ApiError> {
        Err(ApiError::RunNotFound(run.clone()))
    }

    fn timeline(&self, run: &RunId, _query: &TimelineQuery) -> Result<Envelope<Value>, ApiError> {
        Err(ApiError::RunNotFound(run.clone()))
    }

    fn conversation(
        &self,
        _run: &RunId,
        conversation: &ConversationId,
    ) -> Result<Envelope<Value>, ApiError> {
        Err(ApiError::ConversationNotFound(conversation.clone()))
    }

    fn artifact(&self, _run: &RunId, artifact: &ArtifactId) -> Result<Envelope<Value>, ApiError> {
        Err(ApiError::ArtifactNotFound(artifact.clone()))
    }

    fn events(&self, _query: &EventsQuery) -> Result<Self::Events, ApiError> {
        Ok(Vec::new().into_iter())
    }
}

#[test]
fn the_read_trait_covers_every_route_and_is_implementable() {
    let api = Unimplemented;
    let run = RunId::try_from("run-1").expect("valid");
    assert_eq!(api.health().status, HealthStatus::Ok);
    assert_eq!(
        api.runs(&RunsQuery::default()).expect_err("stub").status(),
        500
    );
    assert_eq!(
        api.run(
            &run,
            &RunQuery {
                include_conversations: true,
                filter: None
            }
        )
        .expect_err("stub")
        .code(),
        "run_not_found"
    );
    assert_eq!(
        api.timeline(
            &run,
            &TimelineQuery {
                scope: TimelineScope::Run,
                filter: None
            }
        )
        .expect_err("stub")
        .status(),
        404
    );
    assert_eq!(
        api.conversation(&run, &ConversationId::try_from("c-1").expect("valid"))
            .expect_err("stub")
            .code(),
        "conversation_not_found"
    );
    assert_eq!(
        api.artifact(&run, &ArtifactId::try_from("a-1").expect("valid"))
            .expect_err("stub")
            .code(),
        "artifact_not_found"
    );
    assert_eq!(
        api.events(&EventsQuery::default()).expect("stub").count(),
        0
    );
}

/// The `oneagentgraph` vocabulary this crate reads, against that library's own
/// declaration of it.
///
/// The names in `payload::graph` are a copy — the stack has no shared crate, and
/// each producer owns its own envelope types — so this is the gate that keeps the
/// copy honest: a kind or a usage field renamed there fails here rather than in
/// a payload that silently stops carrying what a turn consumed.
///
/// `onevcs` has no equivalent gate to offer. Its event module is private in every
/// published version, so the only declaration of its vocabulary a consumer can
/// reach is the wire itself; `tests/support/fixture_run.rs` writes those records
/// as that library emits them, and the goldens are what pins the reading.
#[test]
fn the_agent_graph_vocabulary_this_crate_reads_is_the_one_that_library_declares() {
    use onepipeline_ui::payload::graph;

    let wire = |kind: oneagentgraph::event::EventKind| {
        serde_json::to_value(kind)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .expect("a kind serializes as its wire string")
    };
    assert_eq!(
        wire(oneagentgraph::event::EventKind::TurnActivity),
        graph::TURN_ACTIVITY
    );
    assert_eq!(
        wire(oneagentgraph::event::EventKind::TurnCompleted),
        graph::TURN_COMPLETED
    );
    // The six names the turn-control reading rests on: three that say a member is
    // in a turn and three that say it is not. A kind renamed there fails here
    // rather than making every in-flight node read as un-redirectable.
    assert_eq!(
        wire(oneagentgraph::event::EventKind::TurnStarted),
        graph::TURN_STARTED
    );
    assert_eq!(
        wire(oneagentgraph::event::EventKind::TurnInterrupted),
        graph::TURN_INTERRUPTED
    );
    assert_eq!(
        wire(oneagentgraph::event::EventKind::MemberDied),
        graph::MEMBER_DIED
    );
    assert_eq!(
        wire(oneagentgraph::event::EventKind::MemberSettled),
        graph::MEMBER_SETTLED
    );

    // The `turn-interrupted` payload, as that library writes it: every key this
    // crate reads is one of its fields, and none of its fields is one this crate
    // has no reading for. The refusal carries a reason and the delivery does not,
    // which is the discipline the served `redirection` keeps in turn.
    let refused = serde_json::to_value(oneagentgraph::event::TurnInterrupted {
        member: "worker".into(),
        delivered: false,
        input_bytes: 31,
        reason: Some("the member is between turns".into()),
    })
    .expect("the refusal serializes");
    let declared: Vec<&str> = refused
        .as_object()
        .expect("a mapping")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        declared,
        vec![
            graph::MEMBER,
            graph::DELIVERED,
            graph::INPUT_BYTES,
            graph::REASON
        ]
    );
    let delivered = serde_json::to_value(oneagentgraph::event::TurnInterrupted {
        member: "worker".into(),
        delivered: true,
        input_bytes: 31,
        reason: None,
    })
    .expect("the delivery serializes");
    assert!(
        delivered.get(graph::REASON).is_none(),
        "a delivered redirection has no reason it did not land: {delivered}"
    );

    // The payload a `turn-completed` carries, as that library writes it: every
    // key this crate reads is one of its fields, and none of its fields is one
    // this crate has no reading for.
    let usage = serde_json::to_value(oneagentgraph::event::Usage {
        tokens_in: 1,
        tokens_out: 2,
        cache_read: 3,
        cache_write: 4,
        cost: 0.5,
        duration: 1.5,
    })
    .expect("the usage record serializes");
    let read = [
        graph::TOKENS_IN,
        graph::TOKENS_OUT,
        graph::CACHE_READ,
        graph::CACHE_WRITE,
        graph::COST,
        graph::DURATION,
    ];
    let declared: Vec<&str> = usage
        .as_object()
        .expect("a mapping")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(declared, read.to_vec());
    assert_eq!(
        serde_json::to_value(oneagentgraph::event::TurnCompleted {
            usage: oneagentgraph::event::Usage {
                tokens_in: 1,
                tokens_out: 2,
                cache_read: 3,
                cache_write: 4,
                cost: 0.5,
                duration: 1.5,
            },
        })
        .expect("the payload serializes")
        .as_object()
        .and_then(|payload| payload.keys().next().cloned()),
        Some(graph::USAGE.to_owned()),
        "the usage sits where this crate looks for it"
    );
}

/// The `context` edit whose delivery this crate serves, against the SDK's own
/// declaration of it.
///
/// `onepipeline` declares `edits::Operation` and `edits::Delivery` in a private
/// module, so the compiled operation an `edit-committed` carries is read as the
/// wire strings that library writes — the same terms as the `onevcs` vocabulary,
/// and for the same reason. What *is* public beside it is the submitted
/// `channel::Command`, and it is what fixes the two words the operation's
/// `delivery` can hold: `live` is the mode a planner asks for and `next` is the
/// mode that refuses it, so a rename there is a rename of what this crate reads.
///
/// Making that module public is the proposal recorded in `src/AGENTS.md`; until
/// it lands, this plus the goldens written from a real reconciler's records is
/// the whole of the gate available.
#[test]
fn the_live_edit_this_crate_reads_a_delivery_off_is_the_one_the_sdk_declares() {
    use onepipeline::channel::{Command, Deliver};

    let submitted = |deliver: Deliver| {
        serde_json::to_value(Command::Context {
            id: "docs".into(),
            note: "and the control field".into(),
            deliver,
        })
        .expect("the command serializes")
    };
    // The shape `tests/support/fixture_run.rs` writes onto an `edit-committed`.
    assert_eq!(
        submitted(Deliver::Auto),
        serde_json::json!({ "op": "context", "id": "docs", "note": "and the control field" }),
        "an edit that says nothing about delivery is the edit the table always described"
    );
    assert_eq!(
        submitted(Deliver::Live)["deliver"],
        serde_json::json!("live"),
        "the word a delivered note's `delivery` is recorded as"
    );
    assert_eq!(
        submitted(Deliver::Next)["deliver"],
        serde_json::json!("next"),
        "the mode that only ever defers, which is the other half of the pair"
    );
}

/// The browser fixture writes tool summaries a real member could have written,
/// which means it carries a copy of the bound `oneagentgraph` bounds one to.
///
/// TypeScript cannot read a Rust constant and neither can a `.mjs` fixture, so
/// this is the gate that keeps the copy from drifting: raise the bound there and
/// the fixture's copy fails here until it follows.
#[test]
fn the_browser_fixtures_copy_of_the_activity_bound_matches_the_producers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/dag-ui/e2e/fixtures/runs.mjs");
    let source = fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "read {}: {err} — the fixture that carries the copy has moved, so this gate no \
             longer guards anything",
            path.display()
        )
    });
    let declaration = format!(
        "const ACTIVITY_DETAIL_CHARS = {};",
        oneagentgraph::event::MAX_ACTIVITY_DETAIL_CHARS
    );
    assert!(
        source.contains(&declaration),
        "{} does not declare `{declaration}`; the fixture's bound has drifted from \
         oneagentgraph's own MAX_ACTIVITY_DETAIL_CHARS",
        path.display()
    );
}

/// A telemetry document as `onepipeline` writes one, for the tests below to
/// break one property of at a time.
fn telemetry_document() -> Value {
    serde_json::json!({
        "schema_version": 2,
        "run_id": fixture_run::RUN_ID,
        "wall_ms": 31_000,
        "buckets": [
            { "name": "agent", "ms": 13_000 },
            { "name": "judge" },
            { "name": "llmlint" },
            { "name": "gate", "ms": 2_000 },
            { "name": "publication_wait", "ms": 9_000 },
            { "name": "lock_wait", "ms": 1_100 },
            { "name": "setup", "ms": 1_900 },
            { "name": "scheduling", "ms": 4_000 }
        ],
        "usage": {
            "total": { "input": 1_600, "output": 430, "cost_usd": 0.53 }
        },
        "dispatches": 2,
        "settled_done": 2,
        "no_diff": 0,
        "surfaces_queued": 0,
        "surfaces_read": 0
    })
}

/// The document above, with one thing about it changed.
fn document_with(change: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut document = telemetry_document();
    change(&mut document);
    document.to_string().into_bytes()
}

/// The run the document above is about, which is the run these tests ask about.
fn telemetry_run() -> RunId {
    RunId::try_from(fixture_run::RUN_ID).expect("valid")
}

#[test]
fn a_telemetry_document_that_holds_to_its_producers_contract_is_read() {
    let document =
        onepipeline_ui::telemetry::read_document(&telemetry_run(), &document_with(|_| {}))
            .expect("the document a run really produces");
    assert_eq!(document.wall_ms, 31_000);
    assert_eq!(
        document.bucket(onepipeline_ui::telemetry::BucketName::Agent),
        Some(13_000)
    );
    // An unmeasured bucket is present and absent at once: named, so the set is
    // whole, and carrying no span, so nothing reads it as a measured zero.
    assert_eq!(
        document.bucket(onepipeline_ui::telemetry::BucketName::Judge),
        None
    );
    assert_eq!(document.measured_ms(), 31_000);
    assert_eq!(
        document
            .usage_of(onepipeline_ui::telemetry::Party::Total)
            .cost_usd
            .map(onepipeline_ui::telemetry::Cost::get),
        Some(0.53)
    );
    // A party nothing reported for reads as unknown, from its absence.
    assert!(document
        .usage_of(onepipeline_ui::telemetry::Party::Llmlint)
        .is_empty());
}

/// Everything a document can be that this build must not project.
///
/// The producer states each of these about what it writes, and every one of them
/// is a thing a reader would otherwise serve as fact: a bucket set that does not
/// add up, time that was never on the clock, a party reported as having spent
/// nothing when nobody measured it, a whole other run's clock. A malformed
/// document has to become an absence of timing with a reason, never a payload.
#[test]
fn a_document_that_breaks_the_producers_contract_is_refused_by_name() {
    let refusals: [(&str, Vec<u8>, &str); 11] = [
        (
            "not a document at all",
            b"onepipeline: something went wrong".to_vec(),
            "expected value",
        ),
        (
            "a document about another run",
            document_with(|document| {
                document["run_id"] = serde_json::json!(fixture_run::OTHER_RUN_ID);
            }),
            "the document is run `run-20260807-d4e5f6`'s",
        ),
        (
            "a document about no run at all",
            document_with(|document| {
                document
                    .as_object_mut()
                    .expect("a mapping")
                    .remove("run_id");
            }),
            "missing field `run_id`",
        ),
        (
            "a version this build does not read",
            document_with(|document| document["schema_version"] = serde_json::json!(1)),
            "schema_version 1, and this build reads 2",
        ),
        (
            "no version at all",
            document_with(|document| {
                document
                    .as_object_mut()
                    .expect("a mapping")
                    .remove("schema_version");
            }),
            "schema_version absent",
        ),
        (
            "a bucket named twice",
            document_with(|document| {
                document["buckets"][1] = serde_json::json!({ "name": "agent", "ms": 0 });
            }),
            "the `agent` bucket appears 2 times",
        ),
        (
            "a bucket left out",
            document_with(|document| {
                document["buckets"]
                    .as_array_mut()
                    .expect("the buckets")
                    .retain(|bucket| bucket["name"] != serde_json::json!("setup"));
            }),
            "the `setup` bucket appears 0 times",
        ),
        (
            "a bucket this build cannot add up",
            document_with(|document| {
                document["buckets"][2] = serde_json::json!({ "name": "dispatching", "ms": 1 });
            }),
            "unknown variant `dispatching`",
        ),
        (
            "more time measured than the clock ran",
            document_with(|document| document["wall_ms"] = serde_json::json!(1_000)),
            "the buckets measure 31000ms of a 1000ms wall clock",
        ),
        (
            "a party present and reporting nothing",
            document_with(|document| document["usage"]["judge"] = serde_json::json!({})),
            "the `judge` party is present and reports nothing",
        ),
        (
            "a cost that is not an amount of money",
            document_with(|document| {
                document["usage"]["total"]["cost_usd"] = serde_json::json!(-1.0);
            }),
            "the `total` party cost -1.0",
        ),
    ];
    for (what, answered, said) in refusals {
        let refused = onepipeline_ui::telemetry::read_document(&telemetry_run(), &answered)
            .expect_err(&format!("{what} is not a telemetry document"));
        assert!(
            matches!(
                refused,
                onepipeline_ui::telemetry::Unavailable::Unreadable(_)
            ),
            "{what}: {refused:?}"
        );
        assert!(
            refused.to_string().contains(said),
            "{what}: the refusal does not name it — {refused}"
        );
    }
}

/// A number no clock could hold is refused whichever layer notices it.
///
/// `1e999` is valid JSON and not a `f64`, so the reader may refuse it while
/// decoding rather than while checking; both are refusals, and the one thing
/// that must not happen is a cost of infinity reaching a payload.
#[test]
fn a_cost_no_number_can_hold_never_reaches_a_payload() {
    let refused = onepipeline_ui::telemetry::read_document(
        &telemetry_run(),
        &document_with(|document| {
            document["usage"]["total"]["cost_usd"] = serde_json::json!(1e308);
            document["usage"]["total"]["input"] = serde_json::json!(1);
        }),
    )
    .map(|document| {
        document
            .usage_of(onepipeline_ui::telemetry::Party::Total)
            .cost_usd
            .map(onepipeline_ui::telemetry::Cost::get)
    });
    match refused {
        Ok(cost) => assert!(
            cost.is_some_and(f64::is_finite),
            "a cost that reached a payload is a number: {cost:?}"
        ),
        Err(unavailable) => assert!(matches!(
            unavailable,
            onepipeline_ui::telemetry::Unavailable::Unreadable(_)
        )),
    }
    // Written as text rather than through `serde_json::json!`, because `1e999` is
    // not a number any `Value` holds either — and the rest of the document is the
    // good one, so the cost is the only thing there is to refuse it for.
    let overflowed = String::from_utf8(document_with(|_| {}))
        .expect("utf-8")
        .replace("0.53", "1e999")
        .into_bytes();
    assert!(
        onepipeline_ui::telemetry::read_document(&telemetry_run(), &overflowed).is_err(),
        "a cost past every number is not a cost"
    );
}

/// The one way a cost is made, held to what a cost can be.
///
/// The document boundary refuses a negative through this very type, but JSON has
/// no NaN and no infinity to write one of, so those are only reachable where the
/// type is — from a reader that computed a number and called it money. `Cost` is
/// what stands between any of them and a payload, so it is driven where it
/// stands rather than only through the one caller that exists today.
#[test]
fn a_cost_is_an_amount_of_money_or_it_is_never_made() {
    use onepipeline_ui::telemetry::Cost;

    assert_eq!(Cost::try_from(0.53).map(Cost::get), Ok(0.53));
    // Free is an amount of money; a debt, a NaN and an infinity are not.
    assert_eq!(Cost::try_from(0.0).map(Cost::get), Ok(0.0));
    for refused in [-0.01_f64, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let rejected =
            Cost::try_from(refused).expect_err(&format!("{refused:?} is not an amount of money"));
        assert!(
            rejected.to_string().contains("not an amount of money"),
            "{refused:?}: the refusal does not say so — {rejected}"
        );
    }
}

/// The words this crate names a bucket and a party by, against the words the
/// document spells them with.
///
/// They are two spellings of one vocabulary — one for a refusal to read, one on
/// the wire — and a refusal that names a bucket the document does not have is a
/// reader sending an operator to look for the wrong thing. Read back rather than
/// written out, because reading is the only direction this crate has: the
/// document is the producer's to write.
#[test]
fn every_bucket_and_party_is_named_as_the_document_spells_it() {
    use onepipeline_ui::telemetry::{BucketName, Party};

    for name in BucketName::ALL {
        let read: BucketName = serde_json::from_value(serde_json::json!(name.as_str()))
            .unwrap_or_else(|err| panic!("`{}` is not a bucket name: {err}", name.as_str()));
        assert_eq!(read, name);
    }
    for party in [Party::Agent, Party::Judge, Party::Llmlint, Party::Total] {
        let read: Party = serde_json::from_value(serde_json::json!(party.as_str()))
            .unwrap_or_else(|err| panic!("`{}` is not a party: {err}", party.as_str()));
        assert_eq!(read, party);
    }
}

/// This crate's copy of the stack's shared filter grammar, held to the wire the
/// grammar fixes.
///
/// The grammar is duplicated per repository by design — there is no shared util
/// crate here, exactly as with the envelope — so this is the drift gate that
/// stands in for the shared declaration. It is a **type** gate, like the event
/// vocabulary above: `oneagentgraph` declares `EventFilter` and `Matcher` in a
/// public module, and this crate's copy is held to that library's own
/// serialization rather than to a second reading of the wire alone. It could not
/// be until now — the declaration landed in `oneagentgraph` 0.2.13, which added a
/// field to `run::Request` in the same patch release, so the `onepipeline` this
/// crate depended on did not compile against it — and the SDK pin moving to a
/// release built on a later sibling is what makes it one.
///
/// One field is deliberately *not* shared: this grammar has no `round` matcher.
/// Execution is continuous, the label is deprecated and stamped by nothing, and a
/// matcher over it would be a filter that silently matched nothing.
#[test]
fn the_filter_grammar_this_crate_reads_is_the_one_the_stack_shares() {
    use onepipeline_ui::filter::{EventFilter, Matcher};

    // Every field a matcher may name, and exactly those, under exactly these
    // names: this is the document a sibling producer reads off the same query.
    let mine = serde_json::to_value(Matcher {
        source: Some(onepipeline::event::Source::Agentgraph),
        kind: Some("turn-*".into()),
        run_id: Some("run-1".into()),
        node: Some("build".into()),
        step: Some("compile".into()),
        member: Some("worker".into()),
        persona: Some("engineer".into()),
    })
    .expect("this crate's matcher serializes");
    assert_eq!(
        mine,
        serde_json::json!({
            "source": "agentgraph",
            "kind": "turn-*",
            "run_id": "run-1",
            "node": "build",
            "step": "compile",
            "member": "worker",
            "persona": "engineer",
        }),
        "the shared grammar's matcher has drifted"
    );

    // And the same document off the sibling's own type, filled the same way:
    // this is what makes the gate read that library's declaration rather than a
    // second transcription of what it happens to emit.
    assert_eq!(
        mine,
        serde_json::to_value(oneagentgraph::event::Matcher {
            source: Some(oneagentgraph::event::Source::Agentgraph),
            kind: Some("turn-*".into()),
            run_id: Some("run-1".into()),
            node: Some("build".into()),
            step: Some("compile".into()),
            member: Some("worker".into()),
            persona: Some("engineer".into()),
        })
        .expect("the sibling's matcher serializes"),
        "this crate's matcher has drifted from the one `oneagentgraph` declares"
    );

    // A matcher that names nothing serializes to nothing, so a spec round-trips
    // as the file wrote it rather than gaining every key it left unasked — which
    // is the sibling's behaviour too, not a convention this crate chose.
    assert_eq!(
        serde_json::to_value(EventFilter::default()).expect("serializes"),
        serde_json::json!({})
    );
    assert_eq!(
        serde_json::to_value(oneagentgraph::event::EventFilter::default())
            .expect("the sibling's filter serializes"),
        serde_json::json!({})
    );

    // `round` is refused rather than ignored: `deny_unknown_fields` is what stops
    // a spec written against the round era from silently matching everything.
    assert!(
        serde_json::from_str::<EventFilter>(r#"{"include":[{"round":1}]}"#).is_err(),
        "a matcher over a label nothing stamps must not parse"
    );
    // And so is a list this grammar does not have, for the same reason.
    assert!(serde_json::from_str::<EventFilter>(r#"{"only":[]}"#).is_err());
}
