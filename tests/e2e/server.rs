//! The read API's journeys: a real server, a real socket, real recorded runs.
//!
//! These are the port of `tests/e2e/test_server_e2e.py` from the repository the
//! frontend comes from — the same journeys, against the onepipeline SDK's run
//! store instead of that repository's. Nothing is stubbed: each one spawns the
//! compiled binary over a directory the SDK itself writes and reads the bytes
//! that come back.

use std::fs;
use std::path::Path;
// The journeys that write a config chain and a harness stand-in are `cfg(unix)`
// — they chmod a script and stop the server with a signal — and they are the
// only callers here that name this type rather than spelling it in full. So the
// import is gated with them, exactly as `Stop` is below: an import left ungated
// is an unused one on Windows, which this crate's gate denies.
#[cfg(unix)]
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use onepipeline_ui::contract::RunId;
use onepipeline_ui::telemetry;

use crate::fixture_run;
use crate::harness_history;
use crate::http;
use crate::serving::Serving;
#[cfg(unix)]
use crate::serving::Stop;
use crate::sibling;

/// A server over one settled run and one more, so the list has rows to page.
fn two_runs() -> Serving {
    Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
    })
}

/// Every successful response carries the schema-version preamble.
fn assert_enveloped(body: &Value) {
    assert_eq!(body["api_version"], json!(2), "{body}");
    assert_eq!(body["telemetry_schema_version"], json!(20), "{body}");
    assert!(
        body["observed_at"]
            .as_str()
            .is_some_and(|at| at.len() >= 20),
        "the envelope says when it was read: {body}"
    );
}

#[test]
fn healthz_answers_without_reading_run_storage() {
    // Deliberately over an *empty* root: liveness must answer whether or not
    // there is anything to serve, which is the whole point of it not being
    // enveloped like the read routes.
    let serving = Serving::start(|_| {});
    let response = http::get(serving.address, "/healthz");
    assert_eq!(response.status, 200);
    // The release is read off the SDK this test binary links, not restated: a
    // pin move that left the served value behind fails here rather than telling
    // a host its engine and its reader are the same release when they are not.
    assert_eq!(
        response.json(),
        json!({ "status": "ok", "onepipeline_version": onepipeline::VERSION })
    );
}

#[test]
fn the_run_list_serves_every_recorded_run_with_its_session_attribution() {
    let serving = two_runs();
    let response = http::get(serving.address, "/api/v2/runs?include_settled=true");
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_enveloped(&body);
    let runs = body["runs"].as_array().expect("runs is an array");
    assert_eq!(runs.len(), 2);
    let ids: Vec<&str> = runs
        .iter()
        .filter_map(|run| run["run_id"].as_str())
        .collect();
    assert_eq!(ids, vec![fixture_run::RUN_ID, fixture_run::OTHER_RUN_ID]);
    for run in runs {
        assert_eq!(run["state"], json!("settled"));
        assert_eq!(run["node_counts"]["done"], json!(2));
        // The raw launching session id is never served; the opaque key that
        // groups runs by their planner is.
        assert!(run["launch"]["session_key"].is_string(), "{run}");
        assert!(
            !body.to_string().contains(fixture_run::SESSION),
            "the raw launching session id reached the wire"
        );
    }
}

#[test]
fn the_run_list_leads_with_the_run_that_moved_most_recently() {
    // A reader arrives on the first row, so the order is the answer to "what am I
    // here to look at". The two fixture runs record the same instants, so the one
    // that progressed *after* them is what has to lead — which the SDK's own
    // id-ordered listing would bury alphabetically.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::append(&dir, "node-ready", json!({}));
    });
    let body = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let ids: Vec<&str> = body["runs"]
        .as_array()
        .expect("runs is an array")
        .iter()
        .filter_map(|run| run["run_id"].as_str())
        .collect();
    assert_eq!(
        ids,
        vec![fixture_run::RUN_ID, fixture_run::OTHER_RUN_ID],
        "the run that progressed last is not the one a reader lands on"
    );

    // And the page boundary is positional in that order rather than a comparison
    // on the id: the second page must be the row the first one did not serve,
    // even though its id sorts *before* the cursor's.
    let first = http::get(serving.address, "/api/v2/runs?include_settled=true&limit=1").json();
    let cursor = first["next_cursor"].as_str().expect("a cursor");
    assert_eq!(cursor, fixture_run::RUN_ID);
    let second = http::get(
        serving.address,
        &format!("/api/v2/runs?include_settled=true&cursor={cursor}"),
    )
    .json();
    assert_eq!(
        second["runs"][0]["run_id"],
        json!(fixture_run::OTHER_RUN_ID)
    );
}

#[test]
fn a_cursor_naming_a_run_that_has_gone_serves_the_list_from_its_start() {
    // A run can be swept between two pages, and a client holding that cursor must
    // still be able to read: serving nothing would strand it on a page it can
    // never turn, so the list restarts rather than ending.
    let serving = two_runs();
    let body = http::get(
        serving.address,
        "/api/v2/runs?include_settled=true&cursor=run-20260807-999999",
    )
    .json();
    assert_eq!(
        body["runs"].as_array().map(Vec::len),
        Some(2),
        "a stale cursor stranded the client instead of restarting the list"
    );
}

#[test]
fn a_run_with_no_journal_is_served_from_the_result_the_run_recorded() {
    // Nothing to fold, so the run's own recorded result is the only account there
    // is. It
    // must reach the list, the graph and the node telemetry as one derivation:
    // a row and the graph it opens describing different graphs is the
    // disagreement an operator actually saw.
    let serving = Serving::start(|root| {
        fixture_run::write_recorded_only(root, fixture_run::RECORDED_ONLY_RUN_ID);
    });
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let counts = &listed["runs"][0]["node_counts"];
    // Counted in the run's own words: a client renders a closed vocabulary, but a
    // count that silently renamed what the run wrote would hide it entirely.
    assert_eq!(counts["improvised"], json!(1), "{counts}");
    assert_eq!(counts["failed"], json!(1), "{counts}");

    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RECORDED_ONLY_RUN_ID),
    )
    .json();
    let graph = &detail["graph"];
    // The word outside the vocabulary is served as `unknown` rather than passed
    // through — a client switches on this exhaustively and refuses the whole run
    // over a member it does not have — and never as a neighbouring meaning.
    assert_eq!(graph["node_status"][fixture_run::NODE_ID], json!("unknown"));
    assert_eq!(
        graph["node_status"][fixture_run::REVIEW_NODE_ID],
        json!("failed")
    );

    let nodes = detail["run"]["nodes"].as_array().expect("nodes");
    let review = nodes
        .iter()
        .find(|node| node["node"] == json!(fixture_run::REVIEW_NODE_ID))
        .expect("the failed node's telemetry");
    // How it failed, from the only classification a onepipeline journal carries:
    // the outcome word the run itself recorded.
    assert_eq!(review["failure"]["class"], json!("gate"));
    let converted = nodes
        .iter()
        .find(|node| node["node"] == json!(fixture_run::NODE_ID))
        .expect("the other node's telemetry");
    assert_eq!(converted["status"], json!("unknown"));
    // A status that is not a lost outcome is not a failure, whatever it says.
    assert!(converted.get("failure").is_none(), "{converted}");
}

#[test]
fn the_run_list_hides_settled_runs_unless_asked_for_them() {
    let serving = two_runs();
    let body = http::get(serving.address, "/api/v2/runs").json();
    assert_eq!(
        body["runs"].as_array().map(Vec::len),
        Some(0),
        "the list is a supervision surface; finished work is not what needs attention"
    );
}

#[test]
fn the_run_list_pages_by_opaque_cursor() {
    let serving = two_runs();
    let first = http::get(serving.address, "/api/v2/runs?include_settled=true&limit=1").json();
    assert_eq!(first["runs"].as_array().map(Vec::len), Some(1));
    let cursor = first["next_cursor"]
        .as_str()
        .expect("a continuation cursor");
    assert_eq!(cursor, fixture_run::RUN_ID);

    let second = http::get(
        serving.address,
        &format!("/api/v2/runs?include_settled=true&limit=1&cursor={cursor}"),
    )
    .json();
    assert_eq!(
        second["runs"][0]["run_id"],
        json!(fixture_run::OTHER_RUN_ID)
    );
    assert!(
        second["next_cursor"].is_null(),
        "the last page names no continuation"
    );
}

/// Every path template `contract::routes` declares, filled in for one run.
///
/// Driven off that constant rather than a list written here, so a route added to
/// the contract is a route this journey serves rather than one it forgets: the
/// `{...}` placeholders are the only thing filled in, and an unfilled one leaves
/// a path the server answers `404` for, which fails the assertion. The timeline
/// carries the one selection the contract makes required — a scope — because a
/// route answering `422` for a missing one has not been asked about the run.
///
/// Returned paired with the template each was built from, so a caller tells the
/// stream and the unenveloped liveness apart by that template rather than by a
/// string it spelled itself.
fn every_route_over(run: &str, conversation: &str, artifact: &str) -> Vec<(&'static str, String)> {
    use onepipeline_ui::contract::routes;
    routes::TABLE
        .iter()
        // The routes that write to the run are driven by the journeys about
        // each verb, over runs built for what each one does; this is every
        // route a reader opens.
        .filter(|route| route.method == routes::Method::Get)
        .map(|route| route.path)
        .map(|template| {
            let path = template
                .replace("{run}", run)
                .replace("{project}", &encoded(fixture_run::PLAN_PROJECT))
                .replace("{node}", fixture_run::NODE_ID)
                .replace(
                    "/conversations/{id}",
                    &format!("/conversations/{conversation}"),
                )
                .replace("/artifacts/{id}", &format!("/artifacts/{artifact}"));
            let path = match template {
                routes::RUN_TIMELINE => format!("{path}?scope=run"),
                // A watch of no seconds reads the run once and returns, which is
                // the one shape of it a sweep over every route can read to the
                // end.
                routes::RUN_WATCH => format!("{path}?timeout=0"),
                _ => path,
            };
            (template, path)
        })
        .collect()
}

/// A project id as a client sends it on the wire: path-encoded, so the `:`
/// between the source and the native id reaches the route as `%3A`.
fn encoded(project: &str) -> String {
    project.replace(':', "%3A")
}

#[test]
fn a_run_launched_from_a_plan_store_project_is_served_by_every_route() {
    // The shape every run this host launches now has, and the one an eleven-minor
    // behind engine dropped on sight: its `LaunchRecord` was
    // `deny_unknown_fields` with a required `plan`, so a record naming a project
    // instead did not deserialize and the run was not in the list at all.
    let serving = two_runs();

    // Read off disk first, so this journey cannot go on passing after the fixture
    // has quietly stopped being the shape it is about.
    let record: Value = serde_json::from_str(
        &fs::read_to_string(serving.run_dir(fixture_run::RUN_ID).join("launch.json"))
            .expect("the launch record"),
    )
    .expect("the launch record parses");
    assert_eq!(record["project"], json!(fixture_run::PLAN_PROJECT));
    assert!(
        record.get("plan").is_none(),
        "the run under test names no plan path: {record}"
    );

    // Listed — with `include_settled`, because this one is finished and the list
    // is a supervision surface.
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    assert!(
        listed["runs"]
            .as_array()
            .expect("the rows")
            .iter()
            .any(|row| row["run_id"] == json!(fixture_run::RUN_ID)),
        "the run is in the list: {listed}"
    );

    // And served in full by every route that serves a run: a detail with its
    // graph, a timeline with spans, a transcript with turns, and the artifact's
    // own bytes.
    for (template, path) in every_route_over(
        fixture_run::RUN_ID,
        fixture_run::CONVERSATION_ID,
        fixture_run::ARTIFACT_ID,
    ) {
        if template == onepipeline_ui::contract::routes::EVENTS {
            let mut stream = http::stream(serving.address, &path, None);
            assert_eq!(stream.status, 200, "{path}");
            let snapshot = stream.frames(1).remove(0).json();
            assert!(
                snapshot["runs"]
                    .as_array()
                    .expect("the snapshot's rows")
                    .iter()
                    .any(|row| row["run_id"] == json!(fixture_run::RUN_ID)),
                "{path} opens on a snapshot naming the run: {snapshot}"
            );
            continue;
        }
        if template == onepipeline_ui::contract::routes::RUN_WATCH {
            let mut stream = http::stream(serving.address, &path, None);
            assert_eq!(stream.status, 200, "{path}");
            let last = std::iter::from_fn(|| stream.next_frame())
                .last()
                .expect("a watch of no seconds returns");
            assert_eq!(last.event, "returned", "{path}: {last:?}");
            assert_eq!(last.json()["run_id"], json!(fixture_run::RUN_ID));
            continue;
        }
        let response = http::get(serving.address, &path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        if template != onepipeline_ui::contract::routes::HEALTHZ {
            assert_enveloped(&response.json());
        }
    }

    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    assert_eq!(detail["graph"]["run_id"], json!(fixture_run::RUN_ID));
    assert!(
        !detail["graph"]["node_states"]
            .as_object()
            .expect("the node states")
            .is_empty(),
        "the run is served whole, not as an empty shell: {detail}"
    );
    let timeline = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    assert!(
        !timeline["spans"].as_array().expect("the spans").is_empty(),
        "{timeline}"
    );
    let conversation = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::CONVERSATION_ID
        ),
    )
    .json();
    assert!(
        !conversation["conversation"]["turns"]
            .as_array()
            .expect("the turns")
            .is_empty(),
        "{conversation}"
    );
}

#[test]
fn every_launch_record_shape_this_reader_must_accept_is_listed() {
    // The launch record is the first thing read and the one thing that can stop a
    // run being read at all. Five shapes are on a real runs root — the plan path
    // the engine used to name, the project it names now, both across the change,
    // neither, and a key recorded by a build later than this one — and a reader
    // that refuses any of them serves an operator a list their run is missing
    // from, with nothing anywhere saying why.
    let mut shapes = Vec::new();
    let serving = Serving::start(|root| {
        shapes = fixture_run::write_launch_shapes(root);
    });
    assert_eq!(shapes.len(), 5, "every shape is written");

    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let rows: Vec<&str> = listed["runs"]
        .as_array()
        .expect("the rows")
        .iter()
        .filter_map(|row| row["run_id"].as_str())
        .collect();
    for (run, shape) in &shapes {
        assert!(
            rows.contains(&run.as_str()),
            "a launch record carrying {shape} is not in the list: {listed}"
        );
        // And it opens, rather than being a row that answers nothing.
        let response = http::get(serving.address, &format!("/api/v2/runs/{run}"));
        assert_eq!(
            response.status, 200,
            "a launch record carrying {shape} does not open: {}",
            response.body
        );
        let detail = response.json();
        assert_enveloped(&detail);
        assert_eq!(detail["run"]["run_id"], json!(run.as_str()));
    }
}

#[test]
fn a_settled_node_serves_the_words_its_settlement_recorded() {
    // A card that says only "failed" tells a reader less than the run knows. The
    // two recorded texts mean different things — the lifecycle's own prose, and
    // what the dispatch reported — so both reach the wire, whether they came off
    // the settlement envelope or the run's own recorded result.
    let serving = Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    });
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let results = &body["graph"]["node_results"];

    // The fold keeps a node's status, outcome and branch but not the prose beside
    // them, so every one of these comes off the settlement envelope itself.
    let failed = &results[fixture_run::REPORTED_NODE_ID];
    assert_eq!(failed["detail"], json!("the profile did not finish"));
    assert_eq!(failed["error"], json!("profile exited non-zero"));
    assert_eq!(failed["exit_code"], json!(2));
    assert_eq!(failed["ok"], json!(false));

    let live = &results[fixture_run::SHIP_NODE_ID];
    assert_eq!(live["detail"], json!("the change request is open"));
    // Nothing recorded is nothing served: an absent field is not a null one.
    assert!(live.get("error").is_none(), "{live}");
}

#[test]
fn a_run_detail_serves_its_graph_plan_and_transcripts() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    );
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_enveloped(&body);
    assert_eq!(body["run"]["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(body["run"]["last_event"], json!("node-settled"));

    let graph = &body["graph"];
    // One graph, not an array of rounds: nothing in a continuous engine batches
    // nodes, so there is one desired graph and one account of where it has got to.
    assert!(body.get("rounds").is_none(), "{body}");
    assert_eq!(graph["run_id"], json!(fixture_run::RUN_ID));
    assert!(graph.get("round").is_none(), "{graph}");
    // One status per plan task, so a client never invents one for a node.
    let tasks: Vec<&str> = graph["plan"]["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .filter_map(|task| task["id"].as_str())
        .collect();
    assert_eq!(
        tasks,
        vec![fixture_run::NODE_ID, fixture_run::REVIEW_NODE_ID]
    );
    for task in &tasks {
        assert_eq!(graph["node_status"][*task], json!("done"), "{graph}");
    }
    assert_eq!(graph["result"]["state"], json!("complete"));
    assert!(graph["result"].get("round").is_none(), "{graph}");
    assert_eq!(
        graph["node_results"][fixture_run::NODE_ID]["pr"],
        json!("https://example.invalid/changes/1")
    );

    // One transcript per session the run relayed, and the pair each was run
    // under: the worker's own side, and the judge member that reviewed it. Beside
    // the second sits the judge that supervised *it*, which no session relayed
    // and only that member's settled report records.
    let conversations = body["conversations"].as_array().expect("conversations");
    assert_eq!(conversations.len(), 3);
    assert_eq!(
        conversations[0]["conversation"]["id"],
        json!(fixture_run::CONVERSATION_ID)
    );
    assert_eq!(
        conversations[0]["attribution"]["nodeId"],
        json!(fixture_run::NODE_ID)
    );
    assert_eq!(
        conversations[0]["attribution"]["transportRole"],
        json!("agent")
    );
    assert_eq!(
        conversations[1]["conversation"]["id"],
        json!(fixture_run::REVIEW_CONVERSATION_ID)
    );
    assert_eq!(
        conversations[1]["attribution"]["transportRole"],
        json!("judge")
    );
    assert_eq!(
        conversations[2]["conversation"]["id"],
        json!(fixture_run::REVIEW_JUDGE_CONVERSATION_ID)
    );
    assert_eq!(
        conversations[2]["attribution"]["parentConversationId"],
        json!(fixture_run::REVIEW_CONVERSATION_ID)
    );
}

#[test]
fn opting_out_of_transcripts_keeps_the_field_and_empties_it() {
    let serving = two_runs();
    let body = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}?include_conversations=false",
            fixture_run::RUN_ID
        ),
    )
    .json();
    assert_eq!(
        body["conversations"],
        json!([]),
        "the opt-out is a size lever, not a schema change"
    );
    assert!(body["graph"]["node_status"].is_object(), "{body}");
}

#[test]
fn a_run_nobody_recorded_is_a_not_found_in_the_error_contract() {
    let serving = two_runs();
    let response = http::get(serving.address, "/api/v2/runs/run-nobody-recorded");
    assert_eq!(response.status, 404);
    assert_eq!(
        response.json(),
        json!({
            "error": {
                "code": "run_not_found",
                "message": "no recorded run run-nobody-recorded",
            }
        })
    );
}

#[test]
fn a_run_id_that_could_traverse_the_root_never_reaches_storage() {
    let serving = two_runs();
    // Encoded, so it is one path segment on the wire and the router hands the
    // handler the raw `../` — which the identifier newtype is what refuses.
    let response = http::get(serving.address, "/api/v2/runs/..%2F..%2Fetc");
    assert_eq!(response.status, 422);
    let body = response.json();
    assert_eq!(body["error"]["code"], json!("invalid_run_id"));
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("ASCII letters")),
        "{body}"
    );
}

/// `dispatch_id` is the key a client sends back to ask about the dispatch, so
/// it is a validated identifier or it is absent. The key is derived by joining
/// the run and the node, and each is short enough on its own while the two
/// together overrun what an identifier may be — the run is still served, and the
/// span still groups its sessions, but it carries no id the contract's own
/// boundary would refuse.
#[test]
fn a_dispatch_whose_derived_key_is_too_long_to_name_is_served_without_one() {
    // Valid on its own: a run id may be 128 characters, and this is 120 of them.
    let long_run: String = format!("run-{}", "a".repeat(116));
    assert_eq!(long_run.len(), 120);
    let serving = Serving::start(|root| {
        fixture_run::write(root, &long_run);
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let dispatch = |run: &str| -> Value {
        let body = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{run}/timeline?scope=node&node={}",
                fixture_run::NODE_ID
            ),
        )
        .json();
        body["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .find(|span| span["kind"] == "dispatch")
            .cloned()
            .expect("the node's dispatch")
    };

    let overrun = dispatch(&long_run);
    assert_eq!(overrun["node_id"], json!(fixture_run::NODE_ID));
    assert!(
        overrun.get("dispatch_id").is_none(),
        "served an id the route would refuse: {overrun}"
    );

    // The short run beside it is untouched: this omits the id it cannot form, it
    // does not stop the timeline naming the dispatches it can.
    let named = dispatch(fixture_run::RUN_ID);
    assert_eq!(
        named["dispatch_id"],
        json!(format!("{}.{}", fixture_run::RUN_ID, fixture_run::NODE_ID))
    );
}

#[test]
fn the_node_timeline_describes_the_dispatch_that_did_the_work() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        ),
    );
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_enveloped(&body);
    assert_eq!(body["timeline_schema_version"], json!(10));
    let spans = body["spans"].as_array().expect("spans");
    let dispatch = spans
        .iter()
        .find(|span| span["kind"] == "dispatch")
        .expect("the node's dispatch");
    assert_eq!(
        dispatch["dispatch_id"],
        json!(format!("{}.{}", fixture_run::RUN_ID, fixture_run::NODE_ID)),
        "schema 10 names the dispatch its sessions belong to"
    );
    assert_eq!(dispatch["transport_role"], json!("agent"));
    assert_eq!(dispatch["agent_role"], json!("worker"));
    assert_eq!(dispatch["status"], json!("done"));
    assert_eq!(dispatch["parent_id"], json!("node.contract-interface"));

    // The count beside the node is the transcript a reader opens from it: one
    // relayed envelope, one turn, and the run's own total over every node.
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let node = detail["run"]["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .find(|row| row["node"] == json!(fixture_run::NODE_ID))
        .expect("the dispatched node");
    assert_eq!(node["turns"], json!(3));
    assert_eq!(
        node["turns"],
        json!(detail["conversations"][0]["conversation"]["turns"]
            .as_array()
            .map(Vec::len)
            .expect("the transcript's turns"))
    );
    assert_eq!(detail["run"]["turns"], json!(4));
}

/// A run's releases, over real HTTP: the join, the six records, and the wait a
/// person has to be told about.
///
/// The join is the whole of the first half. `onevcs` observes a release long after
/// the dispatch that produced the work has settled and outside any session of it,
/// so nothing stamps that envelope with a node — the fixture writes it with none,
/// exactly as a real one has none. A reading that joined on the envelope's label
/// would serve this key absent on every run in existence and pass every other
/// assertion about the shape of it, so what is asserted here is that the served
/// node item carries the release *and* that no record of the node is that
/// observation.
#[test]
fn a_nodes_item_carries_the_release_the_commit_it_landed_as_went_out_in() {
    let serving = two_runs();
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let node = &detail["graph"]["node_results"][fixture_run::NODE_ID];
    assert_eq!(
        node["release"],
        json!({
            "identity": "github.com/nickderobertis/onepipeline-ui",
            "target": "crate",
            "style": "automated",
            "version": fixture_run::RELEASE_VERSION,
        }),
        "{node}"
    );
    // The same commit the node's own publication is served with, which is what the
    // two readings share and the only thing that joins them.
    assert_eq!(
        detail["node_details"][fixture_run::NODE_ID]["publication"]["commit"],
        json!(fixture_run::MERGE_SHA)
    );
    // Absent — not null — for the node beside it, which published nothing and was
    // released in nothing.
    assert!(
        detail["graph"]["node_results"][fixture_run::REVIEW_NODE_ID]
            .get("release")
            .is_none(),
        "{detail}"
    );

    // And no record labelled with that node is the observation it came from.
    let at_node = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        ),
    )
    .json();
    let kinds = |body: &Value| -> Vec<String> {
        body["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
            .filter_map(|event| event["kind"].as_str().map(str::to_owned))
            .collect()
    };
    let labelled = kinds(&at_node);
    assert!(
        !labelled.iter().any(|kind| kind == "release-observed"),
        "the observation carries a node label after all, so this join proves nothing: {labelled:?}"
    );

    // Every one of the six reaches a reader, each carrying its own record's fields.
    let at_run = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    let served = kinds(&at_run);
    for kind in [
        "release-probed",
        "release-acknowledged",
        "release-observed",
        "release-wait",
        "release-arrived",
        "release-adopted",
    ] {
        assert!(
            served.iter().any(|seen| seen == kind),
            "the run serves no {kind}: {served:?}"
        );
    }
    let events: Vec<Value> = at_run["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .collect();
    let of = |kind: &str| -> Value {
        events
            .iter()
            .find(|event| event["kind"] == json!(kind))
            .unwrap_or_else(|| panic!("no {kind} was served"))["release"]
            .clone()
    };
    // A probe names what it asked and what it was told, and no commit: it is a
    // question to a registry rather than a record of what a release carried.
    assert_eq!(of("release-probed")["outcome"], json!("released"));
    assert_eq!(of("release-probed")["elapsed_ms"], json!(412));
    assert!(of("release-probed").get("landing_commit").is_none());
    // An acknowledgement names the person, because a human step has one.
    assert_eq!(
        of("release-acknowledged")["actor"],
        json!("a-recording-host")
    );
    assert_eq!(of("release-acknowledged")["superseded"], json!(false));
    // And the wait tells the two apart: only the entry a person owes carries the
    // action they have to perform.
    let awaiting = of("release-wait")["awaiting"].clone();
    let awaiting = awaiting.as_array().expect("the entries a node is held on");
    assert_eq!(
        awaiting
            .iter()
            .map(|entry| (entry["style"].clone(), entry.get("action").cloned()))
            .collect::<Vec<_>>(),
        vec![
            (json!("automated"), None),
            (
                json!("human-step"),
                Some(json!(fixture_run::HUMAN_RELEASE_ACTION))
            ),
        ]
    );
    assert_eq!(
        of("release-adopted")["versions"]
            .as_array()
            .map(Vec::len)
            .expect("the versions an adoption wrote"),
        2
    );
}

/// What a reader is served when a producer wrote a release record badly.
///
/// A read surface reads what a producer wrote, and every one of these is a
/// plausible near-miss rather than nonsense: a release nobody named a version
/// for, a record whose every field is blank, a wait that names nothing it waits
/// on, a wait that began at a word rather than an instant, and adopted versions
/// each missing one of the three things a version is. The rule in each case is
/// the same — a field a producer left blank has said nothing, and absent is what
/// nothing is — and what makes it worth a journey is that the alternative is
/// visible: an empty release object reaches a reader as a heading over a blank
/// panel, and a `since` that no client can parse fails the *whole* timeline over
/// one entry.
#[test]
fn a_release_record_a_producer_wrote_badly_is_served_as_the_nothing_it_said() {
    let serving = Serving::start(|root| {
        fixture_run::write_malformed_releases(root, fixture_run::MALFORMED_RELEASE_RUN_ID);
    });
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::MALFORMED_RELEASE_RUN_ID),
    )
    .json();
    // The node landed, and a release names that commit — but it names no version,
    // so there is no release to serve rather than a release nobody could install.
    assert_eq!(
        detail["node_details"][fixture_run::NODE_ID]["publication"]["commit"],
        json!(fixture_run::MERGE_SHA)
    );
    let node = &detail["graph"]["node_results"][fixture_run::NODE_ID];
    assert!(node.get("release").is_none(), "{node}");

    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::MALFORMED_RELEASE_RUN_ID,
            fixture_run::NODE_ID
        ),
    )
    .json();
    let events: Vec<Value> = timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .collect();
    let of_kind = |kind: &str| -> Vec<&Value> {
        events
            .iter()
            .filter(|event| event["kind"] == json!(kind))
            .collect()
    };
    // Both records really reached the timeline; what is asserted below is what
    // each carries, not that either went missing.
    let waits = of_kind("release-wait");
    assert_eq!(waits.len(), 2, "{events:?}");
    // A wait naming nothing it is held on says nothing at all, so the whole key
    // is absent — never an empty object, which reads as a node held on nothing.
    assert!(waits[0].get("release").is_none(), "{:?}", waits[0]);
    // The one beside it began at a word rather than an instant. Every other field
    // it filled is served; the stamp is not, because the wire types it as one and
    // a client that types it would refuse this whole timeline over the entry.
    let entry = &waits[1]["release"]["awaiting"][0];
    assert_eq!(entry["dep"], json!("sdk"));
    assert_eq!(entry["style"], json!("automated"));
    assert_eq!(entry["last_answer"], json!("not-released"));
    assert!(entry.get("since").is_none(), "{entry}");
    // A record whose every field is blank is a record that said nothing.
    let arrived = of_kind("release-arrived");
    assert_eq!(arrived.len(), 1);
    assert!(arrived[0].get("release").is_none(), "{:?}", arrived[0]);
    // And an adoption keeps the one thing it did say. Each version entry is
    // missing one of the three a version is, so none is served — while the
    // delivery, which the record did name, still is.
    let adopted = of_kind("release-adopted");
    assert_eq!(adopted.len(), 1);
    assert_eq!(adopted[0]["release"]["delivery"], json!("deferred"));
    assert!(
        adopted[0]["release"].get("versions").is_none(),
        "{:?}",
        adopted[0]
    );
}

#[test]
fn the_run_timeline_covers_the_run_and_the_nodes_under_it() {
    let serving = two_runs();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    let spans = body["spans"].as_array().expect("spans");
    // One root span, and it is the run: nothing batches nodes, so there is no
    // stack of rounds above them and no span carries one.
    let roots: Vec<&Value> = spans.iter().filter(|span| span["kind"] == "run").collect();
    assert_eq!(roots.len(), 1, "{spans:?}");
    let run = roots[0];
    assert_eq!(run["id"], json!(format!("run.{}", fixture_run::RUN_ID)));
    assert_eq!(run["ended_at"], json!("2026-08-07T12:00:30.000Z"));
    assert!(
        spans.iter().all(|span| span.get("round").is_none()),
        "a span still carries a round: {spans:?}"
    );
    let nodes: Vec<&str> = spans
        .iter()
        .filter(|span| span["kind"] == "node")
        .filter_map(|span| span["node_id"].as_str())
        .collect();
    assert_eq!(
        nodes,
        vec![fixture_run::NODE_ID, fixture_run::REVIEW_NODE_ID]
    );
    for span in spans.iter().filter(|span| span["kind"] == "node") {
        assert_eq!(span["parent_id"], run["id"]);
        assert_eq!(
            span["id"],
            json!(format!(
                "node.{}",
                span["node_id"].as_str().expect("a node")
            ))
        );
    }
}

/// A server over the run whose scheduler recorded why each node was waiting.
fn held() -> Serving {
    Serving::start(|root| {
        fixture_run::write_held(root, fixture_run::HELD_RUN_ID);
        // Beside it, a run recorded before the engine wrote any of those records:
        // the same server, the same request, and the gap it always showed.
        fixture_run::write(root, fixture_run::RUN_ID);
    })
}

/// One node's spans of that run, at the scope an operator opens the node in.
fn held_node_spans(serving: &Serving, node: &str) -> Vec<Value> {
    http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={node}",
            fixture_run::HELD_RUN_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone()
}

/// Every `queued` span among those served, in the order the run recorded them.
fn queued_spans(spans: &[Value]) -> Vec<&Value> {
    spans
        .iter()
        .filter(|span| span["kind"] == "queued")
        .collect()
}

#[test]
fn a_node_behind_running_work_is_served_a_span_per_hold_the_engine_recorded() {
    let serving = held();
    let spans = held_node_spans(&serving, fixture_run::HELD_BEHIND_NODE_ID);
    let queued = queued_spans(&spans);

    // Three holds, because three times the answer to "what is ahead of it"
    // changed — and not one bar naming whatever was ahead of it first.
    assert_eq!(queued.len(), 3, "{spans:?}");
    let ahead: Vec<Vec<&str>> = queued
        .iter()
        .map(|span| {
            span["reasons"][0]["ahead"]
                .as_array()
                .expect("the dispatches ahead of it")
                .iter()
                .map(|node| node.as_str().expect("a node id"))
                .collect()
        })
        .collect();
    assert_eq!(
        ahead,
        vec![
            fixture_run::HELD_AHEAD.to_vec(),
            fixture_run::HELD_AHEAD[1..].to_vec(),
            fixture_run::HELD_AHEAD[2..].to_vec(),
        ],
        "{queued:?}"
    );
    for span in &queued {
        assert_eq!(span["reasons"][0]["kind"], json!("concurrency"));
        assert_eq!(span["reasons"][0]["limit"], json!(3));
        assert_eq!(
            span["parent_id"],
            json!(format!("node.{}", fixture_run::HELD_BEHIND_NODE_ID))
        );
        assert_eq!(
            span["node_id"],
            json!(fixture_run::HELD_BEHIND_NODE_ID),
            "{span}"
        );
    }

    // Each closes where the next one opens, and the last one closes where the
    // hold cleared — which is a tenth of a second before the dispatch.
    let bounds: Vec<(&str, &str)> = queued
        .iter()
        .map(|span| {
            (
                span["started_at"].as_str().expect("a start"),
                span["ended_at"].as_str().expect("an end"),
            )
        })
        .collect();
    assert_eq!(
        bounds,
        vec![
            ("2026-08-07T12:00:04.100Z", "2026-08-07T12:00:10.100Z"),
            ("2026-08-07T12:00:10.100Z", "2026-08-07T12:00:20.100Z"),
            ("2026-08-07T12:00:20.100Z", "2026-08-07T12:00:30.100Z"),
        ]
    );
    let dispatch = spans
        .iter()
        .find(|span| span["kind"] == "dispatch")
        .map(|span| span["started_at"].clone());
    assert!(
        dispatch.is_none() || dispatch.as_ref().and_then(Value::as_str) > Some(bounds[2].1),
        "the queue cleared after the dispatch it was holding: {spans:?}"
    );
}

#[test]
fn a_node_held_by_more_than_one_thing_names_each_of_them() {
    let serving = held();
    let spans = held_node_spans(&serving, fixture_run::HELD_MANY_NODE_ID);
    let queued = queued_spans(&spans);
    assert_eq!(queued.len(), 2, "{spans:?}");

    // Two reasons in one span: an unsettled dependency and the decision point
    // holding the subtree, each with its own kind's own fields, so a reader tells
    // "held by two things" from "held by one" off the array alone.
    let both = queued[0]["reasons"].as_array().expect("the reasons");
    assert_eq!(both.len(), 2, "{}", queued[0]);
    assert_eq!(
        both[0],
        json!({ "kind": "dependencies", "blocking": [fixture_run::HELD_AHEAD[0]] })
    );
    assert_eq!(
        both[1],
        json!({ "kind": "decision", "reference": fixture_run::HELD_DECISION_REFERENCE })
    );

    // And then one: a release nobody has published, which is neither of the
    // other two and is drawn as neither.
    assert_eq!(
        queued[1]["reasons"],
        json!([{ "kind": "release", "awaiting": [fixture_run::HELD_RELEASE_DEP] }])
    );
    // Nothing said the hold cleared, so the span is left open rather than closed
    // at an instant this crate invented.
    assert_eq!(queued[1]["ended_at"], Value::Null, "{}", queued[1]);
}

#[test]
fn a_hold_whose_reasons_this_build_cannot_read_is_served_as_no_span_at_all() {
    let serving = held();
    let spans = held_node_spans(&serving, fixture_run::HELD_UNREADABLE_NODE_ID);
    assert!(
        queued_spans(&spans).is_empty(),
        "a hold naming nothing was drawn as an explanation: {spans:?}"
    );
    // The same server, the same run: a hold this build *can* read is a span, so
    // the absence above is this crate declining to draw one rather than nothing
    // being drawn at all.
    assert!(
        !queued_spans(&held_node_spans(&serving, fixture_run::HELD_BEHIND_NODE_ID)).is_empty(),
        "no queued span was served for any node, so this proves nothing"
    );
    // The record itself is still an event of the node, so the reader who wants it
    // has it — it is only the *span* that is withheld.
    let node = span_named(
        &spans,
        &format!("node.{}", fixture_run::HELD_UNREADABLE_NODE_ID),
    );
    assert!(
        node["events"]
            .as_array()
            .expect("events")
            .iter()
            .any(|event| event["kind"] == "node-held"),
        "{node}"
    );
}

#[test]
fn a_run_recorded_before_the_engine_wrote_a_hold_is_served_with_no_invented_span() {
    let serving = held();
    // The run beside it on the same server does record holds and is served them,
    // so what follows is about the historical store rather than about a server
    // that draws no queued span for anything.
    assert!(
        !queued_spans(&held_node_spans(&serving, fixture_run::HELD_BEHIND_NODE_ID)).is_empty(),
        "no queued span was served for any node, so this proves nothing"
    );
    for scope in [
        "scope=run".to_owned(),
        format!("scope=node&node={}", fixture_run::NODE_ID),
    ] {
        let body = http::get(
            serving.address,
            &format!("/api/v2/runs/{}/timeline?{scope}", fixture_run::RUN_ID),
        )
        .json();
        let spans = body["spans"].as_array().expect("spans");
        assert!(
            queued_spans(spans).is_empty(),
            "a run that recorded no hold was served one: {spans:?}"
        );
        assert!(
            spans.iter().all(|span| span.get("reasons").is_none()),
            "a span that is not a hold carries hold reasons: {spans:?}"
        );
    }
}

#[test]
fn the_run_scope_timeline_carries_every_nodes_queue_under_that_node() {
    let serving = held();
    let spans = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::HELD_RUN_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone();
    let queued = queued_spans(&spans);
    assert_eq!(queued.len(), 5, "{spans:?}");
    for span in &queued {
        let node = span["node_id"].as_str().expect("a node");
        assert_eq!(span["parent_id"], json!(format!("node.{node}")), "{span}");
    }
}

/// A server over the run whose lanes ran one after another.
fn lanes() -> Serving {
    Serving::start(|root| {
        fixture_run::write_lanes(root, fixture_run::LANES_RUN_ID);
    })
}

/// One node's spans, as an operator opening that node reads them.
fn node_spans(serving: &Serving, node: &str) -> Vec<Value> {
    node_spans_of(serving, fixture_run::LANES_RUN_ID, node)
}

/// The same, for a node of `run`.
fn node_spans_of(serving: &Serving, run: &str, node: &str) -> Vec<Value> {
    http::get(
        serving.address,
        &format!("/api/v2/runs/{run}/timeline?scope=node&node={node}"),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone()
}

fn span_named<'a>(spans: &'a [Value], id: &str) -> &'a Value {
    spans
        .iter()
        .find(|span| span["id"] == json!(id))
        .unwrap_or_else(|| panic!("no span `{id}` among {spans:?}"))
}

#[test]
fn each_attempt_of_a_re_asked_node_is_served_over_the_attempt_that_ran_it() {
    let serving = lanes();
    let spans = node_spans(&serving, fixture_run::RETRIED_NODE_ID);

    // The abandoned attempt: it began where the run dispatched it, a second
    // before its member came up, and it is over where the dispatch that
    // superseded it began, because nothing else ever ended it.
    let abandoned = span_named(
        &spans,
        &format!("dispatch.{}", fixture_run::RETRIED_FIRST_CONVERSATION_ID),
    );
    assert_eq!(abandoned["started_at"], json!("2026-08-07T12:00:01.000Z"));
    assert_eq!(abandoned["ended_at"], json!("2026-08-07T12:01:00.000Z"));

    // And the attempt that did the work, from the `node-dispatched` that asked
    // for it, which the run ended itself.
    let ran = span_named(
        &spans,
        &format!("dispatch.{}", fixture_run::RETRIED_SECOND_CONVERSATION_ID),
    );
    assert_eq!(ran["started_at"], json!("2026-08-07T12:01:00.000Z"));
    assert_eq!(ran["ended_at"], json!("2026-08-07T12:01:30.000Z"));

    // Each is the moment the run asked for that attempt, and not the moment the
    // session it ran first spoke: two attempts of one node are told apart by the
    // dispatches that bracket them.
    for (span, dispatched) in [
        (abandoned, "2026-08-07T12:00:01.000Z"),
        (ran, "2026-08-07T12:01:00.000Z"),
    ] {
        assert_eq!(span["started_at"], json!(dispatched), "{span}");
    }

    // The two attempts of one node no longer read as having run over one window,
    // which is the whole of what a reader opens a node's timeline to see.
    assert_ne!(abandoned["started_at"], ran["started_at"]);
    assert!(
        abandoned["ended_at"].as_str() <= ran["started_at"].as_str(),
        "the attempts overlap: {abandoned} then {ran}"
    );
    // The node above them still spans all of them: it is the node's window, and
    // it is the only span that is.
    let node = span_named(&spans, &format!("node.{}", fixture_run::RETRIED_NODE_ID));
    assert_eq!(node["started_at"], json!("2026-08-07T12:00:01.000Z"));
    assert_eq!(node["ended_at"], json!("2026-08-07T12:01:31.000Z"));
}

#[test]
fn a_lifecycle_nodes_lanes_are_each_served_over_the_attempt_that_ran_them() {
    let serving = lanes();
    let spans = node_spans(&serving, fixture_run::DRAFTED_NODE_ID);

    let worked = span_named(
        &spans,
        &format!("dispatch.{}", fixture_run::DRAFTED_WORK_CONVERSATION_ID),
    );
    let drafted = span_named(
        &spans,
        &format!("dispatch.{}", fixture_run::DRAFTED_DRAFTING_CONVERSATION_ID),
    );
    let published = span_named(
        &spans,
        &format!("publication.{}", fixture_run::DRAFTED_NODE_ID),
    );

    // The attempt is the unit a session is bracketed by, and this node had one:
    // both of the members it ran in sequence open at the `node-dispatched` that
    // asked for them, and each closes where the run said that member was over.
    // A session is never opened from its own first word — the run's own boundary
    // is what brackets it, and between two members of one attempt the run
    // recorded no boundary at all.
    assert_eq!(worked["started_at"], json!("2026-08-07T12:02:00.000Z"));
    assert_eq!(worked["ended_at"], json!("2026-08-07T12:20:00.000Z"));
    assert_eq!(drafted["started_at"], json!("2026-08-07T12:02:00.000Z"));
    assert_eq!(drafted["ended_at"], json!("2026-08-07T12:20:40.000Z"));
    // The publication opens at the gate rather than at 12:02:01, where `onevcs`
    // cut the worktree the worker then spent eighteen minutes on.
    assert_eq!(published["started_at"], json!("2026-08-07T12:20:41.000Z"));
    assert_eq!(published["ended_at"], json!("2026-08-07T12:21:35.000Z"));
    assert_eq!(published["status"], json!("merged"));

    // And the node's own window is still wider than any lane under it, which is
    // what says the bounds served are the attempt's rather than the node's.
    let node = span_named(&spans, &format!("node.{}", fixture_run::DRAFTED_NODE_ID));
    assert_eq!(node["ended_at"], json!("2026-08-07T12:21:37.000Z"));
    for lane in [worked, drafted, published] {
        assert!(
            lane["ended_at"].as_str() < node["ended_at"].as_str(),
            "a lane was given the node's own end: {lane}"
        );
    }
}

#[test]
fn a_session_the_graph_lost_and_one_whose_worktree_went_each_end_where_that_happened() {
    let serving = lanes();

    // The member died mid-turn. Three records could have ended this session and
    // the graph's own is the earliest: not the worktree going away ten seconds
    // later, and not the run's settlement of the node after that.
    let lost = node_spans(&serving, fixture_run::DIED_NODE_ID);
    let died = span_named(
        &lost,
        &format!("dispatch.{}", fixture_run::DIED_CONVERSATION_ID),
    );
    assert_eq!(died["started_at"], json!("2026-08-07T12:05:00.000Z"));
    assert_eq!(died["ended_at"], json!("2026-08-07T12:05:30.000Z"));
    assert!(
        died["ended_at"].as_str()
            < span_named(&lost, &format!("node.{}", fixture_run::DIED_NODE_ID))["ended_at"]
                .as_str(),
        "the session outlived the record that ended it: {died}"
    );

    // And a session the graph never ended at all: the worktree being reclaimed
    // is the only thing that says when it stopped, so that is the end it carries
    // — ahead of the node's own settlement a second later.
    let taken = node_spans(&serving, fixture_run::RECLAIMED_NODE_ID);
    let reclaimed = span_named(
        &taken,
        &format!("dispatch.{}", fixture_run::RECLAIMED_CONVERSATION_ID),
    );
    assert_eq!(reclaimed["started_at"], json!("2026-08-07T12:06:00.000Z"));
    assert_eq!(reclaimed["ended_at"], json!("2026-08-07T12:06:30.000Z"));
    assert_eq!(
        span_named(&taken, &format!("node.{}", fixture_run::RECLAIMED_NODE_ID))["ended_at"],
        json!("2026-08-07T12:06:31.000Z")
    );
}

#[test]
fn a_session_is_read_in_the_category_the_run_named_its_member() {
    let serving = lanes();
    // A persona this host invented and `agentRoleSchema` has no word for. The
    // member beside it is what says the session was ordinary worker work.
    for (node, session) in [
        (
            fixture_run::RETRIED_NODE_ID,
            fixture_run::RETRIED_SECOND_CONVERSATION_ID,
        ),
        (
            fixture_run::REFUSED_NODE_ID,
            fixture_run::REFUSED_CONVERSATION_ID,
        ),
    ] {
        let spans = node_spans(&serving, node);
        let dispatch = span_named(&spans, &format!("dispatch.{session}"));
        assert_eq!(dispatch["agent_role"], json!("worker"), "{dispatch}");
    }
    let drafting = node_spans(&serving, fixture_run::DRAFTED_NODE_ID);
    assert_eq!(
        span_named(
            &drafting,
            &format!("dispatch.{}", fixture_run::DRAFTED_DRAFTING_CONVERSATION_ID)
        )["agent_role"],
        json!("pr-author")
    );

    // The run's own observer, at no node: `monitor` is the member the observer
    // graph declared, and it is served under that word — not mapped onto a lane
    // this crate kept, because it keeps none.
    let run = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::LANES_RUN_ID
        ),
    )
    .json();
    let spans = run["spans"].as_array().expect("spans").clone();
    let watching = span_named(
        &spans,
        &format!("run-session.{}", fixture_run::WATCHING_CONVERSATION_ID),
    );
    assert_eq!(watching["agent_role"], json!("monitor"));
    // And every word that reached the wire is one a graph of this run declared —
    // the observer's two members, the node graphs' worker and the drafting
    // graph's author — rather than one this crate knows.
    for span in &spans {
        if let Some(role) = span.get("agent_role").and_then(Value::as_str) {
            assert!(
                ["monitor", "check-in", "worker", "pr-author"].contains(&role),
                "`{role}` is a word no graph of this run declared: {span}"
            );
        }
    }
}

#[test]
fn a_member_no_graph_declared_is_not_read_off_the_persona_beside_it() {
    let serving = lanes();

    // A session the graph stamped `reviewer`, a member no graph of this run
    // declared, beside the one persona that reads like a member — the literal
    // word `pr-author`, which the drafting graph does declare and which is what
    // a host really dispatches a drafting turn under. The run said what this
    // session was and said something its own declarations cannot vouch for, so
    // no role is served: answering with the persona would put a *style* over
    // the run's own word for it, and serve a drafting lane for a session that
    // was not one.
    let spans = node_spans(&serving, fixture_run::UNNAMED_NODE_ID);
    let dispatch = span_named(
        &spans,
        &format!("dispatch.{}", fixture_run::UNNAMED_CONVERSATION_ID),
    );
    assert!(
        dispatch.get("agent_role").is_none(),
        "a member this wire has no word for was read off its persona: {dispatch}"
    );
    // The span itself is served in full: what the run recorded about *when* the
    // session ran is not in doubt, only what to call it.
    assert_eq!(dispatch["started_at"], json!("2026-08-07T12:07:00.000Z"));
    assert_eq!(dispatch["ended_at"], json!("2026-08-07T12:07:30.000Z"));

    let run = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::LANES_RUN_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone();
    // The node is still in the graph-level reading — it ran, and the reader can
    // see it — and it is in no category, rather than in the drafting one.
    assert!(
        run.iter()
            .any(|span| span["id"] == json!(format!("node.{}", fixture_run::UNNAMED_NODE_ID))),
        "the node itself went missing: {run:?}"
    );
    for span in &run {
        if span["node_id"] == json!(fixture_run::UNNAMED_NODE_ID) {
            assert!(
                span.get("agent_role").is_none(),
                "an unreadable member reached a category: {span}"
            );
        }
    }

    // And the other half of the same rule, which the member is only ever read
    // *ahead* of: a record that stamped no member at all is still read by the
    // persona it ran under — where a graph of this run declared that word as a
    // member, which the observer graph's `check-in` is. This dispatch relayed
    // no session, so its `node-dispatched` — persona `check-in`, no member — is
    // the whole of what the run said about it.
    let silent = node_spans(&serving, fixture_run::SILENT_NODE_ID);
    let only = span_named(
        &silent,
        &format!("dispatch.{}", fixture_run::SILENT_NODE_ID),
    );
    assert_eq!(only["agent_role"], json!("check-in"), "{only}");
    assert_eq!(
        span_named(
            &run,
            &format!("rollup.{}.agent.check-in", fixture_run::SILENT_NODE_ID)
        )["agent_role"],
        json!("check-in")
    );
}

/// A run whose graphs named their members with words nothing here knows.
fn named_members() -> Serving {
    Serving::start(|root| {
        fixture_run::write_named_members(root, fixture_run::NAMED_RUN_ID);
    })
}

/// The `agent_role` a span carries, or `None` where it carries none.
fn role_of(span: &Value) -> Option<&str> {
    span.get("agent_role").and_then(Value::as_str)
}

#[test]
fn a_member_is_served_under_the_word_the_runs_own_graphs_declared_it_as() {
    let serving = named_members();

    // The run's own observers, at no node: `ticker` and `sentinel` are the
    // members the observer graph declared, and each is served under exactly
    // that word — in the order the run relayed them, which is not the alphabet's.
    let run = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::NAMED_RUN_ID
        ),
    )
    .json();
    let spans = run["spans"].as_array().expect("spans").clone();
    let watching: Vec<(&str, Option<&str>)> = spans
        .iter()
        .filter(|span| span["kind"] == "dispatch" && span.get("node_id").is_none())
        .map(|span| (span["label"].as_str().expect("a label"), role_of(span)))
        .collect();
    assert_eq!(
        watching,
        vec![
            (fixture_run::TICKER_CONVERSATION_ID, Some("ticker")),
            (fixture_run::SENTINEL_CONVERSATION_ID, Some("sentinel")),
        ]
    );

    // A node graph's member, the same way: the session was stamped `drafter`
    // and its graph declared one, so `drafter` is what it is served as — on the
    // node's own dispatch span, on the run-scope category standing for it, and
    // on the detail's session link and conversation alike.
    let drafted = node_spans_of(
        &serving,
        fixture_run::NAMED_RUN_ID,
        fixture_run::DRAFTED_BY_NAME_NODE_ID,
    );
    let dispatch = span_named(
        &drafted,
        &format!("dispatch.{}", fixture_run::DRAFTER_CONVERSATION_ID),
    );
    assert_eq!(dispatch["agent_role"], json!("drafter"), "{dispatch}");
    assert_eq!(dispatch["transport_role"], json!("agent"));
    let rollup = span_named(
        &spans,
        &format!(
            "rollup.{}.agent.drafter",
            fixture_run::DRAFTED_BY_NAME_NODE_ID
        ),
    );
    assert_eq!(rollup["agent_role"], json!("drafter"));

    let detail = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}?include_conversations=true",
            fixture_run::NAMED_RUN_ID
        ),
    )
    .json();
    let node = detail["run"]["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .find(|node| node["node"] == json!(fixture_run::DRAFTED_BY_NAME_NODE_ID))
        .expect("the drafted node");
    assert_eq!(
        node["sessions"][0]["agent_role"],
        json!("drafter"),
        "{node}"
    );
    let conversation = detail["conversations"]
        .as_array()
        .expect("conversations")
        .iter()
        .find(|document| {
            document["conversation"]["id"] == json!(fixture_run::DRAFTER_CONVERSATION_ID)
        })
        .expect("the drafter's conversation");
    assert_eq!(conversation["attribution"]["agentRole"], json!("drafter"));

    // And every word that reached the wire is one a graph of this run declared.
    for span in &spans {
        if let Some(role) = role_of(span) {
            assert!(
                ["ticker", "sentinel", "drafter"].contains(&role),
                "`{role}` is a word no graph of this run declared: {span}"
            );
        }
    }
}

/// The judge that supervised a dispatch is one party of the member it
/// supervised, so it is served under that member's own word — one no graph
/// declared for a judge and nothing here knows — and is the judge side of it
/// by its transport alone.
#[test]
fn a_dispatchs_judge_is_served_under_the_member_it_supervised() {
    let serving = named_members();

    let opened = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::NAMED_RUN_ID,
            fixture_run::DRAFTER_JUDGE_CONVERSATION_ID
        ),
    );
    assert_eq!(opened.status, 200, "{}", opened.body);
    let attribution = opened.json()["attribution"].clone();
    assert_eq!(attribution["agentRole"], json!("drafter"), "{attribution}");
    assert_eq!(attribution["transportRole"], json!("judge"));
    assert_eq!(
        attribution["parentConversationId"],
        json!(fixture_run::DRAFTER_CONVERSATION_ID)
    );

    // And the lane it is reachable through sits in the drafter's own lane,
    // straight after the dispatch it supervised.
    let spans = node_spans_of(
        &serving,
        fixture_run::NAMED_RUN_ID,
        fixture_run::DRAFTED_BY_NAME_NODE_ID,
    );
    let dispatch = span_named(
        &spans,
        &format!("dispatch.{}", fixture_run::DRAFTER_CONVERSATION_ID),
    );
    let lane = span_named(
        &spans,
        &format!("dispatch.{}", fixture_run::DRAFTER_JUDGE_CONVERSATION_ID),
    );
    assert_eq!(lane["agent_role"], json!("drafter"), "{lane}");
    assert_eq!(lane["transport_role"], json!("judge"));
    assert_eq!(dispatch["transport_role"], json!("agent"));
    assert_eq!(lane["dispatch_id"], dispatch["dispatch_id"]);
    assert_eq!(
        lane["started_at"],
        json!(fixture_run::DRAFTER_JUDGE_BOUNDS.0)
    );
    assert_eq!(lane["ended_at"], json!(fixture_run::DRAFTER_JUDGE_BOUNDS.1));
    // No role word reached this node's timeline that a graph of the run did not
    // declare: `judge` is a transport here and never a lane.
    for span in &spans {
        if let Some(role) = role_of(span) {
            assert_eq!(role, "drafter", "{span}");
        }
    }
}

#[test]
fn a_session_with_no_member_is_read_by_its_persona_only_where_a_graph_declared_that_word() {
    let serving = named_members();
    let detail = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}?include_conversations=true",
            fixture_run::NAMED_RUN_ID
        ),
    )
    .json();
    let session_of = |node: &str| {
        detail["run"]["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .find(|row| row["node"] == json!(node))
            .expect("the node")["sessions"][0]
            .clone()
    };
    let attribution_of = |session: &str| {
        detail["conversations"]
            .as_array()
            .expect("conversations")
            .iter()
            .find(|document| document["conversation"]["id"] == json!(session))
            .expect("the conversation")["attribution"]
            .clone()
    };

    // No member stamped, and a persona — `ticker` — the observer graph declared
    // as a member: the persona is the reading, and it reads as that member.
    let timed = node_spans_of(
        &serving,
        fixture_run::NAMED_RUN_ID,
        fixture_run::TIMED_NODE_ID,
    );
    let dispatch = span_named(
        &timed,
        &format!("dispatch.{}", fixture_run::TIMED_CONVERSATION_ID),
    );
    assert_eq!(dispatch["agent_role"], json!("ticker"), "{dispatch}");
    assert_eq!(
        session_of(fixture_run::TIMED_NODE_ID)["agent_role"],
        json!("ticker")
    );
    assert_eq!(
        attribution_of(fixture_run::TIMED_CONVERSATION_ID)["agentRole"],
        json!("ticker")
    );

    // No member stamped, and a persona — `poet` — no graph declared: the
    // session is served, and it is served under no role at all.
    let mused = node_spans_of(
        &serving,
        fixture_run::NAMED_RUN_ID,
        fixture_run::MUSED_NODE_ID,
    );
    let dispatch = span_named(
        &mused,
        &format!("dispatch.{}", fixture_run::MUSED_CONVERSATION_ID),
    );
    assert_eq!(role_of(dispatch), None, "{dispatch}");
    assert_eq!(dispatch["started_at"], json!("2026-08-07T12:04:00.000Z"));
    assert!(session_of(fixture_run::MUSED_NODE_ID)
        .get("agent_role")
        .is_none());
    assert!(
        attribution_of(fixture_run::MUSED_CONVERSATION_ID)
            .get("agentRole")
            .is_none(),
        "a persona no graph declared was served as a role"
    );

    // A member stamped — `stranger` — that no graph declared, beside a persona
    // — `drafter` — that one did: the member decides, the persona is never
    // consulted, and nothing is served.
    let strayed = node_spans_of(
        &serving,
        fixture_run::NAMED_RUN_ID,
        fixture_run::STRAYED_NODE_ID,
    );
    let dispatch = span_named(
        &strayed,
        &format!("dispatch.{}", fixture_run::STRAYED_CONVERSATION_ID),
    );
    assert_eq!(role_of(dispatch), None, "{dispatch}");
    assert!(session_of(fixture_run::STRAYED_NODE_ID)
        .get("agent_role")
        .is_none());
    assert!(
        attribution_of(fixture_run::STRAYED_CONVERSATION_ID)
            .get("agentRole")
            .is_none(),
        "a member no graph declared was read off the persona beside it"
    );
}

#[test]
fn the_graph_records_are_read_from_where_the_engine_keeps_them_when_nothing_names_them() {
    // The host an operator's own server runs on: the engine wrote every graph
    // run's record under `HOME`, and nothing set `ONEAGENTGRAPH_STATE_DIR`. The
    // fixture wrote the records where the harness keeps them, so they are moved
    // to where that library keeps them by default and the server is told only
    // where home is.
    let (workspace, runs) = fixture_run::workspace();
    fixture_run::write_lanes(&runs, fixture_run::LANES_RUN_ID);
    let home = tempfile::tempdir().expect("the home directory");
    let kept = home.path().join(".local/state/oneagentgraph/runs");
    fs::create_dir_all(kept.parent().expect("a parent")).expect("the state directory");
    fs::rename(fixture_run::graph_records_for(&runs), &kept).expect("the records move");
    let serving = Serving::start_under_home(workspace, home.path());

    let run = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::LANES_RUN_ID
        ),
    )
    .json();
    let spans = run["spans"].as_array().expect("spans").clone();
    let watching = span_named(
        &spans,
        &format!("run-session.{}", fixture_run::WATCHING_CONVERSATION_ID),
    );
    assert_eq!(watching["agent_role"], json!("monitor"), "{watching}");
    let drafting = node_spans(&serving, fixture_run::DRAFTED_NODE_ID);
    assert_eq!(
        span_named(
            &drafting,
            &format!("dispatch.{}", fixture_run::DRAFTED_DRAFTING_CONVERSATION_ID)
        )["agent_role"],
        json!("pr-author")
    );
}

/// The lanes run with every node graph's record taken away, so that what one
/// node graph's record is made to say is the only thing that says it: the
/// declarations are read per run, and a `worker` any other record declared
/// would answer for a session whose own record is the one under test.
fn lanes_with_only_the_observer_declared(build: impl FnOnce(&Path)) -> Serving {
    Serving::start(|root| {
        fixture_run::write_lanes(root, fixture_run::LANES_RUN_ID);
        for graph_run in fixture_run::LANE_STREAMS {
            fixture_run::remove_graph_record(root, graph_run);
        }
        build(root);
    })
}

/// A graph run whose record declares a word no member may be called, and the
/// session it stamped with that word.
const REFUSING_STREAM: &str = "node-scope-1786925520099-4311";
const REFUSED_WORD: &str = "wor ker";
const REFUSING_SESSION: &str = "6a0c2e84-1b3d-4f57-9e8a-2c4d6b8f0a13";

/// The `agent_role` one session's dispatch span carries, or `None`.
fn role_at(serving: &Serving, node: &str, session: &str) -> Option<Value> {
    let spans = node_spans(serving, node);
    span_named(&spans, &format!("dispatch.{session}"))
        .get("agent_role")
        .cloned()
}

#[test]
fn a_record_this_build_cannot_read_or_find_or_believe_declares_nothing() {
    let serving = lanes_with_only_the_observer_declared(|root| {
        // A record a later `oneagentgraph` wrote, which this build refuses by
        // its version rather than guessing at.
        fixture_run::write_graph_record(
            root,
            fixture_run::stream_of(fixture_run::RETRIED_SECOND_CONVERSATION_ID),
            json!({ "schema_version": 99, "run_id": "later", "declared_members": ["worker"] }),
        );
        // A record declaring a word the member grammar refuses, and a session
        // stamped with that very word: the declaration declares nothing, so the
        // session is served no role rather than one the client would refuse the
        // whole payload over.
        fixture_run::write_graph_record(
            root,
            REFUSING_STREAM,
            json!({
                "schema_version": 3,
                "run_id": REFUSING_STREAM,
                "graph": "graphs/node-scope.yaml",
                "name": "node-scope",
                "started_ms": 1_786_925_520_000_u64,
                "declared_members": [REFUSED_WORD],
                "events_path": "events.jsonl",
            }),
        );
        fixture_run::append_relayed_on(
            &root.join(fixture_run::LANES_RUN_ID),
            REFUSING_STREAM,
            "turn-started",
            json!({
                "run_id": fixture_run::LANES_RUN_ID,
                "node": fixture_run::WORKING_NODE_ID,
                "member": REFUSED_WORD,
                "persona": REFUSED_WORD,
                "session": REFUSING_SESSION,
            }),
            json!({ "turn": 1 }),
        );
        // And the drafting graph's record, as the sibling writes one, so the
        // run still has a node graph that declared what it ran.
        fixture_run::declare_graph(
            root,
            fixture_run::stream_of(fixture_run::DRAFTED_DRAFTING_CONVERSATION_ID),
            &["pr-author"],
        );
    });
    assert_eq!(
        role_at(
            &serving,
            fixture_run::RETRIED_NODE_ID,
            fixture_run::RETRIED_SECOND_CONVERSATION_ID
        ),
        None,
        "a record this build cannot read was read as declaring its members"
    );
    // A graph run this host holds no record for at all.
    assert_eq!(
        role_at(
            &serving,
            fixture_run::DRAFTED_NODE_ID,
            fixture_run::DRAFTED_WORK_CONVERSATION_ID
        ),
        None,
        "a graph run with no record was read as declaring its members"
    );
    assert_eq!(
        role_at(&serving, fixture_run::WORKING_NODE_ID, REFUSING_SESSION),
        None,
        "a word the member grammar refuses was read as a declared member"
    );
    // And every graph whose record is as the sibling writes it is untouched:
    // the observer's, which the launch record names, and the drafting graph's.
    let run = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::LANES_RUN_ID
        ),
    )
    .json();
    let spans = run["spans"].as_array().expect("spans").clone();
    assert_eq!(
        span_named(
            &spans,
            &format!("run-session.{}", fixture_run::WATCHING_CONVERSATION_ID)
        )["agent_role"],
        json!("monitor")
    );
    assert_eq!(
        role_at(
            &serving,
            fixture_run::DRAFTED_NODE_ID,
            fixture_run::DRAFTED_DRAFTING_CONVERSATION_ID
        ),
        Some(json!("pr-author"))
    );
}

#[test]
fn a_record_from_before_the_sibling_kept_declarations_declares_what_settled() {
    // A record from before the sibling kept declarations lists only the
    // members that settled — and the engine itself reads those as the members
    // the run had, so this does too.
    let serving = lanes_with_only_the_observer_declared(|root| {
        let legacy = fixture_run::stream_of(fixture_run::REFUSED_CONVERSATION_ID);
        fixture_run::write_graph_record(
            root,
            legacy,
            json!({
                "run_id": legacy,
                "graph": "graphs/node-scope.yaml",
                "name": "node-scope",
                "started_ms": 1_786_925_520_000_u64,
                "members": { "worker": "settled" },
                "events_path": "events.jsonl",
            }),
        );
    });
    assert_eq!(
        role_at(
            &serving,
            fixture_run::REFUSED_NODE_ID,
            fixture_run::REFUSED_CONVERSATION_ID
        ),
        Some(json!("worker")),
        "a record that lists only settled members declares none of them"
    );
}

#[test]
fn a_run_scope_category_covers_the_sessions_in_it_rather_than_the_node() {
    let serving = lanes();
    let spans = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::LANES_RUN_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone();

    // The graph-level reading of the same node: one lane per category, each over
    // the attempt its own sessions ran under and closing where they closed,
    // rather than two lanes over the node's own window.
    let worked = span_named(
        &spans,
        &format!("rollup.{}.agent.worker", fixture_run::DRAFTED_NODE_ID),
    );
    let drafted = span_named(
        &spans,
        &format!("rollup.{}.agent.pr-author", fixture_run::DRAFTED_NODE_ID),
    );
    assert_eq!(worked["started_at"], json!("2026-08-07T12:02:00.000Z"));
    assert_eq!(worked["ended_at"], json!("2026-08-07T12:20:00.000Z"));
    assert_eq!(drafted["started_at"], json!("2026-08-07T12:02:00.000Z"));
    assert_eq!(drafted["ended_at"], json!("2026-08-07T12:20:40.000Z"));

    // The re-asked node's two attempts are one category, and it covers both.
    let retried = span_named(
        &spans,
        &format!("rollup.{}.agent.worker", fixture_run::RETRIED_NODE_ID),
    );
    assert_eq!(retried["count"], json!(2));
    assert_eq!(retried["started_at"], json!("2026-08-07T12:00:01.000Z"));
    assert_eq!(retried["ended_at"], json!("2026-08-07T12:01:30.000Z"));

    // Every node of this run dispatched a worker, and every one of them is in the
    // reading: under a role read off the persona this whole lane was empty.
    let workers: Vec<&str> = spans
        .iter()
        .filter(|span| span["agent_role"] == json!("worker"))
        .filter_map(|span| span["node_id"].as_str())
        .collect();
    assert_eq!(
        workers,
        vec![
            fixture_run::RETRIED_NODE_ID,
            fixture_run::DRAFTED_NODE_ID,
            fixture_run::REFUSED_NODE_ID,
            fixture_run::WORKING_NODE_ID,
            fixture_run::DIED_NODE_ID,
            fixture_run::RECLAIMED_NODE_ID,
            fixture_run::SUPERVISED_NODE_ID,
        ],
        "{spans:?}"
    );
}

#[test]
fn a_publication_the_run_never_did_is_absent_and_one_it_never_ruled_on_has_no_status() {
    let serving = lanes();

    // A node still working, on a worktree nothing has published from: no
    // publication span at all, rather than one drawn from the worktree to the end
    // of everything the node recorded.
    let working = node_spans(&serving, fixture_run::WORKING_NODE_ID);
    assert!(
        !working.iter().any(|span| span["kind"] == "publication"),
        "a node that published nothing was served a publication: {working:?}"
    );
    // And its dispatch is open, because nothing in the run has ended it.
    let session = span_named(
        &working,
        &format!("dispatch.{}", fixture_run::WORKING_CONVERSATION_ID),
    );
    assert_eq!(session["started_at"], json!("2026-08-07T12:04:00.000Z"));
    assert_eq!(session["ended_at"], Value::Null, "{session}");

    // The failure a user can cause: the gate refused the branch, so publication
    // work happened and nothing became of it. The span closes where the worktree
    // was taken away and carries no verdict, because the run recorded none.
    let refused = node_spans(&serving, fixture_run::REFUSED_NODE_ID);
    let published = span_named(
        &refused,
        &format!("publication.{}", fixture_run::REFUSED_NODE_ID),
    );
    assert_eq!(published["label"], json!("feature/refused"));
    assert_eq!(published["started_at"], json!("2026-08-07T12:09:01.000Z"));
    assert_eq!(published["ended_at"], json!("2026-08-07T12:09:51.000Z"));
    assert!(
        published.get("status").is_none(),
        "a publication nothing ruled on was given a verdict: {published}"
    );
}

#[test]
fn a_fetch_is_not_what_opens_a_publication_however_it_was_relayed() {
    let serving = lanes();

    // `onevcs` fetches to cut a worktree and fetches again to publish from one,
    // and the record it relays is the same either way. This node did both: one at
    // 12:02:01.5 to cut the worktree, one at 12:20:40.5 to publish. The span opens
    // at neither — it opens at the gate, which is the first record only publishing
    // writes, half a second later.
    let drafted = node_spans(&serving, fixture_run::DRAFTED_NODE_ID);
    let published = span_named(
        &drafted,
        &format!("publication.{}", fixture_run::DRAFTED_NODE_ID),
    );
    assert_eq!(published["started_at"], json!("2026-08-07T12:20:41.000Z"));

    // Which is what the alternative would have cost: this node fetched to cut its
    // worktree and has published nothing since, so a fetch that opened a
    // publication would draw one over every node the run ever dispatched.
    let working = node_spans(&serving, fixture_run::WORKING_NODE_ID);
    assert!(
        relayed_kinds(&working).contains(&"fetch".to_owned()),
        "the node under test relayed no fetch at all: {working:?}"
    );
    assert!(
        !working.iter().any(|span| span["kind"] == "publication"),
        "a fetch opened a publication on a node that published nothing: {working:?}"
    );
}

/// Every relayed record kind a node's own spans carry.
fn relayed_kinds(spans: &[Value]) -> Vec<String> {
    spans
        .iter()
        .filter_map(|span| span["events"].as_array())
        .flatten()
        .filter_map(|event| event["kind"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn a_timeline_scope_that_names_no_node_is_refused_rather_than_guessed() {
    let serving = two_runs();
    for (query, code) in [
        ("scope=node", "invalid_node_id"),
        ("scope=run&node=contract-interface", "invalid_node_id"),
        ("scope=round", "invalid_request"),
        ("", "invalid_request"),
    ] {
        let response = http::get(
            serving.address,
            &format!("/api/v2/runs/{}/timeline?{query}", fixture_run::RUN_ID),
        );
        assert_eq!(response.status, 422, "{query}");
        assert_eq!(response.json()["error"]["code"], json!(code), "{query}");
    }
}

#[test]
fn one_conversation_is_served_by_id_and_an_unknown_one_is_a_not_found() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::CONVERSATION_ID
        ),
    );
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_enveloped(&body);
    assert_eq!(
        body["conversation"]["turns"][0]["assistant"],
        json!(fixture_run::FIRST_REPLY)
    );
    assert_eq!(body["attribution"]["agentRole"], json!("worker"));

    let missing = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/conversations/nope", fixture_run::RUN_ID),
    );
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.json()["error"]["code"],
        json!("conversation_not_found")
    );
}

#[test]
fn an_artifact_is_served_as_a_bounded_tail_and_an_unrecorded_one_is_not_found() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{}",
            fixture_run::RUN_ID,
            fixture_run::ARTIFACT_ID
        ),
    );
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body["content"], json!("the gate ran and passed\n"));
    assert_eq!(body["truncated"], json!(false));
    assert_eq!(body["kind"], json!("gate_log"));

    // A well-formed id the run never recorded reads nothing, even though a file
    // of that name is sitting in the run's own artifact directory.
    std::fs::write(
        serving
            .run_dir(fixture_run::RUN_ID)
            .join("artifacts")
            .join("artifact-unrecorded"),
        "secrets",
    )
    .expect("plant an unrecorded file");
    let missing = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/artifact-unrecorded",
            fixture_run::RUN_ID
        ),
    );
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json()["error"]["code"], json!("artifact_not_found"));
    assert!(!missing.body.contains("secrets"));
}

/// A settled member's report, written by the published writer and read back
/// through the API.
///
/// This is the round trip the retention contract exists for: `retain` copies the
/// report into the run's own storage and `report_for` derives the name it went
/// under, and the server resolves the same artifact through the same published
/// pair. Nothing in this journey spells a report file name — a fixture that
/// hand-wrote one would pass while the two sides disagreed, which is the failure
/// the contract was published to make impossible.
///
/// Both streams are driven, because the name is *derived* from the producer's
/// own stream id and the envelope promises nothing about its characters: one
/// stream survives the SDK's sanitiser unchanged and one does not, and a reader
/// that restated that sanitiser would serve the first and 404 the second.
#[test]
fn a_settled_members_report_is_served_from_the_copy_the_run_retained() {
    let plain = report_document("the acceptance criteria were met");
    let rewritten = report_document("the follow-ups the worker surfaced");
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: PLAIN_STREAM,
                node: fixture_run::REPORTED_NODE_ID,
                member: "worker",
                at: SETTLED_AT,
                artifact: PLAIN_REPORT_ARTIFACT,
                report: &plain,
            },
            fixture_run::Produced::Report,
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: REWRITTEN_STREAM,
                node: fixture_run::REPORTED_NODE_ID,
                member: "worker",
                at: SETTLED_AT,
                artifact: REWRITTEN_REPORT_ARTIFACT,
                report: &rewritten,
            },
            fixture_run::Produced::Report,
        );
    });

    for (artifact, written) in [
        (PLAIN_REPORT_ARTIFACT, &plain),
        (REWRITTEN_REPORT_ARTIFACT, &rewritten),
    ] {
        let response = http::get(
            serving.address,
            &format!("/api/v2/runs/{}/artifacts/{artifact}", fixture_run::RUN_ID),
        );
        assert_eq!(response.status, 200, "{artifact}: {}", response.body);
        let body = response.json();
        assert_eq!(body["id"], json!(artifact));
        assert_eq!(
            body["kind"],
            json!("worker_report"),
            "the producer recorded a report, and the wire's word for one is worker_report"
        );
        assert_eq!(
            body["content"],
            json!(written),
            "{artifact} is served the bytes the member's own report carried"
        );
        assert_eq!(body["truncated"], json!(false));
    }
}

/// A retained report longer than one response may carry is bounded exactly as a
/// log is: the end of it, and the flag that says so.
#[test]
fn a_retained_report_bigger_than_one_response_is_served_as_its_tail() {
    let report = report_document(&format!("{}the last thing it said", "n".repeat(70_000)));
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: PLAIN_STREAM,
                node: fixture_run::REPORTED_NODE_ID,
                member: "worker",
                at: SETTLED_AT,
                artifact: PLAIN_REPORT_ARTIFACT,
                report: &report,
            },
            fixture_run::Produced::Report,
        );
    });
    let body = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{PLAIN_REPORT_ARTIFACT}",
            fixture_run::RUN_ID
        ),
    )
    .json();
    assert_eq!(body["truncated"], json!(true));
    assert_eq!(body["kind"], json!("worker_report"));
    let content = body["content"].as_str().expect("content");
    assert!(
        content.ends_with(report.get(report.len() - 64..).expect("the report's end")),
        "the tail is the end of the report"
    );
    assert!(content.len() <= 64 * 1024);
}

/// A settlement whose report the run never kept.
///
/// `retain` refuses a symlink standing where the report should be — a path that
/// names one file and delivers another — so the settlement is relayed, the
/// artifact is recorded, and no copy exists. That is a real state rather than a
/// hypothetical one, and the route answers it as the contract's not-found rather
/// than by panicking, by serving an empty body, or by following the link the run
/// deliberately did not.
#[test]
fn an_artifact_naming_a_report_the_run_never_retained_is_not_found() {
    let kept = report_document("the report the run did keep");
    let refused = report_document("what the producer put behind the link");
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: PLAIN_STREAM,
                node: fixture_run::REPORTED_NODE_ID,
                member: "worker",
                at: SETTLED_AT,
                artifact: PLAIN_REPORT_ARTIFACT,
                report: &kept,
            },
            fixture_run::Produced::Report,
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: REWRITTEN_STREAM,
                node: fixture_run::REPORTED_NODE_ID,
                member: "worker",
                at: SETTLED_AT,
                artifact: REWRITTEN_REPORT_ARTIFACT,
                report: &refused,
            },
            fixture_run::Produced::SymlinkToReport,
        );
    });
    // The other settlement of the same run, so the not-found below is this
    // report having no copy rather than the route reaching no report at all.
    let served = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{PLAIN_REPORT_ARTIFACT}",
            fixture_run::RUN_ID
        ),
    );
    assert_eq!(served.status, 200, "{}", served.body);
    assert_eq!(served.json()["content"], json!(kept));

    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{REWRITTEN_REPORT_ARTIFACT}",
            fixture_run::RUN_ID
        ),
    );
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(
        response.json()["error"]["code"],
        json!("artifact_not_found")
    );
    assert!(
        !response
            .body
            .contains("what the producer put behind the link"),
        "the run kept no copy, so nothing followed the producer's link: {}",
        response.body
    );
}

/// The stream a `member-settled` was relayed on, as `oneagentgraph` mints one.
const PLAIN_STREAM: &str = "node-scope-1786925518098-3163646";
const SETTLED_AT: &str = "2026-08-07T12:01:00.000Z";
/// A stream the SDK's sanitiser rewrites: a producer's id is a producer's
/// string, and nothing on the envelope constrains its characters.
const REWRITTEN_STREAM: &str = "node scope/qwen@a recording host-3163646";
/// The artifact ids those two settlements recorded for their reports.
///
/// An artifact id crosses this API's own trust boundary, so a producer mints one
/// from its *sanitised* stream — and it therefore names the stream and not the
/// sequence, which is why the file is derivable only from the envelope the
/// artifact was recorded on.
const PLAIN_REPORT_ARTIFACT: &str = "report-node-scope-1786925518098-3163646";
const REWRITTEN_REPORT_ARTIFACT: &str = "report-node-scope-qwen-a-recording-host-3163646";

/// A report shaped the way onejudge's own is, carrying `prose` where a reader
/// looks for what the member said.
fn report_document(prose: &str) -> String {
    format!(
        "{}\n",
        json!({
            "schema_version": 8,
            "control": Value::Null,
            "verdicts": [{ "criterion": "it works", "met": true, "reason": prose }],
            "usage": {},
        })
    )
}

/// The oneharness conversation behind a member's turns, read back through the
/// API from the store oneharness itself wrote it into.
///
/// Nothing copies a session into a run: `oneagentgraph` publishes a *pointer*
/// and the bytes stay in the history store, so this is the artifact whose
/// resolution reaches outside the run directory entirely. The store here is
/// written by `oneharness_core`'s own writer and read back by the same library
/// linked into the server — no `oneharness` process is started on either side —
/// and the journey follows the reader's own route in: the record's artifact id,
/// taken off the timeline reference the event carries.
#[test]
fn a_oneharness_session_artifact_is_served_from_the_history_store_that_holds_it() {
    let store = tempfile::tempdir().expect("the oneharness history store");
    let recorded = harness_history::record(
        store.path(),
        "contract interface worker",
        "land the wire contract",
        "the route table is landed",
    );
    let verbose = harness_history::record(
        store.path(),
        "a very talkative worker",
        "say more than one response can carry",
        &"n".repeat(70_000),
    );
    let serving = Serving::start(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        for session in [&recorded, &verbose] {
            fixture_run::relay_harness_session(
                &dir,
                &fixture_run::HarnessSession {
                    stream: HARNESS_STREAM,
                    node: fixture_run::NODE_ID,
                    member: "worker",
                    history_dir: Some(&session.dir),
                    history_project: &session.project,
                    history_session: &session.session,
                    history_id: &session.history_id,
                    bytes: session.bytes(),
                },
            );
        }
    });

    // The reader's own way in: the timeline hangs the pointer on the record, and
    // the artifact route is asked for exactly what it named.
    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        ),
    )
    .json();
    let reference = relayed(&timeline, "oneharness-session")
        .into_iter()
        .next()
        .expect("the relayed pointer is on the node's timeline")["reference"]
        .clone();
    assert_eq!(reference["kind"], json!("oneharness_session"), "{timeline}");
    assert_eq!(reference["value"], json!(recorded.history_id));

    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{}",
            fixture_run::RUN_ID,
            recorded.history_id
        ),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_enveloped(&body);
    assert_eq!(body["id"], json!(recorded.history_id));
    assert_eq!(body["kind"], json!("oneharness_session"));
    assert_eq!(body["truncated"], json!(false));
    let content: Value =
        serde_json::from_str(body["content"].as_str().expect("content")).expect("the record");
    assert_eq!(
        content["history_id"],
        json!(recorded.history_id),
        "the record served is the one the artifact named: {content}"
    );
    assert_eq!(
        content["text"],
        json!("the route table is landed"),
        "what the agent actually said is what a reader came for: {content}"
    );
    assert_eq!(content["prompt"], json!("land the wire contract"));

    // A conversation longer than one response may carry is bounded exactly as a
    // log is: the end of it, and the flag that says so. A transcript has no size
    // its harness promised, and this is the one artifact kind whose bytes this
    // server never wrote and cannot bound at the source.
    let long = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{}",
            fixture_run::RUN_ID,
            verbose.history_id
        ),
    );
    assert_eq!(long.status, 200, "{}", long.body);
    let body = long.json();
    assert_eq!(body["truncated"], json!(true));
    let content = body["content"].as_str().expect("content");
    assert!(
        content.len() <= 64 * 1024,
        "the body is bounded: {}",
        content.len()
    );
    assert!(
        content.ends_with("\"failure_kind\": null\n}"),
        "the tail is the end of the record: {content}"
    );
}

/// A session's record is served with the model the harness itself said it
/// would run under, and with the refusal oneharness answered when that was not
/// the model asked for.
///
/// The three shapes the linked `oneharness` writes, each recorded through its
/// own writer and read back through the same library: a turn whose harness
/// reported its model, one whose path reports none, and one the harness would
/// have run under a different model than requested — which is refused before a
/// token is spent, as the `model_mismatch` kind beside both names. The third is
/// the record this server could not read at all under the core it linked
/// before: a kind that core did not declare made the whole line unreadable, and
/// a store holding one served `404` for the transcript of a turn that was
/// refused for the one reason an operator most needs to see.
#[test]
fn a_session_record_carries_the_model_the_harness_reported_and_the_refusal_it_gave() {
    use crate::harness_history::Model;
    const REQUESTED: &str = "gpt-5.6-sol";
    const OBSERVED: &str = "gpt-6-astra";

    let store = tempfile::tempdir().expect("the oneharness history store");
    let reported = harness_history::record_under(
        store.path(),
        "a worker whose harness names its model",
        "land the wire contract",
        "the route table is landed",
        Model::Observed(REQUESTED),
    );
    let unreported = harness_history::record_under(
        store.path(),
        "a worker on a path that names none",
        "land the wire contract",
        "the route table is landed",
        Model::Unreported,
    );
    let refused = harness_history::record_under(
        store.path(),
        "a worker refused the model it was told",
        "land the wire contract",
        "",
        Model::Refused {
            requested: REQUESTED,
            observed: OBSERVED,
        },
    );
    let serving = Serving::start(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        for session in [&reported, &unreported, &refused] {
            fixture_run::relay_harness_session(
                &dir,
                &fixture_run::HarnessSession {
                    stream: HARNESS_STREAM,
                    node: fixture_run::NODE_ID,
                    member: "worker",
                    history_dir: Some(&session.dir),
                    history_project: &session.project,
                    history_session: &session.session,
                    history_id: &session.history_id,
                    bytes: session.bytes(),
                },
            );
        }
    });
    let served = |session: &harness_history::Recorded| -> Value {
        let response = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/artifacts/{}",
                fixture_run::RUN_ID,
                session.history_id
            ),
        );
        assert_eq!(response.status, 200, "{}", response.body);
        let body = response.json();
        assert_eq!(body["kind"], json!("oneharness_session"));
        assert_eq!(body["truncated"], json!(false));
        let content: Value =
            serde_json::from_str(body["content"].as_str().expect("content")).expect("the record");
        assert_eq!(
            content["history_id"],
            json!(session.history_id),
            "{content}"
        );
        content
    };

    // The harness named its model, and it was the one asked for.
    let content = served(&reported);
    assert_eq!(content["model"], json!(REQUESTED), "{content}");
    assert_eq!(content["observed_model"], json!(REQUESTED), "{content}");
    assert_eq!(content["failure_kind"], json!(null), "{content}");
    assert_eq!(content["text"], json!("the route table is landed"));

    // A path that reports no model records none — absent from the record, and
    // served absent rather than as the requested one copied over.
    let content = served(&unreported);
    assert!(
        content.get("observed_model").is_none(),
        "a model the harness never reported is not invented for it: {content}"
    );
    assert_eq!(content["failure_kind"], json!(null), "{content}");

    // The refusal: both names, the classified kind in the linked contract's
    // own token, and no text, because no turn ran.
    let content = served(&refused);
    assert_eq!(content["model"], json!(REQUESTED), "{content}");
    assert_eq!(content["observed_model"], json!(OBSERVED), "{content}");
    assert_eq!(
        content["failure_kind"],
        json!(oneharness_core::domain::signals::FailureKind::ModelMismatch),
        "{content}"
    );
    assert_eq!(
        content["failure_kind"],
        json!("model_mismatch"),
        "{content}"
    );
    assert_eq!(content["status"], json!("nonzero"), "{content}");
    assert_eq!(content["text"], json!(null), "{content}");
    assert!(
        content["error"]
            .as_str()
            .is_some_and(|error| error.contains(OBSERVED)),
        "the harness's own words for the model it would have used: {content}"
    );
}

/// Reading one takes no lock and writes nothing under the store.
///
/// `oneharness_core` offers a lookup that reconciles the store's index under an
/// exclusive `flock` and rewrites it; this crate must never call it, because a
/// read surface serving a run would then be standing in the way of the single
/// writer the engine runs. Proved twice over rather than asserted in prose: the
/// whole store is made read-only for the read — a rewrite or a lock file would
/// fail against it — and every file's bytes and modification time are compared
/// across the read.
#[cfg(unix)]
#[test]
fn resolving_a_oneharness_session_writes_nothing_under_the_history_store() {
    use std::os::unix::fs::PermissionsExt;

    let store = tempfile::tempdir().expect("the oneharness history store");
    let recorded = harness_history::record(
        store.path(),
        "read only worker",
        "read the store and change nothing",
        "the store is untouched",
    );
    let serving = Serving::start(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::relay_harness_session(
            &dir,
            &fixture_run::HarnessSession {
                stream: HARNESS_STREAM,
                node: fixture_run::NODE_ID,
                member: "worker",
                history_dir: Some(&recorded.dir),
                history_project: &recorded.project,
                history_session: &recorded.session,
                history_id: &recorded.history_id,
                bytes: recorded.bytes(),
            },
        );
    });

    // First against the store as it really is — writable, with the engine's own
    // writer free to append to it. This is the reading that catches a lookup
    // which reconciles: the index it rewrites and the lock file it creates are
    // both in the comparison below.
    let before = store_state(store.path());
    let served = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{}",
            fixture_run::RUN_ID,
            recorded.history_id
        ),
    );
    assert_eq!(served.status, 200, "{}", served.body);
    assert_eq!(
        store_state(store.path()),
        before,
        "the read added, removed or rewrote a file under the store"
    );

    // Then with the store made read-only outright — every directory and every
    // file, the store's own index and its lock among them, innermost first.
    // This is a store on a read-only mount, and it is where an implementation
    // that has to *write* in order to read stops being able to answer at all:
    // the lookup that reconciles opens that lock for writing before it reads
    // anything.
    let entries: Vec<std::path::PathBuf> = std::iter::once(store.path().to_path_buf())
        .chain(walk(store.path()))
        .collect();
    for entry in entries.iter().rev() {
        let mode = if entry.is_dir() { 0o555 } else { 0o444 };
        fs::set_permissions(entry, fs::Permissions::from_mode(mode))
            .expect("make the store read-only");
    }

    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{}",
            fixture_run::RUN_ID,
            recorded.history_id
        ),
    );

    for entry in &entries {
        let mode = if entry.is_dir() { 0o755 } else { 0o644 };
        fs::set_permissions(entry, fs::Permissions::from_mode(mode)).expect("restore the store");
    }
    assert_eq!(
        response.status, 200,
        "a store nothing may write to is still readable: {}",
        response.body
    );
    assert_eq!(
        store_state(store.path()),
        before,
        "the store was written to"
    );
}

/// A pointer this crate refuses to join, and an id the store does not hold.
///
/// The two path fields come off a *record*, which is external input exactly as a
/// URL is, so each is checked as a bare name before anything joins it. The
/// project is the one that is genuinely joined — the store's own layer — so it
/// is proved against a real second store beside the first: without the check,
/// `../<neighbour>` opens a transcript from a directory the run never named, and
/// that is the arbitrary-file read this boundary exists to prevent. An absolute
/// value is the same failure spelled differently, since joining one discards the
/// store entirely. The session name is held to the rule beside it, and a history
/// id the store does not hold is a `404` rather than a panic or an empty body.
#[test]
fn a_history_pointer_that_is_not_a_bare_name_is_refused_rather_than_joined() {
    let host = tempfile::tempdir().expect("the host's directories");
    let store = host.path().join("store");
    let neighbour = host.path().join("neighbour");
    fs::create_dir_all(&store).expect("the store the run named");
    fs::create_dir_all(&neighbour).expect("the store beside it");
    let recorded = harness_history::record(
        &store,
        "refused pointer worker",
        "point somewhere else",
        "the transcript the run named",
    );
    // A whole second store, holding transcripts this run never pointed at. A
    // reader that joined either value below would serve one of these — which is
    // what makes these two cases a proof rather than an assertion.
    let climbed = harness_history::record(
        &neighbour,
        "a climbed to worker",
        "a conversation this run never had",
        HIDDEN_TRANSCRIPT,
    );
    let rooted = harness_history::record(
        &neighbour,
        "an absolutely named worker",
        "another conversation this run never had",
        HIDDEN_TRANSCRIPT,
    );
    let traversed = format!("../neighbour/{}", climbed.project);
    // The same climb one layer up: a store that reaches the neighbour instead.
    // `oneagentgraph` publishes these three fields only for a file already in
    // oneharness's layout — an absolute path with no component that climbs — and
    // this is that promise checked here rather than taken on the producer's word.
    let climbing_store = store
        .join("..")
        .join("neighbour")
        .to_str()
        .expect("utf-8 path")
        .to_owned();
    let absolute = neighbour
        .join(&rooted.project)
        .to_str()
        .expect("utf-8 path")
        .to_owned();

    // Each case is recorded under the id of the record a *joined* pointer would
    // have found, so the check being gone is the difference between a `404` and
    // that record's own bytes.
    // Each case is `(what, store, project, session, artifact)`.
    let refused: Vec<(&str, Option<&str>, &str, &str, &str)> = vec![
        (
            "a store that climbs into another one",
            Some(&climbing_store),
            &climbed.project,
            &climbed.session,
            &climbed.history_id,
        ),
        (
            "a store that is a relative path",
            Some("oneharness-history"),
            &recorded.project,
            &recorded.session,
            &recorded.history_id,
        ),
        (
            "a project that climbs out of the store",
            None,
            &traversed,
            &climbed.session,
            &climbed.history_id,
        ),
        (
            "a project that is an absolute path",
            None,
            &absolute,
            &rooted.session,
            &rooted.history_id,
        ),
        (
            "a project that is the store's own index",
            None,
            ".index",
            &recorded.session,
            &recorded.history_id,
        ),
        (
            "a session that is not a bare name",
            None,
            &recorded.project,
            "../elsewhere",
            &recorded.history_id,
        ),
        (
            "a session that is empty",
            None,
            &recorded.project,
            "",
            &recorded.history_id,
        ),
    ];
    let serving = Serving::start(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        for (_, named, project, session, artifact) in &refused {
            fixture_run::relay_harness_session(
                &dir,
                &fixture_run::HarnessSession {
                    stream: HARNESS_STREAM,
                    node: fixture_run::NODE_ID,
                    member: "worker",
                    history_dir: Some(named.map_or(store.as_path(), Path::new)),
                    history_project: project,
                    history_session: session,
                    history_id: artifact,
                    bytes: 0,
                },
            );
        }
        // The same store, named as the producer names it, holding an id no
        // record in it carries.
        fixture_run::relay_harness_session(
            &dir,
            &fixture_run::HarnessSession {
                stream: HARNESS_STREAM,
                node: fixture_run::NODE_ID,
                member: "worker",
                history_dir: Some(&store),
                history_project: &recorded.project,
                history_session: &recorded.session,
                history_id: UNRECORDED_HISTORY_ID,
                bytes: 0,
            },
        );
    });

    for (what, _, _, _, artifact) in &refused {
        let response = http::get(
            serving.address,
            &format!("/api/v2/runs/{}/artifacts/{artifact}", fixture_run::RUN_ID),
        );
        assert_eq!(response.status, 404, "{what}: {}", response.body);
        assert_eq!(
            response.json()["error"]["code"],
            json!("artifact_not_found"),
            "{what}"
        );
        assert!(
            !response.body.contains(HIDDEN_TRANSCRIPT),
            "{what} opened a transcript outside the store the run named: {}",
            response.body
        );
    }

    let unknown = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{UNRECORDED_HISTORY_ID}",
            fixture_run::RUN_ID
        ),
    );
    assert_eq!(unknown.status, 404, "{}", unknown.body);
    assert_eq!(unknown.json()["error"]["code"], json!("artifact_not_found"));
}

/// A pointer whose components *resolve* out of the store, which no check on how
/// they are spelled can catch.
///
/// The two names are held to bare names, and a bare name still reaches anywhere
/// on this host if what it names is a symlink: the store's project layer and the
/// session files inside it are written by processes this one does not run, and
/// the pointer at them comes off a *journal* — records written by dispatched
/// agents, which is exactly the input a reader is tempted to trust because it is
/// "ours". So the resolved path is proved to be under the resolved store before
/// it is opened, and this plants both escapes a store offers: a project
/// component that is a link to another store's project, and a session file that
/// is a link to another store's transcript. Each is recorded under the id of the
/// record it would have served, so the confinement being gone is the difference
/// between a `404` and that conversation's own bytes.
///
/// Three more cases hold the answer to what it must *not* break or blur. A store
/// named through a symlink of its own still serves — canonicalizing both sides
/// is what makes a real store reachable by a real name, and a check that
/// compared spellings would refuse this one. A session file that is a dangling
/// link is `Missing` and not a refusal: nothing resolved, so there is nothing to
/// refuse, and the operator's log must not fill with alarms about transcripts
/// that were merely rotated away. And the wire says the same `404
/// artifact_not_found` to all of them — where a refused path *went* is the
/// host's business and is said to the operator's log alone, which is why this
/// journey reads that log rather than asserting the distinction in prose.
#[cfg(unix)]
#[test]
fn a_history_pointer_that_resolves_out_of_the_store_is_refused_rather_than_opened() {
    use std::os::unix::fs::symlink;

    let host = tempfile::tempdir().expect("the host's directories");
    let store = host.path().join("store");
    let elsewhere = host.path().join("elsewhere");
    fs::create_dir_all(&store).expect("the store the run named");
    fs::create_dir_all(&elsewhere).expect("the store beside it");

    let recorded = harness_history::record(
        &store,
        "confined worker",
        "stay in the store",
        "the transcript the run named",
    );
    let by_another_name = harness_history::record(
        &store,
        "a worker named through a link",
        "reach a real store by a real name",
        "the store was reached through a link",
    );
    // The transcripts nothing on this run's pointer may reach. One per escape,
    // because the route serves the *first* event carrying an id and two cases
    // sharing one would prove only whichever came first.
    let through_project = harness_history::record(
        &elsewhere,
        "a linked to project worker",
        "a conversation this run never had",
        HIDDEN_TRANSCRIPT,
    );
    let through_session = harness_history::record(
        &elsewhere,
        "a linked to session worker",
        "another conversation this run never had",
        HIDDEN_TRANSCRIPT,
    );

    // A bare name for a project, which is a link onto the other store's own
    // project directory.
    symlink(
        elsewhere.join(&through_project.project),
        store.join(ESCAPING_PROJECT),
    )
    .expect("the project that leaves the store");
    // A bare name for a session, which is a link onto the other store's
    // transcript file. Listed by the store's own reader exactly as a real
    // session is, because to that reader it is one.
    symlink(
        &through_session.path,
        store
            .join(&recorded.project)
            .join(format!("{ESCAPING_SESSION}.jsonl")),
    )
    .expect("the session that leaves the store");
    // A session that resolves nowhere: listed, and then gone.
    symlink(
        store.join(&recorded.project).join("rotated-away.jsonl"),
        store
            .join(&recorded.project)
            .join(format!("{VANISHED_SESSION}.jsonl")),
    )
    .expect("the session that resolves nowhere");
    // The store, reached by a name of its own that is a link.
    let linked_store = host.path().join("store-by-another-name");
    symlink(&store, &linked_store).expect("the store under another name");

    let serving = Serving::start_with_log(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        for session in [
            // The run's own transcript, named as the producer names it.
            (
                store.clone(),
                recorded.project.clone(),
                recorded.session.clone(),
                recorded.history_id.clone(),
            ),
            // The same store, named through a link to it.
            (
                linked_store.clone(),
                by_another_name.project.clone(),
                by_another_name.session.clone(),
                by_another_name.history_id.clone(),
            ),
            (
                store.clone(),
                ESCAPING_PROJECT.to_owned(),
                through_project.session.clone(),
                through_project.history_id.clone(),
            ),
            (
                store.clone(),
                recorded.project.clone(),
                ESCAPING_SESSION.to_owned(),
                through_session.history_id.clone(),
            ),
            (
                store.clone(),
                recorded.project.clone(),
                VANISHED_SESSION.to_owned(),
                VANISHED_HISTORY_ID.to_owned(),
            ),
        ] {
            let (named, project, file, artifact) = session;
            fixture_run::relay_harness_session(
                &dir,
                &fixture_run::HarnessSession {
                    stream: HARNESS_STREAM,
                    node: fixture_run::NODE_ID,
                    member: "worker",
                    history_dir: Some(&named),
                    history_project: &project,
                    history_session: &file,
                    history_id: &artifact,
                    bytes: 0,
                },
            );
        }
    });

    let artifact = |id: &str| {
        http::get(
            serving.address,
            &format!("/api/v2/runs/{}/artifacts/{id}", fixture_run::RUN_ID),
        )
    };

    // Asked for first, so that by the time the refusals below have been read off
    // the log a line about this one would already be on it.
    let vanished = artifact(VANISHED_HISTORY_ID);
    assert_eq!(vanished.status, 404, "{}", vanished.body);
    assert_eq!(
        vanished.json()["error"]["code"],
        json!("artifact_not_found")
    );

    for (what, escaped) in [
        (
            "a project that is a link out of the store",
            &through_project,
        ),
        (
            "a session that is a link out of the store",
            &through_session,
        ),
    ] {
        let response = artifact(&escaped.history_id);
        assert_eq!(response.status, 404, "{what}: {}", response.body);
        assert_eq!(
            response.json()["error"]["code"],
            json!("artifact_not_found"),
            "{what}"
        );
        assert!(
            !response.body.contains(HIDDEN_TRANSCRIPT),
            "{what} opened a transcript outside the store the run named: {}",
            response.body
        );
        assert!(
            !response
                .body
                .contains(elsewhere.to_str().expect("utf-8 path")),
            "{what} told a reader where the path it refused went: {}",
            response.body
        );
    }

    // The store the pointer really named is still read, whichever name it was
    // reached by.
    for (what, expected, id) in [
        (
            "the store as the producer names it",
            "the transcript the run named",
            &recorded.history_id,
        ),
        (
            "the same store through a link",
            "the store was reached through a link",
            &by_another_name.history_id,
        ),
    ] {
        let served = artifact(id);
        assert_eq!(served.status, 200, "{what}: {}", served.body);
        let content: Value =
            serde_json::from_str(served.json()["content"].as_str().expect("content"))
                .expect("the record");
        assert_eq!(content["text"], json!(expected), "{what}");
    }

    // What the operator is told, and what they are not. A refusal names the
    // artifact — an id that crossed the identifier boundary — and never where
    // the path it refused resolved to.
    let said = serving.wait_until_said(&through_session.history_id);
    for escaped in [&through_project, &through_session] {
        assert!(
            said.contains(&format!(
                "artifact {}: refusing a oneharness session",
                escaped.history_id
            )),
            "the operator was not told their journal carries a pointer that escapes: {said}"
        );
    }
    assert!(
        !said.contains(elsewhere.to_str().expect("utf-8 path")),
        "the refusal put the resolved location on the log: {said}"
    );
    assert!(
        !said.contains(VANISHED_HISTORY_ID),
        "a transcript that is merely gone was reported as a refusal: {said}"
    );
    for served in [&recorded, &by_another_name] {
        assert!(
            !said.contains(&served.history_id),
            "a transcript that was served was reported as a refusal: {said}"
        );
    }
}

/// A pointer that names no store at all resolves against oneharness's own
/// default one.
///
/// The producer publishes `history_dir` only when the store is not the default,
/// and this crate takes no flag and no config key of its own for that path: a
/// second source for it is how a reader and a writer come to disagree about
/// where the transcripts on a host are. What it resolves is what every
/// oneharness process here resolves — the platform state directory — which is
/// what this drives, by running the server with that directory named.
#[cfg(unix)]
#[test]
fn a_pointer_naming_no_store_reads_the_one_every_oneharness_process_here_resolves() {
    let state = tempfile::tempdir().expect("the platform state directory");
    let store = state.path().join("oneharness").join("history");
    fs::create_dir_all(&store).expect("the default store");
    let recorded = harness_history::record(
        &store,
        "default store worker",
        "write into the default store",
        "the default store is where this landed",
    );
    let (workspace, runs) = fixture_run::workspace();
    let dir = fixture_run::write(&runs, fixture_run::RUN_ID);
    fixture_run::relay_harness_session(
        &dir,
        &fixture_run::HarnessSession {
            stream: HARNESS_STREAM,
            node: fixture_run::NODE_ID,
            member: "worker",
            history_dir: None,
            history_project: &recorded.project,
            history_session: &recorded.session,
            history_id: &recorded.history_id,
            bytes: recorded.bytes(),
        },
    );
    let serving = Serving::start_in(
        workspace,
        &[("XDG_STATE_HOME", state.path().to_str().expect("utf-8"))],
    );

    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{}",
            fixture_run::RUN_ID,
            recorded.history_id
        ),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let content: Value =
        serde_json::from_str(response.json()["content"].as_str().expect("content"))
            .expect("the record");
    assert_eq!(
        content["text"],
        json!("the default store is where this landed")
    );
}

/// The engine's own label set for one launch under a run, in oneharness's wire
/// format: what `ONEHARNESS_HISTORY_LABELS` carries into every harness turn of
/// that launch, composed by the engine's own composer over what the repository
/// stamped.
fn stamped(run: &str, launched: onepipeline::agents::Launched<'_>) -> String {
    onepipeline::agents::compose_labels(
        Some("role=engineer"),
        &onepipeline::agents::Stamp {
            run,
            project: Some(fixture_run::PLAN_PROJECT),
            launched,
        },
    )
    .expect("the engine composes the labels")
}

/// A node-scope launch of `node`, at its first attempt.
fn node_launch(node: &str) -> onepipeline::agents::Launched<'_> {
    onepipeline::agents::Launched::Node {
        node,
        step: None,
        attempt: std::num::NonZeroU32::MIN,
    }
}

/// Record one session a launch under `run` wrote, into `store`, the way a
/// oneharness under the engine's overlay records one: labelled as the engine
/// stamped the launch, and pointed at from the run's own pointer file.
fn launched_session(
    store: &Path,
    root: &Path,
    run: &str,
    launched: onepipeline::agents::Launched<'_>,
    name: &str,
    text: &str,
) -> harness_history::Recorded {
    let pointer_file = onepipeline::views::RunPaths::under(root, run).oneharness_sessions();
    harness_history::record_pointed(
        store,
        &harness_history::Pointed {
            pointer_file: &pointer_file,
            labels: &stamped(run, launched),
        },
        name,
        "do the work the node asks",
        text,
    )
}

/// One served agent entry, read back to the session file its pointer line
/// names: the record served under the entry's own `run_id` and history id is
/// the one the writer wrote, in the file the entry says it is in.
fn assert_opens_to_transcript(
    serving: &Serving,
    entry: &Value,
    recorded: &harness_history::Recorded,
    text: &str,
) {
    assert_eq!(entry["history_session"], json!(recorded.session), "{entry}");
    assert_eq!(entry["history_project"], json!(recorded.project), "{entry}");
    assert_eq!(
        entry["history_file"],
        json!(recorded.path.display().to_string()),
        "the entry names the file the writer wrote: {entry}"
    );
    let runs = entry["runs"].as_array().expect("the harness runs");
    assert_eq!(runs.len(), 1, "{entry}");
    assert_eq!(runs[0]["history_id"], json!(recorded.history_id));
    assert_eq!(runs[0]["harness_id"], json!("claude-code:alternate"));
    assert_eq!(runs[0]["harness"], json!("claude-code"));
    assert_eq!(runs[0]["variant"], json!("alternate"));
    assert!(runs[0]["started"]
        .as_str()
        .is_some_and(|at| at.ends_with('Z')));
    // The link: the run the entry names, and the harness run's history id, on
    // the artifact route — the same resolution a relayed session opens through.
    let run = entry["run_id"]
        .as_str()
        .expect("the run the entry is under");
    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{run}/artifacts/{}",
            runs[0]["history_id"].as_str().expect("a history id")
        ),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["kind"], json!("oneharness_session"));
    let content: Value =
        serde_json::from_str(body["content"].as_str().expect("content")).expect("the record");
    assert_eq!(
        content["history_id"],
        json!(recorded.history_id),
        "{content}"
    );
    assert_eq!(
        content["session"],
        json!(recorded.session),
        "the record served is from the session file the pointer line names: {content}"
    );
    assert_eq!(content["text"], json!(text), "{content}");
}

/// Every agent a run launched, off the run's own pointer file, each opening to
/// the transcript in the store oneharness itself kept it in.
///
/// Three runs under one project, recorded the way the engine's overlay has a
/// oneharness record them — the labels the launch was stamped with, and one
/// pointer line per harness run appended to the run's own file — through that
/// library's own writer, into a store under the journey's own state directory.
/// Nothing is relayed into any journal: these sessions are the ones only the
/// pointer file names, and the artifact route opens each through it.
#[test]
fn the_agents_a_run_launched_are_served_off_its_pointer_file_and_open_to_their_transcripts() {
    const QUIET_RUN: &str = "run-20260807-e7f8a9";
    let (workspace, root) = fixture_run::workspace();
    let store = workspace.path().join("oneharness-history");
    for run in [fixture_run::RUN_ID, fixture_run::OTHER_RUN_ID, QUIET_RUN] {
        fixture_run::write(&root, run);
    }
    // The first run: a worker under its node and the run's observer. The
    // second: one worker. The third launched nothing yet, so it has no file.
    let worker = launched_session(
        &store,
        &root,
        fixture_run::RUN_ID,
        node_launch(fixture_run::NODE_ID),
        "contract interface worker",
        "the route table is landed",
    );
    let observer = launched_session(
        &store,
        &root,
        fixture_run::RUN_ID,
        onepipeline::agents::Launched::Observer,
        "monitor",
        "nothing has been quiet for long",
    );
    let other = launched_session(
        &store,
        &root,
        fixture_run::OTHER_RUN_ID,
        node_launch(fixture_run::REVIEW_NODE_ID),
        "reviewer",
        "the review is approved",
    );
    let serving = Serving::start_in(workspace, &[]);

    // The run's agents: both sessions, each carrying the engine's keys and the
    // repository's own, in the order they first appeared.
    let response = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/agents", fixture_run::RUN_ID),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_enveloped(&body);
    assert_eq!(body["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(body["skipped"], json!(0));
    let sessions = body["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 2, "{body}");
    assert_opens_to_transcript(&serving, &sessions[0], &worker, "the route table is landed");
    // The name as the writer keeps it, which is its own sanitised spelling.
    assert_eq!(
        sessions[0]["name"],
        json!(oneharness_core::domain::history::sanitize_name(
            "contract interface worker"
        ))
    );
    assert_eq!(sessions[0]["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(
        sessions[0]["labels"],
        json!({
            "onepipeline.attempt": "1",
            "onepipeline.node": fixture_run::NODE_ID,
            "onepipeline.project": fixture_run::PLAN_PROJECT,
            "onepipeline.run_id": fixture_run::RUN_ID,
            "onepipeline.scope": "node",
            "role": "engineer",
        }),
        "{body}"
    );
    // The store the journey wrote into, in the spelling the writer records —
    // the resolved one, which is not the path passed in wherever a temporary
    // directory is reached through a symlink.
    assert_eq!(
        sessions[0]["history_dir"],
        json!(worker.dir.display().to_string()),
        "{body}"
    );
    assert!(
        sessions[0]["project"]
            .as_str()
            .is_some_and(|cwd| cwd.ends_with("project")),
        "the directory the harness ran in: {body}"
    );
    assert_opens_to_transcript(
        &serving,
        &sessions[1],
        &observer,
        "nothing has been quiet for long",
    );
    assert_eq!(
        sessions[1]["labels"]["onepipeline.scope"],
        json!("observer")
    );
    assert!(sessions[1]["labels"].get("onepipeline.node").is_none());

    // One node's: the worker alone. A node that dispatched nothing is an empty
    // list, not an error.
    let node = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/nodes/{}/agents",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        ),
    )
    .json();
    assert_enveloped(&node);
    assert_eq!(node["node"], json!(fixture_run::NODE_ID));
    assert_eq!(
        node["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .map(|entry| entry["history_session"].clone())
            .collect::<Vec<_>>(),
        vec![json!(worker.session)],
        "{node}"
    );
    let none = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/nodes/{}/agents",
            fixture_run::RUN_ID,
            fixture_run::REVIEW_NODE_ID
        ),
    );
    assert_eq!(none.status, 200, "{}", none.body);
    assert_eq!(none.json()["sessions"], json!([]));

    // A run with no pointer file is an empty list, not an error.
    let quiet = http::get(serving.address, &format!("/api/v2/runs/{QUIET_RUN}/agents"));
    assert_eq!(quiet.status, 200, "{}", quiet.body);
    assert_eq!(quiet.json()["sessions"], json!([]));
    assert_eq!(quiet.json()["skipped"], json!(0));

    // The count beside the run's detail is the number of sessions the agents
    // route answers: two, and zero for the run that launched nothing.
    for (run, expected) in [(fixture_run::RUN_ID, 2), (QUIET_RUN, 0)] {
        let detail = http::get(serving.address, &format!("/api/v2/runs/{run}")).json();
        assert_eq!(
            detail["run"]["agent_count"],
            json!(expected),
            "{run}: {detail}"
        );
    }

    // The project's: the union over its three runs, each entry naming the run
    // it is under, and the count beside the project on both routes that serve
    // the group.
    let project = http::get(
        serving.address,
        &format!(
            "/api/v2/projects/{}/agents",
            fixture_run::PLAN_PROJECT.replace(':', "%3A")
        ),
    );
    assert_eq!(project.status, 200, "{}", project.body);
    let body = project.json();
    assert_enveloped(&body);
    assert_eq!(body["project"], json!(fixture_run::PLAN_PROJECT));
    let sessions = body["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 3, "{body}");
    let by_run = |run: &str| -> Vec<&Value> {
        sessions
            .iter()
            .filter(|entry| entry["run_id"] == json!(run))
            .collect()
    };
    assert_eq!(by_run(fixture_run::RUN_ID).len(), 2, "{body}");
    let others = by_run(fixture_run::OTHER_RUN_ID);
    assert_eq!(others.len(), 1, "{body}");
    assert_opens_to_transcript(&serving, others[0], &other, "the review is approved");
    let groups = http::get(serving.address, "/api/v2/projects").json();
    let group = groups["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|group| group["project"] == json!(fixture_run::PLAN_PROJECT))
        .expect("the fixture's project");
    assert_eq!(group["agent_count"], json!(3), "{groups}");
    let group = http::get(
        serving.address,
        &format!(
            "/api/v2/projects/{}",
            fixture_run::PLAN_PROJECT.replace(':', "%3A")
        ),
    )
    .json();
    assert_eq!(group["agent_count"], json!(3), "{group}");

    // A run that is not there, and a project no run was launched from, are the
    // contract's own not-found on every one of the three.
    let missing = http::get(serving.address, "/api/v2/runs/run-20260807-000000/agents");
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(missing.json()["error"]["code"], json!("run_not_found"));
    let missing = http::get(
        serving.address,
        "/api/v2/runs/run-20260807-000000/nodes/contract-interface/agents",
    );
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(missing.json()["error"]["code"], json!("run_not_found"));
    let missing = http::get(serving.address, "/api/v2/projects/local-md%3Anobody/agents");
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(missing.json()["error"]["code"], json!("project_not_found"));
}

/// A pointer file the engine's own reader cannot read is the engine's refusal
/// on the agents route, and leaves the count beside the run absent rather
/// than a zero a reader would take for "nothing launched".
///
/// The project the run is under answers the same way, on all three of its
/// routes: a group's count is the union over its runs, so one run it cannot
/// read is a count it cannot state, and the listing itself is the engine's
/// refusal rather than a union quietly missing a run's share of it.
#[test]
fn a_pointer_file_that_cannot_be_read_is_refused_and_leaves_the_count_absent() {
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        // A directory where the file should be: there, and not readable as one.
        fs::create_dir_all(
            onepipeline::views::RunPaths::under(root, fixture_run::RUN_ID).oneharness_sessions(),
        )
        .expect("a directory in the pointer file's place");
    });
    let response = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/agents", fixture_run::RUN_ID),
    );
    assert_eq!(response.status, 422, "{}", response.body);
    assert_eq!(response.json()["error"]["code"], json!("refused"));
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    assert!(
        detail["run"].get("agent_count").is_none(),
        "a count nothing could read is served absent, not as a zero: {detail}"
    );

    // The project the run is under: the listing is the same refusal, and both
    // routes that carry the group's count leave it absent for the same reason.
    let encoded = fixture_run::PLAN_PROJECT.replace(':', "%3A");
    let listing = http::get(
        serving.address,
        &format!("/api/v2/projects/{encoded}/agents"),
    );
    assert_eq!(listing.status, 422, "{}", listing.body);
    assert_eq!(listing.json()["error"]["code"], json!("refused"));
    let group = http::get(serving.address, &format!("/api/v2/projects/{encoded}")).json();
    assert!(
        group.get("agent_count").is_none(),
        "the group's count is the union over its runs, and one it could not read leaves \
         it absent rather than short: {group}"
    );
    let groups = http::get(serving.address, "/api/v2/projects").json();
    let listed = groups["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|group| group["project"] == json!(fixture_run::PLAN_PROJECT))
        .expect("the fixture's project");
    assert!(
        listed.get("agent_count").is_none(),
        "the row carries the same absent count as the group: {groups}"
    );
}

/// The stream `oneagentgraph` relays a member's oneharness invocation on.
const HARNESS_STREAM: &str = "node-scope-1786925518098-3163646";
/// A history id well-formed enough to ask for and recorded by nothing.
const UNRECORDED_HISTORY_ID: &str = "01a00d0f-c094-7660-b26c-8a53baaf9c3b";
/// What the store beside the one the run named holds. No response may carry it.
const HIDDEN_TRANSCRIPT: &str = "a conversation from a store this run never named";
/// A bare name for a project, which is a link onto another store's project.
///
/// This and the three below are `unix` for the reason their journey is: planting
/// a link needs a privilege Windows CI does not hold. Gated rather than deleted
/// or allowed, so the file still says on every platform what is confined there.
#[cfg(unix)]
const ESCAPING_PROJECT: &str = "a-project-that-is-a-link";
/// A bare name for a session, which is a link onto another store's transcript.
#[cfg(unix)]
const ESCAPING_SESSION: &str = "a-session-that-is-a-link";
/// A bare name for a session whose file resolves to nothing at all.
#[cfg(unix)]
const VANISHED_SESSION: &str = "a-session-that-went-away";
/// The id recorded for that vanished session. Well-formed and readable nowhere.
#[cfg(unix)]
const VANISHED_HISTORY_ID: &str = "01a00d0f-c094-7660-b26c-8a53baaf9c3c";

/// Every file under a directory, in a stable order.
///
/// Scoped to `unix` because its only caller is: the read-only-store journey
/// above proves itself by taking every mode down to read-only, which is a
/// `unix` permission model. Gated rather than deleted or allowed, so the file
/// still says on every platform which journey this exists for.
#[cfg(unix)]
fn walk(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let mut entries: Vec<std::path::PathBuf> = fs::read_dir(root)
        .expect("read the store")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    entries.sort();
    for entry in entries {
        if entry.is_dir() {
            found.push(entry.clone());
            found.extend(walk(&entry));
        } else {
            found.push(entry);
        }
    }
    found
}

/// Every file in a store, by name, bytes and modification time — the whole of
/// what a read must leave alone.
///
/// `unix`-only for the same reason as `walk`, which it is built on: the one
/// journey that compares a store across a read is.
#[cfg(unix)]
fn store_state(
    root: &std::path::Path,
) -> Vec<(
    std::path::PathBuf,
    Option<Vec<u8>>,
    Option<std::time::SystemTime>,
)> {
    walk(root)
        .into_iter()
        .map(|path| {
            let metadata = fs::metadata(&path).ok();
            (
                path.clone(),
                fs::read(&path).ok(),
                metadata.and_then(|metadata| metadata.modified().ok()),
            )
        })
        .collect()
}

/// The conversation label is what makes a turn reachable, and nothing else is.
///
/// `oneagentgraph` stamps `session` into an envelope's labels on its four turn
/// kinds and on no other, and this crate's whole conversation surface keys off
/// it: the transcripts a run detail lists, the reference a timeline hangs on a
/// relayed turn in *both* scopes, and the document the transcript route serves.
/// A producer that stopped stamping it served every run an empty
/// `conversations` here with nothing failing, which is what this journey exists
/// to stop happening twice — so it asserts the reachable chain and, on the same
/// store, that an agentgraph record carrying no label reaches none of it.
#[test]
fn the_conversation_label_a_producer_stamps_is_what_makes_a_turn_reachable() {
    let serving = two_runs();
    // A relayed record of the same kind, on the same node, that the producer
    // stamped no session onto: the label is the difference, so the timeline must
    // hang no transcript on it.
    fixture_run::append_relayed(
        &serving.run_dir(fixture_run::RUN_ID),
        "agentgraph",
        "turn-started",
        json!({
            "run_id": fixture_run::RUN_ID,
            "node": fixture_run::NODE_ID,
            "member": "worker",
            "persona": "worker",
        }),
        json!({ "turn": 9 }),
    );
    // And one carrying a label no route could resolve. A session id is what a
    // client addresses a transcript by, so a label the conversation route would
    // refuse must reach no listing, no turn id and no count either — a number
    // beside a node that folded in a session nobody can open is the same broken
    // promise as no number at all.
    fixture_run::append_relayed(
        &serving.run_dir(fixture_run::RUN_ID),
        "agentgraph",
        "turn-started",
        json!({
            "run_id": fixture_run::RUN_ID,
            "node": fixture_run::NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": "../not-a-session",
        }),
        json!({ "turn": 10, "role": "assistant" }),
    );

    let detail = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}?include_conversations=true",
            fixture_run::RUN_ID
        ),
    )
    .json();
    let listed: Vec<&str> = detail["conversations"]
        .as_array()
        .expect("conversations")
        .iter()
        .filter_map(|document| document["conversation"]["id"].as_str())
        .collect();
    assert_eq!(
        listed,
        vec![
            fixture_run::CONVERSATION_ID,
            fixture_run::REVIEW_CONVERSATION_ID,
            fixture_run::REVIEW_JUDGE_CONVERSATION_ID
        ],
        "one transcript per labelled session — plus the judge the first one's report \
         holds — and none for the unlabelled record: {detail}"
    );
    // And the count beside the node is the same reading: an unlabelled record
    // reaches no transcript, so counting it would leave a reader who trusted the
    // number one turn short when they opened the transcript.
    let counted = detail["run"]["nodes"]
        .as_array()
        .expect("the rows")
        .iter()
        .find(|row| row["node"] == json!(fixture_run::NODE_ID))
        .expect("the worker node")["turns"]
        .clone();
    assert_eq!(
        counted,
        json!(detail["conversations"][0]["conversation"]["turns"]
            .as_array()
            .expect("its turns")
            .len())
    );

    // Both scopes, because a reader arrives at a turn from either: the run's own
    // timeline and the node's are two readings of the same records, and a
    // reference on one alone is a transcript half the readers cannot open.
    for (scope, expected) in [
        (
            "scope=run".to_owned(),
            vec![
                fixture_run::CONVERSATION_ID,
                fixture_run::REVIEW_CONVERSATION_ID,
            ],
        ),
        (
            format!("scope=node&node={}", fixture_run::NODE_ID),
            vec![fixture_run::CONVERSATION_ID],
        ),
    ] {
        let timeline = http::get(
            serving.address,
            &format!("/api/v2/runs/{}/timeline?{scope}", fixture_run::RUN_ID),
        )
        .json();
        let mut referenced: Vec<String> = Vec::new();
        let mut unlabelled = 0;
        for event in relayed(&timeline, "turn-started") {
            match &event["reference"] {
                Value::Null => unlabelled += 1,
                reference => {
                    assert_eq!(
                        reference["kind"],
                        json!("conversation"),
                        "{scope}: a relayed turn points at its transcript: {event}"
                    );
                    let session = reference["value"].as_str().expect("a session").to_owned();
                    if !referenced.contains(&session) {
                        referenced.push(session);
                    }
                }
            }
        }
        assert_eq!(referenced, expected, "{scope}: {timeline}");
        assert_eq!(
            unlabelled, 2,
            "{scope}: the record with no label and the one with a label no route \
             resolves are both served, with no transcript hung on either"
        );

        // Every reference is followed, because a reference a reader cannot open
        // is the same failure as no reference at all.
        for session in &referenced {
            let served = http::get(
                serving.address,
                &format!(
                    "/api/v2/runs/{}/conversations/{session}",
                    fixture_run::RUN_ID
                ),
            );
            assert_eq!(served.status, 200, "{session}: {}", served.body);
            let body = served.json();
            assert_eq!(body["conversation"]["id"], json!(session));
            assert!(
                !body["conversation"]["turns"]
                    .as_array()
                    .expect("turns")
                    .is_empty(),
                "{session} has the turns the timeline counted: {body}"
            );
        }
    }
}

/// Every event of one kind a timeline served, whatever span it sits under.
fn relayed(timeline: &Value, kind: &str) -> Vec<Value> {
    fn under(span: &Value, kind: &str, found: &mut Vec<Value>) {
        for event in span["events"].as_array().into_iter().flatten() {
            if event["kind"] == json!(kind) {
                found.push(event.clone());
            }
        }
        for child in span["children"].as_array().into_iter().flatten() {
            under(child, kind, found);
        }
    }
    let mut found = Vec::new();
    for span in timeline["spans"].as_array().into_iter().flatten() {
        under(span, kind, &mut found);
    }
    found
}

#[test]
fn a_route_the_contract_does_not_define_still_answers_in_the_error_contract() {
    let serving = two_runs();
    let response = http::get(serving.address, "/api/v2/nope");
    assert_eq!(response.status, 404);
    assert_eq!(response.json()["error"]["code"], json!("no_such_route"));
}

#[test]
fn the_stream_opens_with_a_fresh_snapshot_and_invalidates_on_a_live_append() {
    let serving = two_runs();
    let mut stream = http::stream(serving.address, "/api/v2/events", None);
    assert_eq!(stream.status, 200);

    let snapshot = stream.next_frame().expect("a first frame");
    assert_eq!(snapshot.event, "snapshot");
    assert_eq!(snapshot.id, "0");
    let listed = snapshot.json();
    assert_enveloped(&listed);
    assert_eq!(
        listed["runs"].as_array().map(Vec::len),
        Some(2),
        "the snapshot carries every run, settled or not"
    );

    // A real append to a real journal, exactly as the running loop makes one.
    fixture_run::append(
        &serving.run_dir(fixture_run::RUN_ID),
        "planner-surface-queued",
        json!({ "kind": "decision", "message": "which way?", "blocking": true }),
    );

    let changed = stream.next_frame().expect("the append is noticed");
    assert_eq!(changed.event, "run.changed");
    assert_eq!(changed.json()["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(changed.id, "1", "cursors are monotonic within a connection");
}

/// A `run_id` on the stream is the id a client turns straight back into
/// `GET /api/v2/runs/{run}`. A directory whose name the contract's own boundary
/// would refuse is one the stream must not point a client at, so it is passed
/// over rather than announced as a run to go and read.
#[test]
fn a_run_directory_the_contract_cannot_name_is_never_announced_on_the_stream() {
    let unnameable = "a run with spaces";
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, unnameable);
    });
    let mut stream = http::stream(serving.address, "/api/v2/events", None);
    assert_eq!(stream.next_frame().expect("a snapshot").event, "snapshot");

    // Both move: only the one a client could refetch is reported.
    fixture_run::append(&serving.run_dir(unnameable), "node-ready", json!({}));
    fixture_run::append(
        &serving.run_dir(fixture_run::RUN_ID),
        "node-ready",
        json!({}),
    );

    let changed = stream.next_frame().expect("the append is noticed");
    assert_eq!(changed.event, "run.changed");
    assert_eq!(
        changed.json()["run_id"],
        json!(fixture_run::RUN_ID),
        "the stream named a run the route would refuse"
    );
}

#[test]
fn a_run_that_leaves_the_root_is_reported_removed() {
    let serving = two_runs();
    let mut stream = http::stream(serving.address, "/api/v2/events", None);
    assert_eq!(stream.next_frame().expect("a snapshot").event, "snapshot");

    std::fs::remove_dir_all(serving.run_dir(fixture_run::OTHER_RUN_ID))
        .expect("the run leaves the root");

    let removed = stream.next_frame().expect("the removal is noticed");
    assert_eq!(removed.event, "run.removed");
    assert_eq!(removed.json()["run_id"], json!(fixture_run::OTHER_RUN_ID));
}

#[test]
fn a_reconnect_carrying_a_cursor_still_opens_with_a_snapshot() {
    let serving = two_runs();
    let mut resumed = http::stream(serving.address, "/api/v2/events", Some("41"));
    let first = resumed.next_frame().expect("a first frame");
    assert_eq!(
        first.event, "snapshot",
        "this process retains no history to replay, so a reconnect is re-snapshotted"
    );
    assert_eq!(
        first.id, "41",
        "the cursor only continues the numbering across the reconnect"
    );
}

#[test]
fn a_crafted_last_event_id_cannot_stop_a_client_reconnecting() {
    let serving = two_runs();
    let mut stream = http::stream(serving.address, "/api/v2/events", Some("not-a-cursor"));
    let first = stream.next_frame().expect("a first frame");
    assert_eq!(first.event, "snapshot");
    assert_eq!(
        first.id, "0",
        "an id this process could not have issued is ignored"
    );
}

#[test]
fn a_watched_run_that_is_not_one_is_refused_before_the_stream_opens() {
    let serving = two_runs();
    let response = http::get(serving.address, "/api/v2/events?run_id=..%2Fetc");
    assert_eq!(response.status, 422);
    assert_eq!(response.json()["error"]["code"], json!("invalid_run_id"));
}

#[test]
fn a_run_recorded_with_no_events_serves_a_null_last_event() {
    let serving = Serving::start(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        std::fs::write(dir.join("events.jsonl"), "").expect("a journal with nothing in it");
    });
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    assert_eq!(
        body["run"]["last_event"],
        Value::Null,
        "never an empty string: a just-launched run has recorded nothing"
    );
    assert_eq!(body["run"]["timing"]["wall_ms"], json!(0));
}

#[test]
fn a_journal_line_this_build_cannot_read_does_not_stop_the_run_being_served() {
    let serving = Serving::start(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        let journal = dir.join("events.jsonl");
        let existing = std::fs::read_to_string(&journal).expect("the journal");
        std::fs::write(
            &journal,
            format!("{existing}{{\"v\":99,\"from\":\"a newer schema\"}}\n"),
        )
        .expect("append a line from the future");
    });
    let response = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    );
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json()["graph"]["node_status"][fixture_run::NODE_ID],
        json!("done"),
        "a reader skips records it cannot read rather than refusing the run around them"
    );
}

#[test]
fn a_directory_that_records_no_launch_is_not_a_run() {
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        std::fs::create_dir_all(root.join("not-a-run")).expect("a stray directory");
        std::fs::write(root.join("not-a-run/notes.txt"), "scratch").expect("stray contents");
    });
    let body = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let ids: Vec<&str> = body["runs"]
        .as_array()
        .expect("runs")
        .iter()
        .filter_map(|run| run["run_id"].as_str())
        .collect();
    assert_eq!(ids, vec![fixture_run::RUN_ID]);
}

/// A server that was serving, asked to stop the given way, exits `0` before
/// `STOP_DEADLINE`.
///
/// Being asked to stop is the *normal* end of a read surface, so anything else —
/// a non-zero status, or a shutdown a supervisor has to escalate to `SIGKILL` —
/// is a clean stop reported as a crash by everything supervising this process.
#[cfg(unix)]
fn assert_stops_cleanly(stop: Stop) {
    let serving = two_runs();
    // Proves it was serving before it was asked, so a `0` here cannot be a
    // process that failed to start.
    assert_eq!(http::get(serving.address, "/healthz").status, 200);
    let status = serving.stop_on(stop);
    assert_eq!(
        status.code(),
        Some(0),
        "being asked to stop is the normal end of a read surface: {status}"
    );
}

/// Unix only: `Serving::stop_on` needs a stop a parent can *ask* for, and
/// Windows has none — see `tests/support/serving.rs`'s `ask_to_stop`.
#[cfg(unix)]
#[test]
fn a_server_a_supervisor_asks_to_stop_finishes_cleanly() {
    assert_stops_cleanly(Stop::Terminate);
}

/// The other half of the same contract. `SIGINT` is what a terminal sends, and a
/// server that handled only `SIGTERM` would be killed by it — the same 130-shaped
/// failure as the 143 the published binary gave, just from the other signal.
#[cfg(unix)]
#[test]
fn a_server_interrupted_at_a_terminal_finishes_cleanly() {
    assert_stops_cleanly(Stop::Interrupt);
}

/// A subscriber must not be able to hold the shutdown open, and must not have
/// its response cut off mid-frame either.
///
/// Those pull in opposite directions, and the server resolves them at the frame
/// boundary: the stop is noticed at the reader's next poll, so the frames
/// already written arrive whole and the stream is then closed at the end of one
/// rather than the socket being dropped in the middle of one. This asserts both
/// halves — the client sees a clean end of stream, and the process still exits
/// `0` inside the bound with the subscription open.
#[cfg(unix)]
#[test]
fn a_server_asked_to_stop_ends_its_open_streams_rather_than_waiting_on_them() {
    let serving = two_runs();
    let mut stream = http::stream(serving.address, "/api/v2/events", None);
    assert_eq!(stream.status, 200);
    let snapshot = stream.next_frame().expect("a first frame");
    assert_eq!(snapshot.event, "snapshot");

    let address = serving.address;
    let status = serving.stop_on(Stop::Terminate);
    assert_eq!(status.code(), Some(0), "a subscriber held the stop open");

    // Read to the end from *this* side: the server closed the stream, so the
    // remaining frames are whole and then it ends. A truncated frame would come
    // back as a parse failure here, and a dropped socket as a read error.
    while let Some(frame) = stream.next_frame() {
        let _ = frame.json();
    }
    assert!(
        std::net::TcpStream::connect(address).is_err(),
        "the process exited but something is still listening on {address}"
    );
}

/// A server over the run that is still being driven.
fn live_run() -> Serving {
    Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    })
}

#[test]
fn a_live_run_reports_what_it_is_doing_and_what_it_is_waiting_on() {
    let serving = live_run();
    let body = http::get(serving.address, "/api/v2/runs?include_settled=false").json();
    let run = &body["runs"][0];
    assert_eq!(run["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(run["state"], json!("active"), "a live run is not settled");
    // A decision point is outstanding — a human action nobody has attested — and
    // that is what the run is doing, whatever else is dispatched beside it.
    assert_eq!(run["phase"], json!("deciding"));
    assert_eq!(run["timing_quality"], json!("partial"));
    assert_eq!(run["launch"]["launcher"], json!("codex"));
    // The human action is waiting and the node behind it is gated by it.
    assert_eq!(run["node_counts"]["waiting"], json!(1));
    assert_eq!(run["node_counts"]["blocked"], json!(1));
    assert_eq!(run["node_counts"]["done"], json!(1));

    // Every millisecond of the run's clock has exactly one home: the lanes the
    // wire names a fraction for, and the residue nothing measured.
    let timing = &run["timing"];
    let ms = |key: &str| {
        timing[key]
            .as_u64()
            .unwrap_or_else(|| panic!("{key}: {timing}"))
    };
    // The sibling's own invariant, carried onto the wire: its measured buckets
    // sum exactly to the whole, so the residue is what nothing measured.
    let measured: u64 = [
        "agent_seconds",
        "judge_seconds",
        "llmlint_seconds",
        "gate_seconds",
        "publication_wait_seconds",
        "lock_wait_seconds",
        "setup_seconds",
        "scheduling_seconds",
    ]
    .iter()
    .filter_map(|lane| timing[*lane].as_u64())
    .sum();
    assert!(
        measured * 1_000 + ms("unattributed_ms") <= ms("wall_ms")
            && ms("wall_ms") - measured * 1_000 - ms("unattributed_ms") < 8_000,
        "the measured buckets and the residue are the whole clock, to the second \
         each of them is served in: {timing}"
    );
    // Measured where a record measured it, and absent where none did — never a
    // zero a reader could take for a measurement.
    // The bucket is wall time the run spent blocked, which is what a breakdown
    // of a clock means — not the `elapsed` the `lock-wait` record carries, which
    // is how long that one wait had lasted when the turn finally came. The
    // rollup on the timeline serves the second; this serves the first.
    assert_eq!(
        timing["lock_wait_seconds"],
        json!(2),
        "the sibling attributed the block: {timing}"
    );
    assert_eq!(
        timing["llmlint_model_ms"],
        json!(null),
        "nothing reports time inside a model, for any party: {timing}"
    );
    assert_eq!(timing["judge_model_ms"], json!(null), "{timing}");
    assert_eq!(timing["agent_model_ms"], json!(null), "{timing}");
    assert_eq!(timing["tool_ms"], json!(null), "nothing times a tool call");
    // The run waited on a planner and on a person, and the sibling's vocabulary
    // folds both into `scheduling` — which is where that time is, and why the
    // wire's own lane for it is absent rather than a share of a bucket that is
    // not it.
    assert!(
        timing["scheduling_seconds"].as_u64().is_some_and(|s| s > 0),
        "the waits are time the run spent: {timing}"
    );
    assert_eq!(
        timing["idle_orchestration_ms"],
        json!(null),
        "nothing measures the two waits apart from the rest of scheduling: {timing}"
    );
}

#[test]
fn the_run_is_served_as_one_graph_with_the_decisions_holding_it_back() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let graph = &body["graph"];
    // One graph and one recorded result, whatever a node did earlier: the loop is
    // continuous, so what a reader is told is where the whole thing has got to.
    assert!(body.get("rounds").is_none(), "{body}");
    assert_eq!(
        graph["result"],
        Value::Null,
        "no driver has closed out, so there is no recorded result"
    );
    // The node that failed and was superseded is still in the graph's account of
    // itself — a settlement is not forgotten because a later edit replaced it.
    assert_eq!(
        graph["node_status"][fixture_run::REPORTED_NODE_ID],
        json!("running"),
        "the re-asked dispatch is what the node is doing now: {graph}"
    );
    assert_eq!(
        graph["node_status"][fixture_run::SIGNOFF_NODE_ID],
        json!("waiting")
    );
    assert_eq!(
        graph["node_status"][fixture_run::ANNOUNCE_NODE_ID],
        json!("blocked")
    );
    assert_eq!(
        graph["node_gated_by"][fixture_run::ANNOUNCE_NODE_ID],
        json!([fixture_run::SIGNOFF_NODE_ID]),
        "a client is told which nodes are holding a blocked one, in plan order"
    );
    // `node_states` carries only what the journal recorded, never a derived gate.
    assert!(
        graph["node_states"]
            .get(fixture_run::ANNOUNCE_NODE_ID)
            .is_none(),
        "blocked is derived on every read, not recorded: {graph}"
    );
    assert_eq!(
        graph["node_states"][fixture_run::SIGNOFF_NODE_ID],
        json!("waiting")
    );
    // The one thing a continuous engine pauses for, and the reason a reader of a
    // stalled run can tell "waiting on a person" from "abandoned". The blocking
    // surface this run raised was answered, so what is left is the human action.
    let decisions = graph["decisions"].as_array().expect("decisions");
    assert_eq!(
        decisions
            .iter()
            .map(|decision| decision["id"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        vec![fixture_run::SIGNOFF_NODE_ID],
        "{decisions:?}"
    );
    assert_eq!(
        decisions[0]["unblocks"],
        json!([fixture_run::ANNOUNCE_NODE_ID])
    );
}

#[test]
fn a_lifecycle_node_serves_the_steps_and_the_prose_it_actually_has() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let ship = body["graph"]["plan"]["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["id"] == json!(fixture_run::SHIP_NODE_ID))
        .expect("the lifecycle node")
        .clone();
    assert_eq!(ship["repo"], json!("nickderobertis/onepipeline-ui"));
    assert_eq!(ship["branch"], json!("feature/ship"));
    assert_eq!(ship["base_branch"], json!("main"));
    assert_eq!(ship["title"], json!("Ship it"));
    assert_eq!(ship["execution_checkout"], json!("primary"));
    assert_eq!(ship["max_turns"], json!(12));
    // Plan schema 2 retired `done_when`, and a node has no such field to serve:
    // the bar is the `## Acceptance criteria` section of the node's own prose,
    // written once and handed to the judge as the first message of its transcript.
    assert!(ship.get("done_when").is_none(), "{ship}");
    // A `context` note carries exactly one dispatch and is consumed on delivery,
    // and this node has been dispatched — so the note it was given is gone rather
    // than still owed to a dispatch that already had it.
    let prose = ship["task"].as_str().expect("the node's prose");
    assert!(!prose.contains("Planner context"), "{prose}");

    // The other half: a node nothing has dispatched still carries its note, and
    // it reaches the reader as the section the SDK renders it as — never as a
    // second acceptance bar.
    let announce = body["graph"]["plan"]["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["id"] == json!(fixture_run::ANNOUNCE_NODE_ID))
        .expect("the blocked node")
        .clone();
    let owed = announce["task"].as_str().expect("the node's prose");
    assert!(owed.contains("Planner context"), "{owed}");
    assert!(owed.contains("adds no acceptance criteria"), "{owed}");
    assert!(owed.contains(fixture_run::CARRIED_NOTE), "{owed}");

    let steps = ship["steps"].as_array().expect("steps");
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["id"], json!("build"));
    assert_eq!(steps[0]["kind"], json!("agent"));
    // A step recorded with no prose of its own is still named, because the wire
    // has no shape for a step without any.
    assert_eq!(steps[1]["kind"], json!("human"));
    assert_eq!(steps[1]["task"], json!("hand-over"));

    // A human node carries its action prose and no persona.
    let signoff = body["graph"]["plan"]["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["id"] == json!(fixture_run::SIGNOFF_NODE_ID))
        .expect("the human node")
        .clone();
    assert_eq!(signoff["kind"], json!("human"));
    assert_eq!(signoff["task"], json!("Approve the change."));

    // The steps the attempt finished are the ones a continuation may skip.
    let results = &body["graph"]["node_results"][fixture_run::SHIP_NODE_ID];
    assert_eq!(results["completed"], json!(true));
    assert_eq!(results["pr"], json!("https://example.invalid/changes/2"));
    let recorded_steps = results["steps"].as_array().expect("recorded steps");
    assert_eq!(recorded_steps[0]["status"], json!("done"));
    assert_eq!(recorded_steps[1]["status"], json!("pending"));

    // What the node published, as evidence a reader can open.
    let detail = &body["node_details"][fixture_run::SHIP_NODE_ID];
    assert_eq!(detail["publication"]["branch"], json!("feature/ship"));
    assert_eq!(detail["publication"]["merged"], json!(false));
}

/// The distinction a planner acts on first: which of the nodes still working have
/// a turn this run can reach, and which can only be cancelled.
#[test]
fn each_in_flight_node_says_whether_its_turn_can_be_redirected() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let graph = &body["graph"];
    let control = graph["node_control"]
        .as_object()
        .expect("the graph says what it has in flight")
        .clone();

    // One entry per node in flight, and no other: a node with no turn has nothing
    // to redirect, so it must not read as un-redirectable.
    let mut named: Vec<&String> = control.keys().collect();
    named.sort();
    assert_eq!(
        named,
        vec![
            fixture_run::UNCONTROLLED_NODE_ID,
            fixture_run::REDIRECTED_NODE_ID,
            fixture_run::REPORTED_NODE_ID
        ],
        "only the running nodes: {control:?}"
    );
    for node in [
        fixture_run::SHIP_NODE_ID,
        fixture_run::SIGNOFF_NODE_ID,
        fixture_run::ANNOUNCE_NODE_ID,
    ] {
        assert_ne!(
            graph["node_status"][node],
            json!("running"),
            "{node} is not in flight, so it has no control entry to be missing"
        );
    }

    // The node talking in a turn this run has an address for.
    let redirectable = &control[fixture_run::REDIRECTED_NODE_ID];
    assert_eq!(redirectable["addressable"], json!(true));
    assert_eq!(redirectable["member"], json!("worker"));
    assert!(
        redirectable.get("reason").is_none(),
        "a node that can be corrected has no reason it cannot: {redirectable}"
    );

    // The node on a harness with no lever. Not an error, not an absent value,
    // and carrying the words the sibling itself refused with.
    let uncontrollable = &control[fixture_run::UNCONTROLLED_NODE_ID];
    assert_eq!(uncontrollable["addressable"], json!(false));
    assert_eq!(
        uncontrollable["reason"],
        json!(fixture_run::NO_CONTROL_REASON),
        "the reason is the producing library's own: {uncontrollable}"
    );

    // A previous dispatch's report must not label the turn running now.
    // `provider.control` is asked for per run and the provider's outcome is reset
    // to `NotRequested` for the next one, so this node's earlier `control: null`
    // is a fact about a dispatch that is over. Reading it as this turn's answer
    // would tell a planner to cancel a node they may well be able to correct.
    //
    // Under rounds the two dispatches were told apart by their round labels.
    // There are none, and this reading must still not borrow the old answer.
    let reported = &control[fixture_run::REPORTED_NODE_ID];
    assert_eq!(
        reported["addressable"],
        json!(true),
        "the earlier report describes a dispatch that has ended: {reported}"
    );
    assert!(
        reported.get("reason").is_none(),
        "and it contributes no reason to this turn: {reported}"
    );
    let events: Vec<Value> = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::REPORTED_NODE_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "node")
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .collect();
    // The earlier settlement really did report no controllable turn — so this is
    // the corrected reading rather than a fixture that never had the trap in it.
    assert!(
        events.iter().any(|event| event["kind"] == "member-settled"),
        "an earlier dispatch settled a member here, and its report named no \
         controllable turn: {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["kind"] == "turn-interrupted"),
        "and nobody has pulled the lever at this node at all: {events:?}"
    );
}

/// The moment a planner changed what a running turn was doing, on the timeline of
/// the node whose behaviour changed.
#[test]
fn a_redirected_turn_is_a_record_on_the_nodes_own_timeline() {
    let serving = live_run();
    let node_events = |node: &str| -> Vec<Value> {
        let body = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/timeline?scope=node&node={node}",
                fixture_run::RUN_ID
            ),
        )
        .json();
        body["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .filter(|span| span["kind"] == "node")
            .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
            .collect()
    };

    let delivered = node_events(fixture_run::REDIRECTED_NODE_ID)
        .into_iter()
        .find(|event| event["kind"] == "turn-interrupted")
        .expect("the node's timeline carries the redirection");
    assert_eq!(delivered["at"], json!("2026-08-07T12:00:50.000Z"));
    assert_eq!(delivered["redirection"]["delivered"], json!(true));
    assert_eq!(delivered["redirection"]["member"], json!("worker"));
    assert_eq!(
        delivered["redirection"]["input_bytes"],
        json!(fixture_run::LIVE_NOTE.len()),
    );
    assert!(
        delivered["redirection"].get("reason").is_none(),
        "a delivered redirection carries no reason it failed: {delivered}"
    );

    let refused = node_events(fixture_run::UNCONTROLLED_NODE_ID)
        .into_iter()
        .find(|event| event["kind"] == "turn-interrupted")
        .expect("the lever was pulled here too, and that is a record");
    assert_eq!(refused["at"], json!("2026-08-07T12:00:51.000Z"));
    assert_eq!(refused["redirection"]["delivered"], json!(false));
    assert_eq!(
        refused["redirection"]["reason"],
        json!(fixture_run::NO_CONTROL_REASON)
    );

    // And the planner's own edit says where each note ended up, in the SDK's word
    // for it, on the run's row where the edit was made.
    let run_timeline = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    let edits: Vec<Value> = run_timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .filter(|event| event["kind"] == "edit-committed")
        .collect();
    let delivery = |node: &str| {
        edits
            .iter()
            .find(|event| event["redirection"]["node_id"] == json!(node))
            .unwrap_or_else(|| panic!("an edit-committed for {node}: {edits:?}"))["redirection"]
            .clone()
    };
    assert_eq!(
        delivery(fixture_run::REDIRECTED_NODE_ID)["delivery"],
        json!("live"),
        "the running turn took it, so it is not also owed to the next dispatch"
    );
    assert_eq!(
        delivery(fixture_run::UNCONTROLLED_NODE_ID)["delivery"],
        json!("deferred")
    );

    // The engine that links here records the same fact as a `note-delivered`,
    // and says more: which party of the running conversation took the note. It
    // is served under the same pair a client already reads, with the engine's
    // own word beside it.
    let noted = edits
        .iter()
        .find(|event| event["at"] == json!("2026-08-07T12:00:51.600Z"))
        .expect("the planner's note through the linked engine is an edit on the run's row");
    assert_eq!(
        noted["redirection"],
        json!({
            "reached": "worker",
            "delivered": true,
            "delivery": "live",
            "node_id": fixture_run::REDIRECTED_NODE_ID,
        }),
        "{noted}"
    );
    assert_eq!(noted["author"], json!("planner"));
}

/// A note no turn took is still owed to the node, and the engine's word for that
/// is `carried`: the one disposition that reads as not delivered.
///
/// Driven on its own because it is the disposition the default `note` produces
/// between two dispatches, and the one a planner reads to decide whether to
/// send the correction again — served as `delivered: true` it would say the
/// note had been read when nobody has.
#[test]
fn a_note_carried_to_the_next_dispatch_is_served_as_not_yet_delivered() {
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "pipeline",
            "edit-committed",
            json!({ "run_id": fixture_run::RUN_ID }),
            json!({
                "author": "planner",
                "command": {
                    "op": "note",
                    "id": fixture_run::UNCONTROLLED_NODE_ID,
                    "addressee": "worker",
                    "text": "x",
                    "deliver": "next",
                },
                "operations": [{
                    "kind": "note-delivered",
                    "node": fixture_run::UNCONTROLLED_NODE_ID,
                    "addressee": "worker",
                    "text": "x",
                    "reached": "carried",
                }],
                "operation_kinds": ["note-delivered"],
            }),
        );
    });
    let carried = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .find(|event| event["at"] == json!("2026-08-07T12:01:00.000Z"))
        .expect("the appended edit");
    assert_eq!(
        carried["redirection"],
        json!({
            "reached": "carried",
            "delivered": false,
            "delivery": "deferred",
            "node_id": fixture_run::UNCONTROLLED_NODE_ID,
        }),
        "{carried}"
    );
}

/// Every answer `node_control` can give, each driven from a run that produces it.
///
/// The reading has one job — telling a planner whether correcting a node is on
/// the table — and each of these is a different sentence it says. A branch nobody
/// drives is a sentence nobody has read, and the expensive mistake this whole
/// field exists to prevent is exactly the one an untested branch makes.
#[test]
fn node_control_says_each_of_its_answers_from_a_run_that_produces_it() {
    let control = |plant: fn(&std::path::Path)| {
        let serving = Serving::start(move |root| {
            let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
            plant(&dir);
        });
        http::get(
            serving.address,
            &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
        )
        .json()["graph"]["node_control"]
            .clone()
    };
    // A report that names an address says this member *had* a lever, so the node
    // reads off its turn records — which is the answer a planner acts on.
    let addressed = control(|dir| {
        std::fs::write(
            fixture_run::retained_report(dir),
            serde_json::to_vec(&json!({
                "schema_version": 8,
                "control": {
                    "session": "a-session-skill",
                    "session_dir": "/a/oneharness/store",
                    "cwd": "/a/worktree",
                },
            }))
            .expect("a report"),
        )
        .expect("the retained copy");
    })[fixture_run::REPORTED_NODE_ID]
        .clone();
    assert_eq!(addressed["addressable"], json!(true), "{addressed}");
    assert!(addressed.get("reason").is_none(), "{addressed}");

    // A turn that completed: the member is between turns, which is a wait rather
    // than a refusal — and the sentence says so.
    let between = control(|dir| {
        fixture_run::append_relayed(
            dir,
            "agentgraph",
            "turn-completed",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::REDIRECTED_NODE_ID,
                "member": "worker",
                "persona": "worker",
            }),
            json!({ "usage": { "cost_usd": 1.0 } }),
        );
    })[fixture_run::REDIRECTED_NODE_ID]
        .clone();
    assert_eq!(between["addressable"], json!(false));
    assert!(
        between["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("between turns")),
        "{between}"
    );

    // A member that is gone. Nothing to redirect, and not because of a lever.
    let gone = control(|dir| {
        fixture_run::append_relayed(
            dir,
            "agentgraph",
            "member-died",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::REDIRECTED_NODE_ID,
                "member": "worker",
                "persona": "worker",
            }),
            json!({ "rule": "provider-failure" }),
        );
    })[fixture_run::REDIRECTED_NODE_ID]
        .clone();
    assert_eq!(gone["addressable"], json!(false));
    assert_eq!(gone["reason"], json!("the member is no longer running"));

    // A node the run dispatched whose stream has said nothing yet: no address,
    // which is the engine's own answer for a note aimed at it.
    let silent = control(|dir| {
        fixture_run::append_relayed(
            dir,
            "pipeline",
            "node-dispatched",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::ANNOUNCE_NODE_ID,
                "persona": "check-in",
            }),
            json!({ "persona": "check-in" }),
        );
    })[fixture_run::ANNOUNCE_NODE_ID]
        .clone();
    assert_eq!(silent["addressable"], json!(false));
    assert_eq!(
        silent["reason"],
        json!("nothing of its dispatch has reported a member yet")
    );
    assert!(silent.get("member").is_none(), "{silent}");

    // And the edit a run wrote before delivery had modes: no `delivery` at all,
    // which is exactly the one thing those records did.
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "pipeline",
            "edit-committed",
            json!({ "run_id": fixture_run::RUN_ID }),
            json!({
                "command": { "op": "context", "id": fixture_run::REDIRECTED_NODE_ID, "note": "x" },
                "operations": [{
                    "kind": "context-added",
                    "node": fixture_run::REDIRECTED_NODE_ID,
                    "note": "x",
                }],
            }),
        );
    });
    let legacy = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .find(|event| event["at"] == json!("2026-08-07T12:01:00.000Z"))
        .expect("the appended edit");
    assert_eq!(legacy["redirection"]["delivery"], json!("deferred"));
    assert_eq!(legacy["redirection"]["delivered"], json!(false));
}

/// A record this build cannot read is served as no redirection, never as one
/// that did not land.
///
/// The two halves are the two producers'. `delivered` is a required `bool` on
/// `oneagentgraph`'s own type, and `delivery` is `onepipeline`'s closed pair —
/// so a record missing the first or carrying a third word in the second is one
/// this build has no reading for. Serving it as "not delivered" would tell a
/// planner their note is still owed to a node it may already have reached.
#[test]
fn a_redirection_this_build_cannot_read_is_served_as_none_at_all() {
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let at_node = |node: &str| {
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": node,
                "member": "worker",
                "persona": "worker",
            })
        };
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-interrupted",
            at_node(fixture_run::REDIRECTED_NODE_ID),
            json!({ "member": "worker", "input_bytes": 12 }),
        );
        fixture_run::append_relayed(
            &dir,
            "pipeline",
            "edit-committed",
            json!({ "run_id": fixture_run::RUN_ID }),
            json!({
                "command": { "op": "context", "id": fixture_run::REDIRECTED_NODE_ID, "note": "x" },
                "operations": [{
                    "kind": "context-added",
                    "node": fixture_run::REDIRECTED_NODE_ID,
                    "note": "x",
                    "delivery": "someday",
                }],
            }),
        );
    });

    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::REDIRECTED_NODE_ID
        ),
    )
    .json();
    let unreadable = timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "node")
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .find(|event| event["at"] == json!("2026-08-07T12:01:00.000Z"))
        .expect("the appended record is still on the node's timeline");
    assert_eq!(unreadable["kind"], json!("turn-interrupted"));
    assert!(
        unreadable.get("redirection").is_none(),
        "a record with no `delivered` says nothing about delivery: {unreadable}"
    );

    let run = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let control = &run["graph"]["node_control"][fixture_run::REDIRECTED_NODE_ID];
    assert_eq!(
        control["addressable"],
        json!(true),
        "a record this build cannot read must not turn a correctable node un-correctable: {control}"
    );
    let edits: Vec<Value> = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .filter(|event| event["kind"] == "edit-committed")
        .collect();
    let unknown = edits
        .iter()
        .find(|event| event["at"] == json!("2026-08-07T12:01:00.000Z"))
        .expect("the appended edit is still on the run's timeline");
    assert!(
        unknown.get("redirection").is_none(),
        "a delivery word outside the pair is not relayed for a client to fail on: {unknown}"
    );

    // The same rule for the engine's newer record: `reached` is a closed set on
    // its own type, so a word outside it — or none at all — is a record this
    // build cannot read rather than a note that did not land.
    for (label, reached) in [
        ("a word outside the set", json!("somebody")),
        ("no disposition at all", Value::Null),
    ] {
        let mut operation = json!({
            "kind": "note-delivered",
            "node": fixture_run::REDIRECTED_NODE_ID,
            "addressee": "worker",
            "text": "x",
        });
        if !reached.is_null() {
            operation["reached"] = reached;
        }
        let serving = Serving::start(|root| {
            let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
            fixture_run::append_relayed(
                &dir,
                "pipeline",
                "edit-committed",
                json!({ "run_id": fixture_run::RUN_ID }),
                json!({
                    "author": "planner",
                    "command": {
                        "op": "note",
                        "id": fixture_run::REDIRECTED_NODE_ID,
                        "addressee": "worker",
                        "text": "x",
                    },
                    "operations": [operation],
                    "operation_kinds": ["note-delivered"],
                }),
            );
        });
        let unreadable = http::get(
            serving.address,
            &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
        )
        .json()["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
            .find(|event| event["at"] == json!("2026-08-07T12:01:00.000Z"))
            .expect("the appended edit is still on the run's timeline");
        assert_eq!(unreadable["kind"], json!("edit-committed"));
        assert!(
            unreadable.get("redirection").is_none(),
            "{label} is not relayed for a client to fail on: {unreadable}"
        );
    }
}

/// A redirection is published from inside a turn, so it is not a turn.
#[test]
fn a_redirection_is_not_counted_as_a_turn_of_the_transcript_it_interrupted() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}?include_conversations=true",
            fixture_run::RUN_ID
        ),
    )
    .json();
    let node = body["run"]["nodes"]
        .as_array()
        .expect("the run's nodes")
        .iter()
        .find(|node| node["node"] == json!(fixture_run::REDIRECTED_NODE_ID))
        .expect("the redirected node")
        .clone();
    assert_eq!(
        node["turns"],
        json!(1),
        "the turn that was started, and not the interrupt published from inside it"
    );
    let transcript = body["conversations"]
        .as_array()
        .expect("the transcripts")
        .iter()
        .find(|held| held["conversation"]["id"] == json!(fixture_run::REDIRECTED_CONVERSATION_ID))
        .expect("the redirected worker's transcript")
        .clone();
    let kinds: Vec<&str> = transcript["conversation"]["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .filter_map(|turn| turn["status"].as_str())
        .collect();
    assert_eq!(
        kinds,
        vec!["turn-started"],
        "the redirection is the node's own record, never a phantom turn: {transcript}"
    );
}

#[test]
fn a_wait_on_a_person_is_drawn_as_its_own_open_span() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::SIGNOFF_NODE_ID
        ),
    )
    .json();
    let wait = body["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .find(|span| span["kind"] == "human-wait")
        .expect("the wait on a person");
    assert_eq!(wait["started_at"], json!("2026-08-07T12:00:41.000Z"));
    assert_eq!(
        wait["ended_at"],
        Value::Null,
        "nobody has taken the action, so the wait is still open"
    );
    assert_eq!(wait["node_id"], json!(fixture_run::SIGNOFF_NODE_ID));
}

#[test]
fn the_evidence_a_node_stored_is_served_as_its_verification_record() {
    let serving = live_run();
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let records = detail["node_details"][fixture_run::SHIP_NODE_ID]["verification"]["records"]
        .as_array()
        .expect("the node's verification records")
        .clone();
    assert_eq!(
        records.len(),
        2,
        "the node stored its lint member's report and the change's own log"
    );
    assert_eq!(
        records[0]["artifact_id"],
        json!(fixture_run::LINT_REPORT_ARTIFACT)
    );
    assert_eq!(records[1]["artifact_id"], json!("artifact-long-log"));
    assert_eq!(records[1]["ok"], json!(true));
    assert_eq!(
        records[1]["output_tail"],
        json!("the change request is open"),
        "the prose belongs to the event that stored the evidence"
    );

    // And the same evidence is an interval on the node's own timeline, so a
    // reader can open it and pull the log it names.
    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::SHIP_NODE_ID
        ),
    )
    .json();
    let spans = timeline["spans"].as_array().expect("spans");
    let verification = spans
        .iter()
        .filter(|span| span["kind"] == "verification")
        .find(|span| span["label"] == json!("artifact-long-log"))
        .expect("the evidence the node stored");
    assert_eq!(verification["status"], json!("ok"));
    assert_eq!(
        verification["detail"]["artifact_id"],
        json!("artifact-long-log")
    );
    assert_eq!(
        verification["started_at"],
        json!("2026-08-07T12:00:39.000Z"),
        "bracketed by the record before it, not by the whole dispatch"
    );
    assert_eq!(verification["ended_at"], json!("2026-08-07T12:00:40.000Z"));
    assert_eq!(
        verification["parent_id"],
        json!(format!("node.{}", fixture_run::SHIP_NODE_ID))
    );

    // The publication is the interval between the two ends `onevcs` recorded —
    // and it opens where *publishing* began, at the first wait on the identity's
    // lock, not at the worktree this dispatch was cut into at 12:00:29, where the
    // work being published began.
    let publication = spans
        .iter()
        .find(|span| span["kind"] == "publication")
        .expect("the branch the node published");
    assert_eq!(publication["label"], json!("feature/ship"));
    assert_eq!(publication["started_at"], json!("2026-08-07T12:00:33.000Z"));
    assert_eq!(publication["ended_at"], json!("2026-08-07T12:00:38.000Z"));
    // A change the host has not landed: open, and still running as far as the
    // run is concerned, which is what its own records say.
    assert_eq!(publication["status"], json!("open"));
    assert_eq!(
        publication["reference"],
        json!({ "kind": "pr", "value": "https://example.invalid/changes/2" })
    );

    // The waits `onevcs` timed on the identity's lock, rolled up rather than
    // listed: the count and the total, which is what the contention lane plots.
    let waits = spans
        .iter()
        .find(|span| span["kind"] == "rollup" && span["label"] == json!("lock-wait"))
        .expect("the contention the publication met");
    assert_eq!(waits["count"], json!(1));
    assert_eq!(waits["total_duration_ms"], json!(4_500));
    assert_eq!(
        waits["started_at"],
        json!("2026-08-07T12:00:28.500Z"),
        "the record is written when the turn came and says how long it waited"
    );
    assert_eq!(waits["ended_at"], json!("2026-08-07T12:00:33.000Z"));
    assert_eq!(
        waits["node_id"],
        json!(fixture_run::SHIP_NODE_ID),
        "contention is rolled up per node, not once for the run"
    );
}

#[test]
fn the_run_scope_summarizes_a_nodes_sessions_by_the_category_they_ran_under() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    let spans = body["spans"].as_array().expect("spans").clone();
    let rollups: Vec<&Value> = spans
        .iter()
        .filter(|span| {
            span["kind"] == "rollup"
                && span["label"] == json!("dispatch")
                && span["node_id"] == json!(fixture_run::SHIP_NODE_ID)
        })
        .collect();
    // Two sessions, two categories: the drafting work, read off the persona its
    // first record carried with no member beside it, and the lint member that
    // read it — served under the member word the graph declared for it, which
    // is also the transport it ran as.
    assert_eq!(rollups.len(), 2, "one category, one summary: {rollups:?}");
    assert_eq!(rollups[0]["agent_role"], json!("pr-author"));
    assert_eq!(rollups[0]["transport_role"], json!("agent"));
    assert_eq!(rollups[0]["count"], json!(1));
    assert_eq!(rollups[1]["agent_role"], json!("llmlint"));
    assert_eq!(rollups[1]["transport_role"], json!("llmlint"));
    assert_eq!(rollups[1]["count"], json!(1));
    assert_eq!(
        rollups[0]["events"],
        json!([]),
        "a summary carries no records: a reader who wants them opens the node"
    );
    assert_eq!(
        rollups[0]["parent_id"],
        json!(format!("node.{}", fixture_run::SHIP_NODE_ID))
    );

    // And the node's own scope still serves the sessions themselves, so the two
    // readings agree about the category without the graph carrying every record.
    let node = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::SHIP_NODE_ID
        ),
    )
    .json();
    let dispatches: Vec<&Value> = node["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "dispatch")
        .collect();
    assert_eq!(dispatches.len(), 2);
    assert_eq!(dispatches[0]["agent_role"], json!("pr-author"));
    assert_eq!(dispatches[0]["transport_role"], json!("agent"));
    assert_eq!(dispatches[1]["agent_role"], json!("llmlint"));
    assert_eq!(dispatches[1]["transport_role"], json!("llmlint"));
    assert!(
        !node["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .any(|span| span["kind"] == "rollup" && span["label"] == json!("dispatch")),
        "the node's own reading is the records, not a summary of them"
    );
    // Contention is the exception, and deliberately: a publication takes
    // thousands of waits, so both readings summarize them.
    assert!(
        node["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .any(|span| span["label"] == json!("lock-wait")),
        "the contention lane is served at the node's own scope too"
    );
}

#[test]
fn a_run_that_wrote_no_result_is_described_by_the_fold_behind_it() {
    let serving = Serving::start(|root| {
        fixture_run::write_stopped_mid_flight(root, fixture_run::STOPPED_RUN_ID);
    });
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::STOPPED_RUN_ID),
    )
    .json();
    // The row a reader opens the graph from, and the graph they open: one
    // derivation, so the two cannot describe different runs.
    let telemetry: Vec<(&str, &str)> = body["run"]["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|node| {
            (
                node["node"].as_str().expect("a node id"),
                node["status"].as_str().expect("a status"),
            )
        })
        .collect();
    assert_eq!(telemetry, vec![(fixture_run::NODE_ID, "running")]);
    assert_eq!(
        body["run"]["nodes"][0]["turns"],
        json!(0),
        "nothing was relayed before the driver went, so nothing is counted"
    );
    assert_eq!(
        body["graph"]["node_status"][fixture_run::NODE_ID],
        json!("running"),
        "no driver closed out, so there is no recorded result — and the fold has it"
    );
}

#[test]
fn a_node_that_stored_nothing_serves_no_verification_and_no_publication() {
    let serving = live_run();
    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::SIGNOFF_NODE_ID
        ),
    )
    .json();
    let kinds: Vec<&str> = timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter_map(|span| span["kind"].as_str())
        .collect();
    assert!(
        !kinds.contains(&"verification") && !kinds.contains(&"publication"),
        "a node that recorded neither is served neither, not an empty one: {kinds:?}"
    );
}

#[test]
fn the_run_timeline_is_one_unbroken_span_over_everything_the_run_has_done() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    let roots: Vec<&Value> = body["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "run")
        .collect();
    // One root, over the whole run — not one per batch, because nothing batches.
    assert_eq!(roots.len(), 1, "{roots:?}");
    assert_eq!(
        roots[0]["ended_at"],
        Value::Null,
        "a run still being driven has not ended"
    );
    assert_eq!(roots[0]["phase"], json!("deciding"));

    // The run's own driving session, recorded at no node: it is running for as
    // long as the run it is driving is, rather than a state nothing named.
    let driving: Vec<&Value> = body["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "dispatch" && span["node_id"].is_null())
        .collect();
    assert!(!driving.is_empty(), "no run-level session was served");
    assert!(
        driving
            .iter()
            .all(|span| span["status"] == json!("running")),
        "the run has not closed, so neither has a session it is driving: {driving:?}"
    );
}

#[test]
fn an_artifact_bigger_than_one_response_is_served_as_its_tail() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/artifact-long-log",
            fixture_run::RUN_ID
        ),
    )
    .json();
    assert_eq!(body["truncated"], json!(true));
    assert_eq!(body["kind"], json!("gate_log"));
    let content = body["content"].as_str().expect("content");
    assert!(
        content.ends_with("TAIL\n"),
        "the tail is the end of the file"
    );
    assert!(content.len() <= 64 * 1024);
}

#[test]
fn a_run_that_recorded_only_its_launch_reads_as_undriven_and_starting() {
    let serving = Serving::start(|root| {
        fixture_run::write_launched(root, fixture_run::RUN_ID);
    });
    let body = http::get(serving.address, "/api/v2/runs").json();
    let run = &body["runs"][0];
    assert_eq!(run["phase"], json!("starting"));
    assert_eq!(
        run["state"],
        json!("parked"),
        "a launch that has written nothing since is not being driven"
    );
    assert_eq!(run["node_counts"], json!({}));
    // A launcher outside the closed vocabulary is named `unknown`, never
    // passed through as a word a client cannot switch on.
    assert_eq!(run["launch"]["launcher"], json!("unknown"));
    assert!(
        run["launch"].get("session_key").is_none(),
        "a run that named no session has no key: {run}"
    );

    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    assert_eq!(
        detail["graph"],
        Value::Null,
        "a run whose plan nothing recorded has no graph to serve"
    );
    assert_eq!(detail["conversations"], json!([]));
}

#[test]
fn a_query_parameter_the_route_does_not_accept_is_refused_in_the_error_contract() {
    let serving = live_run();
    for (path, code) in [
        ("/api/v2/runs?include_settled=maybe", "invalid_request"),
        ("/api/v2/runs?limit=lots", "invalid_request"),
        ("/api/v2/runs?cursor=..%2Fetc", "invalid_run_id"),
        (
            "/api/v2/runs/run-20260807-a1b2c3?include_conversations=perhaps",
            "invalid_request",
        ),
    ] {
        let response = http::get(serving.address, path);
        assert_eq!(response.status, 422, "{path}");
        assert_eq!(response.json()["error"]["code"], json!(code), "{path}");
    }
}

#[test]
fn a_page_size_outside_the_bound_is_clamped_rather_than_obeyed() {
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
    });
    for limit in ["0", "100000"] {
        let body = http::get(
            serving.address,
            &format!("/api/v2/runs?include_settled=true&limit={limit}"),
        )
        .json();
        let served = body["runs"].as_array().map(Vec::len).expect("runs");
        assert!((1..=2).contains(&served), "limit={limit} served {served}");
    }
}

#[test]
fn a_watched_stream_reports_only_that_run_and_notices_its_transcripts() {
    let serving = live_run();
    let mut stream = http::stream(
        serving.address,
        &format!("/api/v2/events?run_id={}&after=7", fixture_run::RUN_ID),
        None,
    );
    let snapshot = stream.next_frame().expect("a snapshot");
    assert_eq!(snapshot.event, "snapshot");
    assert_eq!(
        snapshot.id, "7",
        "the query's cursor continues the numbering"
    );

    // A relayed turn is a transcript change, which is a separate fact from the
    // run's own state moving — and the one a detail view refetches on.
    let dir = serving.run_dir(fixture_run::RUN_ID);
    let journal = dir.join("events.jsonl");
    let existing = std::fs::read_to_string(&journal).expect("the journal");
    std::fs::write(
        &journal,
        format!(
            "{existing}{}\n",
            json!({
                "v": 1,
                "ts": "2026-08-07T12:01:00.000Z",
                "stream": "a-recording-host-4243",
                "seq": 99,
                "source": "agentgraph",
                "kind": "agent-turn",
                "labels": {
                    "run_id": fixture_run::RUN_ID,
                    "node": fixture_run::SHIP_NODE_ID,
                    "session": fixture_run::LIVE_CONVERSATION_ID,
                },
                "payload": { "message": "and again" },
                "artifacts": [],
            })
        ),
    )
    .expect("append a relayed turn");

    let mut seen: Vec<String> = Vec::new();
    for _ in 0..2 {
        let frame = stream.next_frame().expect("the stream stayed open");
        assert_eq!(frame.json()["run_id"], json!(fixture_run::RUN_ID));
        seen.push(frame.event);
    }
    assert!(seen.contains(&"run.changed".to_owned()), "{seen:?}");
    assert!(
        seen.contains(&"conversation.changed".to_owned()),
        "a watched run's transcripts are polled on their own interval: {seen:?}"
    );
}

#[test]
fn the_checks_a_host_observed_on_a_publication_are_served_with_their_logs() {
    let serving = two_runs();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let verification = &body["node_details"][fixture_run::NODE_ID]["verification"];
    let checks = verification["checks"].as_array().expect("the checks");
    // The last account of each check, not one row per transition: the required
    // one queued and then passed, and both states were recorded.
    assert_eq!(checks.len(), 2, "{verification}");
    assert_eq!(checks[0]["name"], json!("gate"));
    assert_eq!(checks[0]["required"], json!(true));
    assert_eq!(checks[0]["from_state"], json!("queued"));
    assert_eq!(checks[0]["state"], json!("success"));
    assert_eq!(verification["required_checks"], json!(["gate"]));

    // The advisory one failed, and the log it stored is named twice over: on the
    // check, and as the verification record a reader opens the log from.
    assert_eq!(checks[1]["name"], json!("published-smoke"));
    assert_eq!(checks[1]["required"], json!(false));
    assert_eq!(checks[1]["state"], json!("failure"));
    let log = checks[1]["artifact_id"].as_str().expect("the check's log");
    let failed = verification["records"]
        .as_array()
        .expect("records")
        .iter()
        .find(|record| record["artifact_id"] == json!(log))
        .expect("the failing check's own record");
    assert_eq!(
        failed["ok"],
        json!(false),
        "a host conclusion is read in the host's words, not as a pipeline status"
    );

    // And that log really is readable, by the id the check named.
    let artifact = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/artifacts/{log}", fixture_run::RUN_ID),
    );
    assert_eq!(artifact.status, 200);
    assert_eq!(
        artifact.json()["content"],
        json!("the published-smoke check failed\n")
    );

    // The merge the host completed, which is the commit the work landed as. No
    // url beside it: the host owns that and `onevcs` records none.
    let publication = &body["node_details"][fixture_run::NODE_ID]["publication"];
    assert_eq!(publication["merged"], json!(true));
    assert_eq!(publication["commit"], json!(fixture_run::MERGE_SHA));
    assert_eq!(publication["base_branch"], json!("main"));
    assert!(publication.get("commit_url").is_none(), "{publication}");
}

#[test]
fn a_node_that_observed_no_check_says_so_rather_than_serving_an_empty_one() {
    let serving = two_runs();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    // The review node published nothing and no host ran anything on it, so it
    // carries no checks at all rather than a `checks` list claiming zero of them,
    // and no publication. What it does carry is what it *kept*: the report its
    // settled member stored, which is the only evidence that node produced.
    let detail = &body["node_details"][fixture_run::REVIEW_NODE_ID];
    let verification = &detail["verification"];
    assert!(verification.get("checks").is_none(), "{detail}");
    assert!(verification.get("required_checks").is_none(), "{detail}");
    assert!(detail.get("publication").is_none(), "{detail}");
    let records = verification["records"].as_array().expect("what it kept");
    assert_eq!(records.len(), 1, "{detail}");
    assert_eq!(
        records[0]["artifact_id"],
        json!(fixture_run::REVIEWER_REPORT_ARTIFACT)
    );
}

#[test]
fn what_each_party_consumed_is_served_from_the_records_that_measured_it() {
    let serving = two_runs();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let usage = &body["run"]["usage"];
    // What the run spent, as the sibling folded it from the turns it relayed.
    assert_eq!(usage["total"]["input_tokens"], json!(160_210));
    assert_eq!(usage["total"]["output_tokens"], json!(1_818));
    assert_eq!(usage["total"]["cost_usd"], json!(53.90));
    // The per-party split is read from the onejudge report each side keeps, and
    // both of this run's members kept one. The lint party ran on neither node, so
    // it is unknown rather than free — a null cost cannot be read as a party that
    // cost nothing.
    assert_eq!(usage["agent"]["cost_usd"], json!(31.33));
    assert_eq!(usage["judge"]["cost_usd"], json!(9.75));
    assert_eq!(usage["llmlint"]["input_tokens"], json!(null));
    assert_eq!(usage["llmlint"]["cost_usd"], json!(null));

    // The clock is where that split stops: what each party spent is a document
    // the sibling folds, and how long each spent *inside a model* is a thing no
    // producer in this stack reports. Every one of those lanes says so — absent
    // on the wire, `false` on the presence flag beside it — so a reader cannot
    // take one for a party that used no model time.
    let presence = &body["run"]["timing_presence"];
    let timing = &body["run"]["timing"];
    let work = &body["run"]["node_work_ms"];
    for party in ["agent", "judge", "llmlint"] {
        let lane = format!("{party}_model_ms");
        assert_eq!(presence[&lane], json!(false), "{party}: {presence}");
        assert_eq!(timing[&lane], json!(null), "{party}: {timing}");
        assert_eq!(work[&lane], json!(null), "{party}: {work}");
    }
    assert_eq!(presence["tool_ms"], json!(false));
    assert_eq!(timing["gate_seconds"], json!(2), "{timing}");
    assert_eq!(timing["tool_ms"], json!(null), "{timing}");
    assert_eq!(work["tool_ms"], json!(null), "{work}");
    // The one lane a node-level rollup still carries, which is the run's own.
    assert_eq!(work["wall_ms"], timing["wall_ms"], "{work}");
}

#[test]
fn a_watched_stream_reports_what_a_turn_is_doing_before_it_is_done() {
    let serving = live_run();
    let mut stream = http::stream(
        serving.address,
        &format!("/api/v2/events?run_id={}", fixture_run::RUN_ID),
        None,
    );
    assert_eq!(stream.next_frame().expect("a snapshot").event, "snapshot");

    // One tool summary, published from inside a turn that has not finished:
    // exactly what `oneagentgraph` streams while a member works.
    let dir = serving.run_dir(fixture_run::RUN_ID);
    let journal = dir.join("events.jsonl");
    let existing = std::fs::read_to_string(&journal).expect("the journal");
    std::fs::write(
        &journal,
        format!(
            "{existing}{}\n",
            json!({
                "v": 1,
                "ts": "2026-08-07T12:01:00.000Z",
                "stream": "a-recording-host-4243",
                "seq": 99,
                "source": "agentgraph",
                "kind": "turn-activity",
                "labels": {
                    "run_id": fixture_run::RUN_ID,
                    "node": fixture_run::SHIP_NODE_ID,
                    "persona": "pr-author",
                    "session": fixture_run::LIVE_CONVERSATION_ID,
                },
                "payload": {
                    "kind": "tool_use",
                    "name": "Edit",
                    "detail": "CHANGELOG.md",
                    "truncated": false,
                },
                "artifacts": [],
            })
        ),
    )
    .expect("append a tool summary");

    let mut activity = None;
    for _ in 0..3 {
        let frame = stream.next_frame().expect("the stream stayed open");
        if frame.event == "activity.changed" {
            activity = Some(frame.json());
            break;
        }
    }
    let activity = activity.expect("the watcher was told what the turn is doing");
    assert_eq!(activity["run_id"], json!(fixture_run::RUN_ID));
    let latest = activity["activity"]
        .as_array()
        .expect("the live activity")
        .last()
        .expect("the most recent summary")
        .clone();
    assert_eq!(latest["node"], json!(fixture_run::SHIP_NODE_ID));
    assert!(
        latest.get("round").is_none(),
        "a summary is keyed by its node, not by a batch: {latest}"
    );
    assert_eq!(latest["name"], json!("Edit"));
    assert_eq!(latest["detail"], json!("CHANGELOG.md"));
    assert_eq!(latest["kind"], json!("tool_use"));
    assert_eq!(latest["events"], json!(2), "counted, not just carried");
}

#[test]
fn a_tool_summary_is_carried_on_its_turn_rather_than_served_as_one() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::LIVE_CONVERSATION_ID
        ),
    )
    .json();
    let turns = body["conversation"]["turns"].as_array().expect("the turns");
    // One turn — opened, worked, closed — and the tool summary published from
    // inside it is on it rather than served as a second turn nobody took.
    assert_eq!(turns.len(), 1, "{turns:?}");
    let tools = turns[0]["tools"].as_array().expect("the turn's tool calls");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], json!("Bash"));
    assert_eq!(tools[0]["kind"], json!("tool_use"));
    assert_eq!(tools[0]["input"], json!("just gate"));
    assert_eq!(
        tools[0]["output"],
        json!(null),
        "the journal records the call and never what it returned: {tools:?}"
    );
    // The state the run last recorded it in, which is the record that closed it
    // and not the one that opened it.
    assert_eq!(turns[0]["status"], json!("turn-completed"));
    assert_eq!(turns[0]["usage"]["inputTokens"], json!(900));
    // This member has not settled, so no report holds what its turn took — and
    // the producer stamps the turn's own bounds as it runs, which is what a
    // dispatch nobody will ever have a report for is read from.
    assert_eq!(turns[0]["startedAt"], json!("2026-08-07T12:00:28.000Z"));
    assert_eq!(turns[0]["finishedAt"], json!("2026-08-07T12:00:28.800Z"));
    assert_eq!(turns[0]["durationMs"], json!(800));
}

#[test]
fn the_side_of_the_conversation_a_session_ran_on_is_served_with_it() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let node = body["run"]["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .find(|row| row["node"] == json!(fixture_run::SHIP_NODE_ID))
        .expect("the publishing node");
    let parties: Vec<&str> = node["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .filter_map(|link| link["role"].as_str())
        .collect();
    // Two sessions of one dispatch, under one semantic role and two transports:
    // a failure on either is a different failure, and the pair says which.
    assert_eq!(parties, vec!["llmlint", "agent"], "{node}");
    // Its member-started, the turn it opened, what it said in that turn, and the
    // turn's own close: every relayed record of that party bar the summaries it
    // published from inside a turn.
    assert_eq!(node["lint"], json!(4), "what the lint transport recorded");

    let lint = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::LINT_CONVERSATION_ID
        ),
    )
    .json();
    assert_eq!(lint["attribution"]["transportRole"], json!("llmlint"));
    // The member the graph declared for its lint side is called `llmlint` too,
    // and a stamped member is the reading: the persona beside it — `pr-author`,
    // the word the dispatch ran under — is not consulted, and the session is
    // served as the member the run recorded it as.
    assert_eq!(lint["attribution"]["agentRole"], json!("llmlint"));

    // The agent side of the same node is the other half of that rule: its first
    // relayed record stamps a persona and no member — `oneagentgraph` names the
    // member only from the record after it — so the persona is still what the
    // role is read from there.
    let checked = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::LIVE_CONVERSATION_ID
        ),
    )
    .json();
    assert_eq!(checked["attribution"]["transportRole"], json!("agent"));
    assert_eq!(checked["attribution"]["agentRole"], json!("pr-author"));
    assert_eq!(checked["attribution"]["persona"], json!("pr-author"));
}

#[test]
fn a_publication_that_never_landed_is_served_as_what_it_kept() {
    let serving = Serving::start(|root| {
        fixture_run::write_preserved(root, fixture_run::PRESERVED_RUN_ID);
    });
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::PRESERVED_RUN_ID),
    )
    .json();
    // Nothing merged, so the commit served is the one the work was *preserved*
    // on: the branch is still there, and that sha is where to find it.
    let publication = &body["node_details"][fixture_run::NODE_ID]["publication"];
    assert_eq!(publication["merged"], json!(false));
    assert_eq!(publication["commit"], json!(fixture_run::PRESERVED_SHA));
    assert_eq!(publication["branch"], json!("feature/preserved"));

    // And the span ends where the conflict ended it, with the word that says the
    // publication stopped rather than that it is still in flight.
    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::PRESERVED_RUN_ID,
            fixture_run::NODE_ID
        ),
    )
    .json();
    let span = timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .find(|span| span["kind"] == "publication")
        .expect("the branch the node opened");
    assert_eq!(span["status"], json!("conflict"));
    assert_eq!(span["ended_at"], json!("2026-08-07T12:00:09.000Z"));
    assert!(
        span.get("reference").is_none(),
        "no change was ever opened: {span}"
    );
}

#[test]
fn the_run_clock_is_the_document_the_sibling_aggregates() {
    let serving = two_runs();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let timing = &body["run"]["timing"];

    // The same numbers `onepipeline telemetry` prints for this run. The server
    // reads them through the SDK's own fold over the view it already holds and
    // never through that CLI, so the CLI is the *comparison*: asserted against
    // what the provisioned binary says right now, so a build whose attribution
    // moves fails here instead of leaving two readings of one run's clock
    // disagreeing.
    let document = sibling::telemetry(&serving.runs_root(), fixture_run::RUN_ID);
    let run = RunId::try_from(fixture_run::RUN_ID).expect("a valid id");
    let document = telemetry::of_aggregate(&run, &document)
        .expect("the CLI's document holds to the producer's own contract");
    assert_eq!(timing["wall_ms"], json!(document.wall_ms));
    for (lane, name) in [
        ("agent_seconds", telemetry::BucketName::Agent),
        ("judge_seconds", telemetry::BucketName::Judge),
        ("llmlint_seconds", telemetry::BucketName::Llmlint),
        ("gate_seconds", telemetry::BucketName::Gate),
        (
            "publication_wait_seconds",
            telemetry::BucketName::PublicationWait,
        ),
        ("lock_wait_seconds", telemetry::BucketName::LockWait),
        ("setup_seconds", telemetry::BucketName::Setup),
        ("scheduling_seconds", telemetry::BucketName::Scheduling),
    ] {
        assert_eq!(
            timing[lane],
            json!(document.bucket(name).map(|ms| ms / 1_000)),
            "{lane} is not the bucket the sibling measured: {timing}"
        );
    }
    // Its invariant, carried onto the wire: the measured buckets sum exactly to
    // the whole, so what is left over is what nothing measured.
    assert_eq!(
        timing["unattributed_ms"],
        json!(document.wall_ms - document.measured_ms())
    );

    // A bucket nothing measured is absent on both sides — never a zero, which is
    // what a measured nothing looks like.
    assert!(document.bucket(telemetry::BucketName::Judge).is_none());
    assert_eq!(timing["judge_seconds"], json!(null), "{timing}");
    // And the three lanes for time inside a model, which no producer in this
    // stack reports: absent on the wire and absent in the fractions beside it,
    // for every party, however much of the run's clock each one used. What *is*
    // recorded is one invocation's elapsed time, which is a turn's rather than a
    // party's and is served on the turn as `durationMs`.
    for party in ["agent", "judge", "llmlint"] {
        assert_eq!(
            timing[format!("{party}_model_ms")],
            json!(null),
            "{party}: {timing}"
        );
        assert_eq!(
            timing["fractions"][format!("{party}_model")],
            json!(null),
            "{party}: {timing}"
        );
    }

    // And what each party spent is the sibling's split, not a second reading of
    // the records it already read.
    assert_eq!(
        body["run"]["usage"]["total"]["cost_usd"],
        json!(document.usage_of(telemetry::Party::Total).cost_usd)
    );
    assert_eq!(body["run"]["usage"]["llmlint"]["cost_usd"], json!(null));
}

// llmlint: ignore-block[tests_mirror_real_usage] the summary document is a file on disk
// that another process wrote, and that file *is* the interface here: the engine that writes
// a run store and this reader of it are pinned separately (the reason `/healthz` names its
// release), so the document a listing reads is whatever the engine that last summarized the
// run left there — a release ahead of or behind this one, or a file an operator edited. The
// boundary under test, `telemetry::validated`, exists for exactly that document, and the
// only way to hand it one the pinned engine does not write is to write it. Every other
// journey over the clock reads a summary the pinned engine wrote.
#[test]
fn a_run_whose_summary_clock_cannot_be_read_still_serves_the_folds() {
    // The one state in which a row and the detail opened from it read their
    // clocks from different documents: the row's is the one the run's bounded
    // summary carries, and the detail's is the SDK's fold over the view the
    // route holds. A summary on disk carrying a telemetry document that breaks
    // the producer's own contract — here a party present and reporting
    // nothing, which the pinned engine never writes, so the document is one
    // another release or a hand left behind — leaves the **row** with no clock
    // at all: every timing absent, none of them zero, because a run nothing
    // could be measured for must not read as a run that took no time. The
    // detail, which asks no summary, still serves the fold. Neither route
    // starts a process for it.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::summarize(root, fixture_run::RUN_ID);
        let summary = root.join(fixture_run::RUN_ID).join("summary.json");
        let mut document: Value =
            serde_json::from_str(&fs::read_to_string(&summary).expect("the summary"))
                .expect("a summary document");
        document["timing"]["usage"]["judge"] = json!({});
        fs::write(&summary, document.to_string()).expect("the summary is rewritten");
    });
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let row = &listed["runs"][0];
    assert_eq!(row["run_id"], json!(fixture_run::RUN_ID));
    for lane in [
        "agent_seconds",
        "judge_seconds",
        "llmlint_seconds",
        "gate_seconds",
        "publication_wait_seconds",
        "lock_wait_seconds",
        "setup_seconds",
        "scheduling_seconds",
        "wall_seconds",
        "wall_ms",
        "unattributed_ms",
    ] {
        assert_eq!(
            row["timing"][lane],
            json!(null),
            "{lane} is not absent: {row}"
        );
    }
    assert_eq!(
        row["node_counts"]["done"],
        json!(2),
        "a run all the same: {row}"
    );

    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    assert_eq!(body["run"]["timing"]["wall_seconds"], json!(30), "{body}");
    assert_eq!(body["run"]["timing"]["agent_seconds"], json!(13), "{body}");
    assert_eq!(body["run"]["run_id"], json!(fixture_run::RUN_ID));
}
// llmlint: ignore-end[tests_mirror_real_usage]

// Every filtering journey below drives the compiled binary over real HTTP against
// a real recorded run, because `?filter=` is a query the server parses, resolves
// against the run's own launch record, and applies to what it serves — four seams
// a payload built in-process would skip.

/// Every event kind a timeline carries, at whichever scope it was read.
fn kinds_on(body: &Value) -> Vec<String> {
    body["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .filter_map(|event| event["kind"].as_str().map(str::to_owned))
        .collect()
}

/// The run-scoped timeline of the live fixture, read under one filter.
fn timeline_under(serving: &Serving, filter: Option<&str>) -> Value {
    let query = filter.map_or_else(String::new, |spec| format!("&filter={}", urlencode(spec)));
    http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run{query}",
            fixture_run::RUN_ID
        ),
    )
    .json()
}

/// Percent-encode a query value, which an inline spec needs and a profile name
/// does not: a spec is JSON, and `{`, `"` and `,` are not query-safe.
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[test]
fn a_named_profile_narrows_the_stream_to_the_decisions_or_leaves_it_whole() {
    let serving = live_run();

    // Unfiltered: the whole merged store, all three producing libraries.
    let whole = kinds_on(&timeline_under(&serving, None));
    assert!(whole.iter().any(|kind| kind == "node-settled"), "{whole:?}");
    assert!(
        whole.iter().any(|kind| kind == "turn-activity"),
        "{whole:?}"
    );
    assert!(
        whole.iter().any(|kind| kind == "change-opened"),
        "{whole:?}"
    );

    // `planner` is the decisions-level reading: onepipeline's own vocabulary is a
    // closed set and it is exactly the decisions. Nothing a sibling relayed is a
    // decision, so none of it survives.
    let decisions = kinds_on(&timeline_under(&serving, Some("planner")));
    assert!(!decisions.is_empty(), "the decisions are still served");
    for kind in [
        "node-ready",
        "node-settled",
        "decision-pending",
        "edit-committed",
    ] {
        assert!(
            decisions.iter().any(|served| served == kind),
            "{kind} is a decision and must survive: {decisions:?}"
        );
    }
    for kind in [
        "turn-activity",
        "turn-completed",
        "change-opened",
        "gate-verdict",
    ] {
        assert!(
            !decisions.iter().any(|served| served == kind),
            "{kind} is activity, not a decision: {decisions:?}"
        );
    }

    // `detailed` is the detailed stream, which is what an observer of a run
    // reads: it narrows nothing, and is named so that the two readings a viewer
    // switches between are two profiles rather than a profile and nothing.
    assert_eq!(kinds_on(&timeline_under(&serving, Some("detailed"))), whole);

    // The engine shipped that profile as `monitor` until it stopped naming an
    // observer member, and ships no alias — so neither does this API. A reader
    // asking for it at a run whose launch defined nothing is refused by name and
    // told which profiles do exist, rather than served an alias of either.
    let refused = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run&filter=monitor",
            fixture_run::RUN_ID
        ),
    );
    assert_eq!(refused.status, 404, "{}", refused.body);
    let error = &refused.json()["error"];
    assert_eq!(error["code"], json!("unknown_filter_profile"));
    let message = error["message"].as_str().expect("a message");
    assert!(
        message.contains("planner") && message.contains("detailed"),
        "{message}"
    );
}

#[test]
fn an_inline_spec_is_read_in_the_grammar_the_stack_shares() {
    let serving = live_run();
    let whole = kinds_on(&timeline_under(&serving, None));

    // `exclude` wins, and `kind` is a glob over the wire string — so one matcher
    // drops every turn record a sibling relayed while leaving the rest.
    let quiet = kinds_on(&timeline_under(
        &serving,
        Some(r#"{"exclude":[{"kind":"turn-*"}]}"#),
    ));
    assert!(
        !quiet.iter().any(|kind| kind.starts_with("turn-")),
        "the glob matched nothing: {quiet:?}"
    );
    assert!(quiet.iter().any(|kind| kind == "node-settled"), "{quiet:?}");
    assert!(quiet.len() < whole.len());

    // An absent `include` admits everything, so a broad include beside a narrow
    // exclude is how "all of this except that" is written — and `exclude` still
    // wins over whatever `include` admitted.
    let vcs_only = kinds_on(&timeline_under(
        &serving,
        Some(r#"{"include":[{"source":"vcs"}],"exclude":[{"kind":"lock-wait"}]}"#),
    ));
    assert!(
        vcs_only.iter().any(|kind| kind == "change-opened"),
        "{vcs_only:?}"
    );
    assert!(
        !vcs_only.iter().any(|kind| kind == "lock-wait"),
        "{vcs_only:?}"
    );
    assert!(
        !vcs_only.iter().any(|kind| kind == "node-settled"),
        "{vcs_only:?}"
    );

    // A reserved label the envelope carries under the same name, matched exactly.
    let one_node = kinds_on(&timeline_under(
        &serving,
        Some(&format!(
            r#"{{"include":[{{"node":"{}"}}]}}"#,
            fixture_run::REDIRECTED_NODE_ID
        )),
    ));
    assert!(!one_node.is_empty(), "the node's own records are served");
    assert!(
        one_node.iter().any(|kind| kind == "turn-interrupted"),
        "{one_node:?}"
    );
    assert!(
        !one_node.iter().any(|kind| kind == "change-opened"),
        "{one_node:?}"
    );

    // `member` has a typed slot of its own on the engine's envelope, which is where
    // every producer linked here stamps it: a matcher over it reaches the records
    // of one member and none of the run's own.
    let one_member = kinds_on(&timeline_under(
        &serving,
        Some(r#"{"include":[{"member":"worker"}]}"#),
    ));
    assert!(
        one_member.iter().any(|kind| kind == "turn-started"),
        "{one_member:?}"
    );
    assert!(
        !one_member.iter().any(|kind| kind == "node-settled"),
        "{one_member:?}"
    );
    let no_member = kinds_on(&timeline_under(
        &serving,
        Some(r#"{"include":[{"member":"nobody-ran-as-this"}]}"#),
    ));
    assert!(no_member.is_empty(), "{no_member:?}");
}

#[test]
fn a_matcher_over_the_phase_reaches_the_records_a_producer_stamped_one_on() {
    // `phase` is the agent envelope's one reserved dimension — the part of a
    // change's life a record belongs to, which `onevcs` stamps and `onepipeline`
    // relays as stamped — and the grammar every producer in the stack now reads
    // names it. A record carrying none matches no phase a matcher asks for.
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed_at_phase(
            &dir,
            "vcs",
            "change-check",
            "review",
            json!({ "run_id": fixture_run::RUN_ID, "node": fixture_run::NODE_ID }),
            json!({ "name": "gate", "required": true, "from": "queued", "to": "in_progress" }),
        );
    });
    let reviewed = kinds_on(&timeline_under(
        &serving,
        Some(r#"{"include":[{"phase":"review"}]}"#),
    ));
    assert_eq!(reviewed, vec!["change-check"], "{reviewed:?}");
    let released = kinds_on(&timeline_under(
        &serving,
        Some(r#"{"include":[{"phase":"release"}]}"#),
    ));
    assert!(released.is_empty(), "{released:?}");
    // And it is refused where every other field is, in the grammar's own terms: a
    // phase the engine does not spell is not a matcher, and an empty one matches
    // nothing on the stream.
    for spec in [
        r#"{"include":[{"phase":"gate"}]}"#,
        r#"{"include":[{"phase":""}]}"#,
    ] {
        let refused = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/timeline?scope=run&filter={}",
                fixture_run::RUN_ID,
                urlencode(spec)
            ),
        );
        assert_eq!(refused.status, 422, "{spec}: {}", refused.body);
    }
}

#[test]
fn a_filter_shapes_the_response_and_never_the_run() {
    // The whole point of the read API staying read-only: a reader who narrowed
    // their attention is shown the same graph, in the same states, as one who
    // asked for everything. Only the records served beside it change.
    let serving = live_run();
    let detail = |filter: &str| -> Value {
        http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}?include_conversations=false&filter={filter}",
                fixture_run::RUN_ID
            ),
        )
        .json()
    };
    let wide = detail("detailed");
    let narrow = detail("planner");
    assert_eq!(narrow["graph"]["node_status"], wide["graph"]["node_status"]);
    assert_eq!(
        narrow["graph"]["node_control"],
        wide["graph"]["node_control"]
    );
    assert_eq!(narrow["graph"]["decisions"], wide["graph"]["decisions"]);
    assert_eq!(
        narrow["graph"]["node_results"],
        wide["graph"]["node_results"]
    );
    assert_eq!(narrow["run"]["nodes"], wide["run"]["nodes"]);
    // Including the clock: the document describes the run, not the reading of it.
    assert_eq!(narrow["run"]["timing"], wide["run"]["timing"]);
}

#[test]
fn a_profile_the_runs_launch_config_defined_answers_for_that_run_alone() {
    // A retained `--set filters.NAME=SPEC` is where a launch's own opaque
    // decisions are kept, and it is the one place this crate can read a
    // run-specific one from. The launch record is written by the SDK and read
    // here verbatim.
    let defined = "change-watch";
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::define_filter_profile(&dir, defined, r#"{"include":[{"kind":"change-*"}]}"#);
        // A second run, launched with none: the same name must not answer for it.
        fixture_run::write_live(root, fixture_run::OTHER_RUN_ID);
    });

    let served = kinds_on(&timeline_under(&serving, Some(defined)));
    assert!(
        !served.is_empty(),
        "the profile resolved and served records"
    );
    assert!(
        served.iter().all(|kind| kind.starts_with("change-")),
        "the launch's own spec is what shaped it: {served:?}"
    );

    // The same name, at a run whose launch defined nothing: not a 500, not a
    // silently unfiltered payload, but the refusal naming what that run does have.
    let refused = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run&filter={defined}",
            fixture_run::OTHER_RUN_ID
        ),
    );
    assert_eq!(refused.status, 404);
    let error = &refused.json()["error"];
    assert_eq!(error["code"], json!("unknown_filter_profile"));
    let message = error["message"].as_str().expect("a message");
    assert!(message.contains(defined), "{message}");
    assert!(
        message.contains("planner") && message.contains("detailed"),
        "a reader who mistyped a name is told which names exist: {message}"
    );

    // And a launch-defined name may not shadow a built-in one: those two mean the
    // same thing for every run, which is the whole reason a reader names them.
    let shadowing = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::define_filter_profile(&dir, "planner", r#"{"include":[{"kind":"change-*"}]}"#);
    });
    let planner = kinds_on(&timeline_under(&shadowing, Some("planner")));
    assert!(
        planner.iter().any(|kind| kind == "node-settled"),
        "the built-in profile is what `planner` still means: {planner:?}"
    );
}

#[test]
fn a_profile_the_launch_config_declared_in_its_filters_block_answers_under_its_own_name() {
    // The engine's own place for a launch's profiles is the `filters.profiles`
    // block a `--launch-config` file or a `--filter-profile NAME=SPEC` flag lands
    // in, retained on the launch record as the typed block `next` and `monitor`
    // resolve through. `monitor` is the word the engine shipped its detailed
    // profile under before it stopped naming an observer member, and it ships no
    // alias — so a run whose launch declared a profile of that name is served
    // *that* profile, as the launch's own, and not the built-in it used to be.
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::declare_filter_profile(&dir, "monitor", r#"{"include":[{"source":"vcs"}]}"#);
        fixture_run::write_live(root, fixture_run::OTHER_RUN_ID);
    });

    let served = kinds_on(&timeline_under(&serving, Some("monitor")));
    assert!(!served.is_empty(), "the launch's profile resolved");
    assert!(
        served.iter().any(|kind| kind == "change-opened"),
        "the launch's own spec is what shaped it: {served:?}"
    );
    assert!(
        !served.iter().any(|kind| kind == "node-settled"),
        "not the detailed stream the word used to name: {served:?}"
    );
    // Named beside the two built-ins when a reader asks for something else.
    let refused = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run&filter=no-such-profile",
            fixture_run::RUN_ID
        ),
    );
    assert_eq!(refused.status, 404);
    let message = refused.json()["error"]["message"]
        .as_str()
        .expect("a message")
        .to_owned();
    for name in ["planner", "detailed", "monitor"] {
        assert!(message.contains(name), "{message}");
    }

    // At a run whose launch declared no such block, the word names nothing.
    let refused = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run&filter=monitor",
            fixture_run::OTHER_RUN_ID
        ),
    );
    assert_eq!(refused.status, 404, "{}", refused.body);
    assert_eq!(
        refused.json()["error"]["code"],
        json!("unknown_filter_profile")
    );
}

#[test]
fn a_filter_that_could_match_nothing_is_refused_at_the_boundary() {
    let serving = live_run();
    let refused = |spec: &str| -> http::Response {
        http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/timeline?scope=run&filter={}",
                fixture_run::RUN_ID,
                urlencode(spec)
            ),
        )
    };
    // A matcher naming no field at all matches *every* event, so one in `exclude`
    // silences the whole stream — far likelier a typo than an intent, and not a
    // thing the empty payload it produces could tell anyone.
    let empty = refused(r#"{"exclude":[{}]}"#);
    assert_eq!(empty.status, 422);
    let message = empty.json()["error"]["message"]
        .as_str()
        .expect("a message")
        .to_owned();
    assert_eq!(empty.json()["error"]["code"], json!("invalid_request"));
    assert!(
        message.contains("exclude[0]") && message.contains("name at least one"),
        "the refusal names which matcher and what is wrong with it: {message}"
    );

    // A field the stream carries no empty value for matches nothing at all.
    let blank = refused(r#"{"include":[{"kind":"node-ready"},{"node":"  "}]}"#);
    assert_eq!(blank.status, 422);
    assert!(
        blank.json()["error"]["message"]
            .as_str()
            .is_some_and(|why| why.contains("include[1]") && why.contains("`node` is empty")),
        "{:?}",
        blank.json()
    );

    // A spec that is not a spec, and a name that is not a usable name.
    assert_eq!(refused(r#"{"include":"everything"}"#).status, 422);
    assert_eq!(refused(r#"{"include":[{"round":1}]}"#).status, 422);
    assert_eq!(refused("../etc/passwd").status, 422);
}

#[test]
fn a_filtered_stream_is_not_woken_by_a_movement_it_excluded() {
    // The stream invalidates rather than restating state, so a filter decides
    // which movements are worth announcing. A subscriber narrowed to decisions
    // must not be woken by every tool call — and must still be woken by a
    // decision.
    let serving = Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    });
    let mut stream = http::stream(
        serving.address,
        &format!(
            "/api/v2/events?run_id={}&filter=planner",
            fixture_run::RUN_ID
        ),
        None,
    );
    assert_eq!(stream.status, 200);
    assert_eq!(stream.frames(1)[0].event, "snapshot");

    // Activity this connection excluded: the run really moved, and this
    // subscriber is deliberately not told, because nothing it is watching for
    // changed. The harness polls every 50ms, so this waits out many polls before
    // concluding the silence is the filter's doing rather than a slow read.
    let dir = serving.run_dir(fixture_run::RUN_ID);
    fixture_run::append_relayed(
        &dir,
        "agentgraph",
        "turn-activity",
        json!({
            "run_id": fixture_run::RUN_ID,
            "node": fixture_run::REDIRECTED_NODE_ID,
            "member": "worker",
            "session": fixture_run::REDIRECTED_CONVERSATION_ID,
        }),
        json!({ "kind": "tool_use", "name": "Read", "detail": "docs/contract.md" }),
    );
    let woken = stream.frame_within(std::time::Duration::from_millis(750));
    assert!(
        woken.is_none(),
        "a subscriber narrowed to decisions was woken by a tool call: {:?}",
        woken.map(|frame| (frame.event, frame.data))
    );

    // Then a decision, which it *is* watching for: the same run, the same poll
    // loop, and this time a frame.
    fixture_run::append(&dir, "node-settled", json!({ "status": "done" }));
    let frame = stream.next_frame().expect("the stream stayed open");
    assert_eq!(frame.event, "run.changed");
    assert_eq!(frame.json()["run_id"], json!(fixture_run::RUN_ID));
    assert!(
        frame.json().get("round").is_none(),
        "an invalidation names the run that moved and nothing else: {}",
        frame.data
    );
}

#[test]
fn a_filtered_detail_carries_the_transcripts_that_reading_is_about() {
    // The detail's own event listing is its transcripts, and the filter narrows
    // exactly that. A decisions-level reading is served none — a session whose
    // every record was excluded is absent rather than present and empty, because
    // an empty transcript says the session recorded nothing.
    let serving = live_run();
    let detail = |filter: &str| -> Value {
        http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}?include_conversations=true&filter={filter}",
                fixture_run::RUN_ID
            ),
        )
        .json()
    };
    let sessions = |body: &Value| -> Vec<String> {
        body["conversations"]
            .as_array()
            .expect("conversations")
            .iter()
            .filter_map(|held| held["conversation"]["id"].as_str().map(str::to_owned))
            .collect()
    };

    let detailed = sessions(&detail("detailed"));
    assert!(
        detailed.contains(&fixture_run::LIVE_CONVERSATION_ID.to_owned()),
        "{detailed:?}"
    );
    assert_eq!(sessions(&detail("planner")), Vec::<String>::new());

    // A spec that admits one node's records is served that node's session and no
    // other, which is the narrowing a reader writes an inline spec for.
    let one = sessions(&detail(&urlencode(&format!(
        r#"{{"include":[{{"node":"{}"}}]}}"#,
        fixture_run::REDIRECTED_NODE_ID
    ))));
    assert_eq!(
        one,
        vec![fixture_run::REDIRECTED_CONVERSATION_ID.to_owned()]
    );
}

#[test]
fn a_node_scoped_timeline_is_narrowed_by_the_same_filter_as_the_run() {
    // The two scopes are different payloads rather than one a subset of the
    // other, so a filter proven at run scope is not proven at node scope.
    let serving = live_run();
    let node_timeline = |filter: Option<&str>| -> Value {
        let query = filter.map_or_else(String::new, |spec| format!("&filter={spec}"));
        http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/timeline?scope=node&node={}{query}",
                fixture_run::RUN_ID,
                fixture_run::SHIP_NODE_ID
            ),
        )
        .json()
    };

    let whole = node_timeline(None);
    let kinds = kinds_on(&whole);
    assert!(
        kinds.iter().any(|kind| kind == "turn-completed"),
        "{kinds:?}"
    );
    assert!(kinds.iter().any(|kind| kind == "node-settled"), "{kinds:?}");

    let decisions = node_timeline(Some("planner"));
    let narrowed = kinds_on(&decisions);
    assert!(
        narrowed.iter().any(|kind| kind == "node-settled"),
        "{narrowed:?}"
    );
    assert!(
        !narrowed.iter().any(|kind| kind.starts_with("turn-")),
        "{narrowed:?}"
    );

    // The spans themselves are what the run recorded, whatever the filter said: a
    // reader narrowing their attention must not lose the node from its own
    // timeline, nor find its dispatch bracketed somewhere else.
    let spans = |body: &Value| -> Vec<(String, String, Value)> {
        body["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .map(|span| {
                (
                    span["id"].as_str().unwrap_or_default().to_owned(),
                    span["kind"].as_str().unwrap_or_default().to_owned(),
                    span["started_at"].clone(),
                )
            })
            .collect()
    };
    assert_eq!(spans(&decisions), spans(&whole));
}

#[test]
fn an_unknown_profile_is_refused_by_the_detail_route_too() {
    // Every route that takes the parameter resolves it against the run, so each
    // of them answers for a name that run has no profile for.
    let serving = live_run();
    for route in [
        format!("/api/v2/runs/{}", fixture_run::RUN_ID),
        format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    ] {
        let joiner = if route.contains('?') { '&' } else { '?' };
        let refused = http::get(
            serving.address,
            &format!("{route}{joiner}filter=nothing-defines-this"),
        );
        assert_eq!(refused.status, 404, "{route}");
        assert_eq!(
            refused.json()["error"]["code"],
            json!("unknown_filter_profile"),
            "{route}"
        );
        // And a malformed spec is the request's own fault on every one of them.
        let malformed = http::get(
            serving.address,
            &format!("{route}{joiner}filter={}", urlencode(r#"{"exclude":[{}]}"#)),
        );
        assert_eq!(malformed.status, 422, "{route}");
    }
}

#[test]
fn a_watcher_is_told_the_activity_its_filter_admits_and_no_other() {
    // `activity.changed` is a listing of records like any other, so it is narrowed
    // by the same filter — and a connection that admits those records is still
    // told what its nodes are doing.
    let serving = Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    });
    let latest = |filter: &str| -> Option<Value> {
        let mut stream = http::stream(
            serving.address,
            &format!(
                "/api/v2/events?run_id={}&filter={filter}",
                fixture_run::RUN_ID
            ),
            None,
        );
        assert_eq!(stream.status, 200);
        assert_eq!(stream.frames(1)[0].event, "snapshot");
        fixture_run::append_relayed(
            &serving.run_dir(fixture_run::RUN_ID),
            "agentgraph",
            "turn-activity",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::REDIRECTED_NODE_ID,
                "member": "worker",
                "session": fixture_run::REDIRECTED_CONVERSATION_ID,
            }),
            json!({ "kind": "tool_use", "name": "Grep", "detail": "docs/contract.md" }),
        );
        let mut activity = None;
        while let Some(frame) = stream.frame_within(std::time::Duration::from_millis(750)) {
            if frame.event == "activity.changed" {
                activity = Some(frame.json());
                break;
            }
        }
        activity
    };

    let told = latest("detailed").expect("the detailed reading is told what the turn is doing");
    let summary = told["activity"]
        .as_array()
        .expect("the live activity")
        .last()
        .expect("the most recent summary")
        .clone();
    assert_eq!(summary["node"], json!(fixture_run::REDIRECTED_NODE_ID));
    assert_eq!(summary["name"], json!("Grep"));

    // The decisions-level reading is not about tool calls, so it is told none —
    // neither an `activity.changed` carrying an empty list, which would be this
    // server saying the node is doing nothing.
    assert!(
        latest("planner").is_none(),
        "a decisions-level watcher was told about a tool call"
    );
}

/// Every event a run-scoped timeline lists, across its spans.
fn events_on(body: &Value) -> Vec<Value> {
    body["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// The word a host's observer binding raises its surfaces under in these
/// journeys: a word naming no member, no persona and no kind the engine declares,
/// so what they prove is that the vocabulary is open rather than that one host's
/// words happen to be on a list.
const SENTINEL: &str = "sentinel";
/// A blocking kind that same host defined, likewise nobody's built-in.
const SENTINEL_LOST: &str = "sentinel-lost";

#[test]
fn a_surface_of_a_kind_no_vocabulary_declares_is_served_as_the_host_raised_it() {
    // Surface kinds are an open vocabulary: the engine declares and acts on two
    // of its own, raises a third, and relays every other well-formed kind a host
    // defines unchanged — its message, its source, its blocking flag and its
    // unread accounting. A reader of this API is shown exactly that, on the
    // timeline, the run detail and the stream, under a kind this build has never
    // heard of.
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::OTHER_RUN_ID);
        // One the host's observer raised and the planner has read.
        fixture_run::append(
            &dir,
            "planner-surface-queued",
            json!({
                "kind": SENTINEL,
                "message": "the gate went red twice on the same hunk",
                "source": SENTINEL,
                "blocking": false,
            }),
        );
        fixture_run::append(
            &dir,
            "planner-surfaced",
            json!({
                "kind": SENTINEL,
                "message": "the gate went red twice on the same hunk",
                "source": SENTINEL,
                "blocking": false,
                "queued_at": 1_786_190_460_000_u64,
            }),
        );
        // And one that holds a subtree until it is answered, which the engine
        // records as the decision point it is, under the surface's own kind.
        fixture_run::append(
            &dir,
            "planner-surface-queued",
            json!({
                "kind": SENTINEL_LOST,
                "message": "the sentinel stopped answering; park the node or carry on?",
                "source": SENTINEL,
                "blocking": true,
            }),
        );
        fixture_run::append_relayed(
            &dir,
            "pipeline",
            "decision-pending",
            json!({ "run_id": fixture_run::OTHER_RUN_ID, "node": "surface:7" }),
            json!({
                "reference": "surface:7",
                "kind": SENTINEL_LOST,
                "unblocks": [fixture_run::ANNOUNCE_NODE_ID],
            }),
        );
    });

    // The timeline: each surface record carries what it said, as recorded.
    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::OTHER_RUN_ID
        ),
    )
    .json();
    // The host's own, beside the one the fixture's engine raised itself.
    let surfaces: Vec<Value> = events_on(&timeline)
        .into_iter()
        .filter(|event| event["surface"]["source"] == json!(SENTINEL))
        .collect();
    let kinds: Vec<&str> = surfaces
        .iter()
        .filter_map(|event| event["kind"].as_str())
        .collect();
    assert_eq!(
        kinds,
        vec![
            "planner-surface-queued",
            "planner-surfaced",
            "planner-surface-queued"
        ],
        "{surfaces:?}"
    );
    assert_eq!(
        surfaces[0]["surface"],
        json!({
            "kind": SENTINEL,
            "message": "the gate went red twice on the same hunk",
            "source": SENTINEL,
            "blocking": false,
        })
    );
    assert_eq!(surfaces[1]["surface"], surfaces[0]["surface"]);
    assert_eq!(
        surfaces[2]["surface"],
        json!({
            "kind": SENTINEL_LOST,
            "message": "the sentinel stopped answering; park the node or carry on?",
            "source": SENTINEL,
            "blocking": true,
        })
    );
    // The two are decisions, so the decisions-level profile lists them too.
    let decisions = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run&filter=planner",
            fixture_run::OTHER_RUN_ID
        ),
    )
    .json();
    assert_eq!(
        events_on(&decisions)
            .iter()
            .filter(|event| event["surface"]["kind"] == json!(SENTINEL_LOST))
            .count(),
        1,
        "{decisions}"
    );

    // The run detail: the blocking one is the decision point holding its
    // subtree, keyed by the surface and carrying the host's own kind.
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::OTHER_RUN_ID),
    )
    .json();
    let decisions = detail["graph"]["decisions"]
        .as_array()
        .expect("decisions")
        .clone();
    let held = decisions
        .iter()
        .find(|decision| decision["id"] == json!("surface:7"))
        .unwrap_or_else(|| panic!("the blocking surface is a decision point: {decisions:?}"));
    assert_eq!(held["kind"], json!(SENTINEL_LOST));
    assert_eq!(held["unblocks"], json!([fixture_run::ANNOUNCE_NODE_ID]));
    assert_eq!(detail["run"]["phase"], json!("deciding"));
    assert_eq!(detail["run"]["last_event"], json!("decision-pending"));

    // The stream: the run's row is what the snapshot carries, and the surface
    // raised next is what wakes a subscriber — the decisions-level one included,
    // because a surface is a decision whatever kind a host gave it.
    let mut stream = http::stream(serving.address, "/api/v2/events?filter=planner", None);
    assert_eq!(stream.status, 200);
    let snapshot = stream.next_frame().expect("a snapshot").json();
    let row = snapshot["runs"]
        .as_array()
        .expect("runs")
        .iter()
        .find(|row| row["run_id"] == json!(fixture_run::OTHER_RUN_ID))
        .expect("the run's row")
        .clone();
    assert_eq!(row["phase"], json!("deciding"));
    fixture_run::append(
        &serving.run_dir(fixture_run::OTHER_RUN_ID),
        "planner-surface-queued",
        json!({
            "kind": SENTINEL,
            "message": "the sentinel is back",
            "source": SENTINEL,
            "blocking": false,
        }),
    );
    let changed = stream.next_frame().expect("the surface is noticed");
    assert_eq!(changed.event, "run.changed");
    assert_eq!(changed.json()["run_id"], json!(fixture_run::OTHER_RUN_ID));
    // And the row refreshed by name, as a client does on that frame, carries the
    // one thing that moved: the run is surfacing again on top of its decision.
    let refreshed = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=run",
            fixture_run::OTHER_RUN_ID
        ),
    )
    .json();
    assert_eq!(
        events_on(&refreshed)
            .iter()
            .filter(|event| event["surface"]["message"] == json!("the sentinel is back"))
            .count(),
        1
    );

    // Counted with every other surface, and raised through the engine's own
    // surface verb under the host's word: a kind nobody declared is queued on
    // the run's channel and journalled exactly as a declared one is, so the row
    // counts it unread, the run is being driven as far as its last write says,
    // and the timeline serves the kind as the host raised it.
    let asked = Serving::start(|root| {
        fixture_run::write_launched(root, fixture_run::RUN_ID);
    });
    let raised = http::post(
        asked.address,
        &format!("/api/v2/runs/{}/channel/surface", fixture_run::RUN_ID),
        &json!({ "kind": SENTINEL_LOST, "message": "park or carry on?" }).to_string(),
    );
    assert_eq!(raised.status, 200, "{}", raised.body);
    let waiting = http::get(asked.address, "/api/v2/runs").json()["runs"][0].clone();
    assert_eq!(waiting["state"], json!("active"), "{waiting}");
    assert_eq!(waiting["unread_surfaces"], json!(1), "{waiting}");
    assert_eq!(
        waiting["last_event"],
        json!("planner-surface-queued"),
        "{waiting}"
    );
    let queued = http::get(
        asked.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    assert!(
        events_on(&queued)
            .iter()
            .any(|event| event["surface"]["kind"] == json!(SENTINEL_LOST)),
        "{queued}"
    );
    // A run with work still queued and no decision outstanding.
    let surfacing = Serving::start(|root| {
        let dir = fixture_run::write_held(root, fixture_run::HELD_RUN_ID);
        fixture_run::append(
            &dir,
            "planner-surface-queued",
            json!({
                "kind": SENTINEL,
                "message": "one more thing",
                "source": SENTINEL,
                "blocking": false,
            }),
        );
    });
    let row =
        http::get(surfacing.address, "/api/v2/runs?include_settled=true").json()["runs"][0].clone();
    assert_eq!(row["phase"], json!("surfacing"), "{row}");
}

#[test]
fn a_surface_that_said_nothing_this_build_can_read_is_served_without_one() {
    // A record carrying none of the four facts serves no `surface` at all, and a
    // record carrying some serves exactly those: nothing is defaulted, because a
    // field filled in here would be this API saying something no record did.
    let serving = Serving::start(|root| {
        let dir = fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::append(&dir, "planner-surface-queued", json!({}));
        fixture_run::append(
            &dir,
            "planner-surfaced",
            json!({ "blocking": true, "kind": "", "message": "   " }),
        );
    });
    let surfaces: Vec<Value> = events_on(&timeline_under(&serving, None))
        .into_iter()
        .filter(|event| {
            event["kind"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("planner-surface"))
        })
        .collect();
    assert_eq!(surfaces.len(), 2, "{surfaces:?}");
    assert!(surfaces[0].get("surface").is_none(), "{surfaces:?}");
    assert_eq!(surfaces[1]["surface"], json!({ "blocking": true }));
}

#[test]
fn an_edit_by_an_author_the_launch_declared_is_served_with_that_authors_word() {
    // Channel authors are open words: an omitted author is the planner, and every
    // other is one the launch's bus configuration declared together with the ops
    // it grants. The engine reports each such author's applied edit back as an
    // `edit-applied` surface whose source is that author's word. Both reach a
    // reader as recorded — and so does a run the older engine wrote, with its
    // `monitor` author and its `monitor-edit` surface kind, because nothing here
    // keeps a list to refuse either against.
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::OTHER_RUN_ID);
        fixture_run::append(
            &dir,
            "edit-committed",
            json!({
                "author": SENTINEL,
                "command": { "op": "amend", "id": fixture_run::UNCONTROLLED_NODE_ID, "text": "the benchmark's bar is the p99, not the mean" },
                "operations": [{ "kind": "task-amended", "node": fixture_run::UNCONTROLLED_NODE_ID }],
            }),
        );
        fixture_run::append(
            &dir,
            "planner-surface-queued",
            json!({
                "kind": "edit-applied",
                "message": format!("{SENTINEL} applied an edit: amend {}", fixture_run::UNCONTROLLED_NODE_ID),
                "source": SENTINEL,
                "blocking": false,
            }),
        );
        // What the engine wrote before it stopped naming its observer.
        fixture_run::append(
            &dir,
            "planner-surface-queued",
            json!({
                "kind": "monitor-edit",
                "message": "monitor applied an edit: context benchmark",
                "source": "monitor",
                "blocking": false,
            }),
        );
    });
    let events = events_on(
        &http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/timeline?scope=run",
                fixture_run::OTHER_RUN_ID
            ),
        )
        .json(),
    );
    let by_sentinel: Vec<&Value> = events
        .iter()
        .filter(|event| event["kind"] == "edit-committed" && event["author"] == json!(SENTINEL))
        .collect();
    assert_eq!(by_sentinel.len(), 1, "{events:?}");
    let applied: Vec<&Value> = events
        .iter()
        .filter(|event| event["surface"]["kind"] == json!("edit-applied"))
        .collect();
    assert_eq!(applied.len(), 1, "{events:?}");
    assert_eq!(applied[0]["surface"]["source"], json!(SENTINEL));
    assert_eq!(applied[0]["surface"]["blocking"], json!(false));
    assert_eq!(
        applied[0]["surface"]["message"],
        json!(format!(
            "{SENTINEL} applied an edit: amend {}",
            fixture_run::UNCONTROLLED_NODE_ID
        ))
    );
    let older: Vec<&Value> = events
        .iter()
        .filter(|event| event["surface"]["kind"] == json!("monitor-edit"))
        .collect();
    assert_eq!(older.len(), 1, "{events:?}");
    assert_eq!(older[0]["surface"]["source"], json!("monitor"));
    // The older engine's observer author is still served as its own word, on the
    // edit the live fixture recorded for it.
    assert!(
        events
            .iter()
            .any(|event| event["kind"] == "edit-committed" && event["author"] == json!("monitor")),
        "{events:?}"
    );
}

#[test]
fn an_accepted_edit_is_served_with_the_author_that_submitted_it() {
    // The run's bus configuration grants each author its own ops — the planner
    // every op, and each author the launch declared a narrower set — so who
    // asked for a change is a fact about the change. Without it an observer's
    // self-applied fix and the planner's own decision read as one thing on a
    // reader's timeline.
    let serving = live_run();
    let edits: Vec<Value> = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .filter(|event| event["kind"] == "edit-committed")
        .collect();
    let authors: Vec<&str> = edits
        .iter()
        .filter_map(|edit| edit["author"].as_str())
        .collect();
    assert!(authors.contains(&"planner"), "{edits:?}");
    assert!(authors.contains(&"monitor"), "{edits:?}");

    // Recorded rather than defaulted: the two edits this run's reconciler
    // compiled from a `context` command carry no author at all, and an absent one
    // is served absent rather than assumed to be the planner's.
    assert!(
        edits.iter().any(|edit| edit.get("author").is_none()),
        "an author nothing recorded is not invented: {edits:?}"
    );
}

#[test]
fn a_stream_watching_a_run_with_no_such_profile_is_served_rather_than_broken() {
    // The frames are an invalidation, and the refusal a reader can act on is the
    // one the detail route serves when they refetch. A stream that failed instead
    // would leave a browser with no live updates at all over a name one of the
    // runs it is watching happens not to define — so an unknown profile narrows
    // nothing here, and the connection keeps working.
    let serving = Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    });
    let mut stream = http::stream(
        serving.address,
        &format!(
            "/api/v2/events?run_id={}&filter=nothing-defines-this",
            fixture_run::RUN_ID
        ),
        None,
    );
    assert_eq!(stream.status, 200, "the stream opened rather than refusing");
    assert_eq!(stream.frames(1)[0].event, "snapshot");

    // And it is still a working subscription: a record this run writes reaches it.
    fixture_run::append(
        &serving.run_dir(fixture_run::RUN_ID),
        "node-settled",
        json!({ "status": "done" }),
    );
    let frame = stream.next_frame().expect("the stream stayed open");
    assert_eq!(frame.event, "run.changed");
    assert_eq!(frame.json()["run_id"], json!(fixture_run::RUN_ID));

    // The refusal is the detail route's, which is where a reader can act on it.
    let refused = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}?filter=nothing-defines-this",
            fixture_run::RUN_ID
        ),
    );
    assert_eq!(refused.status, 404);
    assert_eq!(
        refused.json()["error"]["code"],
        json!("unknown_filter_profile")
    );
}

/// The transcript a settled dispatch really had, served from the report it left.
///
/// This is the whole of what the view exists for: a manager supervising hours of
/// work they cannot watch reads the prompt each turn was given, the reply it
/// wrote, what its tool calls came back with, and what that turn alone cost. The
/// journal carries none of those, and the report carries all of them — so every
/// assertion here is against a run directory the SDK itself writes, holding a
/// report `onejudge`'s own types serialized.
#[test]
fn a_settled_dispatchs_transcript_is_the_conversation_it_really_had() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::CONVERSATION_ID
        ),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_enveloped(&body);
    let turns = body["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    let persona = body["attribution"]["persona"]
        .as_str()
        .expect("the dispatch's persona");
    assert_eq!(persona, "worker");

    // The prompt the simulated user gave, on the turn that answered it. Who was
    // asked is not what they were asked, and a persona name here is the bug that
    // made this view unable to answer the question it exists for.
    assert_eq!(turns[0]["user"], json!(fixture_run::FIRST_PROMPT));
    assert_eq!(turns[1]["user"], json!(fixture_run::SECOND_PROMPT));
    for turn in &turns {
        assert_ne!(turn["user"], json!(persona), "a persona name for a prompt");
    }

    // The prose it wrote back, which no envelope carries.
    assert_eq!(turns[0]["assistant"], json!(fixture_run::FIRST_REPLY));
    assert_eq!(turns[1]["assistant"], json!(fixture_run::SECOND_REPLY));

    // The call, and what it came back with. A `tool_call` carries no observation
    // and the `tool_result` beside it is where the observation is — that is the
    // producing library's own pairing, and the client pairs them by it.
    let tools = turns[0]["tools"].as_array().expect("the turn's tools");
    assert_eq!(tools.len(), 2, "{tools:?}");
    assert_eq!(tools[0]["kind"], json!("tool_call"));
    assert_eq!(tools[0]["name"], json!("Read"));
    assert_eq!(tools[0]["input"], json!({ "file_path": "src/api.rs" }));
    assert_eq!(tools[0]["output"], json!(null), "a call returns nothing");
    assert_eq!(tools[1]["kind"], json!("tool_result"));
    assert_eq!(tools[1]["name"], json!(null), "a result carries no name");
    assert_eq!(tools[1]["index"], json!(1));
    assert_eq!(tools[1]["output"], json!(fixture_run::TOOL_OBSERVATION));
    // And an absence where the trace exposed none, which is a different fact
    // from a call that returned an empty string.
    let second = turns[1]["tools"].as_array().expect("the turn's tools");
    assert_eq!(second[0]["name"], json!("Bash"));
    assert_eq!(second[1]["kind"], json!("tool_result"));
    assert_eq!(second[1]["output"], json!(null), "{second:?}");

    // What *that turn* spent, from the candidate that ran in its own agent
    // attribution — not the report's total over both sides, which is neither
    // turn's, and not the judge's, which is the other role's.
    assert_eq!(turns[0]["usage"]["costUsd"], json!(29.71));
    assert_eq!(turns[1]["usage"]["costUsd"], json!(1.51));
    assert_eq!(turns[0]["usage"]["inputTokens"], json!(376));
    assert_eq!(turns[0]["usage"]["cacheReadTokens"], json!(44_051));
    assert_eq!(turns[0]["usage"]["cacheWriteTokens"], json!(356));
    assert_eq!(turns[0]["usage"]["outputTokens"], json!(164));
    for turn in turns.iter().take(3) {
        assert_ne!(
            turn["usage"]["costUsd"],
            json!(53.79),
            "the run total repeated on a turn: {turn}"
        );
        assert_ne!(
            turn["usage"]["inputTokens"],
            json!(79_341),
            "the judge's tokens on an agent turn: {turn}"
        );
        assert_ne!(turn["usage"]["costUsd"], json!(9.75), "{turn}");
    }

    // What that turn took, from the same candidate. Not `4364` — the identity the
    // chain fell through before it, whose duration is how long finding that out
    // took — and not `2800`, which is the judge's.
    assert_eq!(turns[0]["durationMs"], json!(900));
    assert_eq!(turns[1]["durationMs"], json!(100));

    // The bounds the report observed for the *agent* side of turn 1. It holds a
    // `role: judge` row for turn 2 as well and none for the agent, so turn 2 is
    // served both bounds absent rather than the judge's clock.
    assert_eq!(turns[0]["startedAt"], json!("2026-08-07T12:00:03.000Z"));
    assert_eq!(turns[0]["finishedAt"], json!("2026-08-07T12:00:03.900Z"));
    assert_eq!(turns[1]["startedAt"], json!(null));
    assert_eq!(turns[1]["finishedAt"], json!(null));
    // Named exactly: the four instants the report recorded against the *judge*,
    // one pair per turn. None of them may appear on any turn served here.
    for judged in [
        "2026-08-07T12:00:03.910Z",
        "2026-08-07T12:00:03.980Z",
        "2026-08-07T12:00:04.800Z",
        "2026-08-07T12:00:04.900Z",
    ] {
        for turn in &turns {
            for bound in ["startedAt", "finishedAt"] {
                assert_ne!(
                    turn[bound],
                    json!(judged),
                    "a judge row's clock reached an agent turn: {turn}"
                );
            }
        }
    }

    // Three turns, because the report recorded three — and the record the
    // producer publishes beside the settlement is not a fourth. It numbers no
    // turn and carries the whole dispatch's total, so serving it beside them
    // would be a turn the report does not have: no prompt, no reply, and every
    // one of the dispatch's dollars billed to it.
    assert_eq!(turns.len(), 3, "{turns:?}");
    for turn in &turns {
        assert_ne!(
            turn["usage"]["costUsd"],
            json!(53.79),
            "the dispatch's own total served as a turn: {turn}"
        );
        assert_ne!(turn["user"], json!(""), "a turn nobody was asked: {turn}");
    }
}

/// A turn the producer never bracketed is still a turn of the transcript: the
/// settled member's report kept it, and the report is what a settled dispatch's
/// transcript is.
///
/// This is the dispatch that opened as an empty transcript. `oneagentgraph`
/// relays a `turn-started` for the turns it brackets and nothing at all for the
/// rest, and reading the report only where a relayed record already stood served
/// every unrelayed turn as nothing — no prose, no tools and no cost, on data
/// where the run had stored all three.
#[test]
fn a_turn_the_journal_never_opened_is_served_from_the_report_that_kept_it() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::CONVERSATION_ID
        ),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    let turns = body["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();

    // As many turns as the report recorded prompts, and no more: the journal
    // opened two of them, the report holds all three, and the record the producer
    // publishes beside the settlement numbers no turn and is not one of them.
    assert_eq!(turns.len(), 3, "{turns:?}");

    // Third in the report and third in the transcript: a row the journal named no
    // record of takes its place by the producer's own turn number, so the two
    // turns before it are still the ones the journal opened.
    let unrelayed = &turns[2];
    assert_eq!(
        unrelayed["id"],
        json!(format!("{}.2", fixture_run::CONVERSATION_ID))
    );
    assert_eq!(unrelayed["user"], json!(fixture_run::THIRD_PROMPT));
    assert_eq!(unrelayed["assistant"], json!(fixture_run::THIRD_REPLY));

    // What it called, and what the call came back with — the observation the
    // journal never held, on a turn the journal never held either.
    let tools = unrelayed["tools"].as_array().expect("the turn's tools");
    assert_eq!(tools.len(), 2, "{tools:?}");
    assert_eq!(tools[0]["kind"], json!("tool_call"));
    assert_eq!(tools[0]["name"], json!("Read"));
    assert_eq!(tools[0]["output"], json!(null), "a call returns nothing");
    assert_eq!(tools[1]["kind"], json!("tool_result"));
    assert_eq!(
        tools[1]["output"],
        json!(fixture_run::UNRELAYED_OBSERVATION)
    );

    // What it cost and took, from the candidate that ran in its own attribution.
    // Five figures, because a dispatch the report credits with a measured cost
    // must serve that cost rather than an absence.
    assert_eq!(
        unrelayed["usage"]["costUsd"],
        json!(fixture_run::UNRELAYED_COST)
    );
    assert_eq!(unrelayed["usage"]["inputTokens"], json!(376));
    assert_eq!(unrelayed["usage"]["outputTokens"], json!(164));
    assert_eq!(unrelayed["usage"]["cacheReadTokens"], json!(44_051));
    assert_eq!(unrelayed["usage"]["cacheWriteTokens"], json!(356));
    assert_eq!(unrelayed["durationMs"], json!(fixture_run::UNRELAYED_MS));
    // The identity and the status oneharness gave that invocation, which is the
    // only account of either any run holds for this turn.
    assert_eq!(unrelayed["model"], json!(fixture_run::UNRELAYED_MODEL));
    assert_eq!(unrelayed["status"], json!("ok"));
    // The report observed no agent-side bounds for it, so the instant it is
    // stamped by is the settlement that stored the report — and the bounds
    // themselves stay absent rather than borrowing another turn's.
    assert_eq!(
        unrelayed["timestamp"],
        json!(fixture_run::WORKER_SETTLED_AT)
    );
    assert_eq!(unrelayed["startedAt"], json!(null));
    assert_eq!(unrelayed["finishedAt"], json!(null));

    // The count beside the node is the same reading: a node that reads `2 turns`
    // above a transcript of three is the disagreement one fold exists to prevent.
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let node = detail["run"]["nodes"]
        .as_array()
        .expect("the run's nodes")
        .iter()
        .find(|node| node["node"] == json!(fixture_run::NODE_ID))
        .expect("the dispatched node")
        .clone();
    assert_eq!(node["turns"], json!(turns.len()));

    // And the timeline addresses the rows the transcript serves, and only those.
    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        ),
    )
    .json();
    let opened = relayed(&timeline, "turn-started");
    let named: Vec<&Value> = opened.iter().map(|event| &event["id"]).collect();
    for turn in 0..2 {
        assert!(
            named.contains(&&json!(format!("{}.{turn}", fixture_run::CONVERSATION_ID))),
            "{named:?}"
        );
    }
    // And nothing plotted addresses a row no record produced: the turn the report
    // alone holds was relayed by nothing, and the record the producer published
    // beside the settlement is not a row to address either.
    assert!(
        !named.contains(&&json!(format!("{}.2", fixture_run::CONVERSATION_ID))),
        "{named:?}"
    );
    for event in relayed(&timeline, "turn-completed") {
        assert!(
            !event["id"]
                .as_str()
                .expect("the event's id")
                .starts_with(fixture_run::CONVERSATION_ID),
            "the dispatch's close addressed as a turn: {event}"
        );
    }
}

/// A settled dispatch serves the judge that supervised it as a conversation of
/// its own, named for the dispatch it ruled on.
#[test]
fn a_settled_dispatch_serves_the_judge_that_supervised_it_as_its_own_conversation() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::REVIEW_JUDGE_CONVERSATION_ID
        ),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_enveloped(&body);

    // The dispatch it supervised, at the node it supervised it under — and
    // served under that dispatch's own member word, whatever it is: the
    // review graph happens to have named the member it runs as the judge
    // transport `judge`, and that is the run's word rather than this crate's.
    // The transport is what tells the two sides of one member apart.
    let attribution = &body["attribution"];
    let supervised = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::REVIEW_CONVERSATION_ID
        ),
    )
    .json();
    assert_eq!(supervised["attribution"]["transportRole"], json!("judge"));
    assert_eq!(
        attribution["agentRole"], supervised["attribution"]["agentRole"],
        "{attribution}"
    );
    assert_eq!(attribution["agentRole"], json!("judge"));
    assert_eq!(attribution["transportRole"], json!("judge"));
    assert_eq!(
        attribution["parentConversationId"],
        json!(fixture_run::REVIEW_CONVERSATION_ID)
    );
    assert_eq!(attribution["nodeId"], json!(fixture_run::REVIEW_NODE_ID));
    assert_eq!(attribution["runId"], json!(fixture_run::RUN_ID));

    let turns = body["conversation"]["turns"]
        .as_array()
        .expect("the judge's turns")
        .clone();
    assert_eq!(
        turns.len(),
        3,
        "two judge turns and the conclusion: {turns:?}"
    );

    // Turn by turn: the bounds the report observed, the elapsed time and model of
    // the candidate that ran it, and what that invocation alone consumed.
    for (index, (started, finished)) in fixture_run::JUDGE_BOUNDS.into_iter().enumerate() {
        assert_eq!(turns[index]["startedAt"], json!(started));
        assert_eq!(turns[index]["finishedAt"], json!(finished));
    }
    assert_eq!(turns[0]["durationMs"], json!(500));
    assert_eq!(turns[1]["durationMs"], json!(400));
    for turn in turns.iter().take(2) {
        assert_eq!(turn["model"], json!(fixture_run::JUDGE_MODEL), "{turn}");
        assert_eq!(turn["harness"], json!("codex:judge"), "{turn}");
        assert_eq!(turn["usage"]["inputTokens"], json!(51_204), "{turn}");
        assert_eq!(turn["usage"]["outputTokens"], json!(311), "{turn}");
        assert_eq!(turn["usage"]["cacheReadTokens"], json!(20_480), "{turn}");
        // A figure the provider never reported is an explicit absence, never a
        // zero: this provider reports no cache write and no cost, and a `0` for
        // either would read as a measurement somebody took.
        for absent in ["cacheWriteTokens", "costUsd"] {
            assert_eq!(turn["usage"][absent], json!(null), "{turn}");
            assert_ne!(turn["usage"][absent], json!(0), "{turn}");
        }
        // And nothing the report keys to the *agent* reaches a judge turn — the
        // chain of identities it carries is the judge side's own.
        assert_ne!(turn["durationMs"], json!(2_800), "{turn}");
        assert_ne!(turn["usage"]["costUsd"], json!(0.11), "{turn}");
        assert_ne!(turn["usage"]["inputTokens"], json!(400), "{turn}");
        assert_eq!(
            turn["unknown"]["attribution"]["role"],
            json!("judge"),
            "{turn}"
        );
        assert_eq!(
            turn["unknown"]["attribution"]["ran"],
            json!("codex:judge"),
            "{turn}"
        );
    }

    // No text against a judge turn, because the report keys none to one.
    for turn in turns.iter().take(2) {
        assert_eq!(turn["assistant"], json!(null), "{turn}");
        assert_eq!(turn["user"], json!(""), "{turn}");
        assert_eq!(turn["tools"], json!([]), "{turn}");
        for prose in [fixture_run::REVIEW_PROMPT, fixture_run::REVIEW_REPLY] {
            assert_ne!(turn["user"], json!(prose), "{turn}");
            assert_ne!(turn["assistant"], json!(prose), "{turn}");
        }
    }

    // The conclusion, which the report keys to the dispatch rather than a turn.
    let closing = &turns[2];
    assert_eq!(closing["assistant"], json!(fixture_run::JUDGE_ASSESSMENT));
    let verdicts = closing["unknown"]["verdicts"]
        .as_array()
        .expect("the judge's verdicts");
    assert_eq!(verdicts.len(), 3, "{verdicts:?}");
    for (index, (criterion, reason)) in fixture_run::JUDGE_CRITERIA.into_iter().enumerate() {
        assert_eq!(verdicts[index]["criterion"], json!(criterion));
        assert_eq!(verdicts[index]["kind"], json!("boolean"));
        assert_eq!(verdicts[index]["value"], json!(true));
        assert_eq!(verdicts[index]["reason"], json!(reason));
    }
    let (criterion, score, reason) = fixture_run::JUDGE_SCORED;
    assert_eq!(verdicts[2]["criterion"], json!(criterion));
    assert_eq!(verdicts[2]["kind"], json!("numeric"));
    assert_eq!(verdicts[2]["value"], json!(score));
    assert_eq!(verdicts[2]["reason"], json!(reason));
    assert_eq!(
        closing["unknown"]["completionReason"],
        json!("the change is approved")
    );
    assert_eq!(closing["unknown"]["stoppedEarly"], json!(false));
    // No invocation is recorded for it, so it claims no clock and no spend.
    assert_eq!(closing["startedAt"], json!(null));
    assert_eq!(closing["finishedAt"], json!(null));
    assert_eq!(closing["durationMs"], json!(null));
    assert_eq!(closing["usage"], json!({}));
}

/// A turn carries the chain of identities its invocation was attributed to, in
/// the report's own words: the harness that refused to run it under a model
/// other than the one asked for, why the chain fell through it, and the one
/// that ran.
///
/// The fixture's first turn is exactly the refusal the linked `oneharness`
/// answers — the harness reported it would serve a different model than the
/// requested one, and the turn was refused before a token was spent rather
/// than silently spent on the other model. Both halves of that record are
/// served as the report holds them: the `model_mismatch` kind on the candidate
/// and the `model-mismatch` reason on the fall-through, beside the model that
/// was asked for and the one the harness named instead. A reading that served
/// only the candidate that ran would show a turn that ran on `claude-code` and
/// nothing of the model it was refused under.
#[test]
fn a_turn_serves_the_chain_its_invocation_fell_through_and_the_model_it_was_refused() {
    let serving = two_runs();
    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::CONVERSATION_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();

    let chain = &turns[0]["unknown"]["attribution"];
    assert_eq!(chain["role"], json!("agent"), "{chain}");
    assert_eq!(chain["turn_index"], json!(1), "{chain}");
    assert_eq!(chain["ran"], json!("claude-code:default"), "{chain}");
    assert_eq!(
        chain["fell_through"],
        json!([{
            "harness": "codex",
            "reason": oneharness_core::domain::fallback::FallThroughReason::ModelMismatch,
        }]),
        "the reason the chain fell through, in the linked contract's own word: {chain}"
    );
    assert_eq!(chain["fell_through"][0]["reason"], json!("model-mismatch"));
    let refused = &chain["candidates"][0];
    assert_eq!(refused["harness"], json!("codex"));
    assert_eq!(refused["ran"], json!(false));
    assert_eq!(
        refused["failure_kind"],
        json!(oneharness_core::domain::signals::FailureKind::ModelMismatch),
        "{refused}"
    );
    assert_eq!(
        refused["failure_kind"],
        json!("model_mismatch"),
        "{refused}"
    );
    assert_eq!(refused["model"], json!(fixture_run::REQUESTED_MODEL));
    assert!(
        refused["error"]
            .as_str()
            .is_some_and(|error| error.contains(fixture_run::OBSERVED_MODEL)),
        "the model the harness said it would run under instead: {refused}"
    );
    assert_eq!(chain["candidates"][1]["ran"], json!(true));
    // The turn's own identity and clock are still the candidate that ran, and
    // it was refused nothing.
    assert_eq!(turns[0]["durationMs"], json!(900));
    assert_eq!(turns[0]["failureKind"], json!(null));

    // A turn whose chain fell through nothing carries no fall-through at all —
    // the report omits an empty one, and so does this — while its attribution
    // is still served.
    let direct = &turns[1]["unknown"]["attribution"];
    assert_eq!(direct["ran"], json!("claude-code:default"), "{direct}");
    assert!(direct.get("fell_through").is_none(), "{direct}");
}

/// The classified reason oneharness gave for the invocation that **ran** a
/// turn is served as that turn's `failureKind`, as it always was for the
/// judge's turns.
///
/// A candidate can run and still be classified: the one kind that appears on
/// a `status: ok` run is a harness that only deferred a builtin tool call and
/// did no useful work. Served `null` on every agent turn, a reader had the
/// judge's account of such a failure and never the worker's.
#[test]
fn a_turn_whose_invocation_was_classified_serves_the_kind_oneharness_gave_it() {
    use oneharness_core::domain::signals::FailureKind;
    const STREAM: &str = "node-scope-1786925518777-3163334";
    const SESSION: &str = "node-scope-1786925518777-3163334.worker";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        // The one turn, as the producer opened it, so the session is one the
        // run lists; what the report says about it is the whole of the reading.
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "pr-author",
                "session": SESSION,
            }),
            json!({
                "turn": 1,
                "role": "assistant",
                "instruction": "Land the wire contract.",
                "started_at": "2026-08-07T12:01:00.000Z",
            }),
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:01.000Z",
                artifact: "report-node-scope-1786925518777-3163334",
                report: &classified_report(FailureKind::ToolDeferred),
            },
            fixture_run::Produced::Report,
        );
    });
    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json();
    let turns = turns["conversation"]["turns"]
        .as_array()
        .unwrap_or_else(|| panic!("the transcript: {turns}"))
        .clone();
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(
        turns[0]["failureKind"],
        json!(FailureKind::ToolDeferred.as_str()),
        "{}",
        turns[0]
    );
    assert_eq!(turns[0]["harness"], json!("oneagentgraph"));
    assert_eq!(turns[0]["durationMs"], json!(4_200));
    assert_eq!(
        turns[0]["unknown"]["attribution"]["candidates"][0]["failure_kind"],
        json!("tool_deferred"),
        "{}",
        turns[0]
    );
}

/// A report whose one turn ran on a candidate oneharness classified `kind`,
/// on a `status: ok` run — the shape a deferred tool call leaves.
fn classified_report(kind: oneharness_core::domain::signals::FailureKind) -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, Message, PartyTelemetry, Report, Telemetry,
        TelemetryRole, Transcript, Usage,
    };

    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user("Land the wire contract."),
                Message::assistant("I would run the gate, but the tool call was deferred."),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: None,
        settled_reason: Some("the harness deferred the tool call".into()),
        judge_decisions: Vec::new(),
        usage: None,
        telemetry: Some(Telemetry {
            wall_ms: 9_000,
            agent: PartyTelemetry::default(),
            judge: PartyTelemetry::default(),
            orchestration_ms: 10,
            sessions: Vec::new(),
            attribution: vec![HarnessAttribution {
                role: TelemetryRole::Agent,
                turn_index: 1,
                ran: Some("claude-code:default".into()),
                fell_through: Vec::new(),
                candidates: vec![CandidateAttempt {
                    harness: "claude-code".into(),
                    harness_id: "claude-code:default".into(),
                    variant: None,
                    model: None,
                    status: "ok".into(),
                    available: true,
                    ran: true,
                    failure_kind: Some(kind.as_str().to_owned()),
                    failure_kind_source: Some("json:result".into()),
                    exit_code: Some(0),
                    duration_ms: Some(4_200),
                    error: None,
                    session_id: None,
                    history_id: None,
                    usage: Some(Usage {
                        input_tokens: Some(11),
                        output_tokens: Some(22),
                        cache_read_tokens: None,
                        cache_write_tokens: None,
                        cost_usd: Some(2.5),
                    }),
                }],
                history_file: None,
                judge: None,
            }],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// A dispatch's own transcript is left as the earlier steps made it, and carries
/// nothing the report recorded against the judge.
#[test]
fn a_dispatchs_own_transcript_gains_no_judge_figure_beside_it() {
    let serving = two_runs();
    let transcript = |id: &str| {
        http::get(
            serving.address,
            &format!("/api/v2/runs/{}/conversations/{id}", fixture_run::RUN_ID),
        )
        .json()
    };

    let body = transcript(fixture_run::CONVERSATION_ID);
    assert_eq!(
        body["attribution"]["agentRole"],
        json!("worker"),
        "the dispatch is still read as the worker's"
    );
    assert_eq!(
        body["attribution"]["parentConversationId"],
        json!(null),
        "a dispatch supervises nothing"
    );
    let turns = body["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 3, "{turns:?}");
    // The prompts, the replies, and each turn's own agent-side measurements.
    assert_eq!(turns[0]["user"], json!(fixture_run::FIRST_PROMPT));
    assert_eq!(turns[0]["assistant"], json!(fixture_run::FIRST_REPLY));
    assert_eq!(turns[0]["durationMs"], json!(900));
    // And none of the figures its report attributes to the judge instead — nor
    // the judge's chain of identities, which is the one other thing the report
    // keys to a turn: what rides on an agent turn's `unknown` is the agent's own
    // attribution and nothing else.
    for turn in &turns {
        assert_ne!(turn["durationMs"], json!(70), "{turn}");
        assert_ne!(turn["durationMs"], json!(60), "{turn}");
        assert_ne!(turn["usage"]["inputTokens"], json!(79_341), "{turn}");
        assert_ne!(turn["usage"]["costUsd"], json!(9.75), "{turn}");
        let unknown = turn["unknown"].as_object().expect("a map");
        assert!(unknown.keys().all(|key| key == "attribution"), "{turn}");
        assert_eq!(
            turn["unknown"]["attribution"]["role"],
            json!("agent"),
            "{turn}"
        );
    }
    // That report records no judge turn, so there is no second conversation to
    // open beside it — a verdict alone does not make one.
    let asked = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}.judge",
            fixture_run::RUN_ID,
            fixture_run::CONVERSATION_ID
        ),
    );
    assert_eq!(asked.status, 404, "{}", asked.body);

    // The other dispatch, whose report *does* hold the judge's rows: its own turn
    // has no `role: agent` row, and must be served bounds-absent rather than
    // handed the judge's clock beside it.
    let reviewed = transcript(fixture_run::REVIEW_CONVERSATION_ID);
    let turns = reviewed["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns[0]["user"], json!(fixture_run::REVIEW_PROMPT));
    assert_eq!(turns[0]["assistant"], json!(fixture_run::REVIEW_REPLY));
    assert_eq!(turns[0]["durationMs"], json!(2_800));
    for turn in &turns {
        for (started, finished) in fixture_run::JUDGE_BOUNDS {
            for bound in ["startedAt", "finishedAt"] {
                assert_ne!(turn[bound], json!(started), "{turn}");
                assert_ne!(turn[bound], json!(finished), "{turn}");
            }
        }
        assert_eq!(turn["startedAt"], json!(null), "{turn}");
        assert_eq!(turn["finishedAt"], json!(null), "{turn}");
        assert_ne!(turn["usage"]["inputTokens"], json!(51_204), "{turn}");
        // The member's own chain, and not the judge's: the transport is the
        // judge's, and the attribution it carries is still the agent side's.
        let unknown = turn["unknown"].as_object().expect("a map");
        assert!(unknown.keys().all(|key| key == "attribution"), "{turn}");
        assert_eq!(
            turn["unknown"]["attribution"]["role"],
            json!("agent"),
            "{turn}"
        );
    }
}

/// The judge's turns are reachable from the node's own timeline, through a lane
/// that sits with the dispatch it supervised.
#[test]
fn the_judges_lane_sits_with_the_dispatch_it_supervised_on_the_nodes_timeline() {
    let serving = two_runs();
    let spans = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::REVIEW_NODE_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone();

    let supervised = format!("dispatch.{}", fixture_run::REVIEW_CONVERSATION_ID);
    let judge = format!("dispatch.{}", fixture_run::REVIEW_JUDGE_CONVERSATION_ID);
    let at = |id: &str| {
        spans
            .iter()
            .position(|span| span["id"] == json!(id))
            .unwrap_or_else(|| panic!("no span `{id}` among {spans:?}"))
    };
    // Straight after the dispatch in the same scope: that adjacency is what a
    // client gathers the two into one dispatch by.
    assert_eq!(at(&judge), at(&supervised) + 1, "{spans:?}");
    let lane = &spans[at(&judge)];
    let dispatch = &spans[at(&supervised)];
    // In the lane of the member it supervised, told from it by the transport.
    assert_eq!(lane["agent_role"], dispatch["agent_role"], "{lane}");
    assert_eq!(lane["transport_role"], json!("judge"));
    assert_eq!(lane["kind"], dispatch["kind"]);
    assert_eq!(lane["parent_id"], dispatch["parent_id"]);
    assert_eq!(lane["node_id"], json!(fixture_run::REVIEW_NODE_ID));
    assert_eq!(lane["dispatch_id"], dispatch["dispatch_id"]);
    // And it opens the judge's own conversation rather than the dispatch's.
    assert_eq!(
        lane["reference"],
        json!({
            "kind": "conversation",
            "value": fixture_run::REVIEW_JUDGE_CONVERSATION_ID,
        })
    );
    // Drawn over what the report observed, not over the node's window.
    assert_eq!(lane["started_at"], json!(fixture_run::JUDGE_BOUNDS[0].0));
    assert_eq!(lane["ended_at"], json!(fixture_run::JUDGE_BOUNDS[1].1));
    assert_eq!(lane["events"], json!([]), "the judge relays none");

    // The lane is what makes the conversation reachable.
    let opened = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            lane["reference"]["value"].as_str().expect("a conversation")
        ),
    );
    assert_eq!(opened.status, 200, "{}", opened.body);
}

/// A member that has not settled serves no judge lane and no judge conversation,
/// rather than an empty one.
#[test]
fn a_member_that_has_not_settled_serves_no_judge_lane_and_no_judge_conversation() {
    let serving = live_run();
    let asked = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}.judge",
            fixture_run::RUN_ID,
            fixture_run::LIVE_CONVERSATION_ID
        ),
    );
    assert_eq!(asked.status, 404, "{}", asked.body);
    assert_eq!(
        asked.json()["error"]["code"],
        json!("conversation_not_found")
    );

    let spans = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::REDIRECTED_NODE_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone();
    assert!(
        spans.iter().any(
            |span| span["reference"]["value"] == json!(fixture_run::REDIRECTED_CONVERSATION_ID)
        ),
        "the dispatch itself is still drawn: {spans:?}"
    );
    assert!(
        !spans.iter().any(|span| {
            span["transport_role"] == json!("judge")
                || span["reference"]["value"]
                    .as_str()
                    .is_some_and(|value| value.ends_with(".judge"))
        }),
        "a running dispatch has no judge lane to draw: {spans:?}"
    );
}

/// A judge lane the run never closed is served with an absent end, and the
/// conclusion beside it is served whole however long it is.
#[test]
fn a_judge_lane_the_run_never_closed_is_served_open_and_its_conclusion_whole() {
    const STREAM: &str = "node-scope-1786925519777-3163777";
    const SESSION: &str = "node-scope-1786925519777-3163777.worker";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                // A lifecycle node's step, which its judge has to be addressable
                // by and not by the node alone.
                "step": "build",
                "member": "worker",
                "persona": "pr-author",
                "session": SESSION,
            }),
            json!({ "turn": 1 }),
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:09.000Z",
                artifact: "report-node-scope-1786925519777-3163777",
                report: &unclosed_judge_report(),
            },
            fixture_run::Produced::Report,
        );
    });

    let spans = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::SHIP_NODE_ID
        ),
    )
    .json()["spans"]
        .as_array()
        .expect("spans")
        .clone();
    let at = |id: String| {
        spans
            .iter()
            .position(|span| span["id"] == json!(id))
            .unwrap_or_else(|| panic!("no span `{id}` among {spans:?}"))
    };
    // The pairing a client gathers: a judge sibling straight after the *worker*
    // dispatch it supervised, in the same scope.
    let worker = at(format!("dispatch.{SESSION}"));
    let supervising = at(format!("dispatch.{SESSION}.judge"));
    assert_eq!(supervising, worker + 1, "{spans:?}");
    assert_eq!(spans[worker]["agent_role"], json!("worker"));
    let lane = spans[supervising].clone();
    // A run of this host's shape: the worker's judge is in the worker's lane,
    // under the member word the node graph declared, and is the judge side of
    // it by its transport alone.
    assert_eq!(lane["agent_role"], json!("worker"), "{lane}");
    assert_eq!(lane["transport_role"], json!("judge"));
    assert_eq!(lane["dispatch_id"], spans[worker]["dispatch_id"]);
    assert_eq!(lane["started_at"], json!("2026-08-07T12:01:00.000Z"));
    assert_eq!(lane["step_id"], json!("build"), "the step it supervised");
    // The run observed no end for the judge's second turn, so the lane is open —
    // never given an invented end, and never closed at the turn before it.
    assert_eq!(lane["ended_at"], json!(null), "{lane}");

    let supervised = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}.judge",
            fixture_run::RUN_ID
        ),
    )
    .json();
    assert_eq!(supervised["attribution"]["agentRole"], json!("worker"));
    assert_eq!(supervised["attribution"]["transportRole"], json!("judge"));
    assert_eq!(
        supervised["attribution"]["stepId"],
        json!("build"),
        "a lifecycle node's judge is addressable by the step it ran under"
    );
    let turns = supervised["conversation"]["turns"]
        .as_array()
        .expect("the judge's turns")
        .clone();
    assert_eq!(turns.len(), 3, "{turns:?}");
    assert_eq!(turns[0]["durationMs"], json!(2_000));
    assert_eq!(turns[0]["model"], json!("gpt-5-codex"));
    // No cost, because codex reports none: an absence, never a zero.
    assert_eq!(turns[0]["usage"]["costUsd"], json!(null));
    assert_ne!(turns[0]["usage"]["costUsd"], json!(0));
    assert_eq!(turns[1]["startedAt"], json!("2026-08-07T12:01:05.000Z"));
    assert_eq!(turns[1]["finishedAt"], json!(null), "never observed");
    // And the turn the report attributes no invocation to keeps the bounds it
    // does hold and claims none of the figures it does not.
    assert_eq!(turns[1]["durationMs"], json!(null));
    assert_eq!(turns[1]["model"], json!(null));
    assert_eq!(turns[1]["harness"], json!(""));
    assert_eq!(turns[1]["status"], json!("unknown"));
    assert_eq!(turns[1]["usage"], json!({}));

    // And the conclusion is served whole rather than bounded as an artifact is.
    let closing = &turns[2];
    let assessment = closing["assistant"].as_str().expect("the assessment");
    assert!(
        assessment.len() > VERBOSE_ASSESSMENT_BYTES,
        "cut short at {} bytes",
        assessment.len()
    );
    assert!(
        assessment.ends_with("and that is the whole of it."),
        "{closing}"
    );
    assert_eq!(
        closing["unknown"]["verdicts"]
            .as_array()
            .map(Vec::len)
            .expect("the verdicts"),
        VERBOSE_CRITERIA
    );
    assert_eq!(closing["unknown"]["stoppedEarly"], json!(true));
}

/// How many criteria the verbose report rules on, and how long an assessment it
/// closes with: past the 64 KiB this API bounds an *artifact's* bytes by.
const VERBOSE_CRITERIA: usize = 40;
const VERBOSE_ASSESSMENT_BYTES: usize = 64 * 1024;

/// A report whose judge ran twice, whose second turn was never observed to
/// finish, and whose conclusion is longer than one screen, in onejudge's own
/// types.
fn unclosed_judge_report() -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, JudgeKind, JudgeValue, JudgeVerdict, Message,
        NamedVerdict, PartyTelemetry, Report, SessionLink, Telemetry, TelemetryRole, Transcript,
        Usage,
    };

    let usage = Usage {
        input_tokens: Some(64),
        output_tokens: Some(12),
        cache_read_tokens: None,
        cache_write_tokens: None,
        // A provider that reports no cost, which must not read as a zero.
        cost_usd: None,
    };
    let candidate = |ms| CandidateAttempt {
        harness: "codex".into(),
        harness_id: "codex:default".into(),
        variant: None,
        model: Some("gpt-5-codex".into()),
        status: "ok".into(),
        available: true,
        ran: true,
        failure_kind: None,
        failure_kind_source: None,
        exit_code: Some(0),
        duration_ms: Some(ms),
        error: None,
        session_id: None,
        history_id: None,
        usage: Some(usage.clone()),
    };
    let attributed = |turn_index, ms| HarnessAttribution {
        role: TelemetryRole::Judge,
        turn_index,
        ran: Some("codex:default".into()),
        fell_through: Vec::new(),
        candidates: vec![candidate(ms)],
        history_file: None,
        judge: None,
    };
    let mut assessment = String::new();
    while assessment.len() <= VERBOSE_ASSESSMENT_BYTES {
        assessment.push_str(
            "The dispatch was read against every criterion it was given, and the \
             reading is recorded here in full rather than summarised. ",
        );
    }
    assessment.push_str("and that is the whole of it.");

    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user("Land the wire contract."),
                Message::assistant("The route table is landed."),
            ],
        },
        verdicts: (0..VERBOSE_CRITERIA)
            .map(|index| {
                NamedVerdict::new(
                    format!("the route table answers request {index}"),
                    JudgeKind::Boolean,
                    JudgeVerdict {
                        value: JudgeValue::Bool(index % 2 == 0),
                        reason: format!("request {index} was read end to end"),
                        usage: None,
                    },
                )
            })
            .collect(),
        assessment: Some(assessment),
        completion_reason: None,
        settled_reason: Some("a streaming sink asked to stop".into()),
        judge_decisions: Vec::new(),
        usage: Some(usage.clone()),
        telemetry: Some(Telemetry {
            wall_ms: 12_000,
            agent: PartyTelemetry::default(),
            judge: PartyTelemetry {
                usage: Some(usage.clone()),
                ..PartyTelemetry::default()
            },
            orchestration_ms: 40,
            sessions: vec![
                SessionLink {
                    session_id: "01a02f4c-685b-75e2-8281-e8937fd20d47".into(),
                    role: TelemetryRole::Judge,
                    turn_index: 1,
                    started_at: "2026-08-07T12:01:00.000Z".into(),
                    finished_at: Some("2026-08-07T12:01:02.000Z".into()),
                    history_id: None,
                    judge: None,
                },
                // The end nobody observed, which leaves the lane open.
                SessionLink {
                    session_id: "01a02f4f-6168-72d1-b946-2251794e2fce".into(),
                    role: TelemetryRole::Judge,
                    turn_index: 2,
                    started_at: "2026-08-07T12:01:05.000Z".into(),
                    finished_at: None,
                    history_id: None,
                    judge: None,
                },
            ],
            // One attribution for two links: the second invocation reported a
            // session and a start, and no candidate is attributed to it.
            attribution: vec![attributed(1, 2_000)],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
        stopped_early: true,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// A stored report whose session bounds are not timestamps is refused where it is
/// read, rather than served as a turn's clock.
///
/// A `SessionLink` spells both of its bounds as a plain string, so a report can
/// deserialize and version cleanly and still say a turn started at
/// `in the second turn`. Those two values are served as a judge turn's
/// `startedAt` and `finishedAt` and folded into the interval its lane is drawn
/// over — so one this crate cannot order is a duration no client can compute and
/// an ordering it renders wrong, which is worse than the absence the wire already
/// has a spelling for.
///
/// Both bounds, because two different readings reach them: the interval parses
/// what it folds, and the turn serves what it was given. The run still holds each
/// copy — the artifact route serves its bytes — so this is a refusal at the read
/// and not a file that is not there.
#[test]
fn a_report_whose_session_bounds_are_not_timestamps_is_refused() {
    const OPENED: &str = "node-scope-1786925519888-3163881";
    const CLOSED: &str = "node-scope-1786925519888-3163882";
    // The report the readable judge journey uses, restamped one value at a time:
    // what this asserts is the bound and not a shape this crate dislikes.
    let restamped = |mutate: fn(&mut Value)| {
        let mut document: Value =
            serde_json::from_str(&unclosed_judge_report()).expect("the report parses");
        mutate(&mut document);
        format!("{document}\n")
    };
    // A start that is not an instant, on a row beside one that is: the lane still
    // opens, and the turn would carry the word.
    let unstamped_start = restamped(|document| {
        document["telemetry"]["sessions"][1]["started_at"] = json!("in the second turn");
    });
    // And an end that is not an instant, which the interval already declines to
    // fold and the turn would serve anyway.
    let unstamped_end = restamped(|document| {
        document["telemetry"]["sessions"][0]["finished_at"] = json!("a couple of seconds later");
    });

    let reports = [(OPENED, unstamped_start), (CLOSED, unstamped_end)];
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        for &(stream, ref report) in &reports {
            fixture_run::append_relayed(
                &dir,
                "agentgraph",
                "turn-started",
                json!({
                    "run_id": fixture_run::RUN_ID,
                    "node": fixture_run::SHIP_NODE_ID,
                    "member": "worker",
                    "persona": "pr-author",
                    "session": format!("{stream}.worker"),
                }),
                json!({ "turn": 1 }),
            );
            fixture_run::settle_member(
                &dir,
                &fixture_run::SettledMember {
                    stream,
                    node: fixture_run::SHIP_NODE_ID,
                    member: "worker",
                    at: "2026-08-07T12:01:10.000Z",
                    artifact: &format!("report-{stream}"),
                    report: report.as_str(),
                },
                fixture_run::Produced::Report,
            );
        }
    });

    for &(stream, ref report) in &reports {
        let session = format!("{stream}.worker");
        // The run holds the copy: this is a report that was refused, not one that
        // is missing.
        let stored = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/artifacts/report-{stream}",
                fixture_run::RUN_ID
            ),
        );
        assert_eq!(stored.status, 200, "{}", stored.body);
        let bytes = stored.json()["content"]
            .as_str()
            .expect("the tail")
            .to_owned();
        assert!(report.ends_with(&bytes), "{bytes}");

        // No judge conversation is served from a report whose clock cannot be
        // read, so neither bound reaches the wire.
        let supervised = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/conversations/{session}.judge",
                fixture_run::RUN_ID
            ),
        );
        assert_eq!(supervised.status, 404, "{}", supervised.body);
        assert_eq!(
            supervised.json()["error"]["code"],
            json!("conversation_not_found")
        );
        assert!(
            !supervised.body.contains("in the second turn")
                && !supervised.body.contains("a couple of seconds later"),
            "{}",
            supervised.body
        );

        // And the dispatch it supervised reads as the journal relayed it, which
        // is where an unreadable report leaves every other reading too.
        let turns = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/conversations/{session}",
                fixture_run::RUN_ID
            ),
        )
        .json()["conversation"]["turns"]
            .as_array()
            .expect("the transcript")
            .clone();
        assert_eq!(turns.len(), 1, "the relayed turn, not the report's");
        assert_eq!(turns[0]["startedAt"], json!(null), "{turns:?}");
        assert_eq!(turns[0]["finishedAt"], json!(null), "{turns:?}");
        assert_eq!(turns[0]["durationMs"], json!(null), "{turns:?}");

        // Nor is a lane drawn from bounds nothing could order.
        let spans = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/timeline?scope=node&node={}",
                fixture_run::RUN_ID,
                fixture_run::SHIP_NODE_ID
            ),
        )
        .json()["spans"]
            .as_array()
            .expect("spans")
            .clone();
        assert!(
            !spans
                .iter()
                .any(|span| span["id"] == json!(format!("dispatch.{session}.judge"))),
            "{spans:?}"
        );
    }
}

/// A turn whose reply never came reads as having captured none.
///
/// The prompt is still the turn's, and so are the tokens and the time its own
/// invocation spent on it — a turn that produced no prose is not a turn that
/// produced nothing.
#[test]
fn a_turn_whose_report_recorded_no_reply_is_served_as_having_recorded_none() {
    const STREAM: &str = "node-scope-1786925518444-3163999";
    const SESSION: &str = "node-scope-1786925518444-3163999.worker";
    const PROMPT: &str = "Now run the gate.";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        for turn in [1, 2] {
            fixture_run::append_relayed(
                &dir,
                "agentgraph",
                "turn-started",
                json!({
                    "run_id": fixture_run::RUN_ID,
                    "node": fixture_run::SHIP_NODE_ID,
                    "member": "worker",
                    "persona": "pr-author",
                    "session": SESSION,
                }),
                json!({ "turn": turn }),
            );
        }
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:01.000Z",
                artifact: "report-node-scope-1786925518444-3163999",
                report: &unanswered_report(PROMPT),
            },
            fixture_run::Produced::Report,
        );
    });

    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 2, "{turns:?}");
    assert_eq!(turns[0]["assistant"], json!("The route table is landed."));
    // The turn that recorded no reply: the prompt it was given, an explicit
    // absence where the prose would be, and the measurements it still made.
    assert_eq!(turns[1]["user"], json!(PROMPT));
    assert_eq!(turns[1]["assistant"], json!(null));
    assert_eq!(turns[1]["usage"]["costUsd"], json!(2.5));
    assert_eq!(turns[1]["durationMs"], json!(4_200));
}

/// A session whose member has not settled is served from what its own records
/// published, which is not the same as being served empty.
#[test]
fn a_session_with_no_stored_report_is_served_as_the_journal_relayed_it() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::LIVE_CONVERSATION_ID
        ),
    )
    .json();
    let turns = body["conversation"]["turns"].as_array().expect("the turns");
    assert!(!turns.is_empty(), "an unsettled session still has turns");
    // What the journal relayed while the turn ran: the instruction it is
    // answering, the words it published for it, and the summary of the call it
    // made. The observation that call returned is not here because this harness
    // published none — a `tool_use` with no `tool_result` after it.
    assert_eq!(turns[0]["user"], json!(fixture_run::LIVE_INSTRUCTION));
    assert_eq!(turns[0]["assistant"], json!("opened the change request"));
    assert_eq!(turns[0]["tools"][0]["name"], json!("Bash"));
    assert_eq!(turns[0]["tools"][0]["output"], json!(null));
    assert_eq!(turns[0]["durationMs"], json!(800));
    // And never the persona in place of the prompt: who was asked is not what
    // they were asked.
    let persona = body["attribution"]["persona"]
        .as_str()
        .expect("the dispatch's persona");
    for turn in turns {
        assert_ne!(turn["user"], json!(persona), "{turn}");
    }
}

/// A settlement whose report the run never kept leaves the transcript as the
/// journal relayed it, rather than emptying it.
///
/// `retain` refuses a symlink standing where the report should be, so the member
/// settled, the artifact was recorded, and no copy exists to read. That is a real
/// state and it is not "the session recorded nothing" — the turns the journal did
/// relay are still the turns a reader opens.
#[test]
fn a_settlement_whose_report_the_run_never_kept_still_serves_its_relayed_turns() {
    const STREAM: &str = "node-scope-1786925518555-3163111";
    const SESSION: &str = "node-scope-1786925518555-3163111.worker";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "pr-author",
                "session": SESSION,
            }),
            json!({ "turn": 1 }),
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:02.000Z",
                artifact: "report-node-scope-1786925518555-3163111",
                report: &unanswered_report("Now run the gate."),
            },
            fixture_run::Produced::SymlinkToReport,
        );
    });

    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(turns[0]["status"], json!("turn-started"));
    // Nothing the report would have filled, and nothing borrowed from it either.
    assert_eq!(turns[0]["user"], json!(""));
    assert_eq!(turns[0]["assistant"], json!(null));
    assert_eq!(turns[0]["durationMs"], json!(null));
    assert_eq!(turns[0]["startedAt"], json!(null));
}

/// A retained report this crate cannot read as one leaves both readings of it
/// where a missing report leaves them.
///
/// The run *does* hold the copy — the artifact route serves its bytes — so this
/// is a parse that failed rather than a file that is not there, which are two
/// different facts about the host and must not become two different answers on
/// the wire. The transcript stays the turns the journal relayed, and the time the
/// party's invocations took stays absent rather than becoming a zero.
#[test]
fn a_retained_report_this_crate_cannot_read_leaves_the_transcript_and_the_clock_alone() {
    const STREAM: &str = "node-scope-1786925518666-3163222";
    const SESSION: &str = "node-scope-1786925518666-3163222.worker";
    const ARTIFACT: &str = "report-node-scope-1786925518666-3163222";
    // Valid JSON, and not a report: no `transcript`, which is the one field a
    // reader of one cannot do without.
    let unreadable = report_document("the acceptance criteria were met");

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "pr-author",
                "session": SESSION,
            }),
            json!({ "turn": 1 }),
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:03.000Z",
                artifact: ARTIFACT,
                report: &unreadable,
            },
            fixture_run::Produced::Report,
        );
    });

    // The run holds the copy: this is a document that is not a report, not a
    // report that is not there.
    let stored = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/artifacts/{ARTIFACT}", fixture_run::RUN_ID),
    );
    assert_eq!(stored.status, 200, "{}", stored.body);
    assert_eq!(stored.json()["content"], json!(unreadable));

    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 1, "the relayed turn, not an empty transcript");
    assert_eq!(turns[0]["user"], json!(""));
    assert_eq!(turns[0]["assistant"], json!(null));
    assert_eq!(turns[0]["durationMs"], json!(null));
}

/// A report written under a contract newer than the one this binary links is
/// refused, rather than read as though the fields it shares still mean the same.
///
/// The version is what says whether the rest of the document means what a reader
/// thinks it does, so a transcript it cannot vouch for is served as the journal
/// relayed it — the same answer a missing report gets, because "this reader
/// cannot read it" is one fact however it came about.
#[test]
fn a_report_written_under_a_newer_contract_than_this_binary_links_is_refused() {
    const STREAM: &str = "node-scope-1786925518777-3163333";
    const SESSION: &str = "node-scope-1786925518777-3163333.worker";
    // The same report the readable journeys use, restamped: one field moved, so
    // what this asserts is the version check and not a shape this crate dislikes.
    let mut document: Value =
        serde_json::from_str(&unanswered_report("Now run the gate.")).expect("the report parses");
    let linked = document["schema_version"].as_u64().expect("a version");
    document["schema_version"] = json!(linked + 1);
    let ahead = format!("{document}\n");

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "pr-author",
                "session": SESSION,
            }),
            json!({ "turn": 1 }),
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:04.000Z",
                artifact: "report-node-scope-1786925518777-3163333",
                report: &ahead,
            },
            fixture_run::Produced::Report,
        );
    });

    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 1, "the relayed turn, not the report's");
    assert_eq!(turns[0]["user"], json!(""), "{turns:?}");
    assert_eq!(turns[0]["assistant"], json!(null), "{turns:?}");
    assert_eq!(turns[0]["durationMs"], json!(null), "{turns:?}");
    // And the timing beside it, which reads the same document through the same
    // check: the party whose only report is ahead of this reader stays unmeasured.
    let timing = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json()["run"]["timing"]
        .clone();
    assert_eq!(timing["agent_model_ms"], json!(null), "{timing}");
}

/// A stored report at the version this host's runs carry, and one behind it, are
/// both read — which is the other half of the refusal above.
///
/// The refusal is only correct while it is a refusal of documents *ahead* of the
/// linked contract. Tightened to equality it would refuse every report written
/// before this binary was built, which on a host that has been running a while is
/// most of them, and each one would fall out of the report-backed transcript into
/// the journal's — the same defect the version pin caused, arrived at from the
/// other side. So both directions are driven: the numbers here are literals
/// rather than the linked constant, because a test that restates the constant
/// cannot tell a reader that moved from a contract that did.
#[test]
fn a_report_at_or_behind_the_linked_contract_is_read() {
    /// The version onejudge stamped when this crate linked its 0.4, and what a
    /// member that settled under that build left behind.
    const BEHIND: u64 = 9;
    /// The version the reports on the host this server was written for carry, and
    /// the one this repository's own fixtures are stamped with. A binary linking
    /// a judge library older than this reads none of them.
    const STORED: u64 = 11;

    assert!(
        u64::from(onejudge::SCHEMA_VERSION) >= STORED,
        "the linked judge library declares {}, which is behind the reports this host stores",
        onejudge::SCHEMA_VERSION
    );

    for (version, stream, node) in [
        (BEHIND, "node-scope-1786925518888-3163444", "worker"),
        (STORED, "node-scope-1786925518999-3163555", "worker"),
    ] {
        let session = format!("{stream}.{node}");
        let mut document: Value = serde_json::from_str(&unanswered_report("Now run the gate."))
            .expect("the report parses");
        document["schema_version"] = json!(version);
        if version == BEHIND {
            // What a report written under that contract really looks like: the
            // pair onejudge added in 11 is not a key it could have carried.
            let fields = document.as_object_mut().expect("a mapping");
            fields.remove("supervisor_control");
            fields.remove("supervisor_control_unavailable");
        }
        let stored = format!("{document}\n");

        let serving = Serving::start(|root| {
            let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
            fixture_run::append_relayed(
                &dir,
                "agentgraph",
                "turn-started",
                json!({
                    "run_id": fixture_run::RUN_ID,
                    "node": fixture_run::SHIP_NODE_ID,
                    "member": node,
                    "persona": "pr-author",
                    "session": session,
                }),
                json!({ "turn": 1 }),
            );
            fixture_run::settle_member(
                &dir,
                &fixture_run::SettledMember {
                    stream,
                    node: fixture_run::SHIP_NODE_ID,
                    member: node,
                    at: "2026-08-07T12:01:05.000Z",
                    artifact: "report-stored",
                    report: &stored,
                },
                fixture_run::Produced::Report,
            );
        });

        let turns = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/conversations/{session}",
                fixture_run::RUN_ID
            ),
        )
        .json()["conversation"]["turns"]
            .as_array()
            .expect("the transcript")
            .clone();
        // The report's own turns, not the journal's one empty row: the prompt the
        // simulated user gave, and the reply the agent wrote.
        assert!(
            turns.len() > 1,
            "a report stamped {version} was not read: {turns:?}"
        );
        assert_eq!(
            turns[0]["user"],
            json!("Land the wire contract."),
            "a report stamped {version} was not read: {turns:?}"
        );
        assert_eq!(
            turns[0]["assistant"],
            json!("The route table is landed."),
            "a report stamped {version} was not read: {turns:?}"
        );
        let unanswered = turns.last().expect("a turn");
        assert_eq!(unanswered["user"], json!("Now run the gate."), "{turns:?}");
        // And what only the report holds: what that turn's own invocation spent
        // and how long it took, off the attribution candidate that ran.
        assert_eq!(unanswered["usage"]["inputTokens"], json!(11), "{turns:?}");
        assert_eq!(unanswered["durationMs"], json!(4_200), "{turns:?}");
    }
}

/// A report whose last turn was never answered, in onejudge's own types.
fn unanswered_report(prompt: &str) -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, Message, PartyTelemetry, Report, Telemetry,
        TelemetryRole, Transcript, Usage,
    };

    let usage = Usage {
        input_tokens: Some(11),
        output_tokens: Some(22),
        cache_read_tokens: None,
        cache_write_tokens: None,
        cost_usd: Some(2.5),
    };
    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            // A system preamble opens no turn and answers none: it is neither
            // party's, so the turn after it is still turn 1 and the numbering the
            // attribution joins on is unmoved.
            messages: vec![
                Message {
                    role: onejudge::Role::System,
                    content: "You are reviewing a wire contract.".into(),
                    events: Vec::new(),
                },
                Message::user("Land the wire contract."),
                Message::assistant("The route table is landed."),
                Message::user(prompt),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: None,
        settled_reason: Some("the supervisor named no next instruction".into()),
        judge_decisions: Vec::new(),
        usage: Some(usage.clone()),
        telemetry: Some(Telemetry {
            wall_ms: 9_000,
            agent: PartyTelemetry::default(),
            judge: PartyTelemetry::default(),
            orchestration_ms: 10,
            sessions: Vec::new(),
            attribution: vec![HarnessAttribution {
                role: TelemetryRole::Agent,
                turn_index: 2,
                ran: Some("claude-code:default".into()),
                fell_through: Vec::new(),
                candidates: vec![CandidateAttempt {
                    harness: "claude-code".into(),
                    harness_id: "claude-code:default".into(),
                    variant: None,
                    model: None,
                    status: "ok".into(),
                    available: true,
                    ran: true,
                    failure_kind: None,
                    failure_kind_source: None,
                    exit_code: Some(0),
                    duration_ms: Some(4_200),
                    error: None,
                    session_id: None,
                    history_id: None,
                    usage: Some(usage),
                }],
                history_file: None,
                judge: None,
            }],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// A report written under an *older* contract than this binary links is still
/// read.
///
/// The refusal beside it is one-sided on purpose: onejudge bumps its version for
/// an added field, so every report stored before the running binary was built is
/// older than it, and a reader that demanded equality would blank the transcript
/// of every dispatch that had already finished.
#[test]
fn a_report_written_under_an_older_contract_is_still_read() {
    const SESSION: &str = "node-scope-1786925518888-3163444.worker";
    let mut document: Value =
        serde_json::from_str(&unanswered_report("Now run the gate.")).expect("the report parses");
    let linked = document["schema_version"].as_u64().expect("a version");
    assert!(linked > 0, "there is an older contract to be written under");
    document["schema_version"] = json!(linked - 1);

    let turns = transcript_of(
        SESSION,
        "node-scope-1786925518888-3163444",
        &format!("{document}\n"),
    );
    // Two: the turn the journal opened, and the one the report holds and no
    // record of the run ever named — a prompt whose reply never came is a turn
    // with no reply rather than a turn nobody is shown.
    assert_eq!(turns.len(), 2, "{turns:?}");
    assert_eq!(turns[0]["user"], json!("Land the wire contract."));
    assert_eq!(turns[0]["assistant"], json!("The route table is landed."));
    assert_eq!(turns[1]["user"], json!("Now run the gate."));
    assert_eq!(turns[1]["assistant"], json!(null), "{turns:?}");
    assert_eq!(turns[1]["usage"]["costUsd"], json!(2.5), "{turns:?}");
}

/// A reply with no prompt before it is still the agent's turn.
///
/// A transcript alternates, and a report that does not is a report about a
/// dispatch that did not — the reply is served as the turn it is, with an empty
/// prompt, rather than joining the turn before it or vanishing.
#[test]
fn a_reply_with_no_prompt_before_it_opens_a_turn_of_its_own() {
    const SESSION: &str = "node-scope-1786925518999-3163555.worker";
    let turns = transcript_of(
        SESSION,
        "node-scope-1786925518999-3163555",
        &report_of(&[("assistant", "Picking up where the last dispatch left off.")]),
    );
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(turns[0]["user"], json!(""), "no prompt was recorded");
    assert_eq!(
        turns[0]["assistant"],
        json!("Picking up where the last dispatch left off.")
    );
}

/// A summary relayed before the session relayed any turn joins the first turn it
/// does relay.
///
/// It was published from inside a turn whose start never reached the journal, and
/// dropping it would lose the only record that the turn happened at all.
#[test]
fn a_summary_relayed_before_any_turn_joins_the_first_turn_relayed() {
    const SESSION: &str = "node-scope-1786925519111-3163666.worker";
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let labels = json!({
            "run_id": fixture_run::RUN_ID,
            "node": fixture_run::SHIP_NODE_ID,
            "member": "worker",
            "persona": "pr-author",
            "session": SESSION,
        });
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-activity",
            labels.clone(),
            json!({
                "kind": "tool_use",
                "name": "Read",
                "detail": "AGENTS.md",
                "truncated": false,
            }),
        );
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            labels.clone(),
            json!({ "turn": 1 }),
        );
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-activity",
            labels,
            json!({
                "kind": "tool_use",
                "name": "Edit",
                "detail": "src/payload.rs",
                "truncated": false,
            }),
        );
    });
    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 1, "{turns:?}");
    let tools = turns[0]["tools"].as_array().expect("the turn's tools");
    assert_eq!(tools.len(), 2, "neither summary was dropped: {tools:?}");
    assert_eq!(tools[0]["name"], json!("Read"), "in the order relayed");
    assert_eq!(tools[0]["index"], json!(0));
    assert_eq!(tools[1]["name"], json!("Edit"));
    assert_eq!(tools[1]["index"], json!(1));
}

/// What each judge of a stacked panel decided is served on the turn it judged,
/// and on no other.
///
/// The report is read back through the artifact route first, so this journey
/// cannot go on passing after the stored document has stopped being a schema-12
/// report carrying two judges' decisions. The transcript is then read off the
/// conversation route and off the detail beside it, which are one fold.
#[test]
fn each_judge_of_a_stacked_panel_is_served_on_the_turn_it_judged() {
    let serving = two_runs();

    let stored = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/{}",
            fixture_run::RUN_ID,
            fixture_run::WORKER_REPORT_ARTIFACT
        ),
    )
    .json();
    assert_eq!(stored["truncated"], json!(false), "{stored}");
    let report: Value = serde_json::from_str(stored["content"].as_str().expect("the bytes"))
        .expect("the stored report parses");
    assert_eq!(report["schema_version"], json!(12), "{report}");
    let judged = report["judge_decisions"]
        .as_array()
        .expect("the report's judge decisions");
    assert_eq!(judged.len(), 1, "{report}");
    assert_eq!(judged[0]["decisions"].as_array().map(Vec::len), Some(2));

    let expected: Vec<Value> = fixture_run::PANEL_DECISIONS
        .iter()
        .map(|(judge, kind, decision, reason)| {
            json!({
                "judge": judge,
                "kind": kind,
                "decision": decision.as_str(),
                "reason": reason,
            })
        })
        .collect();
    let conversation = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::RUN_ID,
            fixture_run::CONVERSATION_ID
        ),
    )
    .json();
    let detail = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}?include_conversations=true",
            fixture_run::RUN_ID
        ),
    )
    .json();
    let listed = detail["conversations"]
        .as_array()
        .expect("the detail's transcripts")
        .iter()
        .find(|listed| listed["conversation"]["id"] == json!(fixture_run::CONVERSATION_ID))
        .expect("the worker's transcript in the detail")
        .clone();

    for served in [&conversation, &listed] {
        let turns = served["conversation"]["turns"]
            .as_array()
            .expect("the transcript");
        assert_eq!(turns.len(), 3, "{served}");
        for (index, turn) in turns.iter().enumerate() {
            if index + 1 == fixture_run::JUDGED_TURN {
                assert_eq!(turn["user"], json!(fixture_run::SECOND_PROMPT), "{turn}");
                assert_eq!(turn["judges"], json!(expected), "{turn}");
            } else {
                assert!(
                    turn.get("judges").is_none(),
                    "turn {} carries decisions made on another turn: {turn}",
                    index + 1
                );
            }
        }
    }
}

/// A journal carrying a `judge-decided` is read by every route that reads a
/// member's records, and each of them serves the record rather than refusing it.
///
/// The session has no settlement, so its row reads the decision off the journal
/// rather than off a report; and the record is the run's last, so the listing,
/// the detail and the stream's opening snapshot each name it as what the run
/// last did.
#[test]
fn a_journal_carrying_a_judges_decision_is_served_by_every_route() {
    /// The member whose session has no settlement on the relaying stream, so
    /// nothing but the journal can say what its judges decided.
    const MEMBER: &str = "engineer";
    const SESSION: &str = "a-recording-host-4243.engineer";
    const REASON: &str = "the dashboard renders, but nothing reads it at phone width";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let labels = json!({
            "run_id": fixture_run::RUN_ID,
            "node": fixture_run::SHIP_NODE_ID,
            "member": MEMBER,
            "persona": MEMBER,
        });
        let mut opened = labels.clone();
        opened["session"] = json!(SESSION);
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            opened,
            json!({
                "turn": 1,
                "role": "assistant",
                "instruction": "Build the dashboard view.",
                "started_at": "2026-08-07T12:01:00.000Z",
            }),
        );
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "judge-decided",
            labels,
            json!({
                "turn": 1,
                "judge": "reviewer",
                "kind": "oneharness",
                "decision": "continue",
                "reason": REASON,
            }),
        );
    });
    let decided = json!([{
        "judge": "reviewer",
        "kind": "oneharness",
        "decision": "continue",
        "reason": REASON,
    }]);

    for (template, path) in every_route_over(fixture_run::RUN_ID, SESSION, "artifact-long-log") {
        if template == onepipeline_ui::contract::routes::EVENTS {
            let mut stream = http::stream(serving.address, &path, None);
            assert_eq!(stream.status, 200, "{path}");
            let snapshot = stream.frames(1).remove(0).json();
            let row = snapshot["runs"]
                .as_array()
                .expect("the snapshot's rows")
                .iter()
                .find(|row| row["run_id"] == json!(fixture_run::RUN_ID))
                .cloned()
                .unwrap_or_else(|| panic!("{path} names the run: {snapshot}"));
            assert_eq!(row["last_event"], json!("judge-decided"), "{path}: {row}");
            continue;
        }
        if template == onepipeline_ui::contract::routes::RUN_WATCH {
            // A watch shows the decision as one of the run's meaningful events
            // only where the engine counts it as one; what it owes a run carrying
            // the record is to read it to the end and return.
            let mut stream = http::stream(serving.address, &path, None);
            assert_eq!(stream.status, 200, "{path}");
            let last = std::iter::from_fn(|| stream.next_frame())
                .last()
                .expect("a watch of no seconds returns");
            assert_eq!(last.event, "returned", "{path}: {last:?}");
            continue;
        }
        let response = http::get(serving.address, &path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        if template == onepipeline_ui::contract::routes::HEALTHZ {
            continue;
        }
        let body = response.json();
        assert_enveloped(&body);
        match template {
            onepipeline_ui::contract::routes::RUNS => {
                let row = body["runs"]
                    .as_array()
                    .expect("the rows")
                    .iter()
                    .find(|row| row["run_id"] == json!(fixture_run::RUN_ID))
                    .cloned()
                    .unwrap_or_else(|| panic!("{path} lists the run: {body}"));
                assert_eq!(row["last_event"], json!("judge-decided"), "{path}: {row}");
            }
            onepipeline_ui::contract::routes::RUN => {
                assert_eq!(body["run"]["last_event"], json!("judge-decided"), "{path}");
                let listed = body["conversations"]
                    .as_array()
                    .expect("the detail's transcripts")
                    .iter()
                    .find(|listed| listed["conversation"]["id"] == json!(SESSION))
                    .cloned()
                    .unwrap_or_else(|| panic!("{path} lists the session: {body}"));
                assert_eq!(
                    listed["conversation"]["turns"][0]["judges"], decided,
                    "{path}"
                );
            }
            onepipeline_ui::contract::routes::RUN_TIMELINE => {
                let listed = body["spans"]
                    .as_array()
                    .expect("the spans")
                    .iter()
                    .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
                    .any(|event| event["kind"] == json!("judge-decided"));
                assert!(listed, "{path} lists the decision: {body}");
            }
            onepipeline_ui::contract::routes::RUN_CONVERSATION => {
                let turns = body["conversation"]["turns"]
                    .as_array()
                    .expect("the transcript");
                assert_eq!(turns.len(), 1, "a decision is not a turn: {body}");
                assert_eq!(turns[0]["judges"], decided, "{path}");
            }
            // An artifact is a producer's bytes and never a listing of events:
            // what this route owes a run carrying the record is not to refuse it.
            _ => {}
        }
    }
}

/// Each judge of a stacked panel, as `(label, harness, model, cost)`, in the
/// order its telemetry is listed — the reviewer first, so a reading that joined a
/// judge row on its side and turn alone would find the reviewer's for both.
const STACKED_JUDGES: [(&str, &str, &str, f64); 2] = [
    ("reviewer", "codex", "gpt-5-codex", 0.5),
    ("lint", "claude-code", "claude-opus-5", 1.25),
];

/// Each judge of a stacked panel is served its own invocation, not the first
/// judge's.
///
/// A panel runs every judge on one supervisor turn, so their session rows and
/// attributions share a side and a turn number and differ only by onejudge's
/// `judge` label. The same report keeps a supervisor turn whose decision list is
/// empty, which the worker's transcript must serve as no `judges` at all.
#[test]
fn each_judge_of_a_stacked_panel_is_served_its_own_invocation() {
    const STREAM: &str = "node-scope-1786925519888-3163888";
    const SESSION: &str = "node-scope-1786925519888-3163888.worker";
    const ARTIFACT: &str = "report-node-scope-1786925519888-3163888";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "worker",
                "session": SESSION,
            }),
            json!({ "turn": 1 }),
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:09.000Z",
                artifact: ARTIFACT,
                report: &stacked_panel_report(),
            },
            fixture_run::Produced::Report,
        );
    });
    let conversation = |id: &str| {
        http::get(
            serving.address,
            &format!("/api/v2/runs/{}/conversations/{id}", fixture_run::RUN_ID),
        )
        .json()
    };

    let judged = conversation(&format!("{SESSION}.judge"));
    let turns = judged["conversation"]["turns"]
        .as_array()
        .expect("the judge's turns");
    // One bounded turn per judge's invocation, and the conclusion after them.
    assert_eq!(turns.len(), STACKED_JUDGES.len() + 1, "{judged}");
    for (turn, (label, harness, model, cost)) in turns.iter().zip(STACKED_JUDGES) {
        assert_eq!(turn["model"], json!(model), "{label}: {turn}");
        assert_eq!(
            turn["harness"],
            json!(format!("{harness}:default")),
            "{label}: {turn}"
        );
        assert_eq!(turn["usage"]["costUsd"], json!(cost), "{label}: {turn}");
        assert_eq!(
            turn["unknown"]["attribution"]["judge"],
            json!(label),
            "{label}: {turn}"
        );
    }
    assert_eq!(
        judged["conversation"]["harnesses"],
        json!(["codex", "claude-code"]),
        "{judged}"
    );

    // The stored report does keep a decision list for the worker's turn, and it is
    // empty — which the transcript serves as no `judges` key rather than `[]`.
    let stored = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/artifacts/{ARTIFACT}", fixture_run::RUN_ID),
    )
    .json();
    let report: Value = serde_json::from_str(stored["content"].as_str().expect("the bytes"))
        .expect("the stored report parses");
    assert_eq!(
        report["judge_decisions"],
        json!([{ "turn": 1, "decisions": [] }])
    );
    let worker = conversation(SESSION);
    let rows = worker["conversation"]["turns"]
        .as_array()
        .expect("the worker's turns");
    assert_eq!(rows.len(), 1, "{worker}");
    assert!(rows[0].get("judges").is_none(), "{worker}");
}

/// A report from a panel of [`STACKED_JUDGES`], both judging the worker's one
/// turn, with a decision list for that turn that recorded nothing.
fn stacked_panel_report() -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, JudgedTurn, Message, PartyTelemetry, Report,
        SessionLink, Telemetry, TelemetryRole, Transcript, Usage,
    };

    let usage = |cost| Usage {
        input_tokens: Some(64),
        output_tokens: Some(12),
        cache_read_tokens: None,
        cache_write_tokens: None,
        cost_usd: Some(cost),
    };
    let sessions = STACKED_JUDGES
        .iter()
        .enumerate()
        .map(|(index, (label, ..))| SessionLink {
            session_id: format!("01a03f4c-685b-75e2-8281-e8937fd20d4{index}"),
            role: TelemetryRole::Judge,
            turn_index: 1,
            started_at: format!("2026-08-07T12:01:0{index}.000Z"),
            finished_at: Some(format!("2026-08-07T12:01:0{}.500Z", index + 2)),
            history_id: None,
            judge: Some((*label).to_owned()),
        })
        .collect();
    let attribution = STACKED_JUDGES
        .iter()
        .map(|(label, harness, model, cost)| HarnessAttribution {
            role: TelemetryRole::Judge,
            turn_index: 1,
            ran: Some(format!("{harness}:default")),
            fell_through: Vec::new(),
            candidates: vec![CandidateAttempt {
                harness: (*harness).to_owned(),
                harness_id: format!("{harness}:default"),
                variant: None,
                model: Some((*model).to_owned()),
                status: "ok".into(),
                available: true,
                ran: true,
                failure_kind: None,
                failure_kind_source: None,
                exit_code: Some(0),
                duration_ms: Some(1_500),
                error: None,
                session_id: None,
                history_id: None,
                usage: Some(usage(*cost)),
            }],
            history_file: None,
            judge: Some((*label).to_owned()),
        })
        .collect();

    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user("Archive the release."),
                Message::assistant("Archived the release."),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: Some("every judge completed".into()),
        settled_reason: None,
        judge_decisions: vec![JudgedTurn {
            turn: 1,
            decisions: Vec::new(),
        }],
        usage: Some(usage(1.75)),
        telemetry: Some(Telemetry {
            wall_ms: 6_000,
            agent: PartyTelemetry::default(),
            judge: PartyTelemetry::default(),
            orchestration_ms: 40,
            sessions,
            attribution,
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// When [`transcript_of`]'s member settled, which is the only instant any run
/// holds for a turn its report kept and no bound was observed for.
const REPORT_SETTLED_AT: &str = "2026-08-07T12:01:05.000Z";

/// A settled member's transcript, from one relayed turn and the report it stored.
fn transcript_of(session: &str, stream: &str, report: &str) -> Vec<Value> {
    let stream = stream.to_owned();
    let labelled = session.to_owned();
    let report = report.to_owned();
    let serving = Serving::start(move |root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fixture_run::append_relayed(
            &dir,
            "agentgraph",
            "turn-started",
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "pr-author",
                "session": labelled,
            }),
            json!({ "turn": 1 }),
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: &stream,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: REPORT_SETTLED_AT,
                artifact: &format!("report-{stream}"),
                report: &report,
            },
            fixture_run::Produced::Report,
        );
    });
    http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{session}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone()
}

/// A report carrying exactly the messages named, in onejudge's own types.
fn report_of(messages: &[(&str, &str)]) -> String {
    use onejudge::{Message, PartyTelemetry, Report, Role, Telemetry, Transcript};

    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: messages
                .iter()
                .map(|(role, content)| Message {
                    role: match *role {
                        "user" => Role::User,
                        "assistant" => Role::Assistant,
                        other => panic!("{other} is not a message role onejudge declares"),
                    },
                    content: (*content).to_owned(),
                    events: Vec::new(),
                })
                .collect(),
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: None,
        settled_reason: None,
        judge_decisions: Vec::new(),
        usage: None,
        telemetry: Some(Telemetry {
            wall_ms: 1_000,
            agent: PartyTelemetry::default(),
            judge: PartyTelemetry::default(),
            orchestration_ms: 0,
            sessions: Vec::new(),
            attribution: Vec::new(),
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// A filter narrows the turns a transcript *lists* and never what each listed
/// turn was.
///
/// The invariant one level down from `a_filter_shapes_the_response_and_never_the
/// _run`: the events a transcript carries are a listing and are the filter's to
/// narrow, but a turn's own prompt, reply, tool observations, cost and clock come
/// from the settled member's stored report — which describes the dispatch, not
/// the reading of it. A reader who narrowed their attention sees fewer turns, and
/// every turn they do see says exactly what it said to a reader who asked for
/// everything.
#[test]
fn a_filter_narrows_the_turns_a_transcript_lists_and_never_what_each_one_was() {
    let serving = two_runs();
    let detail = |filter: &str| -> Value {
        http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}?include_conversations=true&filter={}",
                fixture_run::RUN_ID,
                urlencode(filter)
            ),
        )
        .json()
    };
    let transcript = |body: &Value| -> Vec<Value> {
        body["conversations"]
            .as_array()
            .expect("the transcripts")
            .iter()
            .find(|document| document["conversation"]["id"] == json!(fixture_run::CONVERSATION_ID))
            .expect("the dispatch's own transcript")["conversation"]["turns"]
            .as_array()
            .expect("its turns")
            .clone()
    };

    let wide = detail("detailed");
    // The records that opened the two turns the journal bracketed, excluded: they
    // are relayed envelopes, so a reader who excluded their kind is not shown the
    // turns they opened.
    let narrow = detail(r#"{"exclude":[{"kind":"turn-started"}]}"#);
    let all = transcript(&wide);
    let listed = transcript(&narrow);
    assert_eq!(all.len(), 3, "{all:?}");
    // One of the three: the turn the report alone holds, which no record of the
    // run names and which a filter therefore has nothing to rule on. The listing
    // narrows; what the report says the dispatch did does not.
    assert_eq!(listed.len(), 1, "the listing narrowed: {listed:?}");

    // And the turn still listed is the same turn, down to the fields only the
    // report can fill.
    assert_eq!(listed, all[2..].to_vec());
    assert_eq!(listed[0]["user"], json!(fixture_run::THIRD_PROMPT));
    assert_eq!(listed[0]["assistant"], json!(fixture_run::THIRD_REPLY));
    assert_eq!(
        listed[0]["usage"]["costUsd"],
        json!(fixture_run::UNRELAYED_COST)
    );
    assert_eq!(listed[0]["durationMs"], json!(fixture_run::UNRELAYED_MS));
    assert_eq!(
        listed[0]["tools"][1]["output"],
        json!(fixture_run::UNRELAYED_OBSERVATION)
    );
    // And the wide reading is unmoved, turn for turn.
    assert_eq!(all[0]["user"], json!(fixture_run::FIRST_PROMPT));
    assert_eq!(all[0]["assistant"], json!(fixture_run::FIRST_REPLY));
    assert_eq!(all[0]["usage"]["costUsd"], json!(29.71));
    assert_eq!(all[0]["durationMs"], json!(900));
    assert_eq!(
        all[0]["tools"][1]["output"],
        json!(fixture_run::TOOL_OBSERVATION)
    );
    assert_eq!(all[1]["usage"]["costUsd"], json!(1.51));

    // The fold beside them is the run's, not the reading's — including the one
    // this step re-sourced from the same reports the transcripts are filled from.
    assert_eq!(narrow["run"]["timing"], wide["run"]["timing"]);
    assert_eq!(narrow["run"]["usage"], wide["run"]["usage"]);
    assert_eq!(narrow["run"]["node_work_ms"], wide["run"]["node_work_ms"]);
}

/// The transcript one session of the lanes run serves, as a reader opens it.
fn lane_transcript(serving: &Serving, session: &str) -> Vec<Value> {
    http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{session}",
            fixture_run::LANES_RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone()
}

/// Every turn of a settled two-party dispatch, alternating the supervisor's
/// prompt with the agent's reply, for the whole of the conversation.
///
/// This is the reading an operator opens a run to do, and the one that was
/// broken: the transcript is what the agent and its supervisor actually said to
/// each other, and a reader who is shown one exchange and then silence — or the
/// agent's own words back on the user side — cannot use it for that at all.
///
/// The count is asserted against the report itself rather than against a number
/// written here, because the report is what the reading holds: three of these
/// turns are named by no envelope of the run and a reading that served only the
/// turns some record happened to name would drop them and still look ordered.
#[test]
fn a_settled_dispatch_serves_every_turn_of_the_conversation_it_really_had() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::SUPERVISED_CONVERSATION_ID);

    // What the source holds: the settling member's own report, counted by the
    // prompts it recorded.
    let report: Value =
        serde_json::from_str(&fixture_run::supervised_report()).expect("the stored report");
    let recorded = report["transcript"]["messages"]
        .as_array()
        .expect("the report's transcript")
        .iter()
        .filter(|message| message["role"] == json!("user"))
        .count();
    assert_eq!(turns.len(), recorded, "{turns:?}");
    assert!(
        recorded > usize::try_from(fixture_run::SUPERVISED_RELAYED).expect("a small count"),
        "the fixture no longer holds a turn the journal never named"
    );

    // And each of them is that turn: the prompt it answered, and the reply it
    // wrote. Read in order, so a transcript that served one turn twice or two
    // turns swapped fails on the text rather than only on the count.
    for (index, turn) in turns.iter().enumerate() {
        let number = u64::try_from(index + 1).expect("a small count");
        assert_eq!(
            turn["user"],
            json!(fixture_run::supervised_prompt(number)),
            "turn {number}: {turn}"
        );
        assert_eq!(
            turn["assistant"],
            json!(fixture_run::supervised_reply(number)),
            "turn {number}: {turn}"
        );
    }

    // The count beside the node is the same fold, so a reader who trusts it and
    // then opens the transcript is not shown a different conversation.
    let node = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::LANES_RUN_ID),
    )
    .json()["run"]["nodes"]
        .as_array()
        .expect("the rows")
        .iter()
        .find(|row| row["node"] == json!(fixture_run::SUPERVISED_NODE_ID))
        .expect("the supervised node")
        .clone();
    assert_eq!(node["turns"], json!(turns.len()));
}

/// No party's words, tools or accounting are served against the other party.
///
/// A two-party member relays both sides into one session and both number their
/// turns from 1. Reading the stored report by that number over both sides matched
/// every turn twice — the second copy attributing the agent's prompt and reply to
/// the supervisor — which is what an operator sees as the agent's reply appearing
/// on the user side of the conversation.
#[test]
fn a_settled_two_party_dispatch_serves_nothing_of_its_supervisor_as_a_turn() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::SUPERVISED_CONVERSATION_ID);

    let replies: Vec<Value> = turns.iter().map(|turn| turn["assistant"].clone()).collect();
    for (index, turn) in turns.iter().enumerate() {
        // The agent's reply is never served as anything's prompt — which is what
        // the supervisor's own `turn-started` carries, because the reply is the
        // message it was given to answer.
        assert!(
            !replies.contains(&turn["user"]),
            "turn {index} is served a reply as its prompt: {turn}"
        );
        // Nor is the supervisor's own invocation billed to a turn of the
        // transcript, nor its own tool call folded onto one.
        assert_ne!(
            turn["usage"]["costUsd"],
            json!(fixture_run::SUPERVISOR_COST),
            "turn {index}: {turn}"
        );
        assert_ne!(
            turn["usage"]["inputTokens"],
            json!(fixture_run::SUPERVISOR_INPUT_TOKENS),
            "turn {index}: {turn}"
        );
        assert!(
            !turn["tools"]
                .as_array()
                .expect("the turn's tool events")
                .iter()
                .any(|event| event["input"] == json!(fixture_run::SUPERVISOR_TOOL_DETAIL)),
            "turn {index} is served the supervisor's own call: {turn}"
        );
        // And each turn is measured by its own invocation rather than by the
        // dispatch's total over both sides.
        let number = u64::try_from(index + 1).expect("a small count");
        assert_eq!(
            turn["usage"]["costUsd"],
            json!(fixture_run::supervised_turn_cost(number)),
            "turn {number}: {turn}"
        );
    }
    assert!(
        turns
            .iter()
            .all(|turn| turn["usage"]["costUsd"] != json!(fixture_run::SUPERVISED_TOTAL_COST)),
        "the dispatch's own total is served on a turn: {turns:?}"
    );
}

/// A dispatch the run holds no readable report for is read from its own journal
/// records, and alternates exactly as a settled one does.
///
/// That reading is not a fallback nobody meets: a report exists only once a
/// member settles, so it is the whole of what the live run an operator is
/// watching has. It is joined by the pair of the turn number and the party, and
/// the count it serves is the number of turns the *agent* took — the supervisor's
/// own invocations beside them are the other half of those turns rather than
/// turns of their own.
#[test]
fn a_dispatch_with_no_readable_report_alternates_its_own_records() {
    let serving = lanes();
    let session = fixture_run::WORKING_CONVERSATION_ID;
    let turns = lane_transcript(&serving, session);

    // What the source holds, read off the run's own journal rather than restated
    // here: the distinct turns the agent's side of this session relayed.
    let journal = fs::read_to_string(
        serving
            .run_dir(fixture_run::LANES_RUN_ID)
            .join("events.jsonl"),
    )
    .expect("the run's journal");
    let mut relayed: Vec<u64> = journal
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| {
            event["labels"]["session"] == json!(session)
                && event["payload"]["role"] == json!("assistant")
                && (event["kind"] == json!("turn-started")
                    || event["kind"] == json!("turn-completed"))
        })
        .filter_map(|event| event["payload"]["turn"].as_u64())
        .collect();
    relayed.sort_unstable();
    relayed.dedup();
    assert!(!relayed.is_empty(), "the fixture relays no agent turn");
    // Nothing of this session settled, so no report can be what it is read from.
    assert!(
        !journal.lines().any(|line| {
            let event: Value = serde_json::from_str(line).unwrap_or(Value::Null);
            event["labels"]["member"] == json!("worker")
                && event["stream"] == json!(session.split('.').next().expect("the stream"))
                && (event["kind"] == json!("member-settled")
                    || event["kind"] == json!("member-died"))
        }),
        "the session under test settled, so it is not the reading this journey drives"
    );
    assert_eq!(turns.len(), relayed.len(), "{turns:?}");

    // The supervisor's words reach the reader as the prompt of the turn they
    // opened, and its own turn is not a row: every row is the agent's, with the
    // prompt it answered and the reply it wrote.
    assert_eq!(turns[0]["user"], json!(fixture_run::WORKING_INSTRUCTION));
    assert_eq!(turns[0]["assistant"], json!(fixture_run::WORKING_REPLY));
    assert_eq!(
        turns[1]["user"],
        json!(fixture_run::WORKING_NEXT_INSTRUCTION)
    );
    assert_eq!(turns[1]["assistant"], json!(fixture_run::WORKING_CUT_REPLY));
    let replies: Vec<Value> = turns.iter().map(|turn| turn["assistant"].clone()).collect();
    assert!(
        turns.iter().all(|turn| !replies.contains(&turn["user"])),
        "a reply is served as a prompt: {turns:?}"
    );
}

/// A dispatch still in flight is read from its own records, because nothing else
/// holds it: a report exists only once a member settles.
///
/// The turn that finished carries what it was asked, what it said, what its call
/// came back with, and that one turn's own cost and interval. The turn running
/// now carries everything but an end — which is the reading an operator
/// supervising hours of work they cannot watch actually needs.
#[test]
fn a_dispatch_still_in_flight_serves_what_its_turn_is_saying_and_spending() {
    let serving = lanes();
    let served = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{}",
            fixture_run::LANES_RUN_ID,
            fixture_run::WORKING_CONVERSATION_ID
        ),
    )
    .json();
    // No field is added by this reading and no vocabulary moves for it, so the
    // envelope carrying it declares the version every other route declares.
    assert_eq!(
        served["telemetry_schema_version"],
        json!(onepipeline_ui::contract::TELEMETRY_SCHEMA_VERSION)
    );
    let turns = lane_transcript(&serving, fixture_run::WORKING_CONVERSATION_ID);

    let finished = &turns[0];
    assert_eq!(finished["user"], json!(fixture_run::WORKING_INSTRUCTION));
    assert_eq!(finished["assistant"], json!(fixture_run::WORKING_REPLY));
    assert_eq!(
        finished["tools"][0]["output"],
        json!(fixture_run::WORKING_OBSERVATION)
    );
    // That one turn's own accounting, not the dispatch's total over both sides.
    assert_eq!(finished["usage"]["costUsd"], json!(0.42));
    assert_eq!(finished["usage"]["inputTokens"], json!(4_210));
    assert_eq!(finished["startedAt"], json!("2026-08-07T12:04:03.000Z"));
    assert_eq!(finished["finishedAt"], json!("2026-08-07T12:04:07.000Z"));
    assert_eq!(finished["durationMs"], json!(4_000));

    // The turn nothing has closed: opened, answered in part, and measured by
    // nothing yet. An unmeasured cost is absent rather than a zero a reader would
    // take for a measurement, and an end nobody observed is `null`.
    let running = turns.last().expect("the turn in flight");
    assert_eq!(running["status"], json!("turn-started"));
    assert_eq!(
        running["user"],
        json!(fixture_run::WORKING_NEXT_INSTRUCTION)
    );
    assert_eq!(running["assistant"], json!(fixture_run::WORKING_CUT_REPLY));
    assert_eq!(running["startedAt"], json!("2026-08-07T12:04:09.000Z"));
    assert_eq!(running["finishedAt"], json!(null));
    assert_eq!(running["durationMs"], json!(null));
    assert_eq!(running["usage"], json!({}), "{running}");
}

/// A turn the producer opened and closed is one turn, not two.
///
/// `oneagentgraph` describes one turn with two records, and reading each of them
/// as a turn of its own served the same turn twice — one instruction, one reply
/// and one interval, listed as two rows and plotted as two spans lying exactly
/// over each other, so the reader could hover or open neither. It doubled the
/// count beside the node at the same time, and handed a client two ids for the
/// one turn its timeline addresses.
///
/// So this drives the three surfaces that have to agree — the transcript, the
/// count beside the node, and the timeline's own reference to a turn — over a
/// session whose five relayed turn records on the agent's side describe two
/// turns. The supervisor's own three records describe neither of them.
#[test]
fn one_turn_is_one_row_however_many_records_describe_it() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::WORKING_CONVERSATION_ID);
    assert_eq!(turns.len(), 2, "{turns:?}");

    // No two of them stand over the same moment, which is what a plot of this
    // transcript draws as one span that cannot be reached under another.
    let mut bounds: Vec<&Value> = turns.iter().map(|turn| &turn["startedAt"]).collect();
    bounds.sort_by_key(|at| at.as_str().unwrap_or_default());
    bounds.dedup();
    assert_eq!(bounds.len(), turns.len(), "{turns:?}");

    // The count beside the node is the same reading: a reader who trusts it and
    // then opens the transcript must not find a different number of turns.
    let node = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::LANES_RUN_ID),
    )
    .json()["run"]["nodes"]
        .as_array()
        .expect("the rows")
        .iter()
        .find(|row| row["node"] == json!(fixture_run::WORKING_NODE_ID))
        .expect("the working node")
        .clone();
    assert_eq!(node["turns"], json!(turns.len()));

    // And both records of one turn address that one turn from the timeline: a
    // reader who opened the moment it closed and one who opened the moment it
    // began are handed the same row.
    let timeline = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::LANES_RUN_ID,
            fixture_run::WORKING_NODE_ID
        ),
    )
    .json();
    let addressed = |kind: &str, at: &str| -> Value {
        relayed(&timeline, kind)
            .into_iter()
            .find(|event| event["at"] == json!(at))
            .unwrap_or_else(|| panic!("a {kind} at {at}: {timeline}"))["id"]
            .clone()
    };
    let opened = addressed("turn-started", "2026-08-07T12:04:03.000Z");
    assert_eq!(
        opened,
        addressed("turn-completed", "2026-08-07T12:04:07.000Z")
    );
    assert_eq!(opened, turns[0]["id"]);
}

/// A turn is joined to its own records by the **pair** the producer numbers it
/// with, and never by the number alone — and the supervisor's side of that pair
/// is not a row of the transcript at all.
///
/// The two sides of a two-party member count their turns independently, so both
/// of these are turn 1: the agent's, and the supervisor's answering it. A reading
/// that joined on the number would put the supervisor's instruction and the
/// supervisor's cost on the agent's turn, which is the one figure an operator
/// deciding whether to let a dispatch keep running would act on. And serving the
/// supervisor's turn as a row of its own is the same defect wearing the other
/// face: its instruction *is* the agent's reply, so the row it produced showed an
/// operator the agent's words on the user side of the conversation.
#[test]
fn a_turn_is_joined_by_the_pair_the_producer_numbers_it_with() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::WORKING_CONVERSATION_ID);

    // The supervisor's own invocation reaches a reader as the prompt of the turn
    // it opened, and in no other way: not as a row, not as a reply, and not as a
    // figure on the agent's turn of the same number.
    assert!(
        turns
            .iter()
            .all(|turn| turn["user"] != json!(fixture_run::WORKING_REPLY)),
        "the agent's reply is served on the user side: {turns:?}"
    );
    assert!(
        turns
            .iter()
            .all(|turn| turn["usage"]["inputTokens"] != json!(51)
                && turn["usage"]["costUsd"] != json!(0.01)),
        "the supervisor's own accounting is served against a turn: {turns:?}"
    );
    assert_eq!(turns[0]["usage"]["inputTokens"], json!(4_210));
    assert_eq!(turns[0]["usage"]["costUsd"], json!(0.42));
    // What the supervisor said, on the turn it opened rather than on one of its
    // own: the transcript alternates its prompt with the agent's reply.
    assert_eq!(turns[0]["user"], json!(fixture_run::WORKING_INSTRUCTION));
    assert_eq!(turns[0]["assistant"], json!(fixture_run::WORKING_REPLY));
    assert_eq!(
        turns[1]["user"],
        json!(fixture_run::WORKING_NEXT_INSTRUCTION)
    );
    assert_eq!(turns[1]["assistant"], json!(fixture_run::WORKING_CUT_REPLY));
}

/// An observation is paired with the call the producer says it answers.
///
/// Two joins, because a harness may or may not mint an identity for a call: the
/// identity where both records carry one, and the recorded ordering index where
/// neither does. Never the position in the served array — a turn that made three
/// calls and got two answers back would then hand a reader the wrong tool's
/// output, which reads as a tool having done something it never did.
#[test]
fn an_observation_is_paired_with_the_call_the_producer_says_it_answers() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::WORKING_CONVERSATION_ID);

    // Joined by the identity that harness minted for the call.
    let by_identity = turns[0]["tools"].as_array().expect("the turn's tools");
    assert_eq!(by_identity.len(), 1, "{by_identity:?}");
    assert_eq!(by_identity[0]["name"], json!("Read"));
    assert_eq!(by_identity[0]["input"], json!("docs/contract.md"));
    assert_eq!(
        by_identity[0]["output"],
        json!(fixture_run::WORKING_OBSERVATION)
    );

    // And joined by the recorded ordering index, for the harness that published
    // no identity at all. One entry either way: the observation is folded onto
    // the call it answers rather than served as a second tool nobody invoked.
    let by_index = turns.last().expect("the turn in flight")["tools"]
        .as_array()
        .expect("its tools")
        .clone();
    assert_eq!(by_index.len(), 1, "{by_index:?}");
    assert_eq!(by_index[0]["name"], json!("Edit"));
    assert_eq!(
        by_index[0]["output"],
        json!(fixture_run::WORKING_CUT_OBSERVATION)
    );
    // The producer's own numbering for the call, which is what the pairing rested
    // on — not where either record landed in this array.
    assert_eq!(by_index[0]["index"], json!(0));
}

/// A dispatch whose member died without settling serves everything its journal
/// recorded.
///
/// It will never have a report — a member that dies writes none — so an empty
/// transcript here would be the read API saying a dispatch that talked for
/// minutes said nothing at all. Half the sessions of the run this reading was
/// measured against are in exactly this state.
#[test]
fn a_dispatch_whose_member_died_serves_what_it_managed_to_record() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::DIED_CONVERSATION_ID);
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(turns[0]["user"], json!(fixture_run::DIED_INSTRUCTION));
    assert_eq!(turns[0]["assistant"], json!(fixture_run::DIED_REPLY));
    assert_eq!(turns[0]["tools"][0]["name"], json!("Bash"));
    assert_eq!(
        turns[0]["tools"][0]["output"],
        json!(fixture_run::DIED_OBSERVATION)
    );
    // Nothing closed the turn, so nothing measured it: absent, never zero.
    assert_eq!(turns[0]["finishedAt"], json!(null));
    assert_eq!(turns[0]["durationMs"], json!(null));
    assert_eq!(turns[0]["usage"], json!({}));

    // And the run really does hold no report for it: the member died, so the
    // artifact route has nothing to serve either.
    let settled = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/artifacts/report-{}",
            fixture_run::LANES_RUN_ID,
            fixture_run::DIED_CONVERSATION_ID
        ),
    );
    assert_eq!(settled.status, 404, "{}", settled.body);
}

/// A text the producer flagged as cut is served as cut.
///
/// The journal bounds what a live turn carries and the settled report does not,
/// so a live reply can be the head of one — and a reader told nothing would take
/// the head for the whole of it. The flags are the producer's own, carried on the
/// `unknown` map the turn shape has always had for what it declares no field for:
/// this step adds no field and moves no schema version.
#[test]
fn a_text_the_producer_cut_is_served_as_cut() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::WORKING_CONVERSATION_ID);
    let running = turns.last().expect("the turn in flight");

    assert_eq!(
        running["unknown"],
        json!({ "instruction_truncated": true, "truncated": true }),
        "{running}"
    );
    assert_eq!(running["tools"][0]["output_truncated"], json!(true));
    // The text itself is what the producer wrote and nothing more: served cut,
    // never completed from somewhere else and never padded.
    assert_eq!(running["assistant"], json!(fixture_run::WORKING_CUT_REPLY));

    // A turn nothing was cut on says nothing at all, rather than saying `false`
    // on three fields a reader would have to check.
    assert_eq!(turns[0]["unknown"], json!({}), "{}", turns[0]);
    assert_eq!(turns[0]["tools"][0].get("output_truncated"), None);
}

/// A session that published no words of its own reads as having published none.
///
/// A single-sided member is the case: it publishes no `turn-message` at all — its
/// prose is in the report it writes when it settles, and this one never settled.
/// So the honest answer is an explicit absence, and this reading must not invent
/// a turn or borrow prose from anywhere to fill it.
#[test]
fn a_session_that_published_no_words_reads_as_having_published_none() {
    let serving = lanes();
    let turns = lane_transcript(&serving, fixture_run::RECLAIMED_CONVERSATION_ID);
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(turns[0]["assistant"], json!(null));
    // What it *was* asked is recorded, and is served: an absent reply is not an
    // absent turn.
    assert_eq!(turns[0]["user"], json!(fixture_run::RECLAIMED_INSTRUCTION));
    assert_eq!(turns[0]["startedAt"], json!("2026-08-07T12:06:03.000Z"));
}

/// A session holding both a stored report and live records is served from the
/// report alone.
///
/// The report is complete and unbounded where the journal is bounded, so where
/// the two disagree about a turn the report is the answer — and a reading that
/// merged them could disagree with itself, serving a cut reply beside the whole
/// one for the same turn, or filling a turn the report says produced nothing with
/// words from the journal. `docs/contract.md` states the same precedence for a
/// reader of the wire.
#[test]
fn a_session_with_both_a_report_and_live_records_is_served_from_the_report() {
    const STREAM: &str = "node-scope-1786925518777-3163333";
    const SESSION: &str = "node-scope-1786925518777-3163333.worker";
    const PROMPT: &str = "Now run the gate.";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let labels = || {
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "pr-author",
                "session": SESSION,
            })
        };
        // Both turns as the corrected producer published them while they ran, so
        // the live reading has everything it would need to fill either.
        for (turn, instruction) in [(1, "Land the wire contract."), (2, PROMPT)] {
            fixture_run::append_relayed(
                &dir,
                "agentgraph",
                "turn-started",
                labels(),
                json!({
                    "turn": turn,
                    "role": "assistant",
                    "instruction": instruction,
                    "started_at": "2026-08-07T12:01:00.000Z",
                }),
            );
            fixture_run::append_relayed(
                &dir,
                "agentgraph",
                "turn-message",
                labels(),
                json!({
                    "turn": turn,
                    "role": "assistant",
                    "text": format!("the head of turn {turn}'s reply"),
                    "truncated": true,
                }),
            );
        }
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: STREAM,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:01:01.000Z",
                artifact: "report-node-scope-1786925518777-3163333",
                report: &unanswered_report(PROMPT),
            },
            fixture_run::Produced::Report,
        );
    });

    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 2, "{turns:?}");

    // The whole reply the report stored, and not the head the journal carried.
    assert_eq!(turns[0]["assistant"], json!("The route table is landed."));
    // And the turn the report says produced no reply stays an explicit absence,
    // rather than being filled from the words the journal did carry for it.
    assert_eq!(turns[1]["user"], json!(PROMPT));
    assert_eq!(turns[1]["assistant"], json!(null));
    // Nothing of the live reading beside either of them: no flag saying a text
    // the report holds whole was cut. What the map carries is the report's own
    // attribution of the turn, which is the report's reading and not the live
    // one.
    for turn in &turns {
        let unknown = turn["unknown"].as_object().expect("a map");
        assert!(unknown.keys().all(|key| key == "attribution"), "{turn}");
    }
}

/// The three shapes a live turn can arrive in that the recorded runs above have
/// none of, driven through the route that serves them.
///
/// Each is a producer's record this reading has to answer for: an observation
/// that answers no call this turn published, a reply published in more than one
/// part, and a bound that is not an instant at all.
#[test]
fn a_live_turn_answers_for_the_records_a_recorded_run_has_none_of() {
    const SESSION: &str = "node-scope-1786925518888-3163444.worker";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let labels = || {
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "pr-author",
                "session": SESSION,
            })
        };
        let relay = |kind: &str, payload: Value| {
            fixture_run::append_relayed(&dir, "agentgraph", kind, labels(), payload);
        };
        relay(
            "turn-started",
            json!({
                "turn": 1,
                "role": "assistant",
                "instruction": "Finish the sweep.",
                "started_at": "2026-08-07T12:02:00.000Z",
            }),
        );
        // An observation whose call this turn never published: the call it names
        // was made in the turn before it, which is a different turn's tools.
        relay(
            "turn-activity",
            json!({
                "kind": "tool_result",
                "name": Value::Null,
                "detail": "",
                "output": "8 files changed",
                "tool_call_id": "toolu_from_a_turn_ago",
                "index": 0,
            }),
        );
        // One reply in two parts, which is what a producer that published its
        // words as they arrived would leave behind.
        relay(
            "turn-message",
            json!({ "turn": 1, "role": "assistant", "text": "swept the first half" }),
        );
        relay(
            "turn-message",
            json!({ "turn": 1, "role": "assistant", "text": "and the second" }),
        );
        // A close whose bounds are not instants: the turn is over and this crate
        // can order neither end of it.
        relay(
            "turn-completed",
            json!({
                "turn": 1,
                "role": "assistant",
                "usage": { "cost_usd": 0.05 },
                "started_at": "whenever it was",
                "finished_at": "later",
            }),
        );
    });

    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();

    // One turn, whose two records the producer keyed to each other.
    assert_eq!(turns.len(), 1, "{turns:?}");

    // Served as a record of its own rather than dropped or folded onto a call it
    // does not answer: the run recorded it, and a live reading is the only thing
    // that will ever hold it.
    let tools = turns[0]["tools"].as_array().expect("the turn's tools");
    assert_eq!(tools.len(), 1, "{tools:?}");
    assert_eq!(tools[0]["kind"], json!("tool_result"));
    assert_eq!(tools[0]["name"], json!(null));
    assert_eq!(tools[0]["output"], json!("8 files changed"));

    // Both parts, in the order the producer published them: serving one would
    // drop the rest of a reply that was written whole.
    assert_eq!(
        turns[0]["assistant"],
        json!("swept the first half\n\nand the second")
    );

    // And a bound that is not an instant is served as no bound, exactly as a
    // report's unreadable bounds are: absent beats a value no client can order.
    // The end is the only bound this close alone stamps, so it is the one that
    // goes — the start falls back to the readable copy the open record carried,
    // and with only one end of it there is no elapsed time to serve.
    assert_eq!(turns[0]["status"], json!("turn-completed"));
    assert_eq!(turns[0]["startedAt"], json!("2026-08-07T12:02:00.000Z"));
    assert_eq!(turns[0]["finishedAt"], json!(null));
    assert_eq!(turns[0]["durationMs"], json!(null));
    // The accounting beside it is still that turn's own: one unreadable stamp is
    // not a reason to drop what the producer did measure.
    assert_eq!(turns[0]["usage"]["costUsd"], json!(0.05));
}

/// A turn the journal holds only half of is still the turn it was.
///
/// Two halves, because the journal is a live stream and either record can be the
/// one that is missing or unreadable. A close whose open never reached the
/// journal is a turn the run had and the only account of it anything holds, so it
/// opens a turn of its own rather than closing somebody else's. And a close whose
/// own start stamp cannot be ordered still has the one the open record stamped —
/// the producer writes it on both — so the turn keeps the bound it was measured
/// with instead of losing it to the worse of two copies.
#[test]
fn a_turn_the_journal_holds_only_half_of_is_still_the_turn_it_was() {
    const SESSION: &str = "node-scope-1786925518777-3163111.worker";
    const OPENED: &str = "2026-08-07T12:03:00.000Z";

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let relay = |kind: &str, payload: Value| {
            fixture_run::append_relayed(
                &dir,
                "agentgraph",
                kind,
                json!({
                    "run_id": fixture_run::RUN_ID,
                    "node": fixture_run::SHIP_NODE_ID,
                    "member": "worker",
                    "persona": "pr-author",
                    "session": SESSION,
                }),
                payload,
            );
        };
        relay(
            "turn-started",
            json!({
                "turn": 1,
                "role": "assistant",
                "instruction": "Finish the sweep.",
                "started_at": OPENED,
            }),
        );
        // The close that carries a start stamp nothing can order, beside the
        // readable one its own open record carried.
        relay(
            "turn-completed",
            json!({
                "turn": 1,
                "role": "assistant",
                "usage": { "cost_usd": 0.07 },
                "started_at": "whenever it was",
                "finished_at": "2026-08-07T12:03:02.500Z",
            }),
        );
        // And a close whose open never reached the journal at all: the producer
        // keyed it, and there is nothing here for it to close.
        relay(
            "turn-completed",
            json!({
                "turn": 2,
                "role": "assistant",
                "usage": { "cost_usd": 0.09 },
                "started_at": "2026-08-07T12:03:03.000Z",
                "finished_at": "2026-08-07T12:03:04.000Z",
            }),
        );
    });

    let turns = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{SESSION}",
            fixture_run::RUN_ID
        ),
    )
    .json()["conversation"]["turns"]
        .as_array()
        .expect("the transcript")
        .clone();
    assert_eq!(turns.len(), 2, "{turns:?}");

    // The bound the open record stamped, and the elapsed time measured against
    // it: one unreadable copy of a stamp does not lose the readable one.
    assert_eq!(turns[0]["status"], json!("turn-completed"));
    assert_eq!(turns[0]["startedAt"], json!(OPENED));
    assert_eq!(turns[0]["finishedAt"], json!("2026-08-07T12:03:02.500Z"));
    assert_eq!(turns[0]["durationMs"], json!(2_500));
    assert_eq!(turns[0]["user"], json!("Finish the sweep."));
    assert_eq!(turns[0]["usage"]["costUsd"], json!(0.07));

    // The turn whose open the journal never received: served as the turn it is,
    // with what it spent and the interval it ran over, and with no instruction
    // rather than one borrowed off the turn before it.
    assert_eq!(turns[1]["status"], json!("turn-completed"));
    assert_eq!(turns[1]["startedAt"], json!("2026-08-07T12:03:03.000Z"));
    assert_eq!(turns[1]["finishedAt"], json!("2026-08-07T12:03:04.000Z"));
    assert_eq!(turns[1]["durationMs"], json!(1_000));
    assert_eq!(turns[1]["usage"]["costUsd"], json!(0.09));
    assert_eq!(turns[1]["user"], json!(""));
    assert_eq!(turns[1]["assistant"], json!(null));
}

/// A filter narrows which turns a live transcript lists and never what one of
/// them said.
///
/// The invariant every reading here keeps, on the half of the transcript that
/// comes from journal records rather than from a report: a reader who excluded a
/// kind is shown fewer records, and the turns they are still shown say exactly
/// what they say to a reader who asked for everything. A turn's reply vanishing
/// because its `turn-message` was filtered out would be this API answering one
/// question two ways.
#[test]
fn a_filter_narrows_a_live_transcript_and_never_what_a_turn_said() {
    let serving = lanes();
    let transcript = |filter: &str| -> Vec<Value> {
        http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}?include_conversations=true&filter={}",
                fixture_run::LANES_RUN_ID,
                urlencode(filter)
            ),
        )
        .json()["conversations"]
            .as_array()
            .expect("the transcripts")
            .iter()
            .find(|document| {
                document["conversation"]["id"] == json!(fixture_run::WORKING_CONVERSATION_ID)
            })
            .expect("the working session's transcript")["conversation"]["turns"]
            .as_array()
            .expect("its turns")
            .clone()
    };

    let all = transcript("detailed");
    // The two kinds a turn is opened and answered by. Excluding them drops the
    // turn in flight from the listing — the run relayed nothing else for it — and
    // leaves the one the producer also closed, which it relayed a `turn-completed`
    // for.
    let listed = transcript(r#"{"exclude":[{"kind":"turn-started"},{"kind":"turn-message"}]}"#);
    assert_eq!(all.len(), 2, "{all:?}");
    assert_eq!(listed.len(), 1, "the listing narrowed: {listed:?}");
    assert_eq!(
        listed[0]["assistant"],
        json!(fixture_run::WORKING_REPLY),
        "the reply is what the turn said, not what this reader asked to list"
    );
    // Down to the id, which is the turn's place in the whole session rather than
    // in this reader's listing: an id that moved with a filter would name a
    // different turn than the transcript route serves under it.
    assert_eq!(listed, all[..1].to_vec());
}

/// What a turn only the report holds is stamped, statused and measured by, when
/// the report holds less than everything about it.
///
/// A report bounds a turn where the harness observed one and attributes an
/// invocation to it where one ran, and it holds turns with neither. Each of those
/// is a different fact and each has to reach a reader as one: the instant a row is
/// stamped by falls back from the bound the report observed to the settlement that
/// stored it, a turn no invocation is attributed to has the status of nothing
/// rather than of something that went well, and a turn nothing measured is served
/// no figures at all rather than zeroes.
#[test]
fn a_report_held_turn_is_stamped_and_measured_by_what_the_report_holds() {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, Message, PartyTelemetry, Report, SessionLink,
        Telemetry, TelemetryRole, Transcript, Usage,
    };

    const SESSION: &str = "node-scope-1786925519111-3163777.worker";
    const OPENED: &str = "2026-08-07T12:01:01.000Z";
    const CLOSED: &str = "2026-08-07T12:01:02.500Z";
    const REOPENED: &str = "2026-08-07T12:01:03.000Z";

    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user("Land the wire contract."),
                Message::assistant("Landed it."),
                // Bounded and attributed: the harness observed both ends and an
                // invocation ran.
                Message::user("Now run the gate."),
                Message::assistant("The gate is green."),
                // Bounded at one end and attributed to nothing.
                Message::user("Say what is left."),
                Message::assistant("One follow-up, surfaced."),
                // Neither: the report kept the turn and measured none of it.
                Message::user("And close it out."),
                Message::assistant("Closed."),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: None,
        settled_reason: None,
        judge_decisions: Vec::new(),
        usage: None,
        telemetry: Some(Telemetry {
            wall_ms: 9_000,
            agent: PartyTelemetry::default(),
            judge: PartyTelemetry::default(),
            orchestration_ms: 10,
            sessions: vec![
                SessionLink {
                    session_id: "01a01f4c-685b-75e2-8281-e8937fd20d48".into(),
                    role: TelemetryRole::Agent,
                    turn_index: 2,
                    started_at: OPENED.into(),
                    finished_at: Some(CLOSED.into()),
                    history_id: None,
                    judge: None,
                },
                // Observed opening and never observed closing, which the contract
                // spells as a `null` finish rather than as a malformed bound.
                SessionLink {
                    session_id: "01a01f4c-685b-75e2-8281-e8937fd20d49".into(),
                    role: TelemetryRole::Agent,
                    turn_index: 3,
                    started_at: REOPENED.into(),
                    finished_at: None,
                    history_id: None,
                    judge: None,
                },
            ],
            attribution: vec![HarnessAttribution {
                role: TelemetryRole::Agent,
                turn_index: 2,
                ran: Some("claude-code:default".into()),
                fell_through: Vec::new(),
                candidates: vec![CandidateAttempt {
                    harness: "claude-code".into(),
                    harness_id: "claude-code:default".into(),
                    variant: None,
                    model: Some("claude-opus-5".into()),
                    status: "ok".into(),
                    available: true,
                    ran: true,
                    failure_kind: None,
                    failure_kind_source: None,
                    exit_code: Some(0),
                    duration_ms: Some(1_500),
                    error: None,
                    session_id: None,
                    history_id: None,
                    usage: Some(Usage {
                        input_tokens: Some(12),
                        output_tokens: Some(34),
                        cache_read_tokens: None,
                        cache_write_tokens: None,
                        cost_usd: Some(0.75),
                    }),
                }],
                history_file: None,
                judge: None,
            }],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
        stopped_early: false,
    };
    let turns = transcript_of(
        SESSION,
        "node-scope-1786925519111-3163777",
        &format!(
            "{}\n",
            serde_json::to_string(&report).expect("the report serializes")
        ),
    );
    // Four turns for four prompts: one the journal opened and three it never did.
    assert_eq!(turns.len(), 4, "{turns:?}");

    // Bounded and attributed: the bounds the report observed, the instant it
    // observed the turn finish, and what that invocation was, took and spent.
    assert_eq!(turns[1]["startedAt"], json!(OPENED));
    assert_eq!(turns[1]["finishedAt"], json!(CLOSED));
    assert_eq!(turns[1]["timestamp"], json!(CLOSED));
    assert_eq!(turns[1]["status"], json!("ok"));
    assert_eq!(turns[1]["model"], json!("claude-opus-5"));
    assert_eq!(turns[1]["durationMs"], json!(1_500));
    assert_eq!(turns[1]["usage"]["costUsd"], json!(0.75));

    // Bounded at one end and attributed to nothing: stamped by the opening the
    // report did observe, and served no status, no identity and no figures —
    // a turn nothing measured is not a turn that measured zero.
    assert_eq!(turns[2]["startedAt"], json!(REOPENED));
    assert_eq!(turns[2]["finishedAt"], json!(null));
    assert_eq!(turns[2]["timestamp"], json!(REOPENED));
    assert_eq!(turns[2]["status"], json!("unknown"));
    assert_eq!(turns[2]["model"], json!(null));
    assert_eq!(turns[2]["durationMs"], json!(null));
    assert_eq!(turns[2]["usage"], json!({}), "{:?}", turns[2]);
    // And its prose is served whole, because none of that is what a turn said.
    assert_eq!(turns[2]["user"], json!("Say what is left."));
    assert_eq!(turns[2]["assistant"], json!("One follow-up, surfaced."));

    // Neither bound nor attribution: stamped by the settlement that stored the
    // report, which is the only instant the run holds for it.
    assert_eq!(turns[3]["timestamp"], json!(REPORT_SETTLED_AT));
    assert_eq!(turns[3]["startedAt"], json!(null));
    assert_eq!(turns[3]["finishedAt"], json!(null));
    assert_eq!(turns[3]["status"], json!("unknown"));
    assert_eq!(turns[3]["usage"], json!({}), "{:?}", turns[3]);
    assert_eq!(turns[3]["assistant"], json!("Closed."));
}

#[test]
fn a_run_that_appears_after_the_stream_opened_is_announced_without_reopening_it() {
    // The stream learns which runs exist from the runs root, on every tick, and
    // never from the set its opening snapshot saw. That is what stops the cost
    // bounds this stream is held to being met by a subscriber that stopped
    // looking: a run started while a browser tab was open is exactly the run its
    // operator is waiting for.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let mut stream = http::stream(serving.address, "/api/v2/events", None);
    let snapshot = stream.next_frame().expect("a snapshot");
    assert_eq!(
        snapshot.json()["runs"].as_array().map(Vec::len),
        Some(1),
        "the run that appears below is not there yet"
    );

    fixture_run::write(&serving.runs_root(), fixture_run::OTHER_RUN_ID);

    let changed = stream.next_frame().expect("the new run is noticed");
    assert_eq!(changed.event, "run.changed");
    assert_eq!(changed.json()["run_id"], json!(fixture_run::OTHER_RUN_ID));

    // And it is a run the client can then go and read, which is the whole point
    // of announcing it.
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::OTHER_RUN_ID),
    );
    assert_eq!(detail.status, 200);
}

#[test]
fn a_run_root_that_cannot_be_read_is_reported_rather_than_omitted() {
    // A third of a host's runs went missing without anybody noticing, because a
    // run root the reader refused was dropped in the read. A list that is
    // silently short is indistinguishable from a host with nothing running.
    let refused = "run-20260807-unreadable";
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        // A directory that claims to be a run and is not one: the launch record
        // every reader needs is not a record at all.
        let dir = root.join(refused);
        std::fs::create_dir_all(&dir).expect("the run directory");
        std::fs::write(dir.join("launch.json"), "{ this is not a launch record")
            .expect("the launch record");
    });
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();

    let served: Vec<&str> = listed["runs"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["run_id"].as_str().expect("a run id"))
        .collect();
    assert_eq!(served, vec![fixture_run::RUN_ID], "{listed}");

    let unreadable = listed["unreadable"].as_array().expect("the refused roots");
    assert_eq!(unreadable.len(), 1, "{listed}");
    let entry = &unreadable[0];
    assert!(
        entry["path"].as_str().expect("a path").ends_with(refused),
        "the refusal names the directory it is about: {entry}"
    );
    assert!(
        !entry["reason"].as_str().expect("a reason").is_empty(),
        "a refusal a reader cannot act on: {entry}"
    );

    // And a root with nothing to refuse carries no such array at all, which is
    // what every client written before this field reads.
    let clean = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let listed = http::get(clean.address, "/api/v2/runs?include_settled=true").json();
    assert!(
        listed.get("unreadable").is_none(),
        "a list with nothing to report carries an empty array: {listed}"
    );
}

#[test]
fn a_selection_answers_the_runs_it_names_and_nothing_about_a_page() {
    // The refresh an invalidation frame is for: the frame names the run that
    // moved, and this is how one row is refetched rather than the first page.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
    });
    let listed = http::get(
        serving.address,
        &format!(
            "/api/v2/runs?select={},{}",
            fixture_run::OTHER_RUN_ID,
            fixture_run::RUN_ID
        ),
    )
    .json();

    // The same row shape as a page serves, in the same order — most recent
    // activity first, ties on the id — whatever order the ids were named in.
    let served: Vec<&str> = listed["runs"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["run_id"].as_str().expect("a run id"))
        .collect();
    assert_eq!(
        served,
        vec![fixture_run::RUN_ID, fixture_run::OTHER_RUN_ID],
        "{listed}"
    );
    let page = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let row_of = |body: &serde_json::Value, run: &str| {
        body["runs"]
            .as_array()
            .expect("rows")
            .iter()
            .find(|row| row["run_id"] == json!(run))
            .cloned()
            .unwrap_or_else(|| panic!("{run} is not on this list: {body}"))
    };
    assert_eq!(
        row_of(&listed, fixture_run::RUN_ID),
        row_of(&page, fixture_run::RUN_ID),
        "a selected row and a paged row describe the same run differently"
    );

    // A run named twice is answered once. The bound below is checked against
    // what was *asked for* rather than against what survives that, so naming one
    // run fifty-one times is still a selection larger than a page.
    let repeated = http::get(
        serving.address,
        &format!(
            "/api/v2/runs?select={},{},{}",
            fixture_run::RUN_ID,
            fixture_run::OTHER_RUN_ID,
            fixture_run::RUN_ID
        ),
    )
    .json();
    assert_eq!(
        repeated["runs"].as_array().map(Vec::len),
        Some(2),
        "a run named twice was served twice: {repeated}"
    );

    // **No cursor.** It answered exactly the runs named, so there is no next
    // page for a client to walk into.
    assert!(listed.get("next_cursor").is_none(), "{listed}");
    // And nothing was refused, so nothing is reported as refused.
    assert!(listed.get("unreadable").is_none(), "{listed}");
    assert!(listed.get("missing").is_none(), "{listed}");
}

#[test]
fn a_selection_names_the_run_it_could_not_find_rather_than_omitting_it() {
    // Removal is a normal race: the frame that named the run arrived before the
    // sweep that took it away. A shorter list would leave a client diffing to
    // discover that, and a refusal would fail a refresh of the runs that *are*
    // there.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let gone = "run-20260807-sweptaway";
    let listed = http::get(
        serving.address,
        &format!("/api/v2/runs?select={},{gone}", fixture_run::RUN_ID),
    )
    .json();
    assert_eq!(
        listed["runs"].as_array().map(Vec::len),
        Some(1),
        "the run that is there is still served: {listed}"
    );
    assert_eq!(listed["runs"][0]["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(listed["missing"], json!([gone]), "{listed}");
}

#[test]
fn a_selection_serves_a_settled_run_the_page_would_have_hidden() {
    // `include_settled` decides what a *page* is worth listing. A caller that
    // named a run wants that run, and a settled row that cannot be refreshed
    // reads as a stale view of a run that has in fact finished.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let page = http::get(serving.address, "/api/v2/runs").json();
    assert_eq!(
        page["runs"].as_array().map(Vec::len),
        Some(0),
        "the fixture run has settled, so a page hides it: {page}"
    );
    let selected = http::get(
        serving.address,
        &format!("/api/v2/runs?select={}", fixture_run::RUN_ID),
    )
    .json();
    assert_eq!(selected["runs"][0]["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(selected["runs"][0]["state"], json!("settled"));
}

#[test]
fn a_selection_larger_than_a_page_is_refused_rather_than_truncated() {
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let named: Vec<String> = (0..=onepipeline_ui::contract::RUNS_PAGE_LIMIT)
        .map(|n| format!("run-20260807-{n:06}"))
        .collect();
    // Repeats do not buy a caller room: the bound is on what was asked for, so a
    // selection over the maximum is refused however few distinct runs it names.
    let repeated = http::get(
        serving.address,
        &format!(
            "/api/v2/runs?select={}",
            vec![fixture_run::RUN_ID; named.len()].join(",")
        ),
    );
    assert_eq!(repeated.status, 422);
    assert_eq!(repeated.json()["error"]["code"], json!("invalid_request"));
    let refused = http::get(
        serving.address,
        &format!("/api/v2/runs?select={}", named.join(",")),
    );
    assert_eq!(refused.status, 422);
    let body = refused.json();
    assert_eq!(body["error"]["code"], json!("invalid_request"));
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("a message")
            .contains(&onepipeline_ui::contract::RUNS_PAGE_LIMIT.to_string()),
        "the refusal does not say what the maximum is: {body}"
    );
    // And a name that is not a usable run id is refused at the same boundary,
    // before anything under the runs root is opened.
    let crafted = http::get(serving.address, "/api/v2/runs?select=../elsewhere");
    assert_eq!(crafted.status, 422);
    assert_eq!(crafted.json()["error"]["code"], json!("invalid_run_id"));

    // A selection answers exactly the runs it names, so a paging parameter sent
    // beside one is a request whose two halves disagree about what was asked.
    // Refused rather than resolved: serving the selection and dropping the rest
    // would leave a caller who asked for a second page of named runs reading the
    // first as though it were the answer.
    for paging in [
        "limit=1",
        "cursor=run-20260807-a1b2c3",
        "include_settled=true",
    ] {
        let both = http::get(
            serving.address,
            &format!("/api/v2/runs?select={}&{paging}", fixture_run::RUN_ID),
        );
        assert_eq!(both.status, 422, "{paging}");
        let body = both.json();
        assert_eq!(body["error"]["code"], json!("invalid_request"), "{paging}");
        assert!(
            body["error"]["message"]
                .as_str()
                .expect("a message")
                .contains(paging.split('=').next().expect("a parameter name")),
            "the refusal does not name what it would not take: {body}"
        );
    }
}

#[test]
fn a_rows_clock_and_the_details_are_one_reading() {
    // Two readings of one run's clock, and this is what holds them together: the
    // row's comes from the aggregate the run's summary carries, read in this
    // process, and the detail's comes from `onepipeline telemetry` over the same
    // run. They are the same document by the sibling's design, and a release of
    // it that made them disagree would be a list and a detail an operator sees
    // different numbers on.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let row = http::get(serving.address, "/api/v2/runs?include_settled=true").json()["runs"][0]
        ["timing"]
        .clone();
    let detail = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json()["run"]["timing"]
        .clone();
    assert!(
        !row["wall_ms"].is_null(),
        "the sibling that aggregates this run's telemetry did not answer, so this journey is \
         comparing two absences — run `just bootstrap`"
    );
    for lane in [
        "agent_seconds",
        "judge_seconds",
        "llmlint_seconds",
        "gate_seconds",
        "publication_wait_seconds",
        "lock_wait_seconds",
        "setup_seconds",
        "scheduling_seconds",
        "wall_seconds",
        "wall_ms",
        "unattributed_ms",
    ] {
        assert_eq!(
            row[lane], detail[lane],
            "the row and the detail disagree about {lane}: {row} against {detail}"
        );
    }
}

#[test]
fn a_selection_tells_a_run_it_could_not_read_from_one_that_is_gone() {
    // Two different facts to a caller refreshing a row: the run went away
    // between the frame that named it and the refetch, which is a race and
    // normal; or the run is right there and this host is failing to serve it,
    // which is not. Reported on separate lists so a client is not left guessing
    // which of the two it met.
    let refused = "run-20260807-unreadable";
    let gone = "run-20260807-sweptaway";
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        let dir = root.join(refused);
        std::fs::create_dir_all(&dir).expect("the run directory");
        std::fs::write(dir.join("launch.json"), "{ this is not a launch record")
            .expect("the launch record");
    });
    let listed = http::get(
        serving.address,
        &format!(
            "/api/v2/runs?select={},{refused},{gone}",
            fixture_run::RUN_ID
        ),
    )
    .json();

    assert_eq!(listed["runs"][0]["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(listed["runs"].as_array().map(Vec::len), Some(1), "{listed}");
    assert_eq!(listed["missing"], json!([gone]), "{listed}");
    let unreadable = listed["unreadable"].as_array().expect("the refused root");
    assert_eq!(unreadable.len(), 1, "{listed}");
    assert!(
        unreadable[0]["path"]
            .as_str()
            .expect("a path")
            .ends_with(refused),
        "{listed}"
    );
    assert!(
        !unreadable[0]["reason"]
            .as_str()
            .expect("a reason")
            .is_empty(),
        "{listed}"
    );
}

#[test]
fn runs_that_last_moved_at_the_same_instant_are_ordered_by_their_ids() {
    // The order has to be **total**, or a page boundary lands somewhere
    // different on every read and a client walking the cursor skips or repeats a
    // row. Recording the same instant is the ordinary case rather than a corner
    // one: a host that launched a batch has a dozen runs stamped alike.
    let serving = Serving::start(|root| {
        // Written in the order that would come back if nothing sorted them.
        for run in [
            "run-20260807-ccccc3",
            "run-20260807-aaaaa1",
            "run-20260807-bbbbb2",
        ] {
            fixture_run::write(root, run);
        }
    });
    let body = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let ids: Vec<&str> = body["runs"]
        .as_array()
        .expect("runs is an array")
        .iter()
        .filter_map(|run| run["run_id"].as_str())
        .collect();
    assert_eq!(
        ids,
        vec![
            "run-20260807-aaaaa1",
            "run-20260807-bbbbb2",
            "run-20260807-ccccc3"
        ],
        "runs stamped at one instant came back in no particular order"
    );
}

#[test]
fn a_selection_naming_no_run_at_all_says_so() {
    // `?select=` with nothing after it is a caller asking about no runs. Refused
    // as that rather than as a run whose id happens to be empty, because the
    // second answer — "invalid run id: must not be empty" — is addressed to
    // somebody who wrote no id at all and leaves them looking for a typo.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let refused = http::get(serving.address, "/api/v2/runs?select=");
    assert_eq!(refused.status, 422);
    let body = refused.json();
    assert_eq!(body["error"]["code"], json!("invalid_request"));
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("a message")
            .contains("names no run"),
        "the refusal does not say what was wrong with it: {body}"
    );
    // And the ordinary listing is still what leaving it off asks for.
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    assert_eq!(listed["runs"][0]["run_id"], json!(fixture_run::RUN_ID));
}

#[test]
fn a_run_directory_the_contract_cannot_name_is_reported_rather_than_listed() {
    // A row's `run_id` is what a client turns straight back into
    // `GET /api/v2/runs/{run}`, so a directory whose name this contract's own
    // boundary refuses is not a run to point a reader at. The event stream has
    // always applied that filter before announcing one; the list handed the id
    // out anyway, and a client following it met the route's refusal instead of a
    // run. Reported here rather than dropped, for the reason every other refused
    // root is: an omission nobody is told about is a host that looks empty.
    let unnameable = "a run with spaces";
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, unnameable);
    });
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();

    let served: Vec<&str> = listed["runs"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["run_id"].as_str().expect("a run id"))
        .collect();
    assert_eq!(served, vec![fixture_run::RUN_ID], "{listed}");
    let unreadable = listed["unreadable"].as_array().expect("the refused root");
    assert_eq!(unreadable.len(), 1, "{listed}");
    assert!(
        unreadable[0]["path"]
            .as_str()
            .expect("a path")
            .ends_with(unnameable),
        "the refusal names the directory it is about: {listed}"
    );
    assert!(
        !unreadable[0]["reason"]
            .as_str()
            .expect("a reason")
            .is_empty(),
        "{listed}"
    );
    // And every id the list *did* serve is one the route beside it accepts.
    let detail = http::get(serving.address, &format!("/api/v2/runs/{}", served[0]));
    assert_eq!(detail.status, 200);
}

// Every journey below drives one of the post-launch verbs over real HTTP against
// the compiled server: the route, the engine's own answer projected into the
// envelope, and at least one refusal a user can cause for each verb that writes.
// The server acts as the session the journey names, and the engine judges every
// stop and adoption by it exactly as `onepipeline` judges one by
// `ONEPIPELINE_LAUNCHER_SESSION`.

/// A session that owns nothing under any fixture root.
const STRANGER: &str = "another-planner-session";

/// How long a journey waits for a retained driver to write what it writes
/// before calling it failed.
///
/// A ceiling on a **failure**, never a cost a passing journey pays: each wait
/// returns the moment its condition holds, and the whole adoption journey below
/// takes under two seconds on this host. The ceiling is generous because a
/// driver is a process the kernel schedules, and a loaded host that took ten
/// seconds to run one must not read as a driver that never wrote.
///
/// Unix-only with the adoption journey it paces, which is the one thing that
/// waits on a retained driver.
#[cfg(unix)]
const DRIVER_PATIENCE: Duration = Duration::from_secs(60);

/// Wait until `condition` holds, or fail the journey naming what never happened.
#[cfg(unix)]
fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + DRIVER_PATIENCE;
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "{what} never happened within {DRIVER_PATIENCE:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Whether the process a pid names may still be there, asked the way the
/// engine asks it: signal `0`, which delivers nothing.
#[cfg(unix)]
fn process_is_live(pid: u32) -> bool {
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 delivers nothing and touches no memory; it reports
    // whether the pid could be signalled.
    unsafe { libc::kill(raw, 0) == 0 }
}

/// A retained driver this journey started through the server, ended if the
/// journey did not end it: the one process a suite may signal is one it
/// started, and its pid is the one the adopt route answered.
#[cfg(unix)]
struct RetainedDriver(u32);

#[cfg(unix)]
impl Drop for RetainedDriver {
    fn drop(&mut self) {
        if process_is_live(self.0) {
            let Ok(raw) = i32::try_from(self.0) else {
                return;
            };
            // SAFETY: the pid is the driver the adopt route reported to this
            // journey, which started it; a stale pid is not signalled because
            // the probe above found nothing there.
            unsafe {
                libc::kill(raw, libc::SIGTERM);
            }
        }
    }
}

#[test]
fn projects_are_grouped_as_the_engine_groups_them() {
    // Three runs, two projects, one of them recorded none: the grouping the
    // engine's own `runs` prints, served in its order — groups by newest
    // activity, runs newest first, the `(no project)` group an ordinary group.
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
        // The same shape launched from another project, and written to a
        // minute later than every other run here, so its group leads.
        let dir = fixture_run::write_in_project(
            root,
            "run-20260807-0a1b2c",
            Some("local-md:another-plan"),
        );
        fixture_run::append(&dir, "run-progress", json!({}));
        // And one whose launch recorded no project at all.
        fixture_run::write_in_project(root, "run-20260807-9e8d7c", None);
    });

    let listed = http::get(serving.address, "/api/v2/projects").json();
    assert_enveloped(&listed);
    let groups = listed["projects"].as_array().expect("the groups");
    let ids: Vec<Value> = groups
        .iter()
        .map(|group| group["project"].clone())
        .collect();
    // Newest activity first, then by id; the no-project group by its own
    // recency like any other.
    assert_eq!(
        ids,
        json!(["local-md:another-plan", null, fixture_run::PLAN_PROJECT])
            .as_array()
            .cloned()
            .unwrap(),
        "{listed}"
    );
    let contract = &groups[2];
    assert_eq!(contract["name"], json!("contract"));
    assert_eq!(contract["last_write_at"], json!(1_786_104_030_000_u64));
    let runs: Vec<&str> = contract["runs"]
        .as_array()
        .expect("the group's runs")
        .iter()
        .map(|row| row["run_id"].as_str().expect("an id"))
        .collect();
    // Runs newest first, ties on the id — the order the flat list serves.
    assert_eq!(runs, vec![fixture_run::RUN_ID, fixture_run::OTHER_RUN_ID]);
    // Each row is the run-list row, with schema 18's fields on it.
    let row = &contract["runs"][0];
    assert_eq!(row["state"], json!("settled"));
    assert_eq!(row["phase"], json!("settled"));
    assert_eq!(row["node_counts"]["done"], json!(2));
    assert_eq!(row["liveness"], json!("PARKED"), "{row}");
    assert_eq!(row["unread_surfaces"], json!(0));
    assert_eq!(row["last_progress_at"], json!(1_786_104_030));
    assert_eq!(row["project"], json!(fixture_run::PLAN_PROJECT));
    assert_eq!(row["project_name"], json!("contract"));
    let unprojected = &groups[1];
    assert_eq!(unprojected["project"], json!(null));
    assert!(
        unprojected["runs"][0].get("project").is_none(),
        "a run that recorded no project carries none: {unprojected}"
    );

    // One group by its id, path-encoded on the wire.
    let one = http::get(
        serving.address,
        &format!("/api/v2/projects/{}", encoded("local-md:another-plan")),
    );
    assert_eq!(one.status, 200, "{}", one.body);
    let one = one.json();
    assert_eq!(one["project"], json!("local-md:another-plan"));
    assert_eq!(one["runs"][0]["run_id"], json!("run-20260807-0a1b2c"));
    // And the flat list carries the same fields on the same rows.
    let flat = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let flat_row = flat["runs"]
        .as_array()
        .expect("rows")
        .iter()
        .find(|row| row["run_id"] == json!(fixture_run::RUN_ID))
        .expect("the run");
    assert_eq!(flat_row["project"], row["project"]);
    assert_eq!(flat_row["liveness"], row["liveness"]);
    assert_eq!(flat_row["unread_surfaces"], row["unread_surfaces"]);

    // A project nobody launched from is not there; an id that is not one is
    // refused before anything is compared against it.
    let missing = http::get(
        serving.address,
        &format!("/api/v2/projects/{}", encoded("local-md:nowhere")),
    );
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(missing.json()["error"]["code"], json!("project_not_found"));
    for malformed in ["no-separator", "Bad:source", "local-md:", "local-md:a:b"] {
        let refused = http::get(
            serving.address,
            &format!("/api/v2/projects/{}", encoded(malformed)),
        );
        assert_eq!(refused.status, 422, "{malformed}: {}", refused.body);
        assert_eq!(
            refused.json()["error"]["code"],
            json!("invalid_project_id"),
            "{malformed}"
        );
    }
}

#[test]
fn a_project_listing_reports_a_root_it_could_not_read_rather_than_omitting_it() {
    // The flat list's rule, on the grouped one: a run root the reader refused is
    // named on `unreadable` beside the groups rather than dropped from them,
    // because a grouping that is silently short reads as a host with less
    // running than it has — and the groups themselves are exactly what the
    // readable runs make, unshortened by the refusal.
    let refused = "run-20260807-unreadable";
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        // A directory that claims to be a run and is not one: the launch record
        // every reader needs is not a record at all.
        let dir = root.join(refused);
        std::fs::create_dir_all(&dir).expect("the run directory");
        std::fs::write(dir.join("launch.json"), "{ this is not a launch record")
            .expect("the launch record");
    });
    let listed = http::get(serving.address, "/api/v2/projects").json();
    assert_enveloped(&listed);
    let groups = listed["projects"].as_array().expect("the groups");
    assert_eq!(groups.len(), 1, "{listed}");
    assert_eq!(groups[0]["project"], json!(fixture_run::PLAN_PROJECT));
    let served: Vec<&str> = groups[0]["runs"]
        .as_array()
        .expect("the group's runs")
        .iter()
        .map(|row| row["run_id"].as_str().expect("a run id"))
        .collect();
    assert_eq!(served, vec![fixture_run::RUN_ID], "{listed}");

    let unreadable = listed["unreadable"].as_array().expect("the refused roots");
    assert_eq!(unreadable.len(), 1, "{listed}");
    let entry = &unreadable[0];
    assert!(
        entry["path"].as_str().expect("a path").ends_with(refused),
        "the refusal names the directory it is about: {entry}"
    );
    assert!(
        !entry["reason"].as_str().expect("a reason").is_empty(),
        "a refusal a reader cannot act on: {entry}"
    );

    // And a root with nothing to refuse carries no such array at all, which is
    // what every client written before this field reads.
    let clean = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let listed = http::get(clean.address, "/api/v2/projects").json();
    assert!(
        listed.get("unreadable").is_none(),
        "a grouping with nothing to report carries an empty array: {listed}"
    );
}

#[test]
fn a_run_holding_an_unanswered_question_is_waiting_and_the_row_says_how_many() {
    // The engine's own liveness reading over the bounded summary, served on the
    // row: a run quiet past the parked threshold is `PARKED` — unless a
    // **blocking** surface sits unread in its channel, which is a run waiting
    // on somebody rather than one nobody is driving. Both readings are the
    // engine's, so the row and the detail opened from it say one thing, and the
    // row counts what is waiting. The threshold is the engine's own variable,
    // set to the one second it will take, so a run written two seconds ago is
    // already quiet.
    let quiet = &[("ONEPIPELINE_PARKED_AFTER_SECONDS", "1")];
    let parked = Serving::start_with_env(
        |root| {
            fixture_run::write_launched(root, fixture_run::RUN_ID);
        },
        quiet,
    );
    let row = http::get(parked.address, "/api/v2/runs").json()["runs"][0].clone();
    assert_eq!(row["state"], json!("parked"), "{row}");
    assert_eq!(row["liveness"], json!("PARKED"), "{row}");
    assert_eq!(row["unread_surfaces"], json!(0), "{row}");

    // A blocking finding, raised through the channel's own reply — applied by
    // the call itself, because nothing is driving the run — is a question
    // nobody has read.
    let asked = Serving::start_with_env(
        |root| {
            fixture_run::write_launched(root, fixture_run::RUN_ID);
        },
        quiet,
    );
    let replied = http::post(
        asked.address,
        &format!("/api/v2/runs/{}/channel/reply", fixture_run::RUN_ID),
        r#"{"version":3,"commands":[{"op":"finding","message":"which way?","blocking":true}]}"#,
    );
    assert_eq!(replied.status, 200, "{}", replied.body);
    // Quiet is counted in whole seconds past the threshold, so a run written
    // to this second is not yet quiet under a threshold of one.
    std::thread::sleep(Duration::from_millis(2_200));
    let row = http::get(asked.address, "/api/v2/runs").json()["runs"][0].clone();
    assert_eq!(row["state"], json!("active"), "{row}");
    assert_eq!(row["liveness"], json!("ACTIVE"), "{row}");
    assert_eq!(row["unread_surfaces"], json!(1), "{row}");
    let status = http::get(
        asked.address,
        &format!("/api/v2/runs/{}/status", fixture_run::RUN_ID),
    )
    .json();
    assert_eq!(status["liveness"], row["liveness"], "{status}");
    assert_eq!(status["unread_surfaces"]["count"], row["unread_surfaces"]);

    // A surface that is not a request — a check-in, a finding raised at the
    // surface verb — holds nothing back: unread, counted, and the run is parked
    // all the same.
    let told = Serving::start_with_env(
        |root| {
            fixture_run::write_launched(root, fixture_run::RUN_ID);
        },
        quiet,
    );
    let surfaced = http::post(
        told.address,
        &format!("/api/v2/runs/{}/channel/surface", fixture_run::RUN_ID),
        r#"{"kind":"finding","message":"the gate is red"}"#,
    );
    assert_eq!(surfaced.status, 200, "{}", surfaced.body);
    std::thread::sleep(Duration::from_millis(2_200));
    let row = http::get(told.address, "/api/v2/runs").json()["runs"][0].clone();
    assert_eq!(row["unread_surfaces"], json!(1), "{row}");
    assert_eq!(row["liveness"], json!("PARKED"), "{row}");
    assert_eq!(row["state"], json!("parked"), "{row}");
}

#[test]
fn listing_a_run_that_predates_the_channel_makes_it_no_channel() {
    // A run recorded before the channel existed has no channel directory, and
    // never will unless something writes one. The row counts its unread
    // surfaces as none — and the read that counted them left the run exactly
    // as it found it: `channel queue` over a run makes the directory, so a
    // listing that reached for it on every row would write into every run it
    // listed, and a run an operator was removing at that moment would come back
    // as an empty directory nothing can read.
    let serving = Serving::start(|root| {
        fixture_run::write_recorded_only(root, fixture_run::RECORDED_ONLY_RUN_ID);
    });
    let channel = serving
        .runs_root()
        .join(fixture_run::RECORDED_ONLY_RUN_ID)
        .join("channel");
    assert!(!channel.exists(), "the fixture predates the channel");

    let row =
        http::get(serving.address, "/api/v2/runs?include_settled=true").json()["runs"][0].clone();
    assert_eq!(
        row["run_id"],
        json!(fixture_run::RECORDED_ONLY_RUN_ID),
        "{row}"
    );
    assert_eq!(row["unread_surfaces"], json!(0), "{row}");
    let grouped = http::get(serving.address, "/api/v2/projects").json();
    assert_eq!(
        grouped["projects"][0]["runs"][0]["unread_surfaces"],
        json!(0),
        "{grouped}"
    );
    assert!(
        !channel.exists(),
        "listing the run wrote a channel directory into it"
    );
}

#[test]
fn the_channel_is_raised_read_and_claimed_over_http() {
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let run = fixture_run::RUN_ID;

    // Nothing raised yet: the queue is empty and a claim finds nothing — on a
    // settled run, `finished`.
    let empty = http::get(serving.address, &format!("/api/v2/runs/{run}/channel")).json();
    assert_enveloped(&empty);
    assert_eq!(empty["run_id"], json!(run));
    assert_eq!(empty["surfaces"], json!([]));
    assert_eq!(empty["waiting"], json!([]));
    assert_eq!(empty["held"], json!(null));
    let nothing = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/next"),
        "",
    )
    .json();
    assert_eq!(nothing["status"], json!("finished"), "{nothing}");
    assert_eq!(nothing["surface"], json!(null));

    // A surface raised, in the engine's own words for it.
    let raised = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/surface"),
        r#"{"kind":"finding","message":"the gate is red"}"#,
    );
    assert_eq!(raised.status, 200, "{}", raised.body);
    let raised = raised.json();
    assert_enveloped(&raised);
    assert_eq!(raised["state"], json!("queued"));
    let id = raised["surface"].as_u64().expect("the surface's id");

    // Read: it is waiting, and reading consumes nothing.
    let queue = http::get(serving.address, &format!("/api/v2/runs/{run}/channel")).json();
    assert_eq!(queue["waiting"][0]["id"], json!(id), "{queue}");
    assert_eq!(queue["waiting"][0]["kind"], json!("finding"));
    assert_eq!(queue["waiting"][0]["message"], json!("the gate is red"));
    assert_eq!(queue["waiting"][0]["blocking"], json!(false));
    let again = http::get(serving.address, &format!("/api/v2/runs/{run}/channel")).json();
    assert_eq!(
        again["waiting"], queue["waiting"],
        "a read consumed a surface"
    );

    // Claimed: the channel's only consumer hands it out, shaped through the
    // profile a reader named — the planner's, which is the decisions alone.
    let claimed = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/next?filter=planner"),
        "",
    );
    assert_eq!(claimed.status, 200, "{}", claimed.body);
    let claimed = claimed.json();
    assert_enveloped(&claimed);
    assert_eq!(claimed["status"], json!("surface"));
    assert_eq!(claimed["surface"]["id"], json!(id));
    assert_eq!(claimed["surface"]["message"], json!("the gate is red"));
    assert!(
        claimed["events"]
            .as_array()
            .expect("the shaped events")
            .iter()
            .all(|event| event["source"] == json!("pipeline")),
        "the planner profile admits the decision vocabulary alone: {claimed}"
    );
    // And the claim is journalled: the run's own record says it was surfaced.
    let timeline = http::get(
        serving.address,
        &format!("/api/v2/runs/{run}/timeline?scope=run"),
    )
    .json();
    assert!(
        events_on(&timeline)
            .iter()
            .any(|event| event["kind"] == json!("planner-surfaced")
                && event["surface"]["message"] == json!("the gate is red")),
        "{timeline}"
    );
    // A finding holds nothing back, so a claim consumes it outright: raised,
    // no longer waiting, and nothing in the pending slot.
    let consumed = http::get(serving.address, &format!("/api/v2/runs/{run}/channel")).json();
    assert_eq!(consumed["surfaces"][0]["id"], json!(id), "{consumed}");
    assert_eq!(consumed["waiting"], json!([]));
    assert_eq!(consumed["held"], json!(null));

    // A **blocking** finding — raised through the channel's own reply, which is
    // where a surface that means to stop a subtree comes from — outlives its
    // claim: it is held, pending, until somebody answers it.
    let asked = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/reply"),
        r#"{"version":3,"commands":[{"op":"finding","message":"which way?","blocking":true}]}"#,
    );
    assert_eq!(asked.status, 200, "{}", asked.body);
    let waiting = http::get(serving.address, &format!("/api/v2/runs/{run}/channel")).json();
    assert_eq!(
        waiting["waiting"][0]["message"],
        json!("which way?"),
        "{waiting}"
    );
    assert_eq!(waiting["waiting"][0]["blocking"], json!(true));
    let claimed = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/next"),
        "",
    )
    .json();
    assert_eq!(claimed["status"], json!("surface"), "{claimed}");
    assert_eq!(claimed["surface"]["message"], json!("which way?"));
    let held = http::get(serving.address, &format!("/api/v2/runs/{run}/channel")).json();
    assert_eq!(held["held"]["message"], json!("which way?"), "{held}");
    assert_eq!(held["waiting"], json!([]));

    // The refusals a user can cause: a message with nothing in it, in the
    // engine's words; a kind its grammar refuses; a body that is not the shape.
    let blank = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/surface"),
        r#"{"kind":"finding","message":"   "}"#,
    );
    assert_eq!(blank.status, 422, "{}", blank.body);
    let blank = blank.json();
    assert_eq!(blank["error"]["code"], json!("refused"));
    assert!(
        blank["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("carried nothing")),
        "{blank}"
    );
    let unkind = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/surface"),
        r#"{"kind":"Not A Kind","message":"hello"}"#,
    );
    assert_eq!(unkind.status, 422, "{}", unkind.body);
    assert_eq!(unkind.json()["error"]["code"], json!("invalid_request"));
    let shapeless = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/surface"),
        "not json",
    );
    assert_eq!(shapeless.status, 422, "{}", shapeless.body);
    assert_eq!(shapeless.json()["error"]["code"], json!("invalid_request"));
    // A profile the run does not have, on the claim, is the same refusal the
    // read routes make of it — before anything is claimed.
    let unknown = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/channel/next?filter=nobody"),
        "",
    );
    assert_eq!(unknown.status, 404, "{}", unknown.body);
    assert_eq!(
        unknown.json()["error"]["code"],
        json!("unknown_filter_profile")
    );
    // And a run that is not there, on every verb.
    for (method, path) in [
        (
            "GET",
            "/api/v2/runs/run-that-is-not-there/channel".to_owned(),
        ),
        (
            "POST",
            "/api/v2/runs/run-that-is-not-there/channel/next".to_owned(),
        ),
        (
            "POST",
            "/api/v2/runs/run-that-is-not-there/channel/surface".to_owned(),
        ),
    ] {
        let absent = if method == "GET" {
            http::get(serving.address, &path)
        } else {
            http::post(
                serving.address,
                &path,
                r#"{"kind":"finding","message":"x"}"#,
            )
        };
        assert_eq!(absent.status, 404, "{path}: {}", absent.body);
        assert_eq!(
            absent.json()["error"]["code"],
            json!("run_not_found"),
            "{path}"
        );
    }
}

#[test]
fn a_reply_reaches_the_engine_byte_for_byte_and_is_answered_in_its_words() {
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let run = fixture_run::RUN_ID;
    let reply = format!("/api/v2/runs/{run}/channel/reply");

    // Malformed: the engine's own refusal text, not this server's reading of
    // the body — which it never makes.
    let malformed = http::post(serving.address, &reply, r#"{"nope":"#);
    assert_eq!(malformed.status, 422, "{}", malformed.body);
    let malformed = malformed.json();
    assert_eq!(malformed["error"]["code"], json!("refused"));
    assert!(
        malformed["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("the reply is malformed")),
        "{malformed}"
    );

    // An author the run's launch never declared, issuing an op: judged by the
    // launch configuration inside the engine, and refused naming the author —
    // which is the proof the author reached it unrewritten.
    let ungranted = http::post(
        serving.address,
        &reply,
        r###"{"version": 2, "author": "sentinel", "commands": [{"op": "add", "node": {"id": "extra", "persona": "engineer", "task": "## What\ndo more"}}]}"###,
    );
    assert_eq!(ungranted.status, 422, "{}", ungranted.body);
    let ungranted = ungranted.json();
    assert_eq!(ungranted["error"]["code"], json!("refused"));
    assert!(
        ungranted["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("sentinel")),
        "the refusal names the author the body named: {ungranted}"
    );

    // A correlation that is not one, refused at the boundary — through the
    // bus's own parser, whose words say what a correlation is.
    let uncorrelated = http::post(
        serving.address,
        &format!("{reply}?correlation=not%20a%20token"),
        r#"{"version": 2, "commands": []}"#,
    );
    assert_eq!(uncorrelated.status, 422, "{}", uncorrelated.body);
    let uncorrelated = uncorrelated.json();
    assert_eq!(uncorrelated["error"]["code"], json!("invalid_correlation"));
    assert!(
        uncorrelated["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("is not a correlation")),
        "{uncorrelated}"
    );

    // A correlation the bus's parser accepts reaches the engine beside the
    // bytes, and the engine rules on the pair: a correlation names the question
    // a verdict answers, so an envelope carrying no verdict under one is the
    // engine's refusal — in its words, naming the token it was handed, which is
    // the proof the token reached it unchanged.
    let correlated = http::post(
        serving.address,
        &format!("{reply}?correlation=c-0123456789abcdef0123456789abcdef"),
        r###"{"version": 2, "commands": [{"op": "add", "node": {"id": "extra", "persona": "engineer", "task": "## What\ndo more"}}]}"###,
    );
    assert_eq!(correlated.status, 422, "{}", correlated.body);
    let correlated = correlated.json();
    assert_eq!(correlated["error"]["code"], json!("refused"));
    assert!(
        correlated["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("c-0123456789abcdef0123456789abcdef")
                && said.contains("carries no verdict")),
        "{correlated}"
    );

    // An edit, applied by the reply itself because nothing is driving the run,
    // answered with the receipt — and the omitted author is the planner, by the
    // engine's own contract, as the record the edit left says.
    let applied = http::post(
        serving.address,
        &reply,
        r###"{"version": 2, "commands": [{"op": "add", "node": {"id": "extra", "persona": "engineer", "task": "## What\ndo more"}}]}"###,
    );
    assert_eq!(applied.status, 200, "{}", applied.body);
    let applied = applied.json();
    assert_enveloped(&applied);
    assert_eq!(applied["run_id"], json!(run));
    assert_eq!(applied["receipt"]["state"], json!("applied"), "{applied}");
    assert_eq!(applied["receipt"]["commands"], json!("applied"));
    assert_eq!(applied["receipt"]["reply"], json!(0));
    assert_eq!(applied["advice"], json!([]));
    let detail = http::get(serving.address, &format!("/api/v2/runs/{run}")).json();
    assert!(
        detail["graph"]["plan"]["tasks"]
            .as_array()
            .expect("the plan's tasks")
            .iter()
            .any(|task| task["id"] == json!("extra")),
        "the edit reached the graph: {detail}"
    );
    let timeline = http::get(
        serving.address,
        &format!("/api/v2/runs/{run}/timeline?scope=run"),
    )
    .json();
    let committed: Vec<Value> = events_on(&timeline)
        .into_iter()
        .filter(|event| event["kind"] == json!("edit-committed"))
        .collect();
    assert_eq!(committed.len(), 1, "{timeline}");
    assert_eq!(
        committed[0]["redirection"]["author"]
            .as_str()
            .or(committed[0]["author"].as_str()),
        Some("planner"),
        "an omitted author is the planner: {}",
        committed[0]
    );
}

#[test]
fn an_attestation_completes_a_ready_human_action() {
    let serving = Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    });
    let run = fixture_run::RUN_ID;
    let attest = format!("/api/v2/runs/{run}/attest");

    // A reference nothing is waiting on: the engine's refusal.
    let unwaited = http::post(serving.address, &attest, r#"{"reference":"nobody-asked"}"#);
    assert_eq!(unwaited.status, 422, "{}", unwaited.body);
    let unwaited = unwaited.json();
    assert_eq!(unwaited["error"]["code"], json!("refused"));
    assert!(
        unwaited["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("nobody-asked")),
        "{unwaited}"
    );
    // And a body that is not the shape.
    let shapeless = http::post(serving.address, &attest, r#"{"ref":"signoff"}"#);
    assert_eq!(shapeless.status, 422, "{}", shapeless.body);
    assert_eq!(shapeless.json()["error"]["code"], json!("invalid_request"));

    // The ready human action the live run holds, attested: the receipt, and
    // the decision gone from the graph.
    let before = http::get(serving.address, &format!("/api/v2/runs/{run}")).json();
    assert!(
        before["graph"]["decisions"]
            .as_array()
            .expect("decisions")
            .iter()
            .any(|decision| decision["id"] == json!(fixture_run::SIGNOFF_NODE_ID)),
        "{before}"
    );
    let attested = http::post(
        serving.address,
        &attest,
        &json!({ "reference": fixture_run::SIGNOFF_NODE_ID }).to_string(),
    );
    assert_eq!(attested.status, 200, "{}", attested.body);
    let attested = attested.json();
    assert_enveloped(&attested);
    assert_eq!(attested["receipt"]["state"], json!("applied"), "{attested}");
    // Applied by the call itself, because nothing is driving the run: the
    // engine's own fold now settles the action, and the run's record says who
    // attested what. The decision's *clearing* is the driver's to journal on
    // its next pass — `an_adoption_retains_this_binary_and_the_driver_outlives_the_server`
    // drives that half — so what a driverless run shows here is the
    // attestation and the node's status as the engine folds it.
    let status = http::get(serving.address, &format!("/api/v2/runs/{run}/status")).json();
    assert_eq!(
        status["node_status"][fixture_run::SIGNOFF_NODE_ID],
        json!("done"),
        "{status}"
    );
    let timeline = http::get(
        serving.address,
        &format!("/api/v2/runs/{run}/timeline?scope=run"),
    )
    .json();
    assert!(
        events_on(&timeline)
            .iter()
            .any(|event| event["kind"] == json!("human-attested")),
        "{timeline}"
    );
    // And attested twice is refused: nothing is waiting on it any more.
    let again = http::post(
        serving.address,
        &attest,
        &json!({ "reference": fixture_run::SIGNOFF_NODE_ID }).to_string(),
    );
    assert_eq!(again.status, 422, "{}", again.body);
    assert_eq!(again.json()["error"]["code"], json!("refused"));
}

#[test]
fn a_stop_is_judged_by_the_acting_session() {
    let run = fixture_run::RUN_ID;
    let stop = format!("/api/v2/runs/{run}/stop");

    // A stranger's server: refused, naming the owner as the engine names it —
    // the launcher and a digest, never the session itself.
    let stranger = Serving::start_as(
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        STRANGER,
    );
    let refused = http::post(stranger.address, &stop, "");
    assert_eq!(refused.status, 409, "{}", refused.body);
    let refused = refused.json();
    assert_eq!(refused["error"]["code"], json!("not_owner"));
    let owner = refused["error"]["message"].as_str().expect("the refusal");
    assert!(owner.contains("[claude-code:"), "{owner}");
    assert!(
        !owner.contains(fixture_run::SESSION),
        "the raw session is never served: {owner}"
    );
    // Forced: the owner is named, and the run is stopped anyway — journalled
    // forced, as `onepipeline stop --force` journals it.
    let forced = http::post(stranger.address, &stop, r#"{"force": true}"#);
    assert_eq!(forced.status, 200, "{}", forced.body);
    let forced = forced.json();
    assert_enveloped(&forced);
    assert_eq!(forced["stopped"], json!(true));
    assert_eq!(forced["forced"], json!(true));
    assert!(
        forced["owner"]
            .as_str()
            .is_some_and(|owner| owner.starts_with("[claude-code:")),
        "{forced}"
    );
    let timeline = http::get(
        stranger.address,
        &format!("/api/v2/runs/{run}/timeline?scope=run"),
    )
    .json();
    let stopped: Vec<Value> = events_on(&timeline)
        .into_iter()
        .filter(|event| event["kind"] == json!("run-stopped"))
        .collect();
    assert_eq!(stopped.len(), 1, "{timeline}");
    let row =
        http::get(stranger.address, "/api/v2/runs?include_settled=true").json()["runs"][0].clone();
    assert_eq!(row["phase"], json!("finished"), "{row}");

    // The owner's own server, named on the command line: stopped, not forced.
    let owner = Serving::start_as(
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        fixture_run::SESSION,
    );
    let stopped = http::post(owner.address, &stop, "");
    assert_eq!(stopped.status, 200, "{}", stopped.body);
    let stopped = stopped.json();
    assert_eq!(stopped["forced"], json!(false));
    assert_eq!(stopped["owner"], json!("[mine]"));
    assert_eq!(stopped["teardown"], json!("elsewhere"));

    // The same session from the environment the engine's own CLI reads, with
    // no flag: the same answer.
    let inherited = Serving::start_with_env(
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        &[(onepipeline_ui::cli::SESSION_ENV, fixture_run::SESSION)],
    );
    let stopped = http::post(inherited.address, &stop, "");
    assert_eq!(stopped.status, 200, "{}", stopped.body);
    assert_eq!(stopped.json()["forced"], json!(false));

    // An unattributed server owns nothing, so it is refused every stop it does
    // not force.
    let nobody = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
    });
    let refused = http::post(nobody.address, &stop, "");
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert_eq!(refused.json()["error"]["code"], json!("not_owner"));
    let forced = http::post(nobody.address, &stop, r#"{"force": true}"#);
    assert_eq!(forced.status, 200, "{}", forced.body);
    assert_eq!(forced.json()["forced"], json!(true));
    // And a body that is not the shape is refused before the engine is asked.
    let shapeless = http::post(nobody.address, &stop, r#"{"force": "yes"}"#);
    assert_eq!(shapeless.status, 422, "{}", shapeless.body);
    assert_eq!(shapeless.json()["error"]["code"], json!("invalid_request"));
}

/// The `host-shutdown` records one run's journal carries.
fn host_shutdowns(serving: &Serving, run: &str) -> Vec<Value> {
    events_on(
        &http::get(
            serving.address,
            &format!("/api/v2/runs/{run}/timeline?scope=run"),
        )
        .json(),
    )
    .into_iter()
    .filter(|event| event["kind"] == json!("host-shutdown"))
    .collect()
}

/// Whether a run's own record, read through the API, says a host shutdown put
/// it down.
fn held_for_shutdown(serving: &Serving, run: &str) -> bool {
    !host_shutdowns(serving, run).is_empty()
}

#[test]
fn a_run_shutdown_is_the_engines_report_under_the_acting_session() {
    let run = fixture_run::RUN_ID;
    let shutdown = format!("/api/v2/runs/{run}/shutdown");
    let owner = Serving::start_as(
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
            fixture_run::write(root, fixture_run::OTHER_RUN_ID);
        },
        fixture_run::SESSION,
    );

    // An empty body is the default shutdown: the engine's own grace, nothing
    // forced — answered with the engine's report of this one run.
    let answered = http::post(owner.address, &shutdown, "");
    assert_eq!(answered.status, 200, "{}", answered.body);
    let report = answered.json();
    assert_enveloped(&report);
    assert_eq!(report["scope"], json!("run"), "{report}");
    assert_eq!(report["complete"], json!(true), "{report}");
    assert_eq!(
        report["grace_seconds"],
        json!(onepipeline::cli::DEFAULT_SHUTDOWN_GRACE_SECONDS)
    );
    assert_eq!(report["forced"], json!(false));
    assert_eq!(
        report["root"],
        json!(owner.runs_root().display().to_string()),
        "the report names the runs root it read"
    );
    let runs = report["runs"].as_array().expect("the runs acted on");
    assert_eq!(runs.len(), 1, "one run, and only the one named: {report}");
    assert_eq!(runs[0]["run_id"], json!(run));
    assert_eq!(runs[0]["owner"], json!("[mine]"));
    assert_eq!(runs[0]["forced_over_owner"], json!(false));
    assert_eq!(
        runs[0]["dispatches"],
        json!([]),
        "nothing live to interrupt"
    );
    // The driver was recorded on another host, so this one signals nothing and
    // says so in `stop`'s own word.
    assert_eq!(runs[0]["teardown"], json!("elsewhere"));
    assert!(report["not_pushed"].is_array(), "{report}");
    let rendered = report["rendered"].as_str().expect("the engine's own text");
    assert!(
        rendered.starts_with("shutdown  scope run  grace 600s"),
        "{rendered}"
    );
    assert!(rendered.contains(run), "{rendered}");
    // The run's own record says a host shutdown put it down — and it is not a
    // stop: no `run-stopped` is journalled, and the run stays adoptable.
    let recorded = host_shutdowns(&owner, run);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert!(held_for_shutdown(&owner, run));
    assert!(
        !held_for_shutdown(&owner, fixture_run::OTHER_RUN_ID),
        "a run scope acts on the run it names and no other"
    );

    // A grace and a force, as the body names them.
    let forced = http::post(owner.address, &shutdown, r#"{"grace": 30, "force": true}"#);
    assert_eq!(forced.status, 200, "{}", forced.body);
    let forced = forced.json();
    assert_eq!(forced["grace_seconds"], json!(30), "{forced}");
    assert_eq!(forced["forced"], json!(true));
    // And a grace of zero is the engine's force path, without the flag.
    let zero = http::post(owner.address, &shutdown, r#"{"grace": 0}"#).json();
    assert_eq!(zero["grace_seconds"], json!(0), "{zero}");
    assert_eq!(zero["forced"], json!(true), "{zero}");
}

#[test]
fn a_refused_shutdown_is_the_engines_refusal_and_signals_nothing() {
    let run = fixture_run::RUN_ID;
    let shutdown = format!("/api/v2/runs/{run}/shutdown");
    let stranger = Serving::start_as(
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        STRANGER,
    );

    // Another session's run, under the run scope: `409 not_owner`, naming the
    // owner as the engine names it, and nothing held or journalled.
    let refused = http::post(stranger.address, &shutdown, "");
    assert_eq!(refused.status, 409, "{}", refused.body);
    let refused = refused.json();
    assert_eq!(refused["error"]["code"], json!("not_owner"));
    let said = refused["error"]["message"].as_str().expect("the refusal");
    assert!(said.contains("[claude-code:"), "{said}");
    assert!(!said.contains(fixture_run::SESSION), "{said}");
    // Not even forced: `force` skips the wait, never the ownership rule.
    let forced = http::post(stranger.address, &shutdown, r#"{"force": true}"#);
    assert_eq!(forced.status, 409, "{}", forced.body);
    assert!(!held_for_shutdown(&stranger, run), "nothing was signalled");
    assert_eq!(host_shutdowns(&stranger, run), Vec::<Value>::new());

    // A run that is not there.
    let absent = http::post(
        stranger.address,
        "/api/v2/runs/run-that-is-not-there/shutdown",
        "",
    );
    assert_eq!(absent.status, 404, "{}", absent.body);
    assert_eq!(absent.json()["error"]["code"], json!("run_not_found"));

    // Bodies that are not the shape, refused before the engine is asked.
    for body in [
        r#"{"grace": -1}"#,
        r#"{"grace": "ten minutes"}"#,
        r#"{"grace": 1.5}"#,
        r#"{"force": "yes"}"#,
        r#"{"scope": "host"}"#,
        "not json",
    ] {
        let shapeless = http::post(stranger.address, &shutdown, body);
        assert_eq!(shapeless.status, 422, "{body}: {}", shapeless.body);
        assert_eq!(
            shapeless.json()["error"]["code"],
            json!("invalid_request"),
            "{body}"
        );
    }
    for body in [
        "",
        "{}",
        r#"{"scope": "run"}"#,
        r#"{"scope": "host", "grace": -5}"#,
    ] {
        let shapeless = http::post(stranger.address, "/api/v2/shutdown", body);
        assert_eq!(shapeless.status, 422, "{body}: {}", shapeless.body);
        assert_eq!(
            shapeless.json()["error"]["code"],
            json!("invalid_request"),
            "{body}"
        );
    }
    // A grace this host's clock cannot count to: the engine's own refusal.
    let unbounded = http::post(
        stranger.address,
        "/api/v2/shutdown",
        &json!({ "scope": "host", "grace": u64::MAX }).to_string(),
    );
    assert_eq!(unbounded.status, 422, "{}", unbounded.body);
    assert_eq!(unbounded.json()["error"]["code"], json!("refused"));
    assert!(!held_for_shutdown(&stranger, run), "nothing was signalled");
}

#[test]
fn mine_acts_on_this_sessions_runs_and_host_on_every_run_naming_each_owner() {
    let mine = fixture_run::RUN_ID;
    let theirs = fixture_run::OTHER_RUN_ID;
    let build = |root: &Path| {
        fixture_run::write(root, mine);
        fixture_run::write(root, theirs);
        fixture_run::launched_by(root, theirs, "codex", fixture_run::LIVE_SESSION);
    };

    // `mine`: this session's run, and never another's — which is left exactly
    // as it was.
    let serving = Serving::start_as(build, fixture_run::SESSION);
    let answered = http::post(
        serving.address,
        "/api/v2/shutdown",
        r#"{"scope": "mine", "grace": 45}"#,
    );
    assert_eq!(answered.status, 200, "{}", answered.body);
    let report = answered.json();
    assert_enveloped(&report);
    assert_eq!(report["scope"], json!("mine"), "{report}");
    assert_eq!(report["grace_seconds"], json!(45));
    let acted: Vec<&Value> = report["runs"]
        .as_array()
        .expect("the runs acted on")
        .iter()
        .map(|run| &run["run_id"])
        .collect();
    assert_eq!(acted, vec![&json!(mine)], "{report}");
    assert_eq!(report["runs"][0]["owner"], json!("[mine]"));
    assert!(held_for_shutdown(&serving, mine));
    assert!(
        !held_for_shutdown(&serving, theirs),
        "another session's run"
    );
    assert_eq!(host_shutdowns(&serving, theirs), Vec::<Value>::new());

    // `host`: every run under the root, whoever owns it — acting over the
    // ownership rule and naming the owner it acted over.
    let serving = Serving::start_as(build, fixture_run::SESSION);
    let answered = http::post(serving.address, "/api/v2/shutdown", r#"{"scope": "host"}"#);
    assert_eq!(answered.status, 200, "{}", answered.body);
    let report = answered.json();
    assert_eq!(report["scope"], json!("host"), "{report}");
    assert_eq!(
        report["grace_seconds"],
        json!(onepipeline::cli::DEFAULT_SHUTDOWN_GRACE_SECONDS)
    );
    let runs = report["runs"].as_array().expect("the runs acted on");
    assert_eq!(runs.len(), 2, "{report}");
    let other = runs
        .iter()
        .find(|run| run["run_id"] == json!(theirs))
        .unwrap_or_else(|| panic!("the other session's run was acted on: {report}"));
    assert_eq!(other["forced_over_owner"], json!(true), "{other}");
    let owner = other["owner"].as_str().expect("the owner");
    assert!(owner.starts_with("[codex:"), "the owner is named: {owner}");
    assert!(!owner.contains(fixture_run::LIVE_SESSION), "{owner}");
    let own = runs
        .iter()
        .find(|run| run["run_id"] == json!(mine))
        .expect("this session's own run");
    assert_eq!(own["forced_over_owner"], json!(false));
    assert!(
        report["rendered"]
            .as_str()
            .is_some_and(|said| said.contains("which is another session's run")),
        "{report}"
    );
    assert!(held_for_shutdown(&serving, mine));
    assert!(held_for_shutdown(&serving, theirs));
    assert_eq!(host_shutdowns(&serving, theirs).len(), 1);
}

/// A process that outlives the shell that started it, so that nothing in this
/// test is its parent: `init` reaps it the moment a teardown ends it, which is
/// what a dispatch whose driver has gone looks like to the host.
#[cfg(target_os = "linux")]
struct Orphan(u32);

#[cfg(target_os = "linux")]
impl Orphan {
    fn start() -> Self {
        let said = std::process::Command::new("sh")
            .args(["-c", "sleep 300 >/dev/null 2>&1 & echo $!"])
            .output()
            .expect("sh runs");
        let pid: u32 = String::from_utf8_lossy(&said.stdout)
            .trim()
            .parse()
            .expect("the orphan's pid");
        Self(pid)
    }

    /// Its start token as the kernel records it, in the spelling a dispatch
    /// registry entry carries on Linux: the start time `/proc/PID/stat` gives.
    fn started(&self) -> String {
        let stat = fs::read_to_string(format!("/proc/{}/stat", self.0)).expect("its stat");
        let ticks = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(19))
            .expect("the start time");
        format!("linux-proc-stat:{ticks}")
    }

    fn alive(&self) -> bool {
        Path::new(&format!("/proc/{}", self.0)).exists()
    }
}

#[cfg(target_os = "linux")]
impl Drop for Orphan {
    fn drop(&mut self) {
        if self.alive() {
            // This test started it; it is the one process the test may end.
            let _ = std::process::Command::new("kill")
                .arg(self.0.to_string())
                .status();
        }
    }
}

// llmlint: ignore-block[tests_mirror_real_usage] in both journeys below, the dispatch registry entry is the one a
// driver writes when it starts a node's process — node, pid, this host and the process's own
// start token — and the journey writes it rather than earning it through a driver, because a
// driver that keeps a dispatch alive for as long as a journey needs is one running a harness
// and a model. The process it names is real, started here and proven alive by the engine's own
// probe, and everything after the entry — the ask, the wait, the teardown that kills it, and
// the report — is the engine's, reached through the route.
#[cfg(target_os = "linux")]
#[test]
fn a_shutdown_that_killed_a_dispatch_answers_its_whole_report_as_not_complete() {
    let run = fixture_run::RUN_ID;
    let shutdown = format!("/api/v2/runs/{run}/shutdown");
    let worker = Orphan::start();
    let started = worker.started();
    let serving = Serving::start_as(
        |root| {
            fixture_run::write(root, run);
            fixture_run::dispatching_on_this_host(
                root,
                run,
                fixture_run::NODE_ID,
                worker.0,
                &started,
            );
        },
        fixture_run::SESSION,
    );

    // A dispatch that is asked, waited on for a second, and does not go: the
    // deadline reaps it. That is a shutdown that did not do what it was asked,
    // and it is answered `200` with the whole report saying so.
    let answered = http::post(serving.address, &shutdown, r#"{"grace": 1}"#);
    assert_eq!(answered.status, 200, "{}", answered.body);
    let report = answered.json();
    assert_enveloped(&report);
    assert_eq!(report["complete"], json!(false), "{report}");
    let dispatches = report["runs"][0]["dispatches"]
        .as_array()
        .unwrap_or_else(|| panic!("the dispatches acted on: {report}"));
    assert_eq!(dispatches.len(), 1, "{report}");
    let stopped = &dispatches[0];
    assert_eq!(stopped["node"], json!(fixture_run::NODE_ID));
    assert_eq!(stopped["pid"], json!(worker.0));
    // Asked: the turn the run's records named was sent the redirection, and
    // what the lever answered — no turn there, or a lever that broke — is the
    // engine's own word. Neither is a failure of the shutdown; the deadline
    // applies either way.
    assert!(
        matches!(
            stopped["interrupt"].as_str(),
            Some("no-turn" | "failed" | "delivered")
        ),
        "{stopped}"
    );
    assert_eq!(stopped["ended"], json!("killed"), "{stopped}");
    assert!(
        stopped["waited_ms"]
            .as_u64()
            .is_some_and(|waited| waited >= 1_000),
        "the grace was waited out: {stopped}"
    );
    assert_eq!(
        report["runs"][0]["teardown"],
        json!("signalled"),
        "{report}"
    );
    assert!(!worker.alive(), "the teardown ended the dispatch");
}

#[cfg(target_os = "linux")]
#[test]
fn a_forced_shutdown_asks_nothing_and_its_teardown_is_complete() {
    let run = fixture_run::RUN_ID;
    let worker = Orphan::start();
    let started = worker.started();
    let serving = Serving::start_as(
        |root| {
            fixture_run::write(root, run);
            fixture_run::dispatching_on_this_host(
                root,
                run,
                fixture_run::NODE_ID,
                worker.0,
                &started,
            );
        },
        fixture_run::SESSION,
    );
    let answered = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/shutdown"),
        r#"{"force": true}"#,
    );
    assert_eq!(answered.status, 200, "{}", answered.body);
    let report = answered.json();
    // Torn down without being asked is exactly what a forced shutdown asks
    // for, so the engine counts it complete.
    assert_eq!(report["complete"], json!(true), "{report}");
    let stopped = &report["runs"][0]["dispatches"][0];
    assert_eq!(stopped["interrupt"], json!("not-asked"), "{report}");
    assert_eq!(stopped["ended"], json!("killed"), "{report}");
    assert!(!worker.alive(), "the teardown ended the dispatch");
}
// llmlint: ignore-end[tests_mirror_real_usage]

#[test]
fn a_shutdown_that_could_not_preserve_a_branch_answers_its_whole_report_as_not_complete() {
    // The live run's records name the branch its pr-author node works on, in a
    // repository this host's `onevcs` state root has never heard of — the
    // served workspace's own, empty. The push is refused, and the shutdown
    // says so rather than failing: `200`, the whole report, not complete.
    let run = fixture_run::RUN_ID;
    let serving = Serving::start_as(
        |root| {
            fixture_run::write_live(root, run);
            fs::create_dir_all(onepipeline::views::RunPaths::under(root, run).dispatches())
                .expect("the dispatch registry");
        },
        fixture_run::LIVE_SESSION,
    );
    let answered = http::post(
        serving.address,
        &format!("/api/v2/runs/{run}/shutdown"),
        r#"{"force": true}"#,
    );
    assert_eq!(answered.status, 200, "{}", answered.body);
    let report = answered.json();
    assert_enveloped(&report);
    assert_eq!(report["complete"], json!(false), "{report}");
    let branch = &report["runs"][0]["branches"][0];
    assert_eq!(
        branch["identity"],
        json!("nickderobertis/onepipeline-ui"),
        "{report}"
    );
    assert_eq!(branch["branch"], json!("feature/ship"), "{report}");
    assert_eq!(branch["result"], json!("refused"), "{report}");
    assert_eq!(branch["remote"], Value::Null, "{report}");
    assert!(
        branch["detail"]
            .as_str()
            .is_some_and(|why| why.contains("not a registered repository")),
        "the refusal is the sibling's own words: {branch}"
    );
    assert!(
        report["rendered"]
            .as_str()
            .is_some_and(|said| said.contains("could not be preserved")),
        "{report}"
    );
    // The teardown itself was clean: what the report withholds success over is
    // the branch alone.
    assert_eq!(
        report["runs"][0]["teardown"],
        json!("elsewhere"),
        "{report}"
    );
    assert_eq!(report["not_pushed"], json!([]), "{report}");
}

#[test]
fn the_acting_sessions_key_is_the_one_its_own_runs_rows_carry() {
    let build = |root: &Path| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
        fixture_run::launched_by(
            root,
            fixture_run::OTHER_RUN_ID,
            "codex",
            fixture_run::LIVE_SESSION,
        );
    };
    let serving = Serving::start_as(build, fixture_run::SESSION);
    let unwatched = http::get(serving.address, "/api/v2/unwatched").json();
    let key = unwatched["session_key"]
        .as_str()
        .unwrap_or_else(|| panic!("the acting session's key: {unwatched}"));
    assert!(
        !key.contains(fixture_run::SESSION),
        "the raw session is never served: {key}"
    );
    // A client reading the run list tells this session's run from another's
    // by that key, which is the key the rows name their launcher's session by.
    let rows = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let key_of = |run: &str| {
        rows["runs"]
            .as_array()
            .expect("the rows")
            .iter()
            .find(|row| row["run_id"] == json!(run))
            .and_then(|row| row["launch"]["session_key"].as_str())
            .unwrap_or_else(|| panic!("{run} names its session: {rows}"))
            .to_owned()
    };
    assert_eq!(key_of(fixture_run::RUN_ID), key, "{rows}");
    assert_ne!(key_of(fixture_run::OTHER_RUN_ID), key, "{rows}");

    // An unattributed server owns no run, and names no session.
    let nobody = Serving::start(build);
    let unwatched = http::get(nobody.address, "/api/v2/unwatched").json();
    assert!(unwatched.get("session_key").is_none(), "{unwatched}");
}

// llmlint: ignore-block[tests_mirror_real_usage] the state is the one the engine itself
// records for a run being driven — a launch record naming a live pid on this host, which is
// what `onepipeline adopt` and the adopt route write — and the journey writes that record
// rather than earning it through the adopt route, because a driver that stays driving for
// as long as a journey needs is one dispatching a node, which takes a harness and a model.
// The driver a deterministic fixture can earn settles its one human action as waiting and
// lets go on its own clock, as `an_adoption_retains_this_binary_and_the_driver_outlives_the_server`
// below shows, so a second adoption raced against it would be refused or accepted by
// timing. The pid named is this test's own instead: a process proven alive for the whole
// journey, read by the engine's own probe, and the refusal is the engine's own.
#[test]
fn an_adoption_of_a_run_something_is_driving_is_refused() {
    // A run whose driver is a live process on this host — this very test —
    // is being driven, and the engine refuses to take it over: its own
    // refusal, naming the way out, before anything is written.
    let serving = Serving::start_as(
        |root| {
            fixture_run::write_live(root, fixture_run::RUN_ID);
            fixture_run::driven_on_this_host(root, fixture_run::RUN_ID, std::process::id());
        },
        fixture_run::LIVE_SESSION,
    );
    let adoptions = |address| {
        events_on(
            &http::get(
                address,
                &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
            )
            .json(),
        )
        .iter()
        .filter(|event| event["kind"] == json!("driver-adopted"))
        .count()
    };
    let before = adoptions(serving.address);
    let driving = http::post(
        serving.address,
        &format!("/api/v2/runs/{}/adopt", fixture_run::RUN_ID),
        "",
    );
    assert_eq!(driving.status, 422, "{}", driving.body);
    let driving = driving.json();
    assert_eq!(driving["error"]["code"], json!("refused"));
    assert!(
        driving["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("still being driven")),
        "{driving}"
    );
    assert_eq!(adoptions(serving.address), before, "nothing was written");
    // And a run that is not there.
    let absent = http::post(
        serving.address,
        "/api/v2/runs/run-that-is-not-there/adopt",
        "",
    );
    assert_eq!(absent.status, 404, "{}", absent.body);
    assert_eq!(absent.json()["error"]["code"], json!("run_not_found"));
}
// llmlint: ignore-end[tests_mirror_real_usage]

// llmlint: ignore-block[expensive_tests_stay_behind_their_own_edge] this journey is not
// expensive: it runs in under two seconds — three drivers, each settling a one-node graph
// and exiting — and the sixty seconds beside it is `DRIVER_PATIENCE`, the ceiling a
// *failing* wait reaches before it gives up, which no passing run pays. The tiers behind
// edges of their own here are the ones that need something a checkout may lack (`strace`,
// the base commit's server); this needs the compiled binary every other journey in this
// module drives.
#[cfg(unix)]
#[test]
fn an_adoption_retains_this_binary_and_the_driver_outlives_the_server() {
    let (workspace, root) = fixture_run::workspace();
    let dir = workspace.path().to_path_buf();
    fixture_run::write_awaiting_attestation(&root, fixture_run::RUN_ID, &dir);
    let run = fixture_run::RUN_ID;
    let adopt = format!("/api/v2/runs/{run}/adopt");
    let detail = |address| http::get(address, &format!("/api/v2/runs/{run}")).json();
    let events = |address| {
        events_on(&http::get(address, &format!("/api/v2/runs/{run}/timeline?scope=run")).json())
    };
    // How many times the run's own record says it was adopted: the journalled
    // `driver-adopted`, which the driver writes once it holds the run.
    let adoptions = |address| {
        events(address)
            .iter()
            .filter(|event| event["kind"] == json!("driver-adopted"))
            .count()
    };

    // Refused for a stranger, before anything is written.
    let stranger = Serving::start_in_as(workspace, STRANGER);
    let refused = http::post(stranger.address, &adopt, "");
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert_eq!(refused.json()["error"]["code"], json!("not_owner"));
    assert_eq!(adoptions(stranger.address), 0);
    let (_, workspace) = stranger.stop_keeping_workspace(Stop::Terminate);

    // Adopted by the owner: the driver's pid answered, and **the server stopped
    // at once** — before the driver has done anything but claim the run. The
    // driver was never the server's to end: it goes on, drives the run, and
    // everything it writes is written to a run no server is serving.
    let serving = Serving::start_in_as(workspace, fixture_run::SESSION);
    let adopted = http::post(serving.address, &adopt, "");
    assert_eq!(adopted.status, 200, "{}", adopted.body);
    let adopted = adopted.json();
    assert_enveloped(&adopted);
    assert_eq!(adopted["run_id"], json!(run));
    let pid = u32::try_from(adopted["pid"].as_u64().expect("the driver's pid")).expect("a pid");
    let driver = RetainedDriver(pid);
    assert!(process_is_live(pid), "the pid answered is a process");
    let (status, workspace) = serving.stop_keeping_workspace(Stop::Terminate);
    assert!(status.success(), "{status}");

    // What the driver does after that is the engine's own: it folds the graph,
    // finds one human action nobody has taken, settles it as waiting — there is
    // nothing to dispatch — and, with nothing left that can move without the
    // channel, lets go of the run. All of it read off the run record by a
    // server started afterwards, which held no handle on any of it.
    let restarted = Serving::start_in_as(workspace, fixture_run::SESSION);
    eventually("the driver settled the human action as waiting", || {
        events(restarted.address).iter().any(|event| {
            event["kind"] == json!("node-settled")
                && event["node_id"] == json!(fixture_run::APPROVAL_NODE_ID)
        })
    });
    assert!(
        events(restarted.address)
            .iter()
            .any(|event| event["kind"] == json!("driver-adopted")),
        "the adoption is journalled"
    );
    let driven = detail(restarted.address);
    assert_eq!(
        driven["graph"]["node_status"][fixture_run::APPROVAL_NODE_ID],
        json!("waiting"),
        "{driven}"
    );
    // The driver let go, and the reader proves it gone rather than leaving
    // the run reading as driven for as long as any server lives: it was the
    // server that retained it that would have had to reap it, and that server
    // is gone, so `init` did. What the run reads as is what the engine's own
    // rule makes of a driver on this host that is not there.
    eventually("the driver let go of the run", || !process_is_live(pid));
    eventually("the run reads as one nothing is driving", || {
        detail(restarted.address)["run"]["state"] == json!("driver-dead")
    });
    drop(driver);

    // The person answers. Nothing is driving the run, so the attestation is
    // applied by the call itself — and a second adoption, retained by this
    // server and reaped by it, drives the graph to completion.
    let attested = http::post(
        restarted.address,
        &format!("/api/v2/runs/{run}/attest"),
        &json!({ "reference": fixture_run::APPROVAL_NODE_ID }).to_string(),
    );
    assert_eq!(attested.status, 200, "{}", attested.body);
    assert_eq!(attested.json()["receipt"]["state"], json!("applied"));
    let again = http::post(restarted.address, &adopt, "");
    assert_eq!(again.status, 200, "{}", again.body);
    let second = u32::try_from(again.json()["pid"].as_u64().expect("a pid")).expect("a pid");
    let driver = RetainedDriver(second);
    assert_ne!(second, pid);
    eventually("the second adoption was journalled", || {
        adoptions(restarted.address) == 2
    });
    eventually("the second driver completed the graph", || {
        detail(restarted.address)["run"]["state"] == json!("settled")
    });
    let settled = detail(restarted.address);
    assert_eq!(
        settled["graph"]["node_status"][fixture_run::APPROVAL_NODE_ID],
        json!("done"),
        "{settled}"
    );
    // And this server, the driver's parent, reaped it: a driver that has gone
    // is not a live process, so the run is adoptable again rather than read
    // as driven by a zombie until the server exits.
    eventually("the server reaped the driver it retained", || {
        !process_is_live(second)
    });
    drop(driver);
    // Adopting a settled run something is not driving is the engine's own
    // answer — a fresh driver that settles it again at once — and never a
    // refusal for a driver that is no longer there.
    let third = http::post(restarted.address, &adopt, "");
    assert_eq!(third.status, 200, "{}", third.body);
    let third = u32::try_from(third.json()["pid"].as_u64().expect("a pid")).expect("a pid");
    let driver = RetainedDriver(third);
    eventually("the third driver settled and was reaped", || {
        !process_is_live(third)
    });
    drop(driver);
}
// llmlint: ignore-end[expensive_tests_stay_behind_their_own_edge]

/// The harness stand-in a dispatch here runs: it records the argv it was given
/// and answers as the adapter expects, so a journey can read back *that* it ran
/// and *what as*.
///
/// The harness program is the one process this suite stands in for, and it is
/// the narrowest place to cut: everything above it — the adopt route, the
/// driver, the executor, the graph run, and the oneharness config loader that
/// picks this program — is the linked engine doing its own work. Standing in
/// for the engine instead, at `ONEPIPELINE_ONEAGENTGRAPH_BIN`, would be asking
/// a double whether the engine resolves a config chain.
#[cfg(unix)]
fn write_harness_standin(dir: &Path, log: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let standin = dir.join("fake-harness");
    // The log path is written into the script rather than read from the
    // environment, because what this journey may not assume is anything about
    // the environment the engine composes for a dispatch — that composition is
    // part of what is under test.
    fs::write(
        &standin,
        format!(
            "#!/bin/sh\nprintf '%s %s\\n' \"$0\" \"$*\" >> {:?}\nprintf '{{\"type\":\"result\",\
             \"subtype\":\"success\",\"is_error\":false,\"result\":\"done\",\
             \"session_id\":\"standin\"}}\\n'\n",
            log.display().to_string()
        ),
    )
    .expect("the harness stand-in");
    fs::set_permissions(&standin, std::fs::Permissions::from_mode(0o755))
        .expect("chmod the harness stand-in");
    standin
}

/// A oneharness config chain: `child.toml` names no harness of its own and
/// declares `parent.toml`, which names the one — and points it at the stand-in.
///
/// Split exactly the way an operator splits one, and the split is the assertion:
/// a reader that stopped at the child finds a config selecting no harness at
/// all, so a dispatch composed from it cannot run under `claude-code` by
/// accident. Only a reader that followed `extends` reaches the selection.
#[cfg(unix)]
fn write_extending_config(dir: &Path, standin: &Path) {
    fs::write(
        dir.join("parent.toml"),
        format!(
            "harnesses = [\"claude-code\"]\n\n[harness.claude-code]\nbin = {:?}\n",
            standin.display().to_string()
        ),
    )
    .expect("the parent config");
    fs::write(dir.join("child.toml"), "extends = \"./parent.toml\"\n").expect("the child config");
}

/// The node-scope graph a dispatch of the run's one node runs: one single-sided
/// member, naming the child of the config chain above.
///
/// Single-sided rather than the shipped default's two-party member, because a
/// single-sided member's turn is an `oneharness_core` library call — so the
/// chain is followed by the loader this binary links. The dispatch runs it in a
/// process of its own, and that process is *this executable* at its `drive`
/// verb rather than an installed sibling, which is what makes the resolution
/// under test this build's rather than whatever the host has on PATH.
#[cfg(unix)]
fn write_node_scope_graph(dir: &Path) -> PathBuf {
    let graph = dir.join("node-scope.yaml");
    fs::write(
        &graph,
        "version: 1\nname: node-scope\nmembers:\n  worker:\n    kind: oneharness\n    \
         oneharness_config: ./child.toml\n",
    )
    .expect("the node-scope graph");
    graph
}

// llmlint: ignore-block[expensive_tests_stay_behind_their_own_edge] this journey needs
// nothing a checkout may lack — the compiled binary every other journey in this module
// drives, and a `/bin/sh` script it writes itself — which is what the tiers behind edges
// of their own here need (`strace`, the base commit's server). It dispatches a real turn
// through a retained driver, and settles in about a second: measured, once the turn's
// oneharness history is under the journey's own state directory. The 27 seconds this
// once recorded, and the minutes a busy host made of it, were that turn queueing on the
// history lock every harness turn on the host shares rather than the engine's own work.
#[cfg(unix)]
#[test]
fn an_adopted_dispatch_runs_under_the_harness_its_configs_parent_names() {
    let (workspace, root) = fixture_run::workspace();
    let dir = workspace.path().to_path_buf();
    let log = dir.join("harness.log");
    let standin = write_harness_standin(&dir, &log);
    write_extending_config(&dir, &standin);
    let graph = write_node_scope_graph(&dir);
    let run = fixture_run::RUN_ID;
    fixture_run::write_awaiting_dispatch(&root, run, &dir, &graph);

    // The directory a dispatch of a direct node runs in, named rather than left
    // to default: that default is the server's own working directory, which for
    // this suite is the checkout it was built in — so a journey that dispatches
    // for real must say where, or the dispatch runs over this repository. The
    // state directory is named for the same reason: the turn records itself in
    // oneharness's history under it, behind a lock every harness turn on the
    // host otherwise shares, so a busy host would decide how long this waits.
    let state = dir.join("state");
    let serving = Serving::start_in_as_with_env(
        workspace,
        fixture_run::SESSION,
        &[
            ("ONEPIPELINE_PROJECT_DIR", &dir.display().to_string()),
            ("XDG_STATE_HOME", &state.display().to_string()),
        ],
    );
    let adopted = http::post(serving.address, &format!("/api/v2/runs/{run}/adopt"), "");
    assert_eq!(adopted.status, 200, "{}", adopted.body);
    let pid =
        u32::try_from(adopted.json()["pid"].as_u64().expect("the driver's pid")).expect("a pid");
    let driver = RetainedDriver(pid);

    // The run's own record says the adopt route reached a real dispatch: the
    // node went ready, was dispatched, and the graph that dispatch composed
    // started a member. Nothing here is the journey's to write — each is the
    // engine's, read back off the timeline the server serves.
    let kinds = |address| {
        events_on(&http::get(address, &format!("/api/v2/runs/{run}/timeline?scope=run")).json())
            .iter()
            .map(|event| event["kind"].clone())
            .collect::<Vec<_>>()
    };
    eventually(
        "the adoption dispatched the node over its node-scope graph",
        || kinds(serving.address).contains(&json!("member-started")),
    );
    assert!(
        kinds(serving.address).contains(&json!("node-dispatched")),
        "{:?}",
        kinds(serving.address)
    );

    // And the member that started ran the harness the **parent** config names,
    // reached only by following the child's `extends`. The stand-in records the
    // argv it was given, so what is asserted is the whole answer: the program
    // the chain selected, composed by the `claude-code` adapter the parent
    // asked for, carrying this node's own task.
    eventually(
        "the dispatch ran the harness the parent config names",
        || fs::read_to_string(&log).is_ok_and(|ran| ran.contains("fake-harness")),
    );
    let ran = fs::read_to_string(&log).expect("the harness stand-in's record");
    assert!(
        ran.contains(&standin.display().to_string()),
        "the dispatch ran a harness the parent config did not name: {ran}"
    );
    assert!(
        ran.contains("Do the work the graph dispatches."),
        "the harness was not given this node's task: {ran}"
    );
    drop(driver);
    serving.stop_on(Stop::Terminate);
}
// llmlint: ignore-end[expensive_tests_stay_behind_their_own_edge]

#[cfg(unix)]
#[test]
fn a_dispatch_whose_config_names_a_parent_that_is_not_there_settles_the_node() {
    // The recovery half of the journey above, over the same route and the same
    // chain: the child still declares a parent, and the parent is gone. A reader
    // that followed `extends` has nothing to fold and says so; the node settles
    // rather than the dispatch running under some default harness, and the run
    // stays readable over the API throughout.
    let (workspace, root) = fixture_run::workspace();
    let dir = workspace.path().to_path_buf();
    let log = dir.join("harness.log");
    let standin = write_harness_standin(&dir, &log);
    write_extending_config(&dir, &standin);
    fs::remove_file(dir.join("parent.toml")).expect("take the parent away");
    let graph = write_node_scope_graph(&dir);
    let run = fixture_run::RUN_ID;
    fixture_run::write_awaiting_dispatch(&root, run, &dir, &graph);

    let serving = Serving::start_in_as_with_env(
        workspace,
        fixture_run::SESSION,
        &[("ONEPIPELINE_PROJECT_DIR", &dir.display().to_string())],
    );
    let adopted = http::post(serving.address, &format!("/api/v2/runs/{run}/adopt"), "");
    assert_eq!(adopted.status, 200, "{}", adopted.body);
    let pid =
        u32::try_from(adopted.json()["pid"].as_u64().expect("the driver's pid")).expect("a pid");
    let driver = RetainedDriver(pid);

    let detail = || http::get(serving.address, &format!("/api/v2/runs/{run}")).json();
    eventually(
        "the node settled rather than running under a harness",
        || detail()["graph"]["node_status"][fixture_run::DISPATCH_NODE_ID] == json!("failed"),
    );
    // Settled as the engine settles a dispatch that could not start: the member
    // died where it was composed, and the node carries that outcome rather than
    // a harness's.
    assert_eq!(
        detail()["graph"]["node_results"][fixture_run::DISPATCH_NODE_ID]["outcome"],
        json!("dispatch-died"),
        "{}",
        detail()
    );
    let kinds = events_on(
        &http::get(
            serving.address,
            &format!("/api/v2/runs/{run}/timeline?scope=run"),
        )
        .json(),
    )
    .iter()
    .map(|event| event["kind"].clone())
    .collect::<Vec<_>>();
    assert!(kinds.contains(&json!("member-died")), "{kinds:?}");
    // And the whole of the point: no harness ran at all. A chain that cannot be
    // read selects nothing, rather than falling back to whatever the host has.
    assert!(
        !log.exists(),
        "a harness ran for a config chain that could not be read: {}",
        fs::read_to_string(&log).unwrap_or_default()
    );
    drop(driver);
    serving.stop_on(Stop::Terminate);
}

#[test]
fn a_watch_streams_frames_and_makes_the_server_the_runs_watcher() {
    // Acting as the live run's owner, because `unwatched` answers for the runs
    // the acting session owns and no other — and over a run whose summary
    // document is current, because that verb decides settlement off the
    // document alone and folds nothing, exactly as the CLI does.
    let serving = Serving::start_as(
        |root| {
            fixture_run::write_live(root, fixture_run::RUN_ID);
            fixture_run::summarize(root, fixture_run::RUN_ID);
        },
        fixture_run::LIVE_SESSION,
    );
    let run = fixture_run::RUN_ID;
    let watch = format!("/api/v2/runs/{run}/watch");
    let unwatched = |address| http::get(address, "/api/v2/unwatched").json();

    // Nothing watches the live run: reported, by the server and by the CLI.
    let before = unwatched(serving.address);
    assert_enveloped(&before);
    assert_eq!(before["reported"][0]["run"], json!(run), "{before}");
    assert!(before["reported"][0]["why_not_watched"]
        .as_str()
        .is_some_and(|why| !why.is_empty()));
    let said = sibling::run(
        &serving.runs_root(),
        Some(fixture_run::LIVE_SESSION),
        &["unwatched"],
    );
    assert!(
        String::from_utf8_lossy(&said.stdout).contains(run),
        "the CLI reports the run too: {}",
        String::from_utf8_lossy(&said.stderr)
    );

    // Held: the server is the watcher. The frames come as they happen — the
    // run's meaningful events first, then a heartbeat every tick.
    let mut stream = http::stream(
        serving.address,
        &format!("{watch}?timeout=none&tick=1&until=settled"),
        None,
    );
    assert_eq!(stream.status, 200);
    let first = stream.next_frame().expect("a frame");
    assert_eq!(first.event, "event", "{first:?}");
    assert_eq!(first.json()["watch"], json!("event"));
    let tick = std::iter::from_fn(|| stream.next_frame())
        .find(|frame| frame.event == "tick")
        .expect("a heartbeat");
    assert_eq!(tick.json()["run_id"], json!(run), "{tick:?}");
    let during = unwatched(serving.address);
    assert_eq!(during["reported"], json!([]), "{during}");
    let said = sibling::run(
        &serving.runs_root(),
        Some(fixture_run::LIVE_SESSION),
        &["unwatched"],
    );
    assert!(
        !String::from_utf8_lossy(&said.stdout).contains(run),
        "the CLI reads the run as watched while the stream is held: {}",
        String::from_utf8_lossy(&said.stdout)
    );

    // Closed by the client: the record goes with it.
    drop(stream);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let after = unwatched(serving.address);
        if after["reported"][0]["run"] == json!(run) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the watcher record outlived the stream: {after}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    // A watch of no seconds reads the run once and returns, ending the stream
    // on the `returned` frame.
    let mut once = http::stream(serving.address, &format!("{watch}?timeout=0"), None);
    let frames: Vec<http::Frame> = std::iter::from_fn(|| once.next_frame()).collect();
    let last = frames.last().expect("frames");
    assert_eq!(last.event, "returned", "{frames:?}");
    let returned = last.json();
    assert_eq!(returned["condition"], json!("elapsed"), "{returned}");
    assert!(returned["cursor"]
        .as_str()
        .is_some_and(|c| c.starts_with("1:")));
    // And resumed from that cursor, nothing already reported is reported again.
    let cursor = returned["cursor"].as_str().expect("a cursor").to_owned();
    let mut resumed = http::stream(
        serving.address,
        &format!("{watch}?timeout=0&cursor={cursor}"),
        None,
    );
    let frames: Vec<http::Frame> = std::iter::from_fn(|| resumed.next_frame()).collect();
    assert!(
        frames.iter().all(|frame| frame.event != "event"),
        "{frames:?}"
    );

    // Shaped through a filter, as the CLI's `--filter` shapes a watch: a spec
    // that excludes the settlements reports no event of them, and the stream
    // still returns.
    let mut shaped = http::stream(
        serving.address,
        &format!(
            "{watch}?timeout=0&filter={}",
            "%7B%22exclude%22%3A%5B%7B%22kind%22%3A%22node-settled%22%7D%5D%7D"
        ),
        None,
    );
    let frames: Vec<http::Frame> = std::iter::from_fn(|| shaped.next_frame()).collect();
    let settlements = |frames: &[http::Frame]| {
        frames
            .iter()
            .filter(|frame| frame.event == "event")
            .filter(|frame| frame.json()["event"]["kind"] == json!("node-settled"))
            .count()
    };
    assert_eq!(
        settlements(&frames),
        0,
        "the excluded settlements were reported: {frames:?}"
    );
    assert!(
        frames.iter().any(|frame| frame.event == "event"),
        "the events the spec admits are still reported: {frames:?}"
    );
    assert_eq!(
        frames.last().map(|frame| frame.event.as_str()),
        Some("returned")
    );
    let mut unshaped = http::stream(serving.address, &format!("{watch}?timeout=0"), None);
    let frames: Vec<http::Frame> = std::iter::from_fn(|| unshaped.next_frame()).collect();
    assert!(
        settlements(&frames) > 0,
        "unshaped, the settlements are reported: {frames:?}"
    );

    // Several conditions at once, comma-separated as a query string spells a
    // repeatable flag: the wait returns on the first of them that fires and
    // says which one did.
    let mut several = http::stream(
        serving.address,
        &format!("{watch}?timeout=0&until=settled,node-settled"),
        None,
    );
    let returned = std::iter::from_fn(|| several.next_frame())
        .last()
        .expect("a watch of no seconds returns")
        .json();
    assert!(
        matches!(
            returned["condition"].as_str(),
            Some("settled" | "node-settled" | "elapsed")
        ),
        "{returned}"
    );

    // The refusals: a condition the verb does not return on and a wait that is
    // not one, at the boundary; a cursor this run cannot place and a node it
    // does not hold, in the engine's words, before the stream opens.
    for (query, code) in [
        ("until=whenever", "invalid_request"),
        ("until=settled,whenever", "invalid_request"),
        ("until=", "invalid_request"),
        ("timeout=soon", "invalid_request"),
        ("tick=often", "invalid_request"),
        ("cursor=1:elsewhere:5", "refused"),
        ("until=node=nope", "refused"),
    ] {
        let refused = http::get(serving.address, &format!("{watch}?{query}"));
        assert_eq!(refused.status, 422, "{query}: {}", refused.body);
        assert_eq!(refused.json()["error"]["code"], json!(code), "{query}");
    }
}

#[test]
fn the_read_verbs_serve_what_the_cli_prints() {
    let serving = Serving::start(|root| {
        fixture_run::write(root, fixture_run::RUN_ID);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
    });
    let run = fixture_run::RUN_ID;
    let root = serving.runs_root();
    let cli = |arguments: &[&str]| -> String {
        let output = sibling::run(&root, None, arguments);
        assert!(
            output.status.success(),
            "onepipeline {}: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    };

    // Each rendered verb is byte for byte what the binary prints.
    for (path, arguments) in [
        (format!("/api/v2/runs/{run}/results"), vec!["results", run]),
        (format!("/api/v2/runs/{run}/goals"), vec!["goals", run]),
        (
            format!(
                "/api/v2/runs/{run}/transcript?node={}",
                fixture_run::NODE_ID
            ),
            vec!["transcript", run, fixture_run::NODE_ID],
        ),
        ("/api/v2/goals".to_owned(), vec!["goals"]),
    ] {
        let served = http::get(serving.address, &path);
        assert_eq!(served.status, 200, "{path}: {}", served.body);
        let served = served.json();
        assert_enveloped(&served);
        assert_eq!(
            served["rendered"],
            json!(cli(&arguments)),
            "{path} is not what `onepipeline {}` prints",
            arguments.join(" ")
        );
    }
    // `status` and `host` render the provider-health block the engine probes
    // this host for, which moves between two reads; what is held is the
    // standing, which the rendering opens with.
    let status = http::get(serving.address, &format!("/api/v2/runs/{run}/status")).json();
    assert_eq!(status["run_id"], json!(run));
    assert_eq!(status["liveness"], json!("PARKED"), "{status}");
    assert_eq!(status["unread_surfaces"]["count"], json!(0));
    assert_eq!(status["node_status"][fixture_run::NODE_ID], json!("done"));
    assert_eq!(status["summary"], json!("2/2 done"));
    assert!(
        status["rendered"]
            .as_str()
            .is_some_and(|text| text.starts_with(&format!("{run}  SETTLED  2/2 done"))),
        "{status}"
    );
    assert!(
        cli(&["status", run]).starts_with(&format!("{run}  SETTLED  2/2 done")),
        "the CLI opens with the same standing"
    );
    let host = http::get(serving.address, "/api/v2/host").json();
    assert!(
        host["rendered"]
            .as_str()
            .is_some_and(|text| text.starts_with("host ") && text.contains("no live dispatches")),
        "{host}"
    );
    // The telemetry document is the SDK's own, as the CLI prints it.
    let telemetry = http::get(serving.address, &format!("/api/v2/runs/{run}/telemetry")).json();
    let printed: Value = serde_json::from_str(cli(&["telemetry", run]).trim()).expect("a document");
    assert_eq!(telemetry["telemetry"], printed, "{telemetry}");

    // A node the run never dispatched is the engine's refusal, not an empty
    // transcript; a node that is not a name at all is the boundary's.
    let unknown = http::get(
        serving.address,
        &format!("/api/v2/runs/{run}/transcript?node=nope"),
    );
    assert_eq!(unknown.status, 422, "{}", unknown.body);
    let unknown = unknown.json();
    assert_eq!(unknown["error"]["code"], json!("refused"));
    assert!(
        unknown["error"]["message"]
            .as_str()
            .is_some_and(|said| said.contains("has recorded nothing for node 'nope'")),
        "{unknown}"
    );
    let unnamed = http::get(
        serving.address,
        &format!("/api/v2/runs/{run}/transcript?node=../etc"),
    );
    assert_eq!(unnamed.status, 422, "{}", unnamed.body);
    assert_eq!(unnamed.json()["error"]["code"], json!("invalid_node_id"));
    // And a run that is not there, on every read verb.
    for route in ["status", "results", "goals", "transcript", "telemetry"] {
        let absent = http::get(
            serving.address,
            &format!("/api/v2/runs/run-that-is-not-there/{route}"),
        );
        assert_eq!(absent.status, 404, "{route}: {}", absent.body);
        assert_eq!(
            absent.json()["error"]["code"],
            json!("run_not_found"),
            "{route}"
        );
    }
}

#[test]
fn an_invalidation_names_the_project_group_that_moved() {
    let serving = two_runs();
    let mut stream = http::stream(serving.address, "/api/v2/events", None);
    let snapshot = stream.frames(1).remove(0);
    assert_eq!(snapshot.event, "snapshot");
    fixture_run::append(
        &serving.run_dir(fixture_run::OTHER_RUN_ID),
        "run-progress",
        json!({}),
    );
    let changed = stream.next_frame().expect("the run moved");
    assert_eq!(changed.event, "run.changed");
    let data = changed.json();
    assert_eq!(data["run_id"], json!(fixture_run::OTHER_RUN_ID));
    assert_eq!(data["project"], json!(fixture_run::PLAN_PROJECT), "{data}");
}
