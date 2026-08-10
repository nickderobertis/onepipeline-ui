//! The read API's journeys: a real server, a real socket, real recorded runs.
//!
//! These are the port of `tests/e2e/test_server_e2e.py` from the repository the
//! frontend comes from — the same journeys, against the onepipeline SDK's run
//! store instead of that repository's. Nothing is stubbed: each one spawns the
//! compiled binary over a directory the SDK itself writes and reads the bytes
//! that come back.

use serde_json::{json, Value};

use crate::fixture_run;
use crate::http;
use crate::serving::Serving;

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
    assert_eq!(body["telemetry_schema_version"], json!(10), "{body}");
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
    assert_eq!(response.json(), json!({ "status": "ok" }));
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
        fixture_run::append(&dir, "round-started", json!({}));
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
fn a_run_with_no_journal_is_served_from_the_result_its_round_recorded() {
    // Nothing to fold, so the round's own result is the only account there is. It
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
    let round = &detail["rounds"][0];
    // The word outside the vocabulary is served as `unknown` rather than passed
    // through — a client switches on this exhaustively and refuses the whole run
    // over a member it does not have — and never as a neighbouring meaning.
    assert_eq!(round["node_status"][fixture_run::NODE_ID], json!("unknown"));
    assert_eq!(
        round["node_status"][fixture_run::REVIEW_NODE_ID],
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
    // what the dispatch reported — so both reach the wire, from a finished round's
    // recorded result and from the live fold alike.
    let serving = Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    });
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let rounds = body["rounds"].as_array().expect("rounds is an array");

    let finished = &rounds[0]["node_results"][fixture_run::REVIEW_NODE_ID];
    assert_eq!(
        finished["detail"],
        json!("the reviewer asked for a changelog entry")
    );
    assert_eq!(finished["error"], json!("review exited non-zero"));
    assert_eq!(finished["exit_code"], json!(2));
    assert_eq!(finished["ok"], json!(false));

    // The live round's fold keeps a node's status and outcome but not the prose
    // beside them, so the settlement envelope is where this comes from.
    let live = &rounds[1]["node_results"][fixture_run::SHIP_NODE_ID];
    assert_eq!(live["detail"], json!("the change request is open"));
    // Nothing recorded is nothing served: an absent field is not a null one.
    assert!(live.get("error").is_none(), "{live}");
}

#[test]
fn a_run_detail_serves_its_rounds_plan_and_transcripts() {
    let serving = two_runs();
    let response = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    );
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_enveloped(&body);
    assert_eq!(body["run"]["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(body["run"]["last_event"], json!("round-finished"));

    let rounds = body["rounds"].as_array().expect("rounds is an array");
    assert_eq!(rounds.len(), 1);
    let round = &rounds[0];
    assert_eq!(round["round"], json!(1));
    // One status per plan task, so a client never invents one for a node.
    let tasks: Vec<&str> = round["plan"]["tasks"]
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
        assert_eq!(round["node_status"][*task], json!("done"), "{round}");
    }
    assert_eq!(round["result"]["state"], json!("complete"));
    assert_eq!(
        round["node_results"][fixture_run::NODE_ID]["pr"],
        json!("https://example.invalid/changes/1")
    );

    // One transcript per session the run relayed, and the pair each was run
    // under: the worker's own side, and the judge member that reviewed it.
    let conversations = body["conversations"].as_array().expect("conversations");
    assert_eq!(conversations.len(), 2);
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
    assert!(body["rounds"].as_array().is_some_and(|r| !r.is_empty()));
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
/// the run, the round and the node, and each is short enough on its own while
/// the three together overrun what an identifier may be — the run is still
/// served, and the span still groups its sessions, but it carries no id the
/// contract's own boundary would refuse.
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
        json!(format!(
            "{}.01.{}",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        ))
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
    assert_eq!(body["timeline_schema_version"], json!(2));
    let spans = body["spans"].as_array().expect("spans");
    let dispatch = spans
        .iter()
        .find(|span| span["kind"] == "dispatch")
        .expect("the node's dispatch");
    assert_eq!(
        dispatch["dispatch_id"],
        json!(format!(
            "{}.01.{}",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        )),
        "schema 10 names the dispatch its sessions belong to"
    );
    assert_eq!(dispatch["transport_role"], json!("agent"));
    assert_eq!(dispatch["agent_role"], json!("worker"));
    assert_eq!(dispatch["status"], json!("done"));
    assert_eq!(dispatch["parent_id"], json!("node.01.contract-interface"));

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
    assert_eq!(node["turns"], json!(2));
    assert_eq!(
        node["turns"],
        json!(detail["conversations"][0]["conversation"]["turns"]
            .as_array()
            .map(Vec::len)
            .expect("the transcript's turns"))
    );
    assert_eq!(detail["run"]["turns"], json!(4));
}

#[test]
fn the_run_timeline_covers_the_round_and_the_nodes_under_it() {
    let serving = two_runs();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    let spans = body["spans"].as_array().expect("spans");
    let round = spans
        .iter()
        .find(|span| span["kind"] == "round")
        .expect("a round span");
    assert_eq!(round["round"], json!(1));
    assert_eq!(round["ended_at"], json!("2026-08-07T12:00:31.000Z"));
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
        assert_eq!(span["parent_id"], json!("round-01"));
    }
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
        json!("landed the route table")
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

    // A real append to a real journal, exactly as a live round makes one.
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
    fixture_run::append(&serving.run_dir(unnameable), "round-started", json!({}));
    fixture_run::append(
        &serving.run_dir(fixture_run::RUN_ID),
        "round-started",
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
        response.json()["rounds"][0]["node_status"][fixture_run::NODE_ID],
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

/// Unix only: `Serving::stop` needs a stop a parent can *ask* for, and Windows
/// has none — see `tests/support/serving.rs`'s `ask_to_stop`.
#[cfg(unix)]
#[test]
fn a_server_asked_to_stop_finishes_cleanly() {
    let serving = two_runs();
    // Proves it was serving before it was asked, so a `0` here cannot be a
    // process that failed to start.
    assert_eq!(http::get(serving.address, "/healthz").status, 200);
    let status = serving.stop();
    assert!(
        status.success(),
        "being asked to stop is the normal end of a read surface: {status}"
    );
}

/// A server over the run whose second round is still open.
fn live_run() -> Serving {
    Serving::start(|root| {
        fixture_run::write_live(root, fixture_run::RUN_ID);
    })
}

#[test]
fn a_live_run_reports_the_round_it_is_driving_and_what_it_is_waiting_on() {
    let serving = live_run();
    let body = http::get(serving.address, "/api/v2/runs?include_settled=false").json();
    let run = &body["runs"][0];
    assert_eq!(run["run_id"], json!(fixture_run::RUN_ID));
    assert_eq!(run["state"], json!("active"), "a live round is not settled");
    assert_eq!(run["phase"], json!("driving-round"));
    assert_eq!(run["timing_quality"], json!("partial"));
    assert_eq!(run["launch"]["launcher"], json!("codex"));
    // The human action is waiting and the node behind it is gated by it.
    assert_eq!(run["node_counts"]["waiting"], json!(1));
    assert_eq!(run["node_counts"]["blocked"], json!(1));
    assert_eq!(run["node_counts"]["done"], json!(1));

    // Every millisecond of the run's clock has exactly one home: the lanes the
    // wire names a fraction for, and the residue nothing measured.
    let timing = &run["timing"];
    let wall = timing["wall_ms"].as_u64().expect("wall_ms");
    let ms = |key: &str| {
        timing[key]
            .as_u64()
            .unwrap_or_else(|| panic!("{key}: {timing}"))
    };
    // Read as the fractions rather than the seconds, because that is the one
    // reading carried at the precision the parts were measured in: the eight
    // `*_seconds` are whole seconds of a clock timed in milliseconds.
    let shares: f64 = timing["fractions"]
        .as_object()
        .expect("fractions")
        .values()
        .map(|share| share.as_f64().expect("a share"))
        .sum();
    #[allow(clippy::cast_precision_loss)]
    let residue = ms("unattributed_ms") as f64 / wall as f64;
    assert!(
        (shares + residue - 1.0).abs() < 1e-9,
        "the breakdown must add up to the whole: {timing}"
    );
    // Measured where a record measured it, and absent where none did — never a
    // zero a reader could take for a measurement.
    assert_eq!(
        ms("lock_wait_seconds"),
        4,
        "`onevcs` timed the wait: {timing}"
    );
    assert!(ms("llmlint_model_ms") > 0, "the lint member ran: {timing}");
    assert_eq!(ms("judge_model_ms"), 0, "no judge chain ran: {timing}");
    assert_eq!(
        run["timing_quality"],
        json!("partial"),
        "and the presence flags say which of those zeros were measured"
    );
    assert!(
        timing["idle_orchestration_ms"]
            .as_u64()
            .is_some_and(|ms| ms > 0),
        "the wait on the planner and on the person is time the run spent: {timing}"
    );
}

#[test]
fn every_round_the_run_recorded_is_served_with_its_own_plan_and_result() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}", fixture_run::RUN_ID),
    )
    .json();
    let rounds = body["rounds"].as_array().expect("rounds");
    assert_eq!(rounds.len(), 2, "a finished round is not forgotten");

    let first = &rounds[0];
    assert_eq!(first["round"], json!(1));
    assert_eq!(first["result"]["state"], json!("waiting"));
    assert_eq!(
        first["node_status"][fixture_run::REVIEW_NODE_ID],
        json!("failed"),
        "a finished round's statuses are the ones its own result recorded"
    );

    let second = &rounds[1];
    assert_eq!(second["round"], json!(2));
    assert_eq!(
        second["result"],
        Value::Null,
        "an open round has recorded no result"
    );
    assert_eq!(
        second["node_status"][fixture_run::SIGNOFF_NODE_ID],
        json!("waiting")
    );
    assert_eq!(
        second["node_status"][fixture_run::ANNOUNCE_NODE_ID],
        json!("blocked")
    );
    assert_eq!(
        second["node_gated_by"][fixture_run::ANNOUNCE_NODE_ID],
        json!([fixture_run::SIGNOFF_NODE_ID]),
        "a client is told which nodes are holding a blocked one, in plan order"
    );
    // `node_states` carries only what the journal recorded, never a derived gate.
    assert!(
        second["node_states"]
            .get(fixture_run::ANNOUNCE_NODE_ID)
            .is_none(),
        "blocked is derived on every read, not recorded: {second}"
    );
    assert_eq!(
        second["node_states"][fixture_run::SIGNOFF_NODE_ID],
        json!("waiting")
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
    let ship = body["rounds"][1]["plan"]["tasks"]
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
    assert_eq!(ship["done_when"], json!("the change request is open"));
    // The planner's carried note reaches the reader as the section the SDK
    // renders it as, not as a second acceptance bar.
    let prose = ship["task"].as_str().expect("the node's prose");
    assert!(prose.contains("Planner context"), "{prose}");
    assert!(prose.contains("adds no acceptance criteria"), "{prose}");

    let steps = ship["steps"].as_array().expect("steps");
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["id"], json!("build"));
    assert_eq!(steps[0]["kind"], json!("agent"));
    // A step recorded with no prose of its own is still named, because the wire
    // has no shape for a step without any.
    assert_eq!(steps[1]["kind"], json!("human"));
    assert_eq!(steps[1]["task"], json!("hand-over"));

    // A human node carries its action prose and no persona.
    let signoff = body["rounds"][1]["plan"]["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["id"] == json!(fixture_run::SIGNOFF_NODE_ID))
        .expect("the human node")
        .clone();
    assert_eq!(signoff["kind"], json!("human"));
    assert_eq!(signoff["task"], json!("Approve the change."));

    // The steps the attempt finished are the ones a continuation may skip.
    let results = &body["rounds"][1]["node_results"][fixture_run::SHIP_NODE_ID];
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
    assert_eq!(records.len(), 1, "the node stored one artifact");
    assert_eq!(records[0]["artifact_id"], json!("artifact-long-log"));
    assert_eq!(records[0]["ok"], json!(true));
    assert_eq!(
        records[0]["output_tail"],
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
        .find(|span| span["kind"] == "verification")
        .expect("the evidence the node stored");
    assert_eq!(verification["label"], json!("artifact-long-log"));
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
        json!(format!("node.02.{}", fixture_run::SHIP_NODE_ID))
    );

    // The publication is the interval between the two ends `onevcs` recorded.
    let publication = spans
        .iter()
        .find(|span| span["kind"] == "publication")
        .expect("the branch the node published");
    assert_eq!(publication["label"], json!("feature/ship"));
    assert_eq!(publication["started_at"], json!("2026-08-07T12:00:29.000Z"));
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
        json!(format!("node.02.{}", fixture_run::SHIP_NODE_ID))
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
fn a_round_that_wrote_no_result_is_described_by_the_fold_behind_it() {
    let serving = Serving::start(|root| {
        fixture_run::write_stopped_mid_round(root, fixture_run::STOPPED_RUN_ID);
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
        body["rounds"][0]["node_status"][fixture_run::NODE_ID],
        json!("running"),
        "the round it stopped in has no result of its own, and the fold does"
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
        "a node whose round recorded neither is served neither, not an empty one: {kinds:?}"
    );
}

#[test]
fn the_run_timeline_covers_every_round_the_run_has_had() {
    let serving = live_run();
    let body = http::get(
        serving.address,
        &format!("/api/v2/runs/{}/timeline?scope=run", fixture_run::RUN_ID),
    )
    .json();
    let rounds: Vec<&Value> = body["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "round")
        .collect();
    assert_eq!(rounds.len(), 2);
    assert_eq!(rounds[0]["phase"], json!("reviewing-results"));
    assert_eq!(
        rounds[1]["ended_at"],
        Value::Null,
        "the round being driven has not ended"
    );
    assert_eq!(rounds[1]["phase"], json!("driving-round"));

    // The run's own driving session, recorded at no node: it is running for as
    // long as the round it is driving is, rather than a state nothing named.
    let driving: Vec<&Value> = body["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "dispatch" && span["node_id"].is_null())
        .collect();
    assert!(!driving.is_empty(), "no run-level session was served");
    assert_eq!(driving[0]["status"], json!("done"));
    assert_eq!(
        driving.last().expect("the open round's session")["status"],
        json!("running")
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
    assert_eq!(body["kind"], json!("worker_report"));
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
        detail["rounds"],
        json!([]),
        "a run with no round has no round to serve"
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
                    "round": 2,
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
    // has no detail at all rather than a detail claiming zero checks.
    let details = body["node_details"].as_object().expect("the node details");
    assert!(
        !details.contains_key(fixture_run::REVIEW_NODE_ID),
        "{details:?}"
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
    assert_eq!(usage["agent"]["input_tokens"], json!(1_200));
    assert_eq!(usage["agent"]["cost_usd"], json!(0.42));
    assert_eq!(usage["judge"]["input_tokens"], json!(400));
    assert_eq!(usage["total"]["output_tokens"], json!(430));
    // Nothing ran a lint chain here, and that is served as unknown rather than
    // as a measured nothing: a null cost cannot be read as a free one.
    assert_eq!(usage["llmlint"]["input_tokens"], json!(null));
    assert_eq!(usage["llmlint"]["cost_usd"], json!(null));

    // The same distinction on the clock: the two parties that reported a turn
    // are present, and the one that did not is flagged absent beside its zero.
    let presence = &body["run"]["timing_presence"];
    assert_eq!(presence["agent_model_ms"], json!(true));
    assert_eq!(presence["judge_model_ms"], json!(true));
    assert_eq!(presence["llmlint_model_ms"], json!(false));
    assert_eq!(presence["tool_ms"], json!(false));
    let timing = &body["run"]["timing"];
    assert_eq!(timing["judge_seconds"], json!(3));
    assert_eq!(timing["gate_seconds"], json!(2));
    assert_eq!(timing["lock_wait_seconds"], json!(3));
    assert_eq!(timing["llmlint_model_ms"], json!(0));

    // A node reports only what it measured; one that measured nothing says
    // nothing at all.
    let node = body["run"]["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .find(|row| row["node"] == json!(fixture_run::REVIEW_NODE_ID))
        .expect("the review node");
    assert_eq!(node["usage"]["judge"]["cost_usd"], json!(0.11));
    assert_eq!(node["usage"]["agent"]["cost_usd"], json!(null));
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
                    "round": 2,
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
    assert_eq!(latest["round"], json!("2"));
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
    let tools = turns[1]["tools"].as_array().expect("the turn's tool calls");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], json!("Bash"));
    assert_eq!(tools[0]["kind"], json!("tool_use"));
    assert_eq!(tools[0]["input"], json!("just gate"));
    assert_eq!(turns[1]["usage"]["inputTokens"], json!(900));
    assert_eq!(turns[1]["durationMs"], json!(1_500));
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
    assert_eq!(node["lint"], json!(2), "what the lint transport recorded");

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
    assert_eq!(lint["attribution"]["agentRole"], json!("pr-author"));
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
