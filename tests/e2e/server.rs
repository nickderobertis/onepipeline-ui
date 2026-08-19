//! The read API's journeys: a real server, a real socket, real recorded runs.
//!
//! These are the port of `tests/e2e/test_server_e2e.py` from the repository the
//! frontend comes from — the same journeys, against the onepipeline SDK's run
//! store instead of that repository's. Nothing is stubbed: each one spawns the
//! compiled binary over a directory the SDK itself writes and reads the bytes
//! that come back.

use serde_json::{json, Value};

use onepipeline_ui::contract::RunId;
use onepipeline_ui::telemetry;

use crate::fixture_run;
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
    assert_eq!(body["telemetry_schema_version"], json!(13), "{body}");
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
    assert_eq!(body["timeline_schema_version"], json!(5));
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
    assert!(
        ms("llmlint_model_ms") > 0,
        "the lint member reported a turn: {timing}"
    );
    assert_eq!(
        timing["judge_model_ms"],
        json!(null),
        "no judge chain reported one, which is not zero of it: {timing}"
    );
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
            json!({ "usage": { "duration": 1.0 } }),
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
        json!(format!("node.{}", fixture_run::SHIP_NODE_ID))
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
    // What the run spent, as the sibling folded it from the turns it relayed.
    assert_eq!(usage["total"]["input_tokens"], json!(1_600));
    assert_eq!(usage["total"]["output_tokens"], json!(430));
    assert_eq!(usage["total"]["cost_usd"], json!(0.53));
    // The per-party split is read from the onejudge report each side keeps, and
    // this run kept none — so each party is unknown rather than free. A null cost
    // cannot be read as a run that cost nothing.
    for party in ["agent", "judge", "llmlint"] {
        assert_eq!(usage[party]["input_tokens"], json!(null), "{party}");
        assert_eq!(usage[party]["cost_usd"], json!(null), "{party}");
    }

    // The same distinction on the clock: the two parties that reported a turn
    // carry a number, and the one that did not carries no number at all.
    let presence = &body["run"]["timing_presence"];
    assert_eq!(presence["agent_model_ms"], json!(true));
    assert_eq!(presence["judge_model_ms"], json!(true));
    assert_eq!(presence["llmlint_model_ms"], json!(false));
    assert_eq!(presence["tool_ms"], json!(false));
    let timing = &body["run"]["timing"];
    assert_eq!(timing["gate_seconds"], json!(2), "{timing}");
    assert_eq!(timing["judge_model_ms"], json!(3_000), "{timing}");
    assert_eq!(timing["llmlint_model_ms"], json!(null), "{timing}");
    assert_eq!(timing["tool_ms"], json!(null), "{timing}");

    // The same discipline one level down: a party that reported no turn at a
    // node has no time there, which is not zero of it.
    let work = &body["run"]["node_work_ms"];
    assert_eq!(work["judge_model_ms"], json!(3_000), "{work}");
    assert_eq!(work["llmlint_model_ms"], json!(null), "{work}");
    assert_eq!(work["tool_ms"], json!(null), "{work}");
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
    // Derived from the document's own wall clock rather than restated, so a
    // fixture whose timings move does not need this number rewritten with it.
    #[allow(clippy::cast_precision_loss)]
    let judge_share = timing["judge_model_ms"]
        .as_f64()
        .expect("the judge chain reported turns")
        / document.wall_ms as f64;
    assert_eq!(timing["fractions"]["judge_model"], json!(judge_share));
    assert_eq!(timing["fractions"]["llmlint_model"], json!(null));

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
    // What this server measures for itself is unaffected: a turn reports its own
    // model time, and that is not the sibling's to answer.
    assert_eq!(timing["agent_model_ms"], json!(2_500));
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
