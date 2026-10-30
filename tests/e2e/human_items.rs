//! The human-item routes, against the real binary and the engine's own
//! sample-backed adapter.
//!
//! Every journey here starts `onepipeline-api serve --human-items-sample FILE`
//! over a fresh copy of a bundle in `tests/fixtures/human-items/` and reads the
//! bytes it serves. What answers is `onepipeline::human_items::HumanItemSample`
//! — the adapter the item-contract release ships — and nothing in this
//! repository stands in for it. The CLI/API comparisons run the provisioned
//! `onepipeline human-items --sample` over a second copy of the same bundle, so
//! the two surfaces are held to one engine at one version.
//!
//! These are contract-adapter journeys: they prove filters, shapes, receipts,
//! authority and typed refusals over the published contract. They make no
//! claim about the engine's journal, bus delivery or run-lifecycle resolution,
//! which no released engine implements yet.

use std::path::{Path, PathBuf};
use std::process::Command;

use onepipeline::human_items::{HumanItemDetail, HumanItemReceipt, HumanItemSample, HumanItemView};
use serde_json::{json, Value};
use tempfile::TempDir;

use crate::http;
use crate::serving::Serving;
use crate::sibling;

/// The session the fixtures' own items are owned by — the one the browser
/// tier's server acts as, so both tiers read one bundle.
const OWNER: &str = "claude-code-supervising-session";
/// The session the bundle's one foreign item belongs to.
const OTHER: &str = "other-session";

/// The visible open items of `representative.json`, in the engine's declared
/// order: blocking first — host, then the two high holds by when they were
/// raised, then the plan hold — and the non-blocking ones after, urgent before
/// low.
const DECLARED_ORDER: [&str; 6] = [
    "task-build",
    "question-canary",
    "task-design",
    "task-dashboard",
    "question-cache",
    "question-export",
];

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/human-items")
        .join(name)
}

/// A fresh copy of bundle `name`, in a directory of its own: the routes write
/// it back, and a journey must never write the checked-in fixture.
fn sample(name: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join(name);
    std::fs::copy(fixture(name), &path).expect("copy the bundle");
    (dir, path)
}

/// The server over `bundle`, acting as `session` — unattributed for `None`.
fn serve(bundle: &Path, session: Option<&str>) -> Serving {
    let bundle = bundle.to_str().expect("utf-8 path");
    let arguments = ["--human-items-sample", bundle];
    match session {
        Some(session) => Serving::start_as_with_args(|_| {}, session, &arguments),
        None => Serving::start_with_args(|_| {}, &arguments),
    }
}

/// `onepipeline human-items --sample BUNDLE ARGS…`, which must succeed.
fn cli(bundle: &Path, arguments: &[&str]) -> String {
    let output = Command::new(sibling::binary())
        .arg("human-items")
        .arg("--sample")
        .arg(bundle)
        .args(arguments)
        .output()
        .expect("the sibling CLI starts");
    assert!(
        output.status.success(),
        "`onepipeline human-items {arguments:?}` failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("utf-8 output")
}

fn cli_json(bundle: &Path, arguments: &[&str]) -> Value {
    let printed = cli(bundle, arguments);
    serde_json::from_str(&printed).unwrap_or_else(|err| panic!("{err}: the CLI printed {printed}"))
}

/// What the CLI lists for `arguments`, narrowed to what `session` owns — the
/// one thing the server adds to the engine's query.
fn cli_list_owned(bundle: &Path, arguments: &[&str], session: &str) -> Vec<Value> {
    let mut all = vec!["list", "--json"];
    all.extend_from_slice(arguments);
    match cli_json(bundle, &all) {
        Value::Array(views) => views
            .into_iter()
            .filter(|view| view["item"]["owner"]["session"] == session)
            .collect(),
        other => panic!("the CLI listed {other}"),
    }
}

fn items(response: &http::Response) -> Vec<Value> {
    assert_eq!(response.status, 200, "{}", response.body);
    match response.json() {
        Value::Object(mut body) => {
            assert_eq!(
                body.keys().collect::<Vec<_>>(),
                ["items"],
                "the list is {{items}}"
            );
            match body.remove("items") {
                Some(Value::Array(items)) => items,
                other => panic!("items is {other:?}"),
            }
        }
        other => panic!("the list is {other}"),
    }
}

fn ids(views: &[Value]) -> Vec<String> {
    views
        .iter()
        .map(|view| view["item"]["id"].as_str().expect("an id").to_owned())
        .collect()
}

fn error(response: &http::Response, status: u16, code: &str) -> String {
    assert_eq!(response.status, status, "{}", response.body);
    let body = response.json();
    assert_eq!(body["error"]["code"], code, "{body}");
    body["error"]["message"]
        .as_str()
        .expect("a message")
        .to_owned()
}

fn bundle(path: &Path) -> HumanItemSample {
    serde_json::from_slice(&std::fs::read(path).expect("the bundle reads"))
        .expect("the bundle is still one the engine accepts")
}

/// Every item the list serves decodes as the engine's own `HumanItemView` —
/// whose decoder validates counts and previews — and the order, shapes and
/// bodies are exactly what the CLI lists over the same bundle.
#[test]
fn the_list_is_the_engines_view_in_its_declared_order() {
    let (_dir, served) = sample("representative.json");
    let (_cli_dir, listed) = sample("representative.json");
    let server = serve(&served, Some(OWNER));

    let views = items(&http::get(server.address, "/api/human-items"));
    assert_eq!(ids(&views), DECLARED_ORDER);
    for view in &views {
        serde_json::from_value::<HumanItemView>(view.clone())
            .unwrap_or_else(|err| panic!("{err}: {view}"));
    }
    assert_eq!(views, cli_list_owned(&listed, &[], OWNER));

    // Priorities stay on the wire's vocabulary; Critical is a label only.
    let priorities: Vec<&str> = views
        .iter()
        .map(|view| view["item"]["priority"].as_str().expect("a priority"))
        .collect();
    assert_eq!(
        priorities,
        ["urgent", "high", "high", "medium", "urgent", "low"]
    );
    // Blocking is derived from open state and scope: every open host item
    // blocks, and a non-blocking item reports nothing blocked.
    assert_eq!(views[0]["item"]["block"], json!({"scope": "host"}));
    assert_eq!(views[4]["blocked"], json!({"total": 0, "plans": []}));
    // A work hold's impact is per plan, each plan once, previewing its first
    // three steps.
    let design = &views[2]["blocked"];
    assert_eq!(design["total"], 7);
    assert_eq!(design["plans"][0]["plan"], "plan-a");
    assert_eq!(design["plans"][0]["count"], 5);
    assert_eq!(
        design["plans"][0]["preview"]
            .as_array()
            .expect("a preview")
            .iter()
            .map(|node| node["node"].as_str().expect("a node"))
            .collect::<Vec<_>>(),
        ["build", "test", "lint"]
    );
    assert_eq!(design["plans"][1]["plan"], "plan-b");
    assert_eq!(design["plans"][1]["count"], 2);
    // No owner-ended field exists anywhere in what is served.
    assert!(!http::get(server.address, "/api/human-items")
        .body
        .contains("owner_ended"));
}

/// Every selector the route accepts is the engine's own `HumanItemFilter`, and
/// each one selects exactly what the CLI's `list` selects with the same
/// selector in its own spelling.
#[test]
fn every_filter_selects_what_the_cli_selects() {
    let (_dir, served) = sample("representative.json");
    let (_cli_dir, listed) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    let cases: [(&str, &[&str], &[&str]); 16] = [
        (
            "kind=task",
            &["--kind", "task"],
            &["task-build", "task-design", "task-dashboard"],
        ),
        (
            "kind=question",
            &["--kind", "question"],
            &["question-canary", "question-cache", "question-export"],
        ),
        (
            "blocking=true",
            &["--blocking", "yes"],
            &[
                "task-build",
                "question-canary",
                "task-design",
                "task-dashboard",
            ],
        ),
        (
            "blocking=false",
            &["--blocking", "no"],
            &["question-cache", "question-export"],
        ),
        (
            "priority=urgent",
            &["--priority", "Critical"],
            &["task-build", "question-cache"],
        ),
        (
            "priority=high",
            &["--priority", "high"],
            &["question-canary", "task-design"],
        ),
        (
            "priority=medium",
            &["--priority", "MEDIUM"],
            &["task-dashboard"],
        ),
        ("priority=low", &["--priority", "Low"], &["question-export"]),
        (
            "state=answered",
            &["--state", "answered"],
            &["question-answered"],
        ),
        (
            "state=dismissed",
            &["--state", "dismissed"],
            &["task-dismissed"],
        ),
        ("state=completed", &["--state", "completed"], &[]),
        (
            "session=claude-code-supervising-session",
            &["--session", OWNER],
            &DECLARED_ORDER,
        ),
        (
            "run=run-a",
            &["--run", "run-a"],
            &["question-canary", "task-design"],
        ),
        (
            "plan=plan-b",
            &["--plan", "plan-b"],
            &["task-dashboard", "question-export"],
        ),
        ("host=true", &["--host"], &["task-build"]),
        (
            "kind=question&blocking=false&priority=urgent",
            &[
                "--kind",
                "question",
                "--blocking",
                "no",
                "--priority",
                "critical",
            ],
            &["question-cache"],
        ),
    ];
    for (query, flags, expected) in cases {
        let views = items(&http::get(
            server.address,
            &format!("/api/human-items?{query}"),
        ));
        assert_eq!(ids(&views), expected, "?{query}");
        assert_eq!(views, cli_list_owned(&listed, flags, OWNER), "?{query}");
    }
    // host=false is the complement of host=true over the open items.
    let not_host = items(&http::get(server.address, "/api/human-items?host=false"));
    assert_eq!(ids(&not_host), &DECLARED_ORDER[1..]);
}

/// A selector outside the engine's declaration is the error contract, never
/// an unfiltered list: the human spellings belong to the CLI, scope is not a
/// selector, and the wire's booleans are booleans.
#[test]
fn a_selector_the_engine_does_not_declare_is_refused() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    for query in [
        "priority=Critical",
        "priority=P1",
        "priority=none",
        "blocking=yes",
        "host=1x",
        "state=owner-ended",
        "scope=host",
        "kind=review",
    ] {
        error(
            &http::get(server.address, &format!("/api/human-items?{query}")),
            422,
            "invalid_request",
        );
    }
}

/// The detail is every blocked step, grouped by plan in the order the impact
/// lists them, exactly as `show --json` prints it; a non-blocking item's
/// detail lists none.
#[test]
fn the_detail_enumerates_every_blocked_step_as_the_cli_shows_it() {
    let (_dir, served) = sample("representative.json");
    let (_cli_dir, listed) = sample("representative.json");
    let server = serve(&served, Some(OWNER));

    let response = http::get(server.address, "/api/human-items/task-design");
    assert_eq!(response.status, 200, "{}", response.body);
    let detail = response.json();
    serde_json::from_value::<HumanItemDetail>(detail.clone()).expect("the engine's detail");
    assert_eq!(
        detail,
        cli_json(&listed, &["show", "task-design", "--json"])
    );
    let steps: Vec<(&str, &str)> = detail["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|node| {
            (
                node["run"].as_str().expect("a run"),
                node["node"].as_str().expect("a node"),
            )
        })
        .collect();
    assert_eq!(
        steps,
        [
            ("run-a", "build"),
            ("run-a", "test"),
            ("run-a", "lint"),
            ("run-a", "package"),
            ("run-a", "publish"),
            ("run-b", "docs"),
            ("run-b", "screens"),
        ]
    );

    let cache = http::get(server.address, "/api/human-items/question-cache").json();
    assert_eq!(cache["nodes"], json!([]));
    assert_eq!(
        cache,
        cli_json(&listed, &["show", "question-cache", "--json"])
    );

    error(
        &http::get(server.address, "/api/human-items/no-such-item"),
        404,
        "human_item_not_found",
    );
    error(
        &http::get(server.address, "/api/human-items/..hidden"),
        422,
        "invalid_human_item_id",
    );
}

/// Content belongs to the owning session: another session is served neither
/// the item in a list nor its detail, an unattributed server owns nothing, and
/// the owner reads all of its own.
#[test]
fn an_items_content_is_served_only_to_its_owner() {
    let (_dir, served) = sample("representative.json");

    let owner = serve(&served, Some(OWNER));
    assert!(!ids(&items(&http::get(owner.address, "/api/human-items")))
        .contains(&"task-other".to_owned()));
    let refused = http::get(owner.address, "/api/human-items/task-other");
    error(&refused, 403, "human_item_not_owner");
    assert!(
        !refused.body.contains("Rotate"),
        "a refused detail serves none of the item: {}",
        refused.body
    );
    drop(owner);

    let other = serve(&served, Some(OTHER));
    assert_eq!(
        ids(&items(&http::get(other.address, "/api/human-items"))),
        ["task-other"]
    );
    assert_eq!(
        http::get(other.address, "/api/human-items/task-other").json()["item"]["title"],
        "Rotate the deploy credentials"
    );
    let refused = http::get(other.address, "/api/human-items/task-design");
    error(&refused, 403, "human_item_not_owner");
    assert!(!refused.body.contains("action-items"), "{}", refused.body);
    drop(other);

    let nobody = serve(&served, None);
    assert_eq!(
        items(&http::get(nobody.address, "/api/human-items")),
        Vec::<Value>::new()
    );
    error(
        &http::get(nobody.address, "/api/human-items/task-build"),
        403,
        "human_item_not_owner",
    );
}

/// Every write is the acting session's authority over an item it owns: a
/// write to another session's item, and any write by an unattributed server,
/// is refused before the engine is asked, and the bundle is left as it was.
#[test]
fn a_write_to_an_item_the_session_does_not_own_is_refused_and_changes_nothing() {
    let (_dir, served) = sample("representative.json");
    let before = std::fs::read(&served).expect("the bundle reads");

    let other = serve(&served, Some(OTHER));
    for (path, body) in [
        (
            "/api/human-items/question-canary/answer",
            r#"{"text":"eu-west"}"#,
        ),
        ("/api/human-items/task-build/complete", "{}"),
        ("/api/human-items/task-build/dismiss", "{}"),
    ] {
        error(
            &http::post(other.address, path, body),
            403,
            "human_item_not_owner",
        );
    }
    drop(other);

    let nobody = serve(&served, None);
    error(
        &http::post(nobody.address, "/api/human-items/task-build/dismiss", ""),
        403,
        "human_item_not_owner",
    );
    drop(nobody);
    assert_eq!(std::fs::read(&served).expect("the bundle reads"), before);
}

/// Answering an open question resolves it as the acting session, answers the
/// engine's receipt, writes the bundle the CLI reads back, and a second
/// submission of the same answer is the engine's conflict — never a second
/// write.
#[test]
fn an_answer_is_the_engines_receipt_and_a_repeat_is_its_conflict() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));

    let response = http::post(
        server.address,
        "/api/human-items/question-canary/answer",
        r#"{"text":"eu-west, matching the incident report"}"#,
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let receipt: HumanItemReceipt =
        serde_json::from_str(&response.body).expect("the engine's receipt");
    assert_eq!(receipt.event_id, "sample-question-canary-answered");
    let answered = serde_json::to_value(&receipt.item).expect("serialize");
    assert_eq!(answered["item"]["state"], "answered");
    assert_eq!(
        answered["item"]["resolution"],
        json!({
            "actor": OWNER,
            "on_behalf_of": null,
            "text": "eu-west, matching the incident report",
            "reason": null,
        })
    );
    assert_eq!(answered["blocked"], json!({"total": 0, "plans": []}));
    // The write is the bundle's, so the CLI reads it back.
    assert_eq!(
        cli_json(&served, &["show", "question-canary", "--json"])["item"]["state"],
        "answered"
    );
    let written = std::fs::read(&served).expect("the bundle reads");

    let repeat = http::post(
        server.address,
        "/api/human-items/question-canary/answer",
        r#"{"text":"eu-west, matching the incident report"}"#,
    );
    assert_eq!(
        error(&repeat, 409, "human_item_conflict"),
        "item is already resolved"
    );
    assert_eq!(std::fs::read(&served).expect("the bundle reads"), written);
    assert!(!ids(&items(&http::get(server.address, "/api/human-items")))
        .contains(&"question-canary".to_owned()));

    // A task is not answered, and a blank answer is no answer.
    assert_eq!(
        error(
            &http::post(
                server.address,
                "/api/human-items/task-build/answer",
                r#"{"text":"done"}"#
            ),
            409,
            "human_item_conflict"
        ),
        "action does not match item kind"
    );
    assert_eq!(
        error(
            &http::post(
                server.address,
                "/api/human-items/question-cache/answer",
                r#"{"text":"  "}"#
            ),
            409,
            "human_item_conflict"
        ),
        "answer text must not be blank"
    );
    error(
        &http::post(
            server.address,
            "/api/human-items/question-cache/answer",
            r#"{"answer":"yes"}"#,
        ),
        422,
        "invalid_request",
    );
}

/// A design review is an ordinary task: Complete with an empty body uses the
/// approval reference the item stored when it was raised, the sample authority
/// records that approval as the acting session, and the task completes.
#[test]
fn completing_a_current_design_review_records_its_approval_first() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));

    let response = http::post(
        server.address,
        "/api/human-items/task-design/complete",
        "{}",
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let receipt = response.json();
    assert_eq!(receipt["event_id"], "sample-task-design-completed");
    assert_eq!(receipt["item"]["item"]["state"], "completed");
    assert_eq!(
        receipt["item"]["item"]["resolution"],
        json!({"actor": OWNER, "on_behalf_of": null, "text": null, "reason": null})
    );
    let written = serde_json::to_value(bundle(&served)).expect("serialize");
    assert_eq!(
        written["approvals"],
        json!([{
            "approval": {
                "board_copy": "docs/design/action-items.md",
                "key": "sha256:5d1c0a",
            },
            "actor": OWNER,
            "on_behalf_of": null,
        }])
    );
    // Completion takes nothing: no approval, board copy or key in the body.
    error(
        &http::post(
            server.address,
            "/api/human-items/task-dashboard/complete",
            r#"{"key":"sha256:c4e2f9"}"#,
        ),
        422,
        "invalid_request",
    );
    // A question is not completed.
    assert_eq!(
        error(
            &http::post(
                server.address,
                "/api/human-items/question-cache/complete",
                ""
            ),
            409,
            "human_item_conflict"
        ),
        "action does not match item kind"
    );
}

/// A design review whose document changed since it was raised refuses with
/// "Re-read the current document", dismisses the obsolete task, raises one
/// replacement for the current version and records no approval; completing the
/// obsolete task again raises nothing more.
#[test]
fn completing_a_stale_design_review_replaces_it_and_records_no_approval() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));

    let refused = http::post(
        server.address,
        "/api/human-items/task-dashboard/complete",
        "",
    );
    assert_eq!(
        error(&refused, 409, "human_item_conflict"),
        "Re-read the current document"
    );
    let open = items(&http::get(server.address, "/api/human-items?kind=task"));
    let replacements: Vec<&Value> = open
        .iter()
        .filter(|view| view["item"]["title"] == "Review the dashboard layout")
        .collect();
    assert_eq!(replacements.len(), 1, "one replacement: {open:?}");
    let replacement = replacements[0];
    assert_ne!(replacement["item"]["id"], "task-dashboard");
    assert_eq!(
        replacement["item"]["approval"],
        json!({"board_copy": "docs/design/dashboard.md", "key": "sha256:c4e2f9"})
    );
    let dismissed = items(&http::get(
        server.address,
        "/api/human-items?state=dismissed",
    ));
    let obsolete = dismissed
        .iter()
        .find(|view| view["item"]["id"] == "task-dashboard")
        .expect("the obsolete task is dismissed");
    assert_eq!(
        obsolete["item"]["resolution"]["reason"],
        "Re-read the current document"
    );
    assert!(serde_json::to_value(bundle(&served)).expect("serialize")["approvals"].is_null());

    let again = http::post(
        server.address,
        "/api/human-items/task-dashboard/complete",
        "",
    );
    assert_eq!(
        error(&again, 409, "human_item_conflict"),
        "item is already resolved"
    );
    assert_eq!(
        items(&http::get(server.address, "/api/human-items?kind=task"))
            .iter()
            .filter(|view| view["item"]["title"] == "Review the dashboard layout")
            .count(),
        1
    );

    // The replacement is current, so it completes and records its approval.
    let id = replacement["item"]["id"].as_str().expect("an id");
    let completed = http::post(
        server.address,
        &format!("/api/human-items/{id}/complete"),
        "{}",
    );
    assert_eq!(completed.status, 200, "{}", completed.body);
    assert_eq!(
        serde_json::to_value(bundle(&served)).expect("serialize")["approvals"][0]["approval"]
            ["key"],
        "sha256:c4e2f9"
    );
}

/// Dismissal takes an optional reason: no body, `{}`, a `null` reason and a
/// blank one are all no reason, and a reason given is recorded.
#[test]
fn a_dismissal_records_its_reason_only_when_one_is_given() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    for (id, body, reason) in [
        ("task-build", "", Value::Null),
        ("question-canary", "{}", Value::Null),
        ("task-design", r#"{"reason":null}"#, Value::Null),
        ("question-cache", r#"{"reason":"   "}"#, Value::Null),
        (
            "question-export",
            r#"{"reason":"the export stays"}"#,
            json!("the export stays"),
        ),
    ] {
        let response = http::post(
            server.address,
            &format!("/api/human-items/{id}/dismiss"),
            body,
        );
        assert_eq!(response.status, 200, "{id}: {}", response.body);
        let receipt = response.json();
        assert_eq!(receipt["event_id"], format!("sample-{id}-dismissed"));
        assert_eq!(receipt["item"]["item"]["state"], "dismissed");
        assert_eq!(
            receipt["item"]["item"]["resolution"]["reason"], reason,
            "{id}"
        );
        assert_eq!(receipt["item"]["item"]["resolution"]["actor"], OWNER);
    }
    error(
        &http::post(
            server.address,
            "/api/human-items/task-dashboard/dismiss",
            r#"{"why":"x"}"#,
        ),
        422,
        "invalid_request",
    );
}

/// A question raised as `session`, the body `POST /api/human-items` takes.
fn raise_input(session: &str, dedup: &str, priority: &str) -> String {
    json!({
        "schema_version": 1,
        "dedup_key": dedup,
        "kind": "question",
        "title": "Should the nightly job run on weekends?",
        "body": "The nightly job finds nothing new on weekends. Skipping it saves two hours of runner time each week.",
        "priority": priority,
        "owner": {"session": session, "run": null, "plan": null},
        "block": {"scope": "nothing"},
        "approval": null,
    })
    .to_string()
}

/// Raising takes the engine's `HumanItemInput`, as the owning session only (an
/// unattributed server owns nothing); a duplicate dedup key is the engine's
/// conflict and an input its decoder refuses is the error contract.
#[test]
fn raising_an_item_is_the_owners_and_answers_the_engines_receipt() {
    let (_dir, served) = sample("representative.json");
    let before = std::fs::read(&served).expect("the bundle reads");

    // An unattributed server owns nothing, so it raises nothing either.
    let nobody = serve(&served, None);
    error(
        &http::post(
            nobody.address,
            "/api/human-items",
            &raise_input(OWNER, "nightly", "low"),
        ),
        403,
        "human_item_not_owner",
    );
    drop(nobody);
    assert_eq!(std::fs::read(&served).expect("the bundle reads"), before);

    let server = serve(&served, Some(OWNER));
    let input = raise_input;

    let response = http::post(
        server.address,
        "/api/human-items",
        &input(OWNER, "nightly", "low"),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let receipt: HumanItemReceipt =
        serde_json::from_str(&response.body).expect("the engine's receipt");
    let raised = serde_json::to_value(&receipt.item).expect("serialize");
    assert_eq!(raised["item"]["state"], "open");
    assert_eq!(raised["item"]["owner"]["session"], OWNER);
    let id = raised["item"]["id"].as_str().expect("an id").to_owned();
    assert_eq!(receipt.event_id, format!("sample-{id}-raised"));
    assert!(ids(&items(&http::get(server.address, "/api/human-items"))).contains(&id));

    assert_eq!(
        error(
            &http::post(
                server.address,
                "/api/human-items",
                &input(OWNER, "nightly", "low")
            ),
            409,
            "human_item_conflict"
        ),
        "dedup_key already exists"
    );
    error(
        &http::post(
            server.address,
            "/api/human-items",
            &input(OTHER, "foreign", "low"),
        ),
        403,
        "human_item_not_owner",
    );
    error(
        &http::post(
            server.address,
            "/api/human-items",
            &input(OWNER, "unprioritised", "none"),
        ),
        422,
        "invalid_request",
    );
}

/// The same action through the CLI and through the route, over two copies of
/// one bundle, answers the same receipt and leaves the same bundle — but for
/// the actor, which is the acting session here and the CLI's own operator
/// there.
#[test]
fn the_cli_and_the_route_make_the_same_write() {
    let actions: [(&[&str], &str, &str); 4] = [
        (
            &["answer", "question-cache", "--text", "Reuse it"],
            "/api/human-items/question-cache/answer",
            r#"{"text":"Reuse it"}"#,
        ),
        (
            &["complete", "task-design"],
            "/api/human-items/task-design/complete",
            "{}",
        ),
        (
            &["dismiss", "task-build", "--reason", "restarted"],
            "/api/human-items/task-build/dismiss",
            r#"{"reason":"restarted"}"#,
        ),
        (
            &["dismiss", "question-export"],
            "/api/human-items/question-export/dismiss",
            "",
        ),
    ];
    for (flags, path, body) in actions {
        let (_dir, served) = sample("representative.json");
        let (_cli_dir, written) = sample("representative.json");
        let server = serve(&served, Some(OWNER));
        let response = http::post(server.address, path, body);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        let printed = cli(&written, flags);
        let as_actor = |text: &str| text.replace("sample-operator", OWNER);
        assert_eq!(
            response.json(),
            serde_json::from_str::<Value>(&as_actor(&printed)).expect("the CLI's receipt"),
            "{path}"
        );
        assert_eq!(
            serde_json::to_value(bundle(&served)).expect("serialize"),
            serde_json::from_str::<Value>(&as_actor(
                &std::fs::read_to_string(&written).expect("the bundle reads")
            ))
            .expect("the CLI's bundle"),
            "{path}"
        );
    }
}

/// A long body is served and listed whole: the route, the CLI's list and its
/// report all carry it to its last words — truncation is the browser card's,
/// and nobody else's.
#[test]
fn a_long_body_is_served_and_printed_in_full() {
    let (_dir, served) = sample("long-body.json");
    let server = serve(&served, Some(OWNER));
    let views = items(&http::get(server.address, "/api/human-items"));
    let long = views
        .iter()
        .find(|view| view["item"]["id"] == "long-task")
        .expect("the long item is listed");
    let body = long["item"]["body"].as_str().expect("a body");
    assert!(body.len() > 1000, "{} characters", body.len());
    assert!(body.ends_with("The final words are: ship the reviewed release."));
    assert_eq!(
        http::get(server.address, "/api/human-items/long-task").json()["item"]["body"],
        body
    );
    for verb in ["list", "report"] {
        assert!(
            cli(&served, &[verb]).contains(body),
            "`{verb}` printed it whole"
        );
    }
}

/// The CLI's text and the route's wire describe one priority vocabulary:
/// Critical, High, Medium and Low on the page and in text, urgent/high/
/// medium/low on the wire, and no P-label anywhere.
#[test]
fn priorities_are_words_in_text_and_the_wire_vocabulary_in_json() {
    let (_dir, served) = sample("representative.json");
    let printed = cli(&served, &["list"]);
    for label in ["Critical", "High", "Medium", "Low"] {
        assert!(
            printed.contains(&format!("  {label}  ")),
            "{label} in {printed}"
        );
    }
    for label in ["P0", "P1", "P2", "P3", "urgent"] {
        assert!(!printed.contains(label), "{label} in {printed}");
    }
    assert_eq!(
        onepipeline::human_items::schemas()["priority_labels"],
        json!({"urgent": "Critical", "high": "High", "medium": "Medium", "low": "Low"})
    );
    let server = serve(&served, Some(OWNER));
    let wire = http::get(server.address, "/api/human-items").body;
    assert!(wire.contains(r#""priority":"urgent""#), "{wire}");
    assert!(!wire.contains("Critical"), "{wire}");
}

/// A live host never serves fixture items: without the flag every route is
/// the engine's own `unavailable`, and the flag is refused at the command
/// line over a runs root that holds runs — as is a bundle the engine refuses.
#[test]
fn a_live_host_serves_no_sample_and_refuses_one() {
    let live = Serving::start_as(
        |runs| {
            crate::fixture_run::write(runs, crate::fixture_run::RUN_ID);
        },
        OWNER,
    );
    for response in [
        http::get(live.address, "/api/human-items"),
        http::get(live.address, "/api/human-items/task-build"),
        http::post(live.address, "/api/human-items/task-build/complete", "{}"),
        http::post(live.address, "/api/human-items/task-build/dismiss", ""),
        http::post(
            live.address,
            "/api/human-items/question-canary/answer",
            r#"{"text":"x"}"#,
        ),
        // A raise is refused for want of the sample before any ownership is
        // judged, whoever the body names as its owner.
        http::post(
            live.address,
            "/api/human-items",
            &raise_input(OWNER, "nightly", "low"),
        ),
        http::post(
            live.address,
            "/api/human-items",
            &raise_input(OTHER, "foreign", "low"),
        ),
    ] {
        assert_eq!(
            error(&response, 503, "human_items_unavailable"),
            "human-items unavailable against live state"
        );
    }
    drop(live);

    let (workspace, runs) = crate::fixture_run::workspace();
    crate::fixture_run::write(&runs, crate::fixture_run::RUN_ID);
    let output = Command::new(assert_cmd::cargo::cargo_bin("onepipeline-api"))
        .args(["serve", "--bind", "127.0.0.1:0", "--runs-root"])
        .arg(&runs)
        .arg("--human-items-sample")
        .arg(fixture("representative.json"))
        .output()
        .expect("the binary starts");
    assert_eq!(output.status.code(), Some(2));
    let said = String::from_utf8_lossy(&output.stderr);
    assert!(
        said.contains("a live host never serves sample data"),
        "{said}"
    );
    drop(workspace);

    let (workspace, empty) = crate::fixture_run::workspace();
    let broken = workspace.path().join("broken.json");
    std::fs::write(
        &broken,
        r#"{"schema_version":2,"items":[],"approval_keys":{}}"#,
    )
    .expect("write the bundle");
    let output = Command::new(assert_cmd::cargo::cargo_bin("onepipeline-api"))
        .args(["serve", "--bind", "127.0.0.1:0", "--runs-root"])
        .arg(&empty)
        .arg("--human-items-sample")
        .arg(&broken)
        .output()
        .expect("the binary starts");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("is not a human-item sample bundle"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// What each human-item route served over `representative.json`, held to the
/// goldens `tests/contract.rs` maps to the route table and reconciles with the
/// engine's own types. `UPDATE_CONTRACT_FIXTURES=1` rewrites them from what
/// the server served, which is how a deliberate payload change is made.
#[test]
fn every_human_item_route_serves_the_payload_its_golden_pins() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    let raise = json!({
        "schema_version": 1,
        "dedup_key": "nightly",
        "kind": "question",
        "title": "Should the nightly job run on weekends?",
        "body": "The nightly job finds nothing new on weekends. Skipping it saves two hours of runner time each week.",
        "priority": "low",
        "owner": {"session": OWNER, "run": null, "plan": null},
        "block": {"scope": "nothing"},
        "approval": null,
    })
    .to_string();
    let goldens = [
        (
            "human-items.json",
            http::get(server.address, "/api/human-items"),
        ),
        (
            "human-item.json",
            http::get(server.address, "/api/human-items/task-design"),
        ),
        (
            "human-items-raise.json",
            http::post(server.address, "/api/human-items", &raise),
        ),
        (
            "human-item-answer.json",
            http::post(
                server.address,
                "/api/human-items/question-canary/answer",
                r#"{"text":"eu-west"}"#,
            ),
        ),
        (
            "human-item-complete.json",
            http::post(
                server.address,
                "/api/human-items/task-design/complete",
                "{}",
            ),
        ),
        (
            "human-item-dismiss.json",
            http::post(server.address, "/api/human-items/task-build/dismiss", "{}"),
        ),
    ];
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for (name, response) in goldens {
        assert_eq!(response.status, 200, "{name}: {}", response.body);
        let served = format!(
            "{}\n",
            serde_json::to_string_pretty(&response.json()).expect("serialize")
        );
        let path = dir.join(name);
        if std::env::var_os("UPDATE_CONTRACT_FIXTURES").is_some() {
            std::fs::write(&path, &served).expect("write the golden");
        }
        assert_eq!(
            std::fs::read_to_string(&path).unwrap_or_default(),
            served,
            "{name} differs from what the route served; rerun with UPDATE_CONTRACT_FIXTURES=1 \
             if the change is deliberate"
        );
    }
}

/// A bundle the server can no longer read is the engine's failure — `500
/// engine_error` — naming no path, and the routes answer again once it is back.
#[test]
fn an_unreadable_bundle_is_an_engine_failure_that_names_no_path() {
    let (dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    let away = dir.path().join("away.json");
    std::fs::rename(&served, &away).expect("move the bundle away");
    for response in [
        http::get(server.address, "/api/human-items"),
        http::post(server.address, "/api/human-items/task-build/dismiss", ""),
    ] {
        let said = error(&response, 500, "engine_error");
        assert!(said.contains("could not be read"), "{said}");
        assert!(
            !said.contains(dir.path().to_str().expect("utf-8")),
            "{said}"
        );
    }
    std::fs::rename(&away, &served).expect("put the bundle back");
    assert_eq!(
        ids(&items(&http::get(server.address, "/api/human-items"))),
        DECLARED_ORDER
    );
}

/// A bundle changed under the server into one the engine refuses is the
/// engine's failure on every route until it is one the engine accepts again —
/// the server never serves from a bundle it last read whole.
#[test]
fn a_bundle_corrupted_while_served_is_refused_until_it_is_whole_again() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    let whole = std::fs::read(&served).expect("the bundle reads");
    std::fs::write(
        &served,
        br#"{"schema_version":1,"items":[{}],"approval_keys":{}}"#,
    )
    .expect("corrupt the bundle");
    for response in [
        http::get(server.address, "/api/human-items"),
        http::get(server.address, "/api/human-items/task-build"),
        http::post(server.address, "/api/human-items/task-build/dismiss", ""),
    ] {
        assert!(
            error(&response, 500, "engine_error").contains("not one the engine accepts"),
            "{}",
            response.body
        );
    }
    std::fs::write(&served, &whole).expect("restore the bundle");
    assert_eq!(
        ids(&items(&http::get(server.address, "/api/human-items"))),
        DECLARED_ORDER
    );
}

/// Writes made at once are made one after another: each reads the bundle the
/// last one wrote, so none is lost to another's write-back.
#[test]
fn writes_made_at_once_each_land() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    let address = server.address;
    let writes: Vec<(&str, &str)> = vec![
        (
            "/api/human-items/question-canary/answer",
            r#"{"text":"eu-west"}"#,
        ),
        (
            "/api/human-items/question-cache/answer",
            r#"{"text":"reuse it"}"#,
        ),
        (
            "/api/human-items/question-export/dismiss",
            r#"{"reason":"kept"}"#,
        ),
        ("/api/human-items/task-build/complete", "{}"),
        ("/api/human-items/task-design/complete", "{}"),
        ("/api/human-items/task-dashboard/dismiss", ""),
    ];
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(writes.len()));
    let handles: Vec<_> = writes
        .into_iter()
        .map(|(path, body)| {
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                http::post(address, path, body)
            })
        })
        .collect();
    for handle in handles {
        let response = handle.join().expect("the write's thread");
        assert_eq!(response.status, 200, "{}", response.body);
    }
    let resolved: Vec<(String, String)> = serde_json::to_value(bundle(&served)).expect("serialize")
        ["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|detail| {
            (
                detail["item"]["id"].as_str().expect("an id").to_owned(),
                detail["item"]["state"]
                    .as_str()
                    .expect("a state")
                    .to_owned(),
            )
        })
        .filter(|(id, _)| DECLARED_ORDER.contains(&id.as_str()))
        .collect();
    assert_eq!(
        resolved,
        [
            ("task-build", "completed"),
            ("question-canary", "answered"),
            ("task-design", "completed"),
            ("task-dashboard", "dismissed"),
            ("question-cache", "answered"),
            ("question-export", "dismissed"),
        ]
        .map(|(id, state)| (id.to_owned(), state.to_owned()))
    );
    assert_eq!(
        items(&http::get(address, "/api/human-items")),
        Vec::<Value>::new()
    );
}

/// A write whose bundle cannot be written back is the engine's failure, leaves
/// the bundle exactly as it was, and is made once the bundle can be written.
#[test]
fn a_write_that_cannot_be_written_back_changes_nothing_and_can_be_made_again() {
    let (dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    let before = std::fs::read(&served).expect("the bundle reads");
    // The sibling the write-back stages through, taken by a directory.
    let staging = dir.path().join("representative.json.writing");
    std::fs::create_dir(&staging).expect("block the staging file");
    let refused = http::post(server.address, "/api/human-items/task-build/dismiss", "");
    let said = error(&refused, 500, "engine_error");
    assert!(said.contains("was not written"), "{said}");
    assert!(
        !said.contains(dir.path().to_str().expect("utf-8")),
        "{said}"
    );
    assert_eq!(std::fs::read(&served).expect("the bundle reads"), before);
    assert!(ids(&items(&http::get(server.address, "/api/human-items")))
        .contains(&"task-build".to_owned()));

    std::fs::remove_dir(&staging).expect("unblock the staging file");
    let made = http::post(server.address, "/api/human-items/task-build/dismiss", "");
    assert_eq!(made.status, 200, "{}", made.body);
    assert_eq!(stored_state(&served, "task-build"), "dismissed");
}

fn stored_state(path: &Path, id: &str) -> String {
    serde_json::to_value(bundle(path)).expect("serialize")["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|detail| detail["item"]["id"] == id)
        .and_then(|detail| detail["item"]["state"].as_str())
        .expect("the item's state")
        .to_owned()
}

/// Over HTTP every write is the user's own: each route records the acting
/// session as the actor and nobody as `on_behalf_of`, in its receipt and in the
/// bundle, and a body that tries to name either is refused before the engine
/// is asked. A manager completing on a user's behalf after chat approval is the
/// CLI/runtime path's, which this server has no way to vouch for.
#[test]
fn every_write_is_the_acting_sessions_own_and_no_body_can_name_another() {
    let (_dir, served) = sample("representative.json");
    let server = serve(&served, Some(OWNER));
    let before = std::fs::read(&served).expect("the bundle reads");
    for (path, body) in [
        (
            "/api/human-items/question-canary/answer",
            r#"{"text":"eu-west","on_behalf_of":"the-user"}"#,
        ),
        (
            "/api/human-items/question-canary/answer",
            r#"{"text":"eu-west","actor":"the-user"}"#,
        ),
        (
            "/api/human-items/task-design/complete",
            r#"{"on_behalf_of":"the-user"}"#,
        ),
        (
            "/api/human-items/task-design/complete",
            r#"{"actor":"a-manager"}"#,
        ),
        (
            "/api/human-items/task-build/dismiss",
            r#"{"on_behalf_of":"the-user"}"#,
        ),
        (
            "/api/human-items/task-build/dismiss",
            r#"{"reason":null,"actor":"a-manager"}"#,
        ),
    ] {
        error(
            &http::post(server.address, path, body),
            422,
            "invalid_request",
        );
    }
    assert_eq!(std::fs::read(&served).expect("the bundle reads"), before);

    for (id, path, body) in [
        (
            "question-canary",
            "/api/human-items/question-canary/answer",
            r#"{"text":"eu-west"}"#,
        ),
        ("task-design", "/api/human-items/task-design/complete", "{}"),
        ("task-build", "/api/human-items/task-build/dismiss", ""),
    ] {
        let response = http::post(server.address, path, body);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        let resolution = &response.json()["item"]["item"]["resolution"];
        assert_eq!(resolution["actor"], OWNER, "{path}");
        assert_eq!(resolution["on_behalf_of"], Value::Null, "{path}");
        let written = serde_json::to_value(bundle(&served)).expect("serialize");
        let stored = written["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|detail| detail["item"]["id"] == id)
            .expect("the item is in the bundle");
        assert_eq!(
            stored["item"]["resolution"]["on_behalf_of"],
            Value::Null,
            "{id}"
        );
    }
    // The design review's approval is recorded as the acting session's too.
    let written = serde_json::to_value(bundle(&served)).expect("serialize");
    assert_eq!(
        written["approvals"],
        json!([{
            "approval": {"board_copy": "docs/design/action-items.md", "key": "sha256:5d1c0a"},
            "actor": OWNER,
            "on_behalf_of": null,
        }])
    );
}
