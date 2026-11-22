//! The conversation item every turn-level row names (timeline schema 18), read
//! off the real routes of the compiled server over a run carrying each kind.
//!
//! The run holds two supervised dispatches at one node, in the record shapes a
//! host's runs carry: the worker's own `turn-started`, `turn-message` and
//! `turn-completed` (`role: assistant`), and the supervisor's three beside them on
//! the worker's session (`role: user`, its message `origin: supervisor`), none of
//! the messages carrying a reference in the journal. One dispatch settled, with a
//! report holding the judge's rows, so its judge conversation is served; the other
//! is still running, so none is. Every item a row names is then asked for on the
//! conversation route, which is the pairing a reader relies on.

use std::path::Path;

use serde_json::{json, Value};

use crate::fixture_run;
use crate::http;
use crate::serving::Serving;

/// The settled, judged dispatch.
const SETTLED_STREAM: &str = "node-scope-1790000000001-7001";
const SETTLED: &str = "node-scope-1790000000001-7001.worker";
/// The dispatch still running, which has no judge conversation yet.
const LIVE_STREAM: &str = "node-scope-1790000000002-7002";
const LIVE: &str = "node-scope-1790000000002-7002.worker";
/// A dispatch still running whose journal relayed its third turn before its
/// second: turn 2 is a message alone, so turn 3 sits at turn 2's position.
const GAP_STREAM: &str = "node-scope-1790000000003-7003";
const GAP: &str = "node-scope-1790000000003-7003.worker";
/// How many turns each side of the settled dispatch took.
const SETTLED_TURNS: u64 = 2;

fn labels(run: &str, session: &str) -> Value {
    json!({
        "run_id": session.split('.').next(),
        "node": fixture_run::NODE_ID,
        "member": "worker",
        "persona": "engineer",
        "onepipeline.run_id": run,
        "onepipeline.node": fixture_run::NODE_ID,
        "session": session,
    })
}

/// One relayed turn record on `session`.
fn relay(dir: &Path, run: &str, stream: &str, session: &str, kind: &str, payload: Value) {
    fixture_run::append_relayed_on(dir, stream, kind, labels(run, session), payload);
}

/// One whole turn of one party: its start, its words and its close — or, for
/// a supervisor's last turn of a dispatch it settles, its start and close
/// alone, because it writes no next prompt.
fn turn(dir: &Path, run: &str, stream: &str, session: &str, number: u64, role: &str) {
    turn_saying(dir, run, stream, session, (number, role), true);
}

fn turn_saying(
    dir: &Path,
    run: &str,
    stream: &str,
    session: &str,
    (number, role): (u64, &str),
    says: bool,
) {
    let supervising = role == "user";
    relay(
        dir,
        run,
        stream,
        session,
        "turn-started",
        json!({ "turn": number, "role": role, "started_at": "2026-08-07T12:01:00.000Z",
                "instruction": format!("{role} turn {number} is asked") }),
    );
    if !supervising {
        // One tool call from inside the agent's turn, placed by its `tool`.
        relay(
            dir,
            run,
            stream,
            session,
            "turn-activity",
            json!({ "kind": "tool_call", "name": "Bash", "index": 0,
                    "tool_call_id": format!("call-{stream}-{number}") }),
        );
    }
    let mut said =
        json!({ "turn": number, "role": role, "text": format!("{role} turn {number} says") });
    if supervising {
        said["origin"] = json!("supervisor");
    }
    if says {
        relay(dir, run, stream, session, "turn-message", said);
    }
    relay(
        dir,
        run,
        stream,
        session,
        "turn-completed",
        json!({ "turn": number, "role": role, "started_at": "2026-08-07T12:01:00.000Z",
                "finished_at": "2026-08-07T12:01:00.500Z",
                "usage": { "input_tokens": 10, "output_tokens": 2 } }),
    );
}

/// The settled dispatch's report: both agent turns, and one judge row per
/// supervisor invocation, so its judge conversation is served.
fn judged_report() -> String {
    use onejudge::{
        Message, PartyTelemetry, Report, SessionLink, Telemetry, TelemetryRole, Transcript,
    };

    let link = |role, turn: u32| SessionLink {
        session_id: format!("01a01f6{turn}-6168-72d1-b946-2251794e2fce"),
        role,
        turn_index: turn,
        started_at: "2026-08-07T12:01:00.000Z".into(),
        finished_at: Some("2026-08-07T12:01:00.500Z".into()),
        history_id: None,
        judge: None,
    };
    let turns = 1..=u32::try_from(SETTLED_TURNS).expect("a small count");
    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: turns
                .clone()
                .flat_map(|turn| {
                    [
                        Message::user(format!("assistant turn {turn} is asked")),
                        Message::assistant(format!("assistant turn {turn} says")),
                    ]
                })
                .collect(),
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: Some("the acceptance criteria were met".into()),
        settled_reason: None,
        judge_decisions: Vec::new(),
        usage: None,
        telemetry: Some(Telemetry {
            wall_ms: 1_000,
            agent: PartyTelemetry::default(),
            judge: PartyTelemetry::default(),
            orchestration_ms: 10,
            sessions: turns
                .flat_map(|turn| {
                    [
                        link(TelemetryRole::Agent, turn),
                        link(TelemetryRole::Judge, turn),
                    ]
                })
                .collect(),
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

/// The run: the contract fixture's, plus the two supervised dispatches.
fn write_run(root: &Path) {
    let run = fixture_run::RUN_ID;
    let dir = fixture_run::write(root, run);
    for number in 1..=SETTLED_TURNS {
        turn(&dir, run, SETTLED_STREAM, SETTLED, number, "assistant");
        let settles = number == SETTLED_TURNS;
        turn_saying(
            &dir,
            run,
            SETTLED_STREAM,
            SETTLED,
            (number, "user"),
            !settles,
        );
    }
    // An answer for a turn past what the report and the relayed turn records
    // hold: a turn the settled transcript no longer serves.
    relay(
        &dir,
        run,
        SETTLED_STREAM,
        SETTLED,
        "turn-message",
        json!({ "turn": SETTLED_TURNS + 1, "role": "assistant", "text": "a lost answer" }),
    );
    fixture_run::settle_member(
        &dir,
        &fixture_run::SettledMember {
            stream: SETTLED_STREAM,
            node: fixture_run::NODE_ID,
            member: "worker",
            at: "2026-08-07T12:01:01.000Z",
            artifact: "report-node-scope-1790000000001-7001",
            report: &judged_report(),
        },
        fixture_run::Produced::Report,
    );
    // The live dispatch's first turn, judged by a supervisor that has no judge
    // conversation to be read in yet, and whose message is the prompt of a turn
    // the agent has not started.
    turn(&dir, run, LIVE_STREAM, LIVE, 1, "assistant");
    turn(&dir, run, LIVE_STREAM, LIVE, 1, "user");
    // The gapped dispatch: turn 1 whole, turn 2's answer alone, turn 3 opened.
    turn(&dir, run, GAP_STREAM, GAP, 1, "assistant");
    relay(
        &dir,
        run,
        GAP_STREAM,
        GAP,
        "turn-message",
        json!({ "turn": 2, "role": "assistant", "text": "assistant turn 2 says" }),
    );
    relay(
        &dir,
        run,
        GAP_STREAM,
        GAP,
        "turn-started",
        json!({ "turn": 3, "role": "assistant", "started_at": "2026-08-07T12:01:00.000Z",
                "instruction": "assistant turn 3 is asked" }),
    );
}

fn get(serving: &Serving, path: &str) -> Value {
    let answer = http::get(serving.address, path);
    assert_eq!(answer.status, 200, "{path}: {}", answer.body);
    answer.json()
}

/// Every event row the three routes serve for the node, each tagged with the
/// route it came from.
fn rows_of_every_route(serving: &Serving) -> Vec<(&'static str, Value)> {
    let run = fixture_run::RUN_ID;
    let node = fixture_run::NODE_ID;
    let timeline = get(
        serving,
        &format!("/api/v2/runs/{run}/timeline?scope=node&node={node}"),
    );
    assert_eq!(timeline["timeline_schema_version"], json!(18));
    let mut rows: Vec<(&'static str, Value)> = timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .map(|row| ("timeline", row))
        .collect();
    let page = get(
        serving,
        &format!("/api/v2/runs/{run}/timeline/events?scope=node&node={node}&limit=500"),
    );
    rows.extend(
        page["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| ("events", row.clone())),
    );
    let stream = http::get(
        serving.address,
        &format!("/api/v2/runs/{run}/timeline/node-stream?scope=node&node={node}"),
    );
    assert_eq!(stream.status, 200, "{}", stream.body);
    for line in stream.body.lines() {
        let line: Value = serde_json::from_str(line).expect("a stream line");
        if line["kind"] == "rows" {
            rows.extend(
                line["rows"]
                    .as_array()
                    .expect("rows")
                    .iter()
                    .map(|row| ("node-stream", row.clone())),
            );
        }
    }
    rows
}

/// The rows, on every route, that are this record of `session`.
fn rows_for<'a>(
    rows: &'a [(&'static str, Value)],
    session: &str,
    kind: &str,
    turn: u64,
    role: &str,
) -> Vec<&'a (&'static str, Value)> {
    let found: Vec<_> = rows
        .iter()
        .filter(|(_, row)| {
            row["kind"] == kind
                && row["fields"]["turn"] == json!(turn)
                && row["fields"]["role"] == role
                && row["record_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with(session.split('.').next().unwrap_or("")))
        })
        .collect();
    let routes: std::collections::BTreeSet<_> = found.iter().map(|(route, _)| *route).collect();
    assert_eq!(
        routes.len(),
        3,
        "{kind} turn {turn} ({role}) of {session} is served on every route: {routes:?}"
    );
    found
}

/// The turn ids the conversation route serves for `conversation`.
fn served_turns(serving: &Serving, conversation: &str) -> Vec<String> {
    get(
        serving,
        &format!(
            "/api/v2/runs/{}/conversations/{conversation}",
            fixture_run::RUN_ID
        ),
    )["conversation"]["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .map(|turn| turn["id"].as_str().expect("an id").to_owned())
        .collect()
}

#[test]
fn every_turn_level_row_names_the_conversation_item_it_stands_for() {
    let serving = Serving::start(write_run);
    let rows = rows_of_every_route(&serving);
    let judge = format!("{SETTLED}.judge");
    let expect = |session: &str, kind: &str, turn: u64, role: &str, item: Value| {
        for (route, row) in rows_for(&rows, session, kind, turn, role) {
            assert_eq!(row["conversation_item"], item, "{route}: {row}");
            assert_eq!(
                row["reference"],
                json!({ "kind": "conversation", "value": item["conversation"] }),
                "{route}: {row}"
            );
        }
    };
    let item = |conversation: &str, turn: String, part: &str| json!({ "conversation": conversation, "turn": turn, "part": part });
    for number in 1..=SETTLED_TURNS {
        let own = format!("{SETTLED}.{}", number - 1);
        // The agent's three records are its own turn's three parts.
        expect(
            SETTLED,
            "turn-started",
            number,
            "assistant",
            item(SETTLED, own.clone(), "prompt"),
        );
        expect(
            SETTLED,
            "turn-message",
            number,
            "assistant",
            item(SETTLED, own.clone(), "answer"),
        );
        expect(
            SETTLED,
            "turn-completed",
            number,
            "assistant",
            item(SETTLED, own, "end"),
        );
        // The supervisor's message is the prompt it became; its own invocation is
        // the judge's turn the fold numbers for it.
        if number < SETTLED_TURNS {
            expect(
                SETTLED,
                "turn-message",
                number,
                "user",
                item(SETTLED, format!("{SETTLED}.{number}"), "prompt"),
            );
        }
        let judged = format!("{judge}.{}", number - 1);
        expect(
            SETTLED,
            "turn-started",
            number,
            "user",
            item(&judge, judged.clone(), "prompt"),
        );
        expect(
            SETTLED,
            "turn-completed",
            number,
            "user",
            item(&judge, judged, "end"),
        );
    }
    // No judge conversation is served for a dispatch still running, so its
    // supervisor's invocation opens the reply it is judging.
    expect(
        LIVE,
        "turn-started",
        1,
        "user",
        item(LIVE, format!("{LIVE}.0"), "end"),
    );
    expect(
        LIVE,
        "turn-completed",
        1,
        "user",
        item(LIVE, format!("{LIVE}.0"), "end"),
    );
    expect(
        LIVE,
        "turn-message",
        1,
        "user",
        item(LIVE, format!("{LIVE}.1"), "prompt"),
    );
    // Ruling `a2`: named from the record even where no transcript row is it.
    expect(
        SETTLED,
        "turn-message",
        SETTLED_TURNS + 1,
        "assistant",
        item(SETTLED, format!("{SETTLED}.{SETTLED_TURNS}"), "answer"),
    );
    expect(
        GAP,
        "turn-started",
        3,
        "assistant",
        item(GAP, format!("{GAP}.2"), "prompt"),
    );
    // Ruling `a2`'s gap: turn 2's position holds turn 3, so the item says so.
    let mut gapped = item(GAP, format!("{GAP}.1"), "answer");
    gapped["gap"] = json!(true);
    expect(GAP, "turn-message", 2, "assistant", gapped);

    // Every item a row names whose turn the transcript holds is a turn the
    // conversation route serves under that id.
    let worker = served_turns(&serving, SETTLED);
    let judged = served_turns(&serving, &judge);
    let live = served_turns(&serving, LIVE);
    let gap = served_turns(&serving, GAP);
    assert_eq!(gap, [format!("{GAP}.0"), format!("{GAP}.1")]);
    for (route, row) in &rows {
        let Some(named) = row.get("conversation_item") else {
            continue;
        };
        let turn = named["turn"].as_str().expect("a turn id");
        let served = match named["conversation"].as_str().expect("a conversation") {
            SETTLED => &worker,
            id if id == judge => &judged,
            LIVE => &live,
            GAP => &gap,
            _ => continue,
        };
        // Ruling `a2`: the items named ahead of the transcript, or past it, are
        // the live supervisor's message, whose turn the agent has not started,
        // the settled session's lost answer and the gapped session's newest turn.
        let absent = [
            format!("{LIVE}.1"),
            format!("{SETTLED}.{SETTLED_TURNS}"),
            format!("{GAP}.2"),
        ];
        if absent.iter().any(|id| id == turn) {
            assert!(!served.iter().any(|id| id == turn), "{served:?}");
            assert!(named.get("gap").is_none(), "{route}: {row}");
            continue;
        }
        // Only the gapped answer is flagged; every other named row is its turn.
        assert_eq!(
            named.get("gap").is_some(),
            turn == format!("{GAP}.1"),
            "{route}: {row}"
        );
        assert!(
            served.iter().any(|id| id == turn),
            "{route}: {turn} is not a turn of {served:?}"
        );
    }

    // A tool call keeps the `tool` schema 14 gave it and gains no item.
    for (session, stream, turns) in [
        (SETTLED, SETTLED_STREAM, SETTLED_TURNS),
        (LIVE, LIVE_STREAM, 1),
    ] {
        for number in 1..=turns {
            let call = format!("call-{stream}-{number}");
            let served: Vec<_> = rows
                .iter()
                .filter(|(_, row)| {
                    row["kind"] == "turn-activity" && row["fields"]["tool_call_id"] == call
                })
                .collect();
            let routes: std::collections::BTreeSet<_> =
                served.iter().map(|(route, _)| *route).collect();
            assert_eq!(
                routes.len(),
                3,
                "{call} is served on every route: {routes:?}"
            );
            for (route, row) in served {
                assert!(row.get("conversation_item").is_none(), "{route}: {row}");
                assert_eq!(
                    row["tool"],
                    json!({ "index": 0, "turn": format!("{session}.{}", number - 1), "tool_call_id": call }),
                    "{route}: {row}"
                );
                assert_eq!(row["reference"]["value"], json!(session), "{route}: {row}");
            }
        }
    }
}

#[test]
fn every_conversation_span_names_its_first_turns_prompt() {
    let serving = Serving::start(write_run);
    let timeline = get(
        &serving,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::NODE_ID
        ),
    );
    let spans = timeline["spans"].as_array().expect("spans");
    let judge = format!("{SETTLED}.judge");
    for conversation in [SETTLED, judge.as_str(), LIVE] {
        let span = spans
            .iter()
            .find(|span| span["reference"]["value"] == conversation)
            .unwrap_or_else(|| panic!("a span draws {conversation}: {spans:?}"));
        assert_eq!(
            span["conversation_item"],
            json!({ "conversation": conversation, "turn": format!("{conversation}.0"), "part": "prompt" }),
            "{span}"
        );
        assert_eq!(
            served_turns(&serving, conversation)
                .first()
                .map(String::as_str),
            Some(format!("{conversation}.0").as_str())
        );
    }
}
