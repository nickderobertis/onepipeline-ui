//! What the server serves of a turn's content, read out of the transcript the
//! turn was recorded in.
//!
//! `oneagentgraph` 0.8 relays a turn record with a `transcript` reference into
//! the oneharness history file and none of the bounded copies, and the server
//! reads every conversation, timeline row and activity line through the linked
//! engine's `views::transcript` resolver by that reference. These journeys put
//! the real thing on both sides: history files recorded on a real host
//! (`tests/fixtures/history`, trimmed and redacted, see the README beside them)
//! or written by oneharness's own `HistoryWriter`, journals carrying the records
//! the producer writes, and the compiled server on a real port.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::fixture_run;
use crate::harness_history;
use crate::http;
use crate::serving::Serving;

/// The recorded worker turn's project and session: a shell call, a file edit and
/// a file read, under one candidate that never closed.
const WORKER_PROJECT: &str =
    "home-operator-.onevcs-workspaces-github.com-example-onepipeline-0000-runs-s-6f43533d573f-worktree";
const WORKER_SESSION: &str =
    "node-scope-1792280365528-3632625-worker-skill-20261018T004959Z-3100071";
const WORKER_CANDIDATE: &str = "01a14c7c-a53b-7a83-aa13-3aef27d7f605";

/// The recorded judge turn's project and session: a file read, a shell call, a
/// search and the answer it closed on, under one candidate that closed.
const JUDGE_PROJECT: &str = "home-operator-projects-ai-orchestrator";
const JUDGE_SESSION: &str =
    "design-doc-1791501848591-2551400-worker-judge-20261008T232956Z-2575155";
const JUDGE_CANDIDATE: &str = "01a11dda-1d9a-7b33-b166-4ca0e7d14f86";

/// The session the referenced records are relayed under.
const REFERENCED: &str = "node-scope-1786925520101-4311.worker";

/// A copy of the recorded history store, under a directory of the journey's own.
fn recorded_store(into: &Path) -> PathBuf {
    let store = into.join("history");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/history");
    for project in fs::read_dir(&source).expect("the recorded store") {
        let project = project.expect("a project").path();
        let Some(name) = project.file_name() else {
            continue;
        };
        if !project.is_dir() {
            continue;
        }
        let target = store.join(name);
        fs::create_dir_all(&target).expect("the project directory");
        for session in fs::read_dir(&project).expect("the project's sessions") {
            let session = session.expect("a session").path();
            fs::copy(&session, target.join(session.file_name().expect("named")))
                .expect("copy the session");
        }
    }
    fs::canonicalize(store).expect("the store")
}

/// One recorded entry, read straight off the fixture file: the `event` of the
/// line whose candidate and index are these.
fn recorded_event(project: &str, session: &str, candidate: &str, index: u64) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/history")
        .join(project)
        .join(format!("{session}.jsonl"));
    fs::read_to_string(&path)
        .expect("the recorded session")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a history line"))
        .find(|line| {
            line["type"] == "event"
                && line["run_id"] == candidate
                && line["event"]["index"] == index
        })
        .map(|line| line["event"].clone())
        .expect("the recorded entry")
}

/// The recorded judge turn's closing line.
fn recorded_close() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/history")
        .join(JUDGE_PROJECT)
        .join(format!("{JUDGE_SESSION}.jsonl"));
    fs::read_to_string(&path)
        .expect("the recorded session")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a history line"))
        .find(|line| line["type"] == "run")
        .expect("the closing line")
}

/// A `transcript` reference, in the shape `oneagentgraph` writes one.
fn reference(store: &Path, project: &str, session: &str, candidate: &str) -> Value {
    json!({
        "history_dir": store.to_str().expect("utf-8 store"),
        "history_project": project,
        "history_session": session,
        "history_id": candidate,
    })
}

/// The same, for one event of the candidate.
fn activity_reference(
    store: &Path,
    project: &str,
    session: &str,
    candidate: &str,
    index: u64,
    tool_call_id: Option<&str>,
) -> Value {
    let mut located = reference(store, project, session, candidate);
    located["index"] = json!(index);
    if let Some(identity) = tool_call_id {
        located["tool_call_id"] = json!(identity);
    }
    located
}

fn get(serving: &Serving, path: &str) -> Value {
    let response = http::get(serving.address, path);
    assert_eq!(response.status, 200, "{path}: {}", response.body);
    response.json()
}

/// A worker's turn relayed as the producer relays one once history is on — a
/// reference on every record and no copy on any — read whole, described in one
/// line per call by the engine's resolver, and said as unavailable where the
/// file a reference names is gone.
///
/// The descriptions are the engine's rules applied to entries a real harness
/// recorded: a shell call is its command's first line, a file tool its verb and
/// path, a search its pattern; each is cut to 120 characters with an ellipsis.
#[test]
fn a_referenced_turn_is_read_whole_and_each_call_described_in_one_line() {
    let host = tempfile::tempdir().expect("the host's directories");
    let store = recorded_store(host.path());
    let gone = "a-session-the-store-no-longer-holds";
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let relay = |kind: &str, payload: Value| {
            let labels = json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "worker",
                "session": REFERENCED,
            });
            fixture_run::append_relayed(&dir, "agentgraph", kind, labels, payload);
        };
        relay(
            "turn-started",
            json!({
                "transcript": reference(&store, JUDGE_PROJECT, JUDGE_SESSION, JUDGE_CANDIDATE),
                "turn": 1,
                "role": "assistant",
                "started_at": "2026-08-07T12:04:00.000Z",
            }),
        );
        let worker = |index: u64, kind: &str, name: Option<&str>, identity: Option<&str>| {
            relay(
                "turn-activity",
                json!({
                    "transcript": activity_reference(
                        &store, WORKER_PROJECT, WORKER_SESSION, WORKER_CANDIDATE, index, identity,
                    ),
                    "kind": kind,
                    "name": name,
                    "tool_call_id": identity,
                    "index": index,
                }),
            );
        };
        worker(
            1,
            "tool_call",
            Some("Bash"),
            Some("toolu_019FouuW2Kfh1TCDkAC8HpUX"),
        );
        worker(
            2,
            "tool_result",
            Some("Bash"),
            Some("toolu_019FouuW2Kfh1TCDkAC8HpUX"),
        );
        worker(
            17,
            "tool_call",
            Some("Edit"),
            Some("toolu_01FBZWyg7wcDXCbZY4PvuLWi"),
        );
        worker(
            18,
            "tool_result",
            Some("Edit"),
            Some("toolu_01FBZWyg7wcDXCbZY4PvuLWi"),
        );
        worker(
            22,
            "tool_call",
            Some("Read"),
            Some("toolu_01LjwP1ejJaJFZGyDYougJMX"),
        );
        relay(
            "turn-activity",
            json!({
                "transcript": activity_reference(
                    &store, JUDGE_PROJECT, JUDGE_SESSION, JUDGE_CANDIDATE, 4, None,
                ),
                "kind": "tool_call",
                "name": "Glob",
                "index": 4,
            }),
        );
        // A reference whose file the store no longer holds.
        relay(
            "turn-activity",
            json!({
                "transcript": activity_reference(
                    &store, WORKER_PROJECT, gone, WORKER_CANDIDATE, 30, None,
                ),
                "kind": "tool_call",
                "name": "Bash",
                "index": 30,
            }),
        );
        relay(
            "turn-message",
            json!({
                "transcript": reference(&store, JUDGE_PROJECT, JUDGE_SESSION, JUDGE_CANDIDATE),
                "turn": 1,
                "role": "assistant",
            }),
        );
    });

    // The node's timeline: every turn-activity row carries the resolver's line.
    let timeline = get(
        &serving,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::SHIP_NODE_ID
        ),
    );
    let described: Vec<(u64, String)> = timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "node")
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .filter(|event| {
            event["kind"] == "turn-activity" && event["reference"]["value"] == REFERENCED
        })
        .map(|event| {
            (
                event["tool"]["index"].as_u64().expect("the tool's index"),
                event["description"]
                    .as_str()
                    .expect("a description")
                    .to_owned(),
            )
        })
        .collect();
    let missing = store.join(WORKER_PROJECT).join(format!("{gone}.jsonl"));
    assert_eq!(
        described,
        vec![
            // A shell call: its command's first line, cut to 120 characters.
            (
                1,
                "grep -rn \"RENDER_COST_ENV\\|_ENV: &str = \\\"ONEPIPELINE_[A-Z_]*\\(PROBE\\|RECORD\\|TRACE\\|COST\\|GATE\\|PAUSE\\)\" src | head; g…".to_owned()
            ),
            (2, recorded_output_line(WORKER_PROJECT, WORKER_SESSION, WORKER_CANDIDATE, 2)),
            // A file edit: its verb and the path, cut the same way.
            (
                17,
                "Edit /home/operator/.onevcs/workspaces/github.com-example-onepipeline-0000/runs/s-6f43533d573f/worktree/crates/testfake…".to_owned()
            ),
            (18, recorded_output_line(WORKER_PROJECT, WORKER_SESSION, WORKER_CANDIDATE, 18)),
            // A file read.
            (
                22,
                "Read /home/operator/.onevcs/workspaces/github.com-example-onepipeline-0000/runs/s-6f43533d573f/worktree/src/driver.rs".to_owned()
            ),
            // A search: its pattern.
            (4, ".plans/tasks/*.md".to_owned()),
            // A file the store no longer holds, named and said as gone.
            (
                30,
                format!("transcript unavailable: {}: missing-file", missing.display())
            ),
        ],
        "{timeline}"
    );
    // A description is one bounded line; the line saying a transcript is gone
    // names its file whole, because a cut path names no file.
    for (_, line) in described
        .iter()
        .filter(|(_, line)| !line.starts_with("transcript unavailable: "))
    {
        assert!(line.chars().count() <= 120, "one line, bounded: {line}");
    }
    // Each names the conversation it is a turn of, and the turn it sits in, so a
    // reader opening the row is shown that turn at that call.
    let turn_named: Vec<Value> = timeline["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .find(|span| span["kind"] == "node")
        .expect("the node's span")["events"]
        .as_array()
        .expect("events")
        .iter()
        .filter(|event| event["kind"] == "turn-activity" && event["tool"]["index"] == 17)
        .map(|event| {
            json!([
                event["reference"],
                event["tool"]["turn"],
                event["tool"]["tool_call_id"]
            ])
        })
        .collect();
    assert_eq!(
        turn_named,
        vec![json!([
            { "kind": "conversation", "value": REFERENCED },
            format!("{REFERENCED}.0"),
            "toolu_01FBZWyg7wcDXCbZY4PvuLWi",
        ])]
    );

    // The conversation: the prompt and the reply whole, each call's input as the
    // harness recorded it and its output whole, and no cut flag anywhere.
    let conversation = get(
        &serving,
        &format!(
            "/api/v2/runs/{}/conversations/{REFERENCED}",
            fixture_run::RUN_ID
        ),
    );
    let turn = &conversation["conversation"]["turns"][0];
    let close = recorded_close();
    assert_eq!(turn["user"], close["prompt"], "{turn}");
    assert_eq!(turn["assistant"], close["text"], "{turn}");
    assert_eq!(turn["unknown"], json!({}), "nothing was cut: {turn}");
    let tools = turn["tools"].as_array().expect("the turn's tools");
    let edit = recorded_event(WORKER_PROJECT, WORKER_SESSION, WORKER_CANDIDATE, 17);
    let edited = recorded_event(WORKER_PROJECT, WORKER_SESSION, WORKER_CANDIDATE, 18);
    let served_edit = tools
        .iter()
        .find(|tool| tool["index"] == 17)
        .expect("the edit");
    assert_eq!(
        served_edit["input"], edit["input"],
        "the input whole: {served_edit}"
    );
    assert_eq!(served_edit["output"], edited["output"], "{served_edit}");
    assert_eq!(
        served_edit["toolCallId"],
        json!("toolu_01FBZWyg7wcDXCbZY4PvuLWi")
    );
    assert_eq!(
        tools
            .iter()
            .find(|tool| tool["index"] == 30)
            .expect("the gone call")["output"],
        json!(format!(
            "transcript unavailable: {}: missing-file",
            missing.display()
        ))
    );
    for tool in tools {
        assert!(tool.get("output_truncated").is_none(), "{tool}");
        assert!(tool.get("input_truncated").is_none(), "{tool}");
    }

    // The header's activity line: the node's last call, in the same words.
    let detail = get(&serving, &format!("/api/v2/runs/{}", fixture_run::RUN_ID));
    let activity = detail["run"]["live_activity"]
        .as_array()
        .expect("live activity")
        .iter()
        .find(|entry| entry["node"] == fixture_run::SHIP_NODE_ID)
        .cloned()
        .expect("the ship node's activity");
    assert_eq!(
        activity["description"],
        json!(format!(
            "transcript unavailable: {}: missing-file",
            missing.display()
        ))
    );
}

/// The first line of a recorded result's output, as the resolver describes a
/// result: trimmed, cut to 120 characters with an ellipsis.
fn recorded_output_line(project: &str, session: &str, candidate: &str, index: u64) -> String {
    let event = recorded_event(project, session, candidate, index);
    let line = event["output"]
        .as_str()
        .expect("an output")
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_owned();
    if line.chars().count() <= 120 {
        line
    } else {
        format!("{}…", line.chars().take(119).collect::<String>())
    }
}

/// The bound the recorder held a copy of a turn's text to, in bytes.
const RECORDER_BOUND: usize = 4096;

/// A prompt longer than the recorder's bound, whose end says it is the end.
fn long_prompt(which: &str) -> String {
    format!(
        "{which}: {}\nThe whole instruction ends here, after the bound.",
        "Read the plan and land each node in order. ".repeat(140)
    )
}

/// The recorder's copy of `text`: its head, cut on a character boundary.
fn head(text: &str) -> String {
    let mut cut = RECORDER_BOUND;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text[..cut].to_owned()
}

/// A tool output longer than the recorder's bound, and the tail it kept of it.
fn long_output() -> (String, String) {
    let whole = format!(
        "{}the last line the gate printed",
        "test result: ok. 1 passed\n".repeat(400)
    );
    let mut start = whole.len() - RECORDER_BOUND;
    while !whole.is_char_boundary(start) {
        start += 1;
    }
    let tail = whole[start..].to_owned();
    (whole, tail)
}

/// A run recorded before references keeps the copies its records carried, and
/// each session is read the best way it can be: from the member's stored report
/// where the run holds one, else from a history file the run names whose entry
/// the copy is a cut of, and only where neither exists from the copy — flagged,
/// so a reader can be told the recorder cut it and no whole copy exists.
#[test]
fn a_run_recorded_before_references_reads_each_session_whole_wherever_a_whole_copy_exists() {
    const REPORTED: &str = "node-scope-1786925520201-4311";
    const HISTORIED: &str = "node-scope-1786925520202-4311";
    const NEITHER: &str = "node-scope-1786925520203-4311";
    const POINTED: &str = "node-scope-1786925520204-4311";
    const REPORT_ARTIFACT: &str = "report-node-scope-1786925520201-4311";

    let host = tempfile::tempdir().expect("the host's directories");
    let reported_prompt = long_prompt("reported");
    let historied_prompt = long_prompt("historied");
    let neither_prompt = long_prompt("neither");
    let pointed_prompt = long_prompt("pointed");
    let (whole_output, kept_tail) = long_output();
    let reply = |which: &str| {
        format!(
            "{which}: {}The reply ends here, after the bound.",
            "Ran the gate and it passed. ".repeat(200)
        )
    };
    let recorded = harness_history::record_with_tool(
        &host.path().join("history"),
        "a worker that died before it settled",
        &historied_prompt,
        "just gate",
        &whole_output,
        &reply(HISTORIED),
    );
    let report = serde_json::to_string(&onejudge::Report::new(
        onejudge::Transcript {
            messages: vec![
                onejudge::Message::user(&reported_prompt),
                onejudge::Message::assistant("the plan is landed"),
            ],
        },
        Vec::new(),
        None,
        false,
    ))
    .expect("the report serializes");

    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        let relay = |stream: &str, kind: &str, payload: Value| {
            fixture_run::append_relayed_on(
                &dir,
                stream,
                kind,
                json!({
                    "run_id": fixture_run::RUN_ID,
                    "node": fixture_run::SHIP_NODE_ID,
                    "member": "worker",
                    "persona": "worker",
                    "session": format!("{stream}.worker"),
                }),
                payload,
            );
        };
        // A member nothing relayed a pointer for, whose invocation the run's own
        // pointer file names at the node it ran at — the record a member that died
        // before it settled leaves.
        harness_history::record_pointed(
            &host.path().join("history"),
            &harness_history::Pointed {
                pointer_file: &onepipeline::views::RunPaths::under(root, fixture_run::RUN_ID)
                    .oneharness_sessions(),
                labels: &format!(
                    "onepipeline.run_id={},onepipeline.node={}",
                    fixture_run::RUN_ID,
                    fixture_run::SHIP_NODE_ID
                ),
            },
            "a worker the pointer file names",
            &pointed_prompt,
            "the pointed worker's reply",
        );
        for (stream, prompt) in [
            (REPORTED, &reported_prompt),
            (HISTORIED, &historied_prompt),
            (NEITHER, &neither_prompt),
            (POINTED, &pointed_prompt),
        ] {
            relay(
                stream,
                "turn-started",
                json!({
                    "turn": 1,
                    "role": "assistant",
                    "instruction": head(prompt),
                    "instruction_truncated": true,
                    "started_at": "2026-08-07T12:04:00.000Z",
                }),
            );
            // The call's summary, cut as the recorder cuts one: whitespace
            // collapsed and the head kept.
            relay(
                stream,
                "turn-activity",
                json!({
                    "kind": "tool_call",
                    "name": "Bash",
                    "detail": "{\"command\":\"just gate\"",
                    "truncated": true,
                    "tool_call_id": harness_history::TOOL_CALL_ID,
                    "index": 0,
                }),
            );
            relay(
                stream,
                "turn-activity",
                json!({
                    "kind": "tool_result",
                    "name": "Bash",
                    "detail": "",
                    "output": kept_tail,
                    "output_truncated": true,
                    "tool_call_id": harness_history::TOOL_CALL_ID,
                    "index": 1,
                }),
            );
            relay(
                stream,
                "turn-message",
                json!({
                    "turn": 1,
                    "role": "assistant",
                    "text": head(&reply(stream)),
                    "truncated": true,
                }),
            );
        }
        // The member whose history file the run names: its own pointer at the
        // invocation, relayed as the producer relayed one before references.
        fixture_run::relay_harness_session(
            &dir,
            &fixture_run::HarnessSession {
                stream: HISTORIED,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                history_dir: Some(&recorded.dir),
                history_project: &recorded.project,
                history_session: &recorded.session,
                history_id: &recorded.history_id,
                bytes: recorded.bytes(),
            },
        );
        // And one that names a whole invocation that is some other turn's: the
        // member with neither is pointed at the historied member's file, whose
        // prompt its copy is no cut of, so nothing may be taken from it.
        fixture_run::relay_harness_session(
            &dir,
            &fixture_run::HarnessSession {
                stream: NEITHER,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                history_dir: Some(&recorded.dir),
                history_project: &recorded.project,
                history_session: &recorded.session,
                history_id: &recorded.history_id,
                bytes: recorded.bytes(),
            },
        );
        fixture_run::settle_member(
            &dir,
            &fixture_run::SettledMember {
                stream: REPORTED,
                node: fixture_run::SHIP_NODE_ID,
                member: "worker",
                at: "2026-08-07T12:05:00.000Z",
                artifact: REPORT_ARTIFACT,
                report: &report,
            },
            fixture_run::Produced::Report,
        );
    });

    let turn_of = |stream: &str| -> Value {
        get(
            &serving,
            &format!(
                "/api/v2/runs/{}/conversations/{stream}.worker",
                fixture_run::RUN_ID
            ),
        )["conversation"]["turns"][0]
            .clone()
    };

    // The stored report: the whole prompt, no flag.
    let reported = turn_of(REPORTED);
    assert_eq!(reported["user"], json!(reported_prompt), "{reported}");
    assert!(reported["unknown"].get("instruction_truncated").is_none());

    // No report, and a history file the run names: the whole prompt and the
    // whole output, recovered from the entries the copies are cuts of.
    let historied = turn_of(HISTORIED);
    assert_eq!(historied["user"], json!(historied_prompt), "{historied}");
    assert!(
        historied["user"]
            .as_str()
            .is_some_and(|user| user.ends_with("The whole instruction ends here, after the bound.")),
        "{historied}"
    );
    assert!(historied["unknown"].get("instruction_truncated").is_none());
    let call = &historied["tools"][0];
    assert_eq!(call["output"], json!(whole_output), "{call}");
    assert!(call.get("output_truncated").is_none(), "{call}");
    // The call's input as the harness recorded it, found by the call's identity,
    // where the copy held a cut summary of it.
    assert_eq!(call["input"], json!({ "command": "just gate" }), "{call}");
    assert!(call.get("input_truncated").is_none(), "{call}");
    // And the reply whole, from the same invocation.
    assert_eq!(
        historied["assistant"],
        json!(reply(HISTORIED)),
        "{historied}"
    );
    assert!(
        historied["unknown"].get("truncated").is_none(),
        "{historied}"
    );

    // No report and no pointer relayed: the run's own pointer file names the
    // invocation at the node, and its prompt is recovered from there.
    let pointed = turn_of(POINTED);
    assert_eq!(pointed["user"], json!(pointed_prompt), "{pointed}");
    assert!(pointed["unknown"].get("instruction_truncated").is_none());

    // Neither: the copy, and the recorder's own flags saying it is one — though
    // two whole invocations are named beside it, neither is one the copy is a
    // cut of, so neither is read as its text.
    let neither = turn_of(NEITHER);
    assert_eq!(neither["user"], json!(head(&neither_prompt)), "{neither}");
    assert_eq!(neither["unknown"]["instruction_truncated"], json!(true));
    let call = &neither["tools"][0];
    assert_eq!(call["output"], json!(kept_tail), "{call}");
    assert_eq!(call["output_truncated"], json!(true), "{call}");
    assert_eq!(call["input_truncated"], json!(true), "{call}");
    // Its reply's copy, though the historied member's whole reply is in a file
    // this member was pointed at: that invocation is another turn's.
    assert_eq!(
        neither["assistant"],
        json!(head(&reply(NEITHER))),
        "{neither}"
    );
    assert_eq!(neither["unknown"]["truncated"], json!(true), "{neither}");
}

/// The node timeline's description of each `turn-activity` the referenced
/// session relayed, by the producer's index.
fn descriptions(serving: &Serving) -> Vec<(u64, String)> {
    get(
        serving,
        &format!(
            "/api/v2/runs/{}/timeline?scope=node&node={}",
            fixture_run::RUN_ID,
            fixture_run::SHIP_NODE_ID
        ),
    )["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span["kind"] == "node")
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .filter(|event| {
            event["kind"] == "turn-activity" && event["reference"]["value"] == REFERENCED
        })
        .map(|event| {
            (
                event["tool"]["index"].as_u64().expect("an index"),
                event["description"]
                    .as_str()
                    .expect("a description")
                    .to_owned(),
            )
        })
        .collect()
}

/// Relay one `turn-activity` per `(project, session, candidate, index)` under the
/// referenced session, after the turn that opens it.
fn relay_activities(dir: &Path, store: &Path, entries: &[(&str, &str, &str, u64)]) {
    let relay = |kind: &str, payload: Value| {
        fixture_run::append_relayed(
            dir,
            "agentgraph",
            kind,
            json!({
                "run_id": fixture_run::RUN_ID,
                "node": fixture_run::SHIP_NODE_ID,
                "member": "worker",
                "persona": "worker",
                "session": REFERENCED,
            }),
            payload,
        );
    };
    relay(
        "turn-started",
        json!({
            "transcript": reference(store, JUDGE_PROJECT, JUDGE_SESSION, JUDGE_CANDIDATE),
            "turn": 1,
            "role": "assistant",
            "started_at": "2026-08-07T12:04:00.000Z",
        }),
    );
    for (project, session, candidate, index) in entries {
        relay(
            "turn-activity",
            json!({
                "transcript": activity_reference(store, project, session, candidate, *index, None),
                "kind": "tool_call",
                "name": "Bash",
                "index": index,
            }),
        );
    }
}

/// What a resolved entry is remembered as is only ever what the file holds now:
/// a file removed after it was read is said to be gone on the next read, and an
/// entry not yet written when it was first asked for is read once it is.
#[test]
fn a_remembered_reading_follows_the_history_file_as_it_changes() {
    let host = tempfile::tempdir().expect("the host's directories");
    let store = recorded_store(host.path());
    let worker_file = store
        .join(WORKER_PROJECT)
        .join(format!("{WORKER_SESSION}.jsonl"));
    let judge_file = store
        .join(JUDGE_PROJECT)
        .join(format!("{JUDGE_SESSION}.jsonl"));
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        relay_activities(
            &dir,
            &store,
            &[
                (WORKER_PROJECT, WORKER_SESSION, WORKER_CANDIDATE, 22),
                (JUDGE_PROJECT, JUDGE_SESSION, JUDGE_CANDIDATE, 99),
            ],
        );
    });
    let read = descriptions(&serving);
    assert!(read[0].1.starts_with("Read /home/operator/"), "{read:?}");
    assert_eq!(
        read[1].1,
        format!(
            "transcript unavailable: {}: missing-entry",
            judge_file.display()
        )
    );

    // The read file goes away; the entry not written yet is written.
    fs::remove_file(&worker_file).expect("remove the worker's file");
    let mut written = recorded_event(JUDGE_PROJECT, JUDGE_SESSION, JUDGE_CANDIDATE, 4);
    written["index"] = json!(99);
    let mut line = serde_json::from_str::<Value>(
        fs::read_to_string(&judge_file)
            .expect("the judge's file")
            .lines()
            .find(|line| line.contains("\"type\":\"event\""))
            .expect("an event line"),
    )
    .expect("a history line");
    line["event"] = written;
    let mut appended = fs::read_to_string(&judge_file).expect("the judge's file");
    appended.push_str(&format!("{line}\n"));
    fs::write(&judge_file, appended).expect("append the entry");

    let reread = descriptions(&serving);
    assert_eq!(
        reread,
        vec![
            (
                22,
                format!(
                    "transcript unavailable: {}: missing-file",
                    worker_file.display()
                )
            ),
            (99, ".plans/tasks/*.md".to_owned()),
        ]
    );
}

/// A turn record's reference is confined to the store it names before anything
/// opens it: a project directory in that store that is a symlink to another
/// store's reads as unreadable, and nothing of the other store is served.
#[cfg(unix)]
#[test]
fn a_turn_reference_that_resolves_out_of_its_store_is_not_opened() {
    const ELSEWHERE: &str = "a conversation this store never held";
    let host = tempfile::tempdir().expect("the host's directories");
    let store = recorded_store(host.path());
    let outside = harness_history::record(
        &host.path().join("another-store"),
        "a worker of another store",
        ELSEWHERE,
        ELSEWHERE,
    );
    let linked = "a-project-that-leaves-the-store";
    std::os::unix::fs::symlink(
        outside.path.parent().expect("the other store's project"),
        store.join(linked),
    )
    .expect("plant the link");
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        relay_activities(
            &dir,
            &store,
            &[
                (linked, &outside.session, &outside.history_id, 0),
                // And one that climbs by name rather than through a link.
                ("..", &outside.session, &outside.history_id, 1),
            ],
        );
    });
    let read = descriptions(&serving);
    let unreadable = |project: &str| {
        format!(
            "transcript unavailable: {}: unreadable",
            store
                .join(project)
                .join(format!("{}.jsonl", outside.session))
                .display()
        )
    };
    assert_eq!(read, vec![(0, unreadable(linked)), (1, unreadable(".."))]);
    let conversation = http::get(
        serving.address,
        &format!(
            "/api/v2/runs/{}/conversations/{REFERENCED}",
            fixture_run::RUN_ID
        ),
    );
    assert!(
        !conversation.body.contains(ELSEWHERE),
        "{}",
        conversation.body
    );
}

/// A stored conversation is a transcript, served whole however long it is —
/// where a log beside it of the same length is served as its end, and says so.
#[test]
fn a_stored_conversation_is_served_whole_where_a_log_is_served_as_its_end() {
    const CONVERSATION: &str = "artifact-long-conversation";
    const LOG: &str = "artifact-long-gate-log";
    let whole = format!(
        "the first thing said\n{}the last thing said\n",
        "and then the next thing\n".repeat(4_000)
    );
    assert!(whole.len() > 64 * 1024);
    let serving = Serving::start(|root| {
        let dir = fixture_run::write_live(root, fixture_run::RUN_ID);
        fs::write(dir.join("artifacts").join(CONVERSATION), &whole).expect("the conversation");
        fs::write(dir.join("artifacts").join(LOG), &whole).expect("the log");
        let line = json!({
            "v": 1,
            "ts": "2026-08-07T12:05:00.000Z",
            "stream": "a-recording-host-4243",
            "seq": 9_000,
            "source": "pipeline",
            "kind": "verification-recorded",
            "labels": { "run_id": fixture_run::RUN_ID, "node": fixture_run::SHIP_NODE_ID },
            "payload": {},
            "artifacts": [
                { "id": CONVERSATION, "kind": "conversation", "bytes": whole.len() },
                { "id": LOG, "kind": "log", "bytes": whole.len() },
            ],
        });
        let journal = dir.join("events.jsonl");
        let existing = fs::read_to_string(&journal).expect("the journal");
        fs::write(&journal, format!("{existing}{line}\n")).expect("append the record");
    });
    let read = |id: &str| {
        get(
            &serving,
            &format!("/api/v2/runs/{}/artifacts/{id}", fixture_run::RUN_ID),
        )
    };
    let conversation = read(CONVERSATION);
    assert_eq!(conversation["kind"], json!("conversation"));
    assert_eq!(conversation["truncated"], json!(false));
    assert_eq!(conversation["content"], json!(whole));
    let log = read(LOG);
    assert_eq!(log["kind"], json!("gate_log"));
    assert_eq!(log["truncated"], json!(true));
    let tail = log["content"].as_str().expect("the log's end");
    assert!(tail.ends_with("the last thing said\n") && !tail.contains("the first thing said"));
}
