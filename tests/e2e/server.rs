//! The read API's journeys: a real server, a real socket, real recorded runs.
//!
//! These are the port of `tests/e2e/test_server_e2e.py` from the repository the
//! frontend comes from — the same journeys, against the onepipeline SDK's run
//! store instead of that repository's. Nothing is stubbed: each one spawns the
//! compiled binary over a directory the SDK itself writes and reads the bytes
//! that come back.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use onepipeline_ui::contract::RunId;
use onepipeline_ui::telemetry;

use crate::fixture_run;
use crate::harness_history;
use crate::http;
use crate::serving::Serving;
#[cfg(unix)]
use crate::serving::Stop;

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
    assert_eq!(body["telemetry_schema_version"], json!(14), "{body}");
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
    assert_eq!(body["timeline_schema_version"], json!(6));
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
    assert_eq!(detail["run"]["turns"], json!(5));
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

/// A server over the run whose lanes ran one after another.
fn lanes() -> Serving {
    Serving::start(|root| {
        fixture_run::write_lanes(root, fixture_run::LANES_RUN_ID);
    })
}

/// One node's spans, as an operator opening that node reads them.
fn node_spans(serving: &Serving, node: &str) -> Vec<Value> {
    http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={node}",
            fixture_run::LANES_RUN_ID
        ),
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

    // The run's own observer, at no node: `monitor` is the watching member and is
    // served in the `orchestrator` lane it shares, because the vocabulary a
    // client switches on is closed and a lane it already has is not widened.
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
    assert_eq!(watching["agent_role"], json!("orchestrator"));
    // And no word outside that vocabulary reached the wire.
    for span in &spans {
        if let Some(role) = span.get("agent_role").and_then(Value::as_str) {
            assert!(
                ["orchestrator", "worker", "judge", "check-in", "pr-author"].contains(&role),
                "`{role}` is not a member of `agentRoleSchema`: {span}"
            );
        }
    }
}

#[test]
fn a_member_this_wire_has_no_word_for_is_not_read_off_the_persona_beside_it() {
    let serving = lanes();

    // A session the graph stamped `reviewer`, which `agentRoleSchema` has no word
    // for, beside the one persona that reads like a role — the literal word
    // `pr-author`, which is what a host really dispatches a drafting turn under.
    // The run said what this session was and said something this vocabulary
    // cannot carry, so no role is served: answering with the persona would put a
    // *style* over the run's own word for it, and serve a drafting lane for a
    // session that was not one.
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
    // persona it ran under. This dispatch relayed no session, so its
    // `node-dispatched` — persona `check-in`, no member — is the whole of what
    // the run said about it.
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
    let runs = tempfile::tempdir().expect("temp dir");
    let dir = fixture_run::write(runs.path(), fixture_run::RUN_ID);
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
        runs,
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
        &serving.runs.path().join(fixture_run::RUN_ID),
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
            unlabelled, 1,
            "{scope}: the unlabelled record is served, with no transcript hung on it"
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
    // Two sessions under one semantic role, and the transport half is what tells
    // them apart: the work, and the lint member that read it.
    assert_eq!(rollups.len(), 2, "one category, one summary: {rollups:?}");
    assert_eq!(rollups[0]["agent_role"], json!("pr-author"));
    assert_eq!(rollups[0]["transport_role"], json!("agent"));
    assert_eq!(rollups[0]["count"], json!(1));
    assert_eq!(rollups[1]["agent_role"], json!("pr-author"));
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
    assert_eq!(usage["total"]["input_tokens"], json!(159_834));
    assert_eq!(usage["total"]["output_tokens"], json!(1_654));
    assert_eq!(usage["total"]["cost_usd"], json!(50.83));
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
    // Two relayed turns, and the tool summary published between them is on the
    // one it belongs to rather than a third turn nobody took.
    assert_eq!(turns.len(), 2, "{turns:?}");
    // On the turn that *made* the call. `oneagentgraph` opens a turn before its
    // activities and streams each one live, so the summary between these two
    // records was published from inside the first — carrying it on the second
    // put every journal-derived turn's tools one turn late.
    assert!(
        turns[1]["tools"].as_array().is_some_and(Vec::is_empty),
        "the turn after the call made none of its own: {turns:?}"
    );
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
    assert_eq!(turns[1]["usage"]["inputTokens"], json!(900));
    // This member has not settled, so no report holds what its turn took. An
    // interval nothing measured is absent, and never the zero a reader would
    // take for a measurement.
    assert_eq!(turns[1]["durationMs"], json!(null));
    assert_eq!(turns[1]["startedAt"], json!(null));
    assert_eq!(turns[1]["finishedAt"], json!(null));
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
    assert_eq!(node["lint"], json!(3), "what the lint transport recorded");

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
    // `llmlint` is a word in the *transport* vocabulary and in no other, so this
    // session stamped a member that says which chain ran and nothing about what
    // the dispatch was for. A stamped member is the reading whether or not this
    // wire has a word for it, so the persona beside it is not consulted and the
    // transcript falls to the role every dispatch has.
    assert_eq!(lint["attribution"]["agentRole"], json!("worker"));

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

    // The same numbers `onepipeline telemetry` prints for this run, read through
    // its own CLI rather than folded here a second time. Asserted against what
    // that binary says right now, so a build whose attribution moves fails here
    // instead of leaving two readings of one run's clock disagreeing.
    let run = RunId::try_from(fixture_run::RUN_ID).expect("a valid id");
    let document = onepipeline_ui::telemetry::of_run(serving.runs_root(), &run)
        .expect("the sibling aggregates the fixture run");
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

#[test]
fn a_run_whose_telemetry_cannot_be_read_is_served_with_no_clock_at_all() {
    // The sibling named but absent: the one condition under which this server
    // knows nothing about where a run's time went. Every timing is then absent,
    // and none of them is zero — a run nothing could be measured for must not
    // read as a run that took no time.
    let serving = Serving::start_with_env(
        |root| {
            fixture_run::write(root, fixture_run::RUN_ID);
        },
        &[(
            onepipeline_ui::telemetry::BINARY_ENV,
            "a-onepipeline-that-is-not-installed",
        )],
    );
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let timing = &body["run"]["timing"];
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
        assert_eq!(timing[lane], json!(null), "{lane} is not absent: {timing}");
    }
    // Including the three lanes this server would have folded for itself, which
    // nothing measures either way.
    assert_eq!(timing["agent_model_ms"], json!(null));
    assert_eq!(body["run"]["usage"]["total"]["cost_usd"], json!(null));

    // The row the operator arrives on says the same thing as the detail they open
    // from it: one reading of the run, whether or not its clock could be read.
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true").json();
    let row = &listed["runs"][0];
    assert_eq!(row["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(row["timing"]["wall_seconds"], json!(null), "{row}");
    assert_eq!(row["timing"]["agent_seconds"], json!(null), "{row}");
    assert_eq!(row["node_counts"]["done"], json!(2), "a run all the same");

    // The rest of the payload is untouched: a run with no clock is still a run.
    assert_eq!(body["run"]["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(
        body["node_details"][fixture_run::NODE_ID]["publication"]["merged"],
        json!(true)
    );
}

#[test]
fn a_sibling_that_cannot_answer_names_which_way_it_could_not() {
    let runs = tempfile::tempdir().expect("temp dir");
    fixture_run::write(runs.path(), fixture_run::RUN_ID);

    // Asked about a run it does not have: it ran, and refused. The reason names
    // the command, because the alternative is a server serving no clock and no
    // account of why.
    let never_recorded = RunId::try_from("run-that-was-never-recorded").expect("a valid id");
    let refused =
        telemetry::of_run(runs.path(), &never_recorded).expect_err("the sibling has no such run");
    assert!(
        matches!(refused, telemetry::Unavailable::Refused(_)),
        "{refused:?}"
    );
    assert!(refused.to_string().contains("telemetry"), "{refused}");

    // Not startable at all, which is what a missing install looks like: the
    // message says how to fix it rather than only that it broke.
    let run = RunId::try_from(fixture_run::RUN_ID).expect("a valid id");
    let missing = telemetry::of_run_from("a-onepipeline-that-is-not-installed", runs.path(), &run)
        .expect_err("nothing to start");
    assert!(
        matches!(missing, telemetry::Unavailable::NoBinary(_)),
        "{missing:?}"
    );
    assert!(
        missing.to_string().contains(telemetry::BINARY_ENV),
        "the refusal says how to point at one: {missing}"
    );
}

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

    // `monitor` is the detailed stream, which is what that persona's own contract
    // says it reads: it narrows nothing, and is named so that the two readings a
    // viewer switches between are two profiles rather than a profile and nothing.
    assert_eq!(kinds_on(&timeline_under(&serving, Some("monitor"))), whole);
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
    let wide = detail("monitor");
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
        message.contains("planner") && message.contains("monitor"),
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

    let detailed = sessions(&detail("monitor"));
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

    let told = latest("monitor").expect("the detailed reading is told what the turn is doing");
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

#[test]
fn an_accepted_edit_is_served_with_the_author_that_submitted_it() {
    // The run enforces a per-author op allowlist — a planner may issue every op
    // and a monitor a narrower set — so who asked for a change is a fact about
    // the change. Without it an observer's self-applied fix and the planner's own
    // decision read as one thing on a reader's timeline.
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
    for turn in turns.iter().take(2) {
        assert_ne!(
            turn["usage"]["costUsd"],
            json!(50.72),
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

    // The settlement the report came with is not one of the conversation's turns
    // and does not pretend to be: no prompt, no reply, and the dispatch's own
    // total where a turn's usage would be.
    assert_eq!(turns.len(), 3, "{turns:?}");
    assert_eq!(turns[2]["status"], json!("turn-completed"));
    assert_eq!(turns[2]["user"], json!(""));
    assert_eq!(turns[2]["assistant"], json!(null));
    assert_eq!(turns[2]["durationMs"], json!(null));
    assert_eq!(turns[2]["usage"]["costUsd"], json!(50.72));
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

    // The dispatch it supervised, at the node it supervised it under.
    let attribution = &body["attribution"];
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
        // And nothing the report keys to the *agent* reaches a judge turn.
        assert_ne!(turn["durationMs"], json!(2_800), "{turn}");
        assert_ne!(turn["usage"]["costUsd"], json!(0.11), "{turn}");
        assert_ne!(turn["usage"]["inputTokens"], json!(400), "{turn}");
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
    // And none of the figures its report attributes to the judge instead.
    for turn in &turns {
        assert_ne!(turn["durationMs"], json!(70), "{turn}");
        assert_ne!(turn["durationMs"], json!(60), "{turn}");
        assert_ne!(turn["usage"]["inputTokens"], json!(79_341), "{turn}");
        assert_ne!(turn["usage"]["costUsd"], json!(9.75), "{turn}");
        assert_eq!(turn["unknown"], json!({}), "{turn}");
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
        assert_eq!(turn["unknown"], json!({}), "{turn}");
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
    assert_eq!(lane["agent_role"], json!("judge"));
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
        !spans
            .iter()
            .any(|span| span["agent_role"] == json!("judge")),
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
    assert_eq!(lane["agent_role"], json!("judge"));
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
                },
                // The end nobody observed, which leaves the lane open.
                SessionLink {
                    session_id: "01a02f4f-6168-72d1-b946-2251794e2fce".into(),
                    role: TelemetryRole::Judge,
                    turn_index: 2,
                    started_at: "2026-08-07T12:01:05.000Z".into(),
                    finished_at: None,
                    history_id: None,
                },
            ],
            // One attribution for two links: the second invocation reported a
            // session and a start, and no candidate is attributed to it.
            attribution: vec![attributed(1, 2_000)],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        stopped_early: true,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
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

/// A session whose member has not settled is served exactly as the journal
/// relayed it, which is not the same as being served empty.
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
    // What the journal did relay: the record's own prose and the summaries it
    // published. What it never carried: a prompt, a tool's observation, a
    // per-turn cost, or a clock.
    assert_eq!(turns[0]["assistant"], json!("opened the change request"));
    assert_eq!(turns[0]["tools"][0]["name"], json!("Bash"));
    assert_eq!(turns[0]["tools"][0]["output"], json!(null));
    assert_eq!(turns[0]["durationMs"], json!(null));
    // And never the persona in place of a prompt nobody recorded.
    let persona = body["attribution"]["persona"]
        .as_str()
        .expect("the dispatch's persona");
    for turn in turns {
        assert_eq!(turn["user"], json!(""), "{turn}");
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
            }],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
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
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(turns[0]["user"], json!("Land the wire contract."));
    assert_eq!(turns[0]["assistant"], json!("The route table is landed."));
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
                at: "2026-08-07T12:01:05.000Z",
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

    let wide = detail("monitor");
    // The settlement record excluded: it is one of the session's relayed
    // envelopes, so a reader who excluded its kind is not shown it.
    let narrow = detail(r#"{"exclude":[{"kind":"turn-completed"}]}"#);
    let all = transcript(&wide);
    let listed = transcript(&narrow);
    assert_eq!(all.len(), 3, "{all:?}");
    assert_eq!(listed.len(), 2, "the listing narrowed: {listed:?}");

    // And every turn still listed is the same turn, down to the fields only the
    // report can fill.
    assert_eq!(listed, all[..2].to_vec());
    assert_eq!(listed[0]["user"], json!(fixture_run::FIRST_PROMPT));
    assert_eq!(listed[0]["assistant"], json!(fixture_run::FIRST_REPLY));
    assert_eq!(listed[0]["usage"]["costUsd"], json!(29.71));
    assert_eq!(listed[0]["durationMs"], json!(900));
    assert_eq!(
        listed[0]["tools"][1]["output"],
        json!(fixture_run::TOOL_OBSERVATION)
    );
    assert_eq!(listed[1]["usage"]["costUsd"], json!(1.51));

    // The fold beside them is the run's, not the reading's — including the one
    // this step re-sourced from the same reports the transcripts are filled from.
    assert_eq!(narrow["run"]["timing"], wide["run"]["timing"]);
    assert_eq!(narrow["run"]["usage"], wide["run"]["usage"]);
    assert_eq!(narrow["run"]["node_work_ms"], wide["run"]["node_work_ms"]);
}
