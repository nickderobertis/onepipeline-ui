//! Subscriptions, over a real server: what a tab subscribes to is pushed to it as
//! it changes, and nothing else is.
//!
//! Every journey here starts the compiled binary over a runs root, creates a
//! subscription with `POST /api/v2/subscriptions`, reads its stream off a real
//! socket and grows the run's journal the way the engine's writer does
//! (`tests/support/live_journal.rs`), or through the engine's own verbs. The
//! server's passive trace (`ONEPIPELINE_UI_LIVE_TRACE`) says what each refresh
//! read and rebuilt, which is how a journey holds the server to building its
//! patches from the appended records rather than re-reading the run — and every
//! patched payload is held to what a fresh read of the same route serves.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use onepipeline_ui::patch::{self, Op};
use serde_json::{json, Value};

use crate::fixture_run;
use crate::http;
use crate::live_journal;
use crate::serving::Serving;

/// How long a journey waits for the server to act on an append before calling
/// it stuck: the poll is 50 ms, so this is the loaded-runner margin.
const PATIENCE: Duration = Duration::from_secs(20);

/// How long a stream must stay quiet before a journey reads it as done
/// delivering what one refresh sent.
const QUIET: Duration = Duration::from_millis(300);

/// A server whose subscriptions trace every refresh and refold the SDK's
/// telemetry on every change, so a patched detail can be held to a fresh read.
struct Live {
    serving: Serving,
    trace: PathBuf,
    _trace_dir: tempfile::TempDir,
}

impl Live {
    fn start(build: impl FnOnce(&Path)) -> Self {
        Self::start_with(build, &[])
    }

    fn start_with(build: impl FnOnce(&Path), extra: &[(&str, &str)]) -> Self {
        let trace_dir = tempfile::tempdir().expect("a trace directory");
        let trace = trace_dir.path().join("live.jsonl");
        let trace_text = trace.to_str().expect("utf-8").to_owned();
        let mut environment = vec![
            (onepipeline_ui::live::TRACE_ENV, trace_text.as_str()),
            (onepipeline_ui::live::TELEMETRY_REFOLD_ENV, "0"),
        ];
        environment.extend_from_slice(extra);
        let serving = Serving::start_with_env(build, &environment);
        Self {
            serving,
            trace,
            _trace_dir: trace_dir,
        }
    }

    fn address(&self) -> std::net::SocketAddr {
        self.serving.address
    }

    fn journal(&self, run: &str) -> PathBuf {
        self.serving.run_dir(run).join("events.jsonl")
    }

    /// Every refresh the server traced, in order.
    fn refreshes(&self) -> Vec<Value> {
        fs::read_to_string(&self.trace)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// Wait until the server traced a refresh of `run` after the `seen`th
    /// line, and hand it back.
    fn next_refresh(&self, run: &str, seen: &mut usize) -> Value {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let lines = self.refreshes();
            if let Some(found) = lines[*seen..]
                .iter()
                .position(|line| line["run"] == run && line["refresh"] != "unchanged")
            {
                let line = lines[*seen + found].clone();
                *seen += found + 1;
                return line;
            }
            assert!(
                Instant::now() < deadline,
                "no refresh of {run} after line {seen}: {lines:#?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn subscribe(&self, body: &Value) -> Value {
        let response = http::post(self.address(), "/api/v2/subscriptions", &body.to_string());
        assert_eq!(
            response.status, 201,
            "{body} was not subscribed: {}",
            response.body
        );
        response.json()
    }
}

/// One open subscription: the state it holds, kept by applying what arrives.
struct Tab {
    subscription: String,
    stream: http::Stream,
    applied: String,
    state: Value,
    frames: Vec<Value>,
}

impl Tab {
    fn open(live: &Live, view: &Value) -> Self {
        let subscribed = live.subscribe(&json!({ "view": view }));
        assert_eq!(subscribed["initial"]["type"], "snapshot");
        let snapshot = subscribed["initial"]["snapshot"].clone();
        let subscription = subscribed["subscription"]
            .as_str()
            .expect("an id")
            .to_owned();
        let applied = snapshot["id"].as_str().expect("a snapshot id").to_owned();
        let stream = http::stream(
            live.address(),
            &format!("/api/v2/events?subscription={subscription}&after={applied}"),
            None,
        );
        assert_eq!(stream.status, 200);
        Self {
            subscription,
            stream,
            applied,
            state: snapshot,
            frames: Vec::new(),
        }
    }

    /// Read until the stream goes quiet, applying each frame in order.
    fn drain(&mut self) -> Vec<Value> {
        let mut read = Vec::new();
        while let Some(frame) = self.stream.frame_within(QUIET) {
            let data = frame.json();
            assert_eq!(frame.id, data["id"], "the SSE id is the frame's id");
            assert_eq!(
                frame.event, data["type"],
                "the SSE event is the frame's type"
            );
            assert_eq!(data["subscription"], self.subscription.as_str());
            self.apply(&data);
            read.push(data);
        }
        self.frames.extend(read.iter().cloned());
        read
    }

    fn apply(&mut self, frame: &Value) {
        if frame["type"] == "reset" {
            self.state = frame["snapshot"].clone();
            self.applied = frame["id"].as_str().expect("an id").to_owned();
            return;
        }
        assert_eq!(
            frame["base"],
            self.applied.as_str(),
            "each frame names the one before it"
        );
        let ops = |frame: &Value| -> Vec<Op> {
            frame["ops"]
                .as_array()
                .expect("ops")
                .iter()
                .map(|op| Op::from_json(op).expect("an op the contract allows"))
                .collect()
        };
        let visible = &mut self.state["visible"];
        match frame["type"].as_str() {
            Some("run.changed") => {
                let rows = self.state["sidebar"].as_array_mut().expect("rows");
                let row = frame["row"].clone();
                match rows.iter_mut().find(|held| held["id"] == row["id"]) {
                    Some(held) => *held = row,
                    None => rows.push(row),
                }
            }
            Some("run.removed") => {
                let rows = self.state["sidebar"].as_array_mut().expect("rows");
                rows.retain(|held| held["id"] != frame["run_id"]);
            }
            Some("detail.patch") => {
                patch::apply(&mut visible["detail"], &ops(frame)).expect("the detail patch applies")
            }
            Some("timeline.patch") => patch::apply(&mut visible["timeline"], &ops(frame))
                .expect("the timeline patch applies"),
            Some("channel.patch") => patch::apply(&mut visible["channel"], &ops(frame))
                .expect("the channel patch applies"),
            other => panic!("an unknown frame type {other:?}"),
        }
        self.applied = frame["id"].as_str().expect("an id").to_owned();
    }
}

/// A payload without the instant it was read, which no two reads share.
fn unstamped(mut payload: Value) -> Value {
    if let Some(object) = payload.as_object_mut() {
        object.remove("observed_at");
    }
    payload
}

/// Hold a patched payload to a fresh read, naming what differs rather than
/// printing both whole.
fn same(patched: &Value, fresh: &Value, what: &str) {
    if patched != fresh {
        let mut ops = Vec::new();
        patch::diff(patched, fresh, &mut ops).expect("both payloads are objects");
        let ops: Vec<Value> = ops.iter().map(Op::to_json).collect();
        panic!("{what} differs from a fresh read by {ops:#?}");
    }
}

fn fresh(address: std::net::SocketAddr, path: &str) -> Value {
    let response = http::get(address, path);
    assert_eq!(response.status, 200, "{path}: {}", response.body);
    unstamped(response.json())
}

/// Every node the fixture run's plan carries.
fn plan_nodes(root: &Path, run: &str) -> Vec<String> {
    let plan: Value =
        serde_json::from_slice(&fs::read(root.join(run).join("plan.json")).expect("a plan"))
            .expect("the plan parses");
    plan["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .filter_map(|task| task["id"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn every_appended_record_patches_each_view_into_what_a_fresh_read_serves() {
    let run = fixture_run::RUN_ID;
    let mut held_back = Vec::new();
    let mut nodes = Vec::new();
    let live = Live::start(|root| {
        fixture_run::write(root, run);
        nodes = plan_nodes(root, run);
        let journal = root.join(run).join("events.jsonl");
        let total = fs::read_to_string(&journal)
            .expect("a journal")
            .lines()
            .count();
        // The run's first records on disk, and the rest appended one at a time
        // with every view open: each kind of record the fixture holds arrives
        // live at least once.
        held_back = live_journal::hold_back(&journal, total / 3);
    });
    assert!(
        held_back.len() > 10,
        "enough records to grow the run by: {}",
        held_back.len()
    );

    let mut views: Vec<(String, Value)> = vec![
        ("graph".into(), json!({ "type": "detail", "run_id": run })),
        (
            "graph, planner".into(),
            json!({ "type": "detail", "run_id": run, "filter": "planner" }),
        ),
        (
            "overall".into(),
            json!({ "type": "timeline", "run_id": run, "scope": "run" }),
        ),
        (
            "overall, planner".into(),
            json!({ "type": "timeline", "run_id": run, "scope": "run", "filter": "planner" }),
        ),
        (
            "channel".into(),
            json!({ "type": "channel", "run_id": run }),
        ),
    ];
    for node in &nodes {
        views.push((
            format!("node {node}"),
            json!({ "type": "timeline", "run_id": run, "scope": "node", "node": node }),
        ));
    }
    // Subscribed in turn, before anything grows: a node the held-back records
    // first name is subscribed to as a node of the plan.
    let mut tabs: Vec<(String, Value, Tab)> = Vec::new();
    for (name, view) in views {
        let subscribed = http::post(
            live.address(),
            "/api/v2/subscriptions",
            &json!({ "view": view }).to_string(),
        );
        if subscribed.status == 404 {
            // A plan node no record names yet is not a node this run has a
            // timeline for; it is subscribed to once it has one.
            continue;
        }
        let tab = Tab::open(&live, &view);
        tabs.push((name, view, tab));
    }
    assert!(tabs.len() >= 5);

    let mut seen = live.refreshes().len();
    let journal = live.journal(run);
    let address = live.address();
    let mut appended_refreshes = 0;
    for (index, line) in held_back.iter().enumerate() {
        live_journal::append_lines(&journal, std::slice::from_ref(line));
        let refresh = live.next_refresh(run, &mut seen);
        match refresh["refresh"].as_str() {
            Some("appended") => {
                appended_refreshes += 1;
                assert_eq!(
                    refresh["records"], 1,
                    "only the appended record was read: {refresh}"
                );
                assert_eq!(
                    refresh["whole"],
                    json!([]),
                    "nothing was rebuilt whole: {refresh}"
                );
                let timelines = tabs
                    .iter()
                    .filter(|(_, view, _)| view["type"] == "timeline")
                    .count();
                assert!(
                    refresh["rendered"]
                        .as_u64()
                        .is_some_and(|rendered| rendered <= timelines as u64),
                    "only the appended record was rendered, at most once per timeline: {refresh}"
                );
            }
            Some("reread") => {
                // The engine re-reads a record that sorts before the ones it
                // holds; the rebuild is still sent as what changed.
                assert!(
                    !refresh["whole"].as_array().expect("whole").is_empty(),
                    "{refresh}"
                );
            }
            other => panic!("an unexpected refresh {other:?}"),
        }
        for (name, view, tab) in &mut tabs {
            for frame in tab.drain() {
                for kind in ["snapshot", "reset"] {
                    assert_ne!(
                        frame["type"], kind,
                        "{name} was re-sent its state after record {index}"
                    );
                }
                if let Some(ops) = frame["ops"].as_array() {
                    let root = ops.iter().any(|op| op["p"] == json!([]));
                    assert!(!root, "{name} was patched at its root: {frame}");
                }
            }
            let detail = unstamped(tab.state["visible"]["detail"].clone());
            let filter = view["filter"]
                .as_str()
                .map(|filter| format!("&filter={filter}"))
                .unwrap_or_default();
            same(
                &detail,
                &fresh(
                    address,
                    &format!("/api/v2/runs/{run}?include_conversations=false{filter}"),
                ),
                &format!("{name}'s detail after record {index}"),
            );
            match view["type"].as_str() {
                Some("timeline") => {
                    let scope = match view["node"].as_str() {
                        Some(node) => format!("scope=node&node={node}"),
                        None => "scope=run".to_owned(),
                    };
                    same(
                        &unstamped(tab.state["visible"]["timeline"].clone()),
                        &fresh(
                            address,
                            &format!("/api/v2/runs/{run}/timeline?{scope}{filter}"),
                        ),
                        &format!("{name}'s timeline after record {index}"),
                    );
                }
                Some("channel") => assert_eq!(
                    unstamped(tab.state["visible"]["channel"].clone()),
                    fresh(address, &format!("/api/v2/runs/{run}/channel")),
                    "{name}'s channel after record {index}"
                ),
                _ => {}
            }
        }
    }
    assert!(
        appended_refreshes * 2 > held_back.len(),
        "most appends were read as appends, not re-reads: {appended_refreshes} of {}",
        held_back.len()
    );
}

/// A run of the load corpus's shape, small: one live node appending activity.
fn growing_run(root: &Path, run: &str) {
    fixture_run::write(root, run);
    live_journal::receipt_for(&root.join(run).join("events.jsonl"));
}

/// Now, stamped the way a recorded record is: RFC 3339, milliseconds, UTC.
fn now_millis() -> String {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    time::OffsetDateTime::now_utc()
        .format(&format)
        .expect("a stamp")
}

/// One tool call a node's worker reported, as the next record of the run's own
/// stream — the record a live run appends most.
fn activity(journal: &Path, run: &str, node: &str, marker: &str) -> String {
    let text = fs::read_to_string(journal).expect("a journal");
    let last: Value = text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("a record to follow");
    let stream = last["stream"].as_str().expect("a stream").to_owned();
    let seq = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record["stream"] == stream.as_str())
        .filter_map(|record| record["seq"].as_u64())
        .max()
        .unwrap_or(0)
        + 1;
    json!({
        "v": 1,
        "ts": now_millis(),
        "stream": stream,
        "seq": seq,
        "source": "agentgraph",
        "kind": "turn-activity",
        "labels": {
            "run_id": run, "node": node, "member": "worker", "persona": "worker",
            "session": format!("journey-{run}-{node}.worker"),
        },
        "payload": { "kind": "tool_call", "name": "Bash", "detail": marker, "truncated": false, "index": seq },
        "artifacts": [],
    })
    .to_string()
}

#[test]
fn a_tab_is_sent_trimmed_rows_for_other_runs_and_nothing_restated() {
    let live = Live::start(|root| {
        growing_run(root, fixture_run::RUN_ID);
        growing_run(root, fixture_run::OTHER_RUN_ID);
        // The other run is still going: no driver has closed it out, so what it
        // records next is activity its row shows.
        fs::remove_file(root.join(fixture_run::OTHER_RUN_ID).join("result.json"))
            .expect("unsettle it");
    });
    let subscribed = live.subscribe(&json!({ "view": { "type": "sidebar" } }));
    let rows = subscribed["initial"]["snapshot"]["sidebar"]
        .as_array()
        .expect("rows")
        .clone();
    assert_eq!(rows.len(), 2);
    let fields =
        |row: &Value| -> Vec<String> { row.as_object().expect("a row").keys().cloned().collect() };
    for row in &rows {
        let mut keys = fields(row);
        keys.retain(|key| key != "started_at");
        assert_eq!(
            keys,
            [
                "id",
                "name",
                "group",
                "kind",
                "state",
                "nodes",
                "updated_at"
            ],
            "{row}"
        );
    }
    let mut tab = Tab::open(&live, &json!({ "type": "sidebar" }));
    let mut seen = live.refreshes().len();
    let _ = &mut seen;
    let other = live.journal(fixture_run::OTHER_RUN_ID);
    live_journal::append_lines(
        &other,
        &[activity(
            &other,
            fixture_run::OTHER_RUN_ID,
            fixture_run::NODE_ID,
            "elsewhere",
        )],
    );
    let deadline = Instant::now() + PATIENCE;
    let mut frames = Vec::new();
    while frames.is_empty() && Instant::now() < deadline {
        frames = tab.drain();
    }
    assert_eq!(
        frames.len(),
        1,
        "one frame for one run that moved: {frames:#?}"
    );
    assert_eq!(frames[0]["type"], "run.changed");
    assert_eq!(frames[0]["row"]["id"], fixture_run::OTHER_RUN_ID);
    let mut keys = fields(&frames[0]["row"]);
    keys.retain(|key| key != "started_at");
    assert_eq!(
        keys,
        [
            "id",
            "name",
            "group",
            "kind",
            "state",
            "nodes",
            "updated_at"
        ]
    );
    // Nothing else: the sidebar subscription reads no run's detail, so the
    // server opened none.
    assert!(
        live.refreshes().is_empty(),
        "a sidebar-only tab opened a run: {:#?}",
        live.refreshes()
    );
}

#[test]
fn a_reconnect_replays_every_frame_it_missed_exactly_once() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let mut tab = Tab::open(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "node", "node": fixture_run::NODE_ID }),
    );
    let journal = live.journal(run);
    let mut seen = live.refreshes().len();
    live_journal::append_lines(
        &journal,
        &[activity(
            &journal,
            run,
            fixture_run::NODE_ID,
            "before the drop",
        )],
    );
    live.next_refresh(run, &mut seen);
    tab.drain();
    let last_applied = tab.applied.clone();
    // The stream drops; records keep arriving while nothing is connected.
    let subscription = tab.subscription.clone();
    drop(std::mem::replace(
        &mut tab.stream,
        http::stream(live.address(), "/healthz", None),
    ));
    let markers = ["while away 1", "while away 2", "while away 3"];
    for marker in markers {
        live_journal::append_lines(
            &journal,
            &[activity(&journal, run, fixture_run::NODE_ID, marker)],
        );
        live.next_refresh(run, &mut seen);
    }
    // Reconnecting the way a browser's EventSource does: Last-Event-ID, which
    // takes precedence over a stale `after`.
    tab.stream = http::stream(
        live.address(),
        &format!(
            "/api/v2/events?subscription={subscription}&after={}",
            tab.frames[0]["id"].as_str().unwrap_or_default()
        ),
        Some(&last_applied),
    );
    assert_eq!(tab.stream.status, 200);
    let replayed = tab.drain();
    assert!(!replayed.is_empty());
    assert!(
        replayed
            .iter()
            .all(|frame| frame["type"] == "timeline.patch"
                || frame["type"] == "detail.patch"
                || frame["type"] == "run.changed"),
        "{replayed:#?}"
    );
    // A node timeline lists a record under every span that draws it, so each
    // marker is held to the number of times a fresh read lists it — and that
    // is never zero.
    let fresh_timeline = fresh(
        live.address(),
        &format!(
            "/api/v2/runs/{run}/timeline?scope=node&node={}",
            fixture_run::NODE_ID
        ),
    );
    let details = |timeline: &Value| -> Vec<String> {
        timeline["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
            .filter_map(|event| event["fields"]["Detail"].as_str().map(str::to_owned))
            .collect()
    };
    let (held, served) = (
        details(&tab.state["visible"]["timeline"]),
        details(&fresh_timeline),
    );
    for marker in markers {
        let count = |list: &[String]| {
            list.iter()
                .filter(|detail| detail.as_str() == marker)
                .count()
        };
        assert!(count(&served) > 0, "{marker} is served at all: {served:?}");
        assert_eq!(
            count(&held),
            count(&served),
            "{marker} was applied exactly once: {held:?}"
        );
    }
    same(
        &unstamped(tab.state["visible"]["timeline"].clone()),
        &fresh_timeline,
        "the resumed timeline",
    );
}

#[test]
fn a_cursor_the_subscription_cannot_resume_from_is_answered_with_one_named_reset() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let subscribed = live.subscribe(&json!({ "view": { "type": "detail", "run_id": run } }));
    let subscription = subscribed["subscription"].as_str().expect("an id");
    let snapshot_id = subscribed["initial"]["snapshot"]["id"]
        .as_str()
        .expect("an id");
    let (epoch, seq) = snapshot_id.split_once(':').expect("epoch:seq");
    let seq: u64 = seq.parse().expect("a sequence");

    let cases = [
        (format!("{epoch}:{}", seq + 1000), "unknown-cursor"),
        (
            format!("00000000-0000-4000-8000-000000000000:{seq}"),
            "server-restarted",
        ),
    ];
    for (cursor, reason) in cases {
        let mut stream = http::stream(
            live.address(),
            &format!("/api/v2/events?subscription={subscription}&after={cursor}"),
            None,
        );
        assert_eq!(stream.status, 200);
        let frame = stream.frame_within(PATIENCE).expect("a reset").json();
        assert_eq!(frame["type"], "reset");
        assert_eq!(frame["reason"], reason);
        assert_eq!(
            frame["base"],
            cursor.as_str(),
            "the reset echoes the cursor it refused"
        );
        assert_eq!(frame["snapshot"]["id"], frame["id"]);
        assert_eq!(
            unstamped(frame["snapshot"]["visible"]["detail"].clone()),
            fresh(
                live.address(),
                &format!("/api/v2/runs/{run}?include_conversations=false")
            )
        );
        assert!(
            stream.frame_within(QUIET).is_none(),
            "one reset, nothing restated after it"
        );
    }
    for malformed in [
        "not-a-cursor",
        &format!("{epoch}:-1"),
        &format!("{epoch}:01"),
    ] {
        let refused = http::get(
            live.address(),
            &format!("/api/v2/events?subscription={subscription}&after={malformed}"),
        );
        assert_eq!(refused.status, 400, "{malformed}: {}", refused.body);
        assert_eq!(refused.json()["error"]["code"], "invalid_subscription");
    }
}

#[test]
fn a_cursor_older_than_the_retained_frames_is_answered_stale() {
    // Many runs, each grown once per poll while the stream is away, so the
    // subscription records more frames than it retains. A moving run's row is
    // pushed at most once every `ROW_POLLS_PER_READ` polls, so on a loaded host
    // that takes longer than the contract's grace for a subscription nothing is
    // connected to; this journey is about retention, so its grace is longer.
    let runs: Vec<String> = (0..60)
        .map(|index| format!("retained-{index:02}"))
        .collect();
    let grace = Duration::from_secs(600);
    let live = Live::start_with(
        |root| {
            for run in &runs {
                growing_run(root, run);
            }
        },
        &[(
            onepipeline_ui::live::DISCONNECTED_GRACE_ENV,
            &grace.as_millis().to_string(),
        )],
    );
    let subscribed = live.subscribe(&json!({ "view": { "type": "sidebar" } }));
    let subscription = subscribed["subscription"]
        .as_str()
        .expect("an id")
        .to_owned();
    let snapshot_id = subscribed["initial"]["snapshot"]["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // A second, connected tab on the same view is sent every frame the first
    // one records while away, so counting its frames says when the first has
    // recorded more than it keeps.
    let mut counter = Tab::open(&live, &json!({ "type": "sidebar" }));
    // And a third, connected but never read: its stream falls more than the
    // retained frames behind, is dropped, and on reconnecting is answered with
    // the one explicit re-send rather than a replay that lost frames.
    let stalled = Tab::open(&live, &json!({ "type": "sidebar" }));
    let deadline = Instant::now() + grace;
    let mut counted = 0;
    while counted <= onepipeline_ui::contract::RETAINED_FRAMES {
        let appends: Vec<(PathBuf, Vec<String>)> = runs
            .iter()
            .map(|run| {
                let journal = live.serving.run_dir(run).join("events.jsonl");
                let line = activity(&journal, run, fixture_run::NODE_ID, "churn");
                (journal, vec![line])
            })
            .collect();
        let borrowed: Vec<(&Path, &[String])> = appends
            .iter()
            .map(|(journal, lines)| (journal.as_path(), lines.as_slice()))
            .collect();
        live_journal::append_many(&borrowed);
        counted += counter.drain().len();
        assert!(
            Instant::now() < deadline,
            "only {counted} frames were sent within the subscription's grace"
        );
    }
    let mut stream = http::stream(
        live.address(),
        &format!("/api/v2/events?subscription={subscription}&after={snapshot_id}"),
        None,
    );
    let frame = stream.frame_within(PATIENCE).expect("a reset").json();
    assert_eq!(frame["type"], "reset");
    assert_eq!(frame["reason"], "stale-cursor");
    assert_eq!(
        frame["snapshot"]["sidebar"].as_array().map(Vec::len),
        Some(runs.len())
    );
    let Tab {
        subscription,
        applied,
        stream: dropped,
        ..
    } = stalled;
    drop(dropped);
    let mut resumed = http::stream(
        live.address(),
        &format!("/api/v2/events?subscription={subscription}&after={applied}"),
        None,
    );
    assert_eq!(
        resumed.status, 200,
        "the stalled subscription is still held"
    );
    let reset = resumed
        .frame_within(PATIENCE)
        .expect("a reset for the stalled tab")
        .json();
    assert_eq!(reset["type"], "reset");
    assert_eq!(reset["reason"], "stale-cursor");
}

#[test]
fn a_retired_or_replaced_subscription_is_gone_and_its_stream_says_so() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let first = live.subscribe(&json!({ "view": { "type": "detail", "run_id": run } }));
    let first_id = first["subscription"].as_str().expect("an id").to_owned();
    // Moving to the Channel view replaces the subscription: the detail view
    // left behind is no longer subscribed or read.
    let second = live
        .subscribe(&json!({ "view": { "type": "channel", "run_id": run }, "replaces": first_id }));
    let second_id = second["subscription"].as_str().expect("an id").to_owned();
    for (id, status) in [(&first_id, 410), (&second_id, 200)] {
        let stream = http::stream(
            live.address(),
            &format!("/api/v2/events?subscription={id}"),
            None,
        );
        assert_eq!(stream.status, status, "{id}");
    }
    let gone = http::get(
        live.address(),
        &format!("/api/v2/events?subscription={first_id}"),
    );
    assert_eq!(
        gone.json(),
        json!({ "code": "subscription-unavailable", "reason": "unknown" })
    );
    let deleted = http::delete(
        live.address(),
        &format!("/api/v2/subscriptions/{second_id}"),
    );
    assert_eq!(deleted.status, 204);
    assert_eq!(
        http::delete(
            live.address(),
            &format!("/api/v2/subscriptions/{second_id}")
        )
        .status,
        204,
        "idempotent"
    );
    assert_eq!(
        http::get(
            live.address(),
            &format!("/api/v2/events?subscription={second_id}")
        )
        .status,
        410
    );
    // A cursor from another process's epoch names a restart.
    let restarted = http::get(
        live.address(),
        "/api/v2/events?subscription=00000000-0000-4000-8000-000000000001&after=00000000-0000-4000-8000-000000000000:3",
    );
    assert_eq!(
        restarted.json(),
        json!({ "code": "subscription-unavailable", "reason": "server-restarted" })
    );
    // Recreating with `resume` is answered with an explicit reset, never an
    // ordinary snapshot.
    let resumed = live.subscribe(&json!({
        "view": { "type": "detail", "run_id": run },
        "resume": "00000000-0000-4000-8000-000000000000:3",
    }));
    assert_eq!(resumed["initial"]["type"], "reset");
    assert_eq!(resumed["initial"]["reason"], "server-restarted");
    assert_eq!(
        resumed["initial"]["base"],
        "00000000-0000-4000-8000-000000000000:3"
    );
    assert_eq!(
        resumed["initial"]["snapshot"]["id"],
        resumed["initial"]["id"]
    );
}

#[test]
fn a_subscription_the_contract_cannot_read_is_refused_before_anything_is_opened() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    for (body, status, code) in [
        (
            json!({ "view": { "type": "timeline", "run_id": run, "scope": "node" } }),
            400,
            "invalid_subscription",
        ),
        (
            json!({ "view": { "type": "timeline", "run_id": run, "scope": "run", "node": "x" } }),
            400,
            "invalid_subscription",
        ),
        (
            json!({ "view": { "type": "detail", "run_id": run, "extra": 1 } }),
            400,
            "invalid_subscription",
        ),
        (
            json!({ "view": { "type": "sidebar" }, "replaces": "nope" }),
            400,
            "invalid_subscription",
        ),
        (
            json!({ "view": { "type": "sidebar" }, "replaces": "00000000-0000-4000-8000-000000000000", "resume": "00000000-0000-4000-8000-000000000000:1" }),
            400,
            "invalid_subscription",
        ),
        (
            json!({ "view": { "type": "detail", "run_id": "no-such-run" } }),
            404,
            "run_not_found",
        ),
        (
            json!({ "view": { "type": "timeline", "run_id": run, "scope": "node", "node": "no-such-node" } }),
            404,
            "node_not_found",
        ),
        (
            json!({ "view": { "type": "detail", "run_id": run, "filter": "no-such-profile" } }),
            404,
            "unknown_filter_profile",
        ),
    ] {
        let response = http::post(live.address(), "/api/v2/subscriptions", &body.to_string());
        assert_eq!(response.status, status, "{body}: {}", response.body);
        assert_eq!(response.json()["error"]["code"], code, "{body}");
    }
    let unknown_replaced = live.subscribe(&json!({
        "view": { "type": "sidebar" },
        "replaces": "00000000-0000-4000-8000-000000000000",
    }));
    assert_eq!(
        unknown_replaced["initial"]["type"], "snapshot",
        "a missing replaces is harmless"
    );
}

#[test]
fn a_label_change_without_growth_is_reread_and_served_as_what_changed() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let mut tab = Tab::open(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "run" }),
    );
    let mut seen = live.refreshes().len();
    let journal_before = fs::metadata(live.journal(run)).expect("a journal").len();
    // The overlay `onepipeline label` writes: the journal does not grow.
    fs::write(
        live.serving.run_dir(run).join("labels.json"),
        json!({
            "schema_version": 1,
            "labels": { "kind": "follow-ups" },
            "unlabel": [],
            "set_at": "2026-10-22T00:00:00Z",
            "set_by": { "launcher": "journey", "session": "journey" },
        })
        .to_string(),
    )
    .expect("write the overlay");
    let refresh = live.next_refresh(run, &mut seen);
    assert_eq!(refresh["refresh"], "reread", "{refresh}");
    assert_eq!(
        fs::metadata(live.journal(run)).expect("a journal").len(),
        journal_before
    );
    // The row is read at most once every few polls, so it arrives within the
    // patience rather than with the patches.
    let row = frame_of(&mut tab, "run.changed");
    assert_eq!(
        row["row"]["kind"], "follow-ups",
        "the sidebar row carries the new kind"
    );
    tab.drain();
    assert!(tab
        .frames
        .iter()
        .all(|frame| frame["type"] != "reset" && frame["type"] != "snapshot"));
    assert_eq!(
        unstamped(tab.state["visible"]["detail"].clone()),
        fresh(
            live.address(),
            &format!("/api/v2/runs/{run}?include_conversations=false")
        )
    );
    assert_eq!(
        unstamped(tab.state["visible"]["timeline"].clone()),
        fresh(
            live.address(),
            &format!("/api/v2/runs/{run}/timeline?scope=run")
        )
    );
}

#[test]
fn a_surface_raised_through_the_engine_reaches_the_channel_view_as_a_patch() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let mut tab = Tab::open(&live, &json!({ "type": "channel", "run_id": run }));
    let mut seen = live.refreshes().len();
    // The engine's own writer journals the surface, receipt and all. Its receipt
    // lands just after the record, and a poll between the two is answered with a
    // re-read; so the journey raises until one append is read as one, and every
    // other read is that re-read rather than anything else.
    let mut reads = Vec::new();
    while !reads
        .iter()
        .any(|read: &Value| read["refresh"] == "appended")
    {
        assert!(
            reads.len() < 5,
            "the engine's own append is never read as one: {reads:#?}"
        );
        let raised = http::post(
            live.address(),
            &format!("/api/v2/runs/{run}/channel/surface"),
            &json!({ "kind": "question", "message": "is the journey live?" }).to_string(),
        );
        assert_eq!(raised.status, 200, "{}", raised.body);
        let read = live.next_refresh(run, &mut seen);
        assert!(
            ["appended", "reread"].contains(&read["refresh"].as_str().unwrap_or_default()),
            "{read}"
        );
        reads.push(read);
    }
    let deadline = Instant::now() + PATIENCE;
    let mut frames = Vec::new();
    while !frames
        .iter()
        .any(|frame: &Value| frame["type"] == "channel.patch")
        && Instant::now() < deadline
    {
        frames.extend(tab.drain());
    }
    assert!(
        frames.iter().any(|frame| frame["type"] == "channel.patch"),
        "{frames:#?}"
    );
    let channel = unstamped(tab.state["visible"]["channel"].clone());
    assert_eq!(
        channel,
        fresh(live.address(), &format!("/api/v2/runs/{run}/channel"))
    );
    let messages: Vec<&str> = channel["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter_map(|surface| surface["message"].as_str())
        .collect();
    assert!(messages.contains(&"is the journey live?"), "{messages:?}");
}

/// The UUID every served epoch and subscription id is written as in a golden.
const PINNED_EPOCH: &str = "00000000-0000-4000-8000-0000000e9c00";
const PINNED_SUBSCRIPTION: &str = "00000000-0000-4000-8000-00000005ab00";

/// A served document with what no two runs share replaced by what the golden
/// claims: the process's epoch, the subscription ids, the instant of each read,
/// and any wall-clock stamp written today (the channel's own records of the
/// surface this journey raised, as text or as epoch milliseconds). Everything
/// else is compared byte for byte.
fn pinned(value: &Value, subscriptions: &[String], epoch: &str, today: &str) -> Value {
    match value {
        Value::String(text) => {
            let mut text = text.replace(epoch, PINNED_EPOCH);
            for subscription in subscriptions {
                text = text.replace(subscription.as_str(), PINNED_SUBSCRIPTION);
            }
            if text.starts_with(today) {
                text = "2026-08-07T12:00:00Z".to_owned();
            }
            Value::String(text)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| pinned(item, subscriptions, epoch, today))
                .collect(),
        ),
        Value::Object(members) => Value::Object(
            members
                .iter()
                .map(|(key, member)| {
                    let member = if key == "observed_at" {
                        json!("2026-08-07T12:00:00Z")
                    } else {
                        pinned(member, subscriptions, epoch, today)
                    };
                    (key.clone(), member)
                })
                .collect(),
        ),
        Value::Number(number) => match number.as_u64() {
            // An epoch-millisecond stamp taken today, as the channel's own
            // records carry one.
            Some(millis) if millis.abs_diff(now_epoch_millis()) < 86_400_000 => {
                json!(1_786_104_000_000_u64)
            }
            _ => value.clone(),
        },
        other => other.clone(),
    }
}

fn now_epoch_millis() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

/// The sequence numbers of the event ids one document names, renumbered by
/// rank: other subscriptions take numbers in between, so where a frame's ids
/// fall depends on timing, and what a golden can pin is their order.
fn ranked(document: &Value) -> Value {
    let prefix = format!("{PINNED_EPOCH}:");
    let mut seqs = std::collections::BTreeSet::new();
    collect_seqs(document, &prefix, &mut seqs);
    let rank: BTreeMap<u64, usize> = seqs
        .into_iter()
        .enumerate()
        .map(|(at, seq)| (seq, at + 1))
        .collect();
    renumber(document, &prefix, &rank)
}

fn collect_seqs(value: &Value, prefix: &str, seqs: &mut std::collections::BTreeSet<u64>) {
    match value {
        Value::String(text) => {
            if let Some(seq) = text.strip_prefix(prefix).and_then(|seq| seq.parse().ok()) {
                seqs.insert(seq);
            }
        }
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_seqs(item, prefix, seqs)),
        Value::Object(members) => members
            .values()
            .for_each(|member| collect_seqs(member, prefix, seqs)),
        _ => {}
    }
}

fn renumber(value: &Value, prefix: &str, rank: &BTreeMap<u64, usize>) -> Value {
    match value {
        Value::String(text) => match text
            .strip_prefix(prefix)
            .and_then(|seq| seq.parse::<u64>().ok())
        {
            Some(seq) => Value::String(format!("{prefix}{}", rank[&seq])),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| renumber(item, prefix, rank))
                .collect(),
        ),
        Value::Object(members) => Value::Object(
            members
                .iter()
                .map(|(key, member)| (key.clone(), renumber(member, prefix, rank)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Hold a served document to its golden under `tests/fixtures/`, or rewrite it
/// with `UPDATE_CONTRACT_FIXTURES` set — the variable `tests/contract.rs`
/// rewrites every other golden under.
fn pin_golden(name: &str, document: &Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(document).expect("serialize")
    );
    if std::env::var_os("UPDATE_CONTRACT_FIXTURES").is_some() {
        fs::write(&path, &rendered).expect("rewrite the golden");
        return;
    }
    let pinned = fs::read_to_string(&path).unwrap_or_default();
    assert!(
        pinned == rendered,
        "tests/fixtures/{name} is not what the server serves — re-run with \
         UPDATE_CONTRACT_FIXTURES=1 to accept the change deliberately:\n{rendered}"
    );
}

/// Read `tab` until a frame of `kind` arrives, failing by name after the
/// journey's patience rather than waiting without limit.
fn frame_of(tab: &mut Tab, kind: &str) -> Value {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(found) = tab.frames.iter().find(|frame| frame["type"] == kind) {
            return found.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no {kind} frame arrived within {PATIENCE:?}: {:#?}",
            tab.frames
        );
        tab.drain();
    }
}

#[test]
fn the_served_subscription_and_every_frame_type_are_the_goldens_the_contract_pins() {
    let run = fixture_run::RUN_ID;
    let mut held_back = Vec::new();
    let live = Live::start(|root| {
        fixture_run::write(root, run);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
        let journal = root.join(run).join("events.jsonl");
        let total = fs::read_to_string(&journal)
            .expect("a journal")
            .lines()
            .count();
        // Past the worker's settlement, so the first record held back is the
        // node's push.
        held_back = live_journal::hold_back(&journal, total / 2 + 1);
    });
    let subscribed = live.subscribe(&json!({ "view": { "type": "detail", "run_id": run } }));
    let mut detail = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let mut overall = Tab::open(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "run" }),
    );
    let mut node = Tab::open(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "node", "node": fixture_run::NODE_ID }),
    );
    let mut channel = Tab::open(&live, &json!({ "type": "channel", "run_id": run }));
    let mut sidebar = Tab::open(&live, &json!({ "type": "sidebar" }));

    // One record of the node's own, appended the engine's way.
    let line = held_back
        .iter()
        .find(|line| line.contains(&format!("\"node\":\"{}\"", fixture_run::NODE_ID)))
        .expect("a held-back record of the node")
        .clone();
    live_journal::append_lines(&live.journal(run), &[line]);
    let detail_patch = frame_of(&mut detail, "detail.patch");
    let run_patch = frame_of(&mut overall, "timeline.patch");
    let node_patch = frame_of(&mut node, "timeline.patch");
    let changed = frame_of(&mut sidebar, "run.changed");
    // A surface raised through the engine's own verb reaches the channel view.
    let raised = http::post(
        live.address(),
        &format!("/api/v2/runs/{run}/channel/surface"),
        &json!({ "kind": "question", "message": "pinned" }).to_string(),
    );
    assert_eq!(raised.status, 200, "{}", raised.body);
    let channel_patch = frame_of(&mut channel, "channel.patch");
    // A run taken out of the root is removed from every sidebar.
    fs::remove_dir_all(live.serving.run_dir(fixture_run::OTHER_RUN_ID))
        .expect("remove the other run");
    let removed = frame_of(&mut sidebar, "run.removed");
    // A cursor the subscription never issued is answered with one reset.
    let (epoch, _) = sidebar.applied.split_once(':').expect("epoch:seq");
    let epoch = epoch.to_owned();
    let mut reset_stream = http::stream(
        live.address(),
        &format!(
            "/api/v2/events?subscription={}&after={epoch}:999999",
            sidebar.subscription
        ),
        None,
    );
    let reset = reset_stream
        .frame_within(PATIENCE)
        .expect("a reset frame")
        .json();
    assert_eq!(reset["type"], "reset");

    let subscriptions: Vec<String> = [&detail, &overall, &node, &channel, &sidebar]
        .iter()
        .map(|tab| tab.subscription.clone())
        .chain(std::iter::once(
            subscribed["subscription"]
                .as_str()
                .expect("an id")
                .to_owned(),
        ))
        .collect();
    let today = time::OffsetDateTime::now_utc().date().to_string();
    let pin = |value: &Value| ranked(&pinned(value, &subscriptions, &epoch, &today));
    pin_golden("subscriptions.json", &pin(&subscribed));
    pin_golden(
        "subscription-frames.json",
        &json!([
            pin(&changed),
            pin(&removed),
            pin(&detail_patch),
            pin(&run_patch),
            pin(&node_patch),
            pin(&channel_patch),
            pin(&reset),
        ]),
    );
}

/// Every member name of a JSON object, nested ones as `parent.child`, sorted.
fn field_names(value: &Value, prefix: &str, names: &mut Vec<String>) {
    if let Value::Object(members) = value {
        for (key, member) in members {
            let name = format!("{prefix}{key}");
            field_names(member, &format!("{name}."), names);
            names.push(name);
        }
    }
    names.sort();
}

#[test]
fn the_fixture_writers_receipts_are_the_engines_field_for_field() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let journal = live.journal(run);
    let receipt = || -> Value {
        serde_json::from_slice(&fs::read(live_journal::receipt_path(&journal)).expect("a receipt"))
            .expect("a receipt parses")
    };
    let surface = |message: &str| {
        let raised = http::post(
            live.address(),
            &format!("/api/v2/runs/{run}/channel/surface"),
            &json!({ "kind": "question", "message": message }).to_string(),
        );
        assert_eq!(raised.status, 200, "{}", raised.body);
    };
    // A tab on the run, so the server holds it open and traces each refresh.
    let _tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let mut seen = live.refreshes().len();
    // The engine's own writer appends, then the fixture writer, then the engine.
    surface("the engine writes first");
    let engine_first = receipt();
    live.next_refresh(run, &mut seen);
    live_journal::append_lines(
        &journal,
        &[activity(
            &journal,
            run,
            fixture_run::NODE_ID,
            "the fixture writes",
        )],
    );
    let fixture = receipt();
    let written = fs::metadata(&journal).expect("a journal").len();
    let refresh = live.next_refresh(run, &mut seen);
    surface("the engine writes again");
    let engine_second = receipt();

    let names = |value: &Value| {
        let mut names = Vec::new();
        field_names(value, "", &mut names);
        names
    };
    assert_eq!(
        names(&fixture),
        names(&engine_first),
        "the fixture's receipt names the engine's fields"
    );
    assert_eq!(names(&engine_second), names(&fixture));
    assert_eq!(fixture["schema_version"], engine_first["schema_version"]);
    // Each continues the other's epoch, which the engine does only when the
    // receipt on disk describes the journal exactly as its own stamp reads it:
    // the fixture's stamp is the engine's, value for value.
    assert_eq!(
        fixture["epoch"], engine_first["epoch"],
        "the fixture continued the engine's epoch"
    );
    assert_eq!(
        engine_second["epoch"], fixture["epoch"],
        "the engine continued the fixture's epoch"
    );
    assert_eq!(
        fixture["stamp"]["len"],
        json!(written),
        "the stamp is the journal after the write"
    );
    // And the server read the fixture's append as an append of one record.
    assert_eq!(refresh["refresh"], "appended", "{refresh}");
    assert_eq!(refresh["records"], 1, "{refresh}");
}

#[test]
fn a_disconnected_subscription_expires_after_the_grace_and_a_quiet_connected_one_does_not() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(
        |root| growing_run(root, run),
        &[(onepipeline_ui::live::DISCONNECTED_GRACE_ENV, "1500")],
    );
    // One subscription nothing ever connects to, and one whose stream stays
    // open and is sent nothing for longer than the grace.
    let abandoned = live.subscribe(&json!({ "view": { "type": "sidebar" } }));
    let abandoned = abandoned["subscription"]
        .as_str()
        .expect("an id")
        .to_owned();
    let mut quiet = Tab::open(&live, &json!({ "type": "sidebar" }));
    std::thread::sleep(Duration::from_millis(3_000));
    assert!(
        quiet.drain().is_empty(),
        "nothing moved, so nothing was sent"
    );

    let gone = http::get(
        live.address(),
        &format!("/api/v2/events?subscription={abandoned}"),
    );
    assert_eq!(gone.status, 410, "{}", gone.body);
    assert_eq!(
        gone.json(),
        json!({ "code": "subscription-unavailable", "reason": "expired" })
    );

    // The connected one is still served: what moves now reaches it.
    let journal = live.journal(run);
    live_journal::append_lines(
        &journal,
        &[activity(&journal, run, fixture_run::NODE_ID, "still here")],
    );
    let row = frame_of(&mut quiet, "run.changed");
    assert_eq!(row["row"]["id"], run);
}

#[test]
fn a_stale_telemetry_fold_catches_up_once_the_run_goes_quiet_without_holding_back_the_change() {
    let run = fixture_run::RUN_ID;
    let mut held_back = Vec::new();
    let live = Live::start_with(
        |root| {
            fixture_run::write(root, run);
            let journal = root.join(run).join("events.jsonl");
            let total = fs::read_to_string(&journal)
                .expect("a journal")
                .lines()
                .count();
            // Past the worker's settlement, so the first record held back is
            // the node's push, a change the detail renders.
            held_back = live_journal::hold_back(&journal, total / 2 + 1);
        },
        &[(onepipeline_ui::live::TELEMETRY_REFOLD_ENV, "1500")],
    );
    let mut tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    // Let the fold the subscription opened with age past the interval, so the
    // first change is the one the refold has to catch up with.
    std::thread::sleep(Duration::from_millis(1_600));
    let mut seen = live.refreshes().len();
    live_journal::append_lines(&live.journal(run), &held_back[..1]);
    let first = live.next_refresh(run, &mut seen);
    assert_eq!(first["refresh"], "appended", "{first}");
    assert!(
        first["telemetry_fold_ms"].is_null(),
        "the change waited on a fold: {first}"
    );
    // A second change straight after is sent at once, without the fold.
    live_journal::append_lines(&live.journal(run), &held_back[1..2]);
    let second = live.next_refresh(run, &mut seen);
    assert!(
        second["telemetry_fold_ms"].is_null(),
        "the change waited on a fold: {second}"
    );
    let _ = frame_of(&mut tab, "detail.patch");
    // Then, with nothing appended, the fold catches up within the interval
    // and the detail becomes what a fresh read serves.
    let deadline = Instant::now() + PATIENCE;
    loop {
        let refolded = live
            .refreshes()
            .iter()
            .any(|line| !line["telemetry_fold_ms"].is_null() && line["refresh"] == "unchanged");
        if refolded {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the stale fold never caught up: {:#?}",
            live.refreshes()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    tab.drain();
    // A run still being recorded is timed against the clock, so the instants a
    // fold and a later read are taken at differ; everything the fold counts
    // off the records is held to a fresh read.
    let unclocked = |mut detail: Value| {
        if let Some(run) = detail["run"].as_object_mut() {
            run.remove("timing");
            run.remove("node_work_ms");
        }
        if let Some(telemetry) = detail["telemetry"].as_object_mut() {
            telemetry.remove("wall_ms");
            telemetry.remove("buckets");
        }
        detail
    };
    same(
        &unclocked(unstamped(tab.state["visible"]["detail"].clone())),
        &unclocked(fresh(
            live.address(),
            &format!("/api/v2/runs/{run}?include_conversations=false"),
        )),
        "the detail once the fold caught up",
    );
}

/// Unix-only: the queue is made unreadable with a POSIX permission bit, and
/// Windows denies a read through an ACL this journey cannot set.
#[cfg(unix)]
#[test]
fn a_channel_that_could_not_be_read_for_a_moment_reaches_the_view_once_it_can() {
    use std::os::unix::fs::PermissionsExt;
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let raise = |message: &str| {
        let raised = http::post(
            live.address(),
            &format!("/api/v2/runs/{run}/channel/surface"),
            &json!({ "kind": "question", "message": message }).to_string(),
        );
        assert_eq!(raised.status, 200, "{}", raised.body);
    };
    // The channel exists before the view opens, so it can be made unreadable.
    raise("before the view");
    let mut tab = Tab::open(&live, &json!({ "type": "channel", "run_id": run }));
    let channel = live.serving.run_dir(run).join("channel");
    let readable = fs::metadata(&channel).expect("a channel").permissions();
    // A surface lands, and the queue is then unreadable while the poller looks.
    raise("while unreadable");
    fs::set_permissions(&channel, fs::Permissions::from_mode(0o000)).expect("lock the channel");
    std::thread::sleep(Duration::from_millis(600));
    fs::set_permissions(&channel, readable).expect("unlock the channel");
    // Once it can be read, the surface reaches the view, and the view is the
    // queue a fresh read serves.
    let deadline = Instant::now() + PATIENCE;
    loop {
        tab.drain();
        let shown = tab.state["visible"]["channel"]["surfaces"]
            .as_array()
            .is_some_and(|surfaces| {
                surfaces
                    .iter()
                    .any(|surface| surface["message"] == "while unreadable")
            });
        if shown {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the surface never reached the view: {:#?}",
            tab.frames
        );
    }
    same(
        &unstamped(tab.state["visible"]["channel"].clone()),
        &fresh(live.address(), &format!("/api/v2/runs/{run}/channel")),
        "the channel once it could be read",
    );
}

#[test]
fn a_run_that_never_goes_quiet_still_has_its_telemetry_folded_again() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(
        |root| growing_run(root, run),
        &[(onepipeline_ui::live::TELEMETRY_REFOLD_ENV, "600")],
    );
    let _tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    // The load workload's own writer, a record every 25 ms — faster than the
    // 50 ms poll — for longer than two intervals, so no tick is quiet.
    let root = live
        .serving
        .run_dir(run)
        .parent()
        .expect("a runs root")
        .to_path_buf();
    let log = live._trace_dir.path().join("appended.jsonl");
    let options = json!({
        "root": root, "log": log, "durationMs": 2_500, "rate": 2_400,
        "runs": [{ "run": run, "node": fixture_run::NODE_ID }],
        "burst": 0, "burstRun": run, "burstAt": 0, "openRun": run,
    });
    let writer = std::process::Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/dag-ui-e2e/load/writer.mjs"))
        .arg(options.to_string())
        .status()
        .expect("node runs the load writer");
    assert!(writer.success(), "the load writer failed");
    // A tick that moved, whichever way the engine read it: on a loaded host a
    // writer this fast can outrun the appended read, which the engine then
    // answers with a reread, and the fold is owed on that tick all the same.
    let folded_while_growing = live
        .refreshes()
        .iter()
        .any(|line| line["refresh"] != "unchanged" && !line["telemetry_fold_ms"].is_null());
    assert!(
        folded_while_growing,
        "the fold never caught up while the run kept moving: {:#?}",
        live.refreshes()
    );
}

#[test]
fn a_view_a_switch_left_behind_is_no_longer_kept_current() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let overall =
        live.subscribe(&json!({ "view": { "type": "timeline", "run_id": run, "scope": "run" } }));
    let overall = overall["subscription"].as_str().expect("an id").to_owned();
    let journal = live.journal(run);
    let mut seen = live.refreshes().len();
    live_journal::append_lines(
        &journal,
        &[activity(&journal, run, fixture_run::NODE_ID, "on overall")],
    );
    let before = live.next_refresh(run, &mut seen);
    assert!(
        before["kept"]
            .as_array()
            .is_some_and(|kept| kept.iter().any(|payload| payload == "timeline:run:")),
        "the Overall view's timeline is kept: {before}"
    );
    // The tab moves to the Graph: its subscription replaces the Overall one.
    let _graph = live
        .subscribe(&json!({ "view": { "type": "detail", "run_id": run }, "replaces": overall }));
    live_journal::append_lines(
        &journal,
        &[activity(&journal, run, fixture_run::NODE_ID, "on graph")],
    );
    let after = live.next_refresh(run, &mut seen);
    assert_eq!(
        after["kept"],
        json!(["detail:"]),
        "only the Graph's detail is kept: {after}"
    );
    assert_eq!(
        after["rendered"], 0,
        "no timeline entry was rendered for a view nobody shows: {after}"
    );
}

#[test]
fn a_stream_or_a_retirement_the_contract_cannot_read_is_refused() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let subscribed = live.subscribe(&json!({ "view": { "type": "sidebar" } }));
    let subscription = subscribed["subscription"].as_str().expect("an id");
    for path in [
        // A view's subscription says what it shows; nothing else narrows it.
        format!("/api/v2/events?subscription={subscription}&run_id={run}"),
        format!("/api/v2/events?subscription={subscription}&filter=planner"),
        // An id that is not one this process could have minted.
        "/api/v2/events?subscription=not-a-subscription".to_owned(),
        "/api/v2/events?subscription=".to_owned(),
        format!(
            "/api/v2/events?subscription={}",
            subscription.to_uppercase()
        ),
    ] {
        let refused = http::get(live.address(), &path);
        assert_eq!(refused.status, 400, "{path}: {}", refused.body);
        assert_eq!(
            refused.json()["error"]["code"],
            "invalid_subscription",
            "{path}"
        );
    }
    // A Last-Event-ID that is not text is refused rather than read as none.
    let refused = http::get_with_header(
        live.address(),
        &format!("/api/v2/events?subscription={subscription}"),
        "Last-Event-ID",
        b"\xff\xfe",
    );
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert_eq!(refused.json()["error"]["code"], "invalid_subscription");
    // And a retirement naming no subscription id is refused, never a no-op.
    let refused = http::delete(live.address(), "/api/v2/subscriptions/not-a-subscription");
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert_eq!(refused.json()["error"]["code"], "invalid_subscription");
}

#[test]
fn a_retired_subscription_recreated_from_its_own_cursor_is_answered_unknown_cursor() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let mut tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let journal = live.journal(run);
    live_journal::append_lines(
        &journal,
        &[activity(&journal, run, fixture_run::NODE_ID, "applied")],
    );
    let _ = frame_of(&mut tab, "detail.patch");
    let applied = tab.applied.clone();
    // The subscription goes; the tab recreates its view from the frame it
    // applied — a cursor of this very process, which no live subscription holds.
    let retired = http::delete(
        live.address(),
        &format!("/api/v2/subscriptions/{}", tab.subscription),
    );
    assert_eq!(retired.status, 204);
    let recreated =
        live.subscribe(&json!({ "view": { "type": "detail", "run_id": run }, "resume": applied }));
    let initial = &recreated["initial"];
    assert_eq!(initial["type"], "reset");
    assert_eq!(
        initial["reason"], "unknown-cursor",
        "the same epoch, but a cursor nothing holds"
    );
    assert_eq!(initial["base"], applied.as_str());
    assert_eq!(initial["subscription"], recreated["subscription"]);
    assert_eq!(initial["snapshot"]["id"], initial["id"]);
}

#[test]
fn a_cursor_another_subscription_was_sent_is_not_one_this_one_resumes_from() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    // Two subscriptions sent frames from one sequence, interleaved.
    let mut mine = Tab::open(&live, &json!({ "type": "sidebar" }));
    let mut theirs = Tab::open(&live, &json!({ "type": "sidebar" }));
    let journal = live.journal(run);
    let mut sent_to_them = Vec::new();
    for marker in ["one", "two", "three"] {
        live_journal::append_lines(
            &journal,
            &[activity(&journal, run, fixture_run::NODE_ID, marker)],
        );
        let _ = frame_of(&mut mine, "run.changed");
        let theirs_frame = frame_of(&mut theirs, "run.changed");
        sent_to_them.push(theirs_frame["id"].as_str().expect("an id").to_owned());
        mine.frames.clear();
        theirs.frames.clear();
    }
    let (_, first_mine) = mine.state["id"]
        .as_str()
        .expect("an id")
        .split_once(':')
        .expect("epoch:seq");
    let (_, last_mine) = mine.applied.split_once(':').expect("epoch:seq");
    // The frame the other subscription was sent first: after this one's
    // snapshot, before the last frame this one was sent.
    let foreign = sent_to_them[0].clone();
    let (_, foreign_seq) = foreign.split_once(':').expect("epoch:seq");
    let seq = |text: &str| text.parse::<u64>().expect("a sequence");
    assert!(
        seq(first_mine) < seq(foreign_seq) && seq(foreign_seq) < seq(last_mine),
        "the other subscription's cursor lies inside this one's range"
    );
    let Tab {
        subscription,
        stream,
        ..
    } = mine;
    drop(stream);
    let mut resumed = http::stream(
        live.address(),
        &format!("/api/v2/events?subscription={subscription}&after={foreign}"),
        None,
    );
    let reset = resumed.frame_within(PATIENCE).expect("a reset").json();
    assert_eq!(reset["type"], "reset");
    assert_eq!(
        reset["reason"], "unknown-cursor",
        "a cursor this subscription was never sent"
    );
    assert_eq!(reset["base"], foreign.as_str());
}

/// Unix-only: the runs root is made unlistable with a POSIX permission bit, and
/// Windows denies a listing through an ACL this journey cannot set.
#[cfg(unix)]
#[test]
fn a_sidebar_keeps_its_rows_through_a_root_or_a_run_it_could_not_read_and_moves_once_it_can() {
    use std::os::unix::fs::PermissionsExt;
    let run = fixture_run::RUN_ID;
    let other = fixture_run::OTHER_RUN_ID;
    let live = Live::start(|root| {
        growing_run(root, run);
        growing_run(root, other);
    });
    let mut tab = Tab::open(&live, &json!({ "type": "sidebar" }));
    let root = live
        .serving
        .run_dir(run)
        .parent()
        .expect("a runs root")
        .to_path_buf();
    let listable = fs::metadata(&root).expect("a root").permissions();

    // The root cannot be listed for a moment: no run is announced as gone.
    fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).expect("lock the root");
    std::thread::sleep(Duration::from_millis(400));
    fs::set_permissions(&root, listable).expect("unlock the root");
    tab.drain();
    assert!(
        tab.frames
            .iter()
            .all(|frame| frame["type"] != "run.removed"),
        "a root it could not list read as runs gone: {:#?}",
        tab.frames
    );

    // One run cannot be read while it moves: its row stays as it was …
    let launch = live.serving.run_dir(other).join("launch.json");
    let recorded = fs::read(&launch).expect("a launch record");
    fs::write(&launch, b"{ not a launch record").expect("break the launch record");
    let journal = live.journal(other);
    live_journal::append_lines(
        &journal,
        &[activity(
            &journal,
            other,
            fixture_run::NODE_ID,
            "unreadable",
        )],
    );
    std::thread::sleep(Duration::from_millis(400));
    tab.drain();
    assert!(
        tab.frames
            .iter()
            .all(|frame| frame["type"] != "run.removed"),
        "a run it could not read read as gone: {:#?}",
        tab.frames
    );
    // … and once it can, the row moves to what the run recorded meanwhile.
    fs::write(&launch, recorded).expect("restore the launch record");
    let moved = frame_of(&mut tab, "run.changed");
    assert_eq!(moved["row"]["id"], other);
    assert_eq!(tab.state["sidebar"].as_array().map(Vec::len), Some(2));
}

#[test]
fn a_subscribed_run_that_could_not_be_read_for_a_moment_is_patched_again_once_it_can() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let mut tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let launch = live.serving.run_dir(run).join("launch.json");
    let recorded = fs::read(&launch).expect("a launch record");
    // The engine cannot read the run's launch record while it grows.
    fs::write(&launch, b"{ not a launch record").expect("break the launch record");
    let journal = live.journal(run);
    live_journal::append_lines(
        &journal,
        &[activity(
            &journal,
            run,
            fixture_run::NODE_ID,
            "while unreadable",
        )],
    );
    std::thread::sleep(Duration::from_millis(400));
    tab.drain();
    assert!(
        tab.frames
            .iter()
            .all(|frame| frame["type"] != "detail.patch"),
        "a run the engine could not read was patched: {:#?}",
        tab.frames
    );
    // Once it can be read, what it recorded meanwhile reaches the view.
    fs::write(&launch, recorded).expect("restore the launch record");
    let _ = frame_of(&mut tab, "detail.patch");
    tab.drain();
    same(
        &unstamped(tab.state["visible"]["detail"].clone()),
        &fresh(
            live.address(),
            &format!("/api/v2/runs/{run}?include_conversations=false"),
        ),
        "the detail once the run could be read again",
    );
}

#[test]
fn a_run_that_moves_every_poll_has_its_row_pushed_at_most_once_per_interval_and_ends_current() {
    let live = Live::start(|root| {
        growing_run(root, fixture_run::RUN_ID);
        growing_run(root, fixture_run::OTHER_RUN_ID);
        fs::remove_file(root.join(fixture_run::OTHER_RUN_ID).join("result.json"))
            .expect("unsettle it");
    });
    let mut tab = Tab::open(&live, &json!({ "type": "sidebar" }));
    let other = live.journal(fixture_run::OTHER_RUN_ID);
    // One record every poll, for a while: the run moves on every tick. The
    // load workload's writer appends from one process, so the pace holds on a
    // loaded host, where a writer spawned per record falls behind the interval.
    let poll = Duration::from_millis(50);
    let log = live._trace_dir.path().join("moving.jsonl");
    let options = json!({
        "root": other.parent().and_then(Path::parent).expect("a runs root"),
        "log": log, "durationMs": 3_000, "rate": 1_200,
        "runs": [{ "run": fixture_run::OTHER_RUN_ID, "node": fixture_run::NODE_ID }],
        "burst": 0, "burstRun": fixture_run::OTHER_RUN_ID, "burstAt": 0,
        "openRun": fixture_run::OTHER_RUN_ID,
    });
    let started = Instant::now();
    let writer = std::process::Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/dag-ui-e2e/load/writer.mjs"))
        .arg(options.to_string())
        .status()
        .expect("node runs the load writer");
    let elapsed = started.elapsed();
    assert!(writer.success(), "the load writer failed");
    let appended = fs::read_to_string(&log)
        .expect("the writer's log")
        .lines()
        .count();
    let last = fs::read_to_string(&other)
        .expect("a journal")
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .expect("a last record")["ts"]
        .clone();
    // Its row is read again once the interval is up, to what the run then
    // holds: the last record among them.
    let updated = |tab: &Tab| {
        tab.state["sidebar"]
            .as_array()
            .expect("rows")
            .iter()
            .find(|row| row["id"] == fixture_run::OTHER_RUN_ID)
            .map(|row| row["updated_at"].clone())
    };
    let deadline = Instant::now() + PATIENCE;
    while updated(&tab).as_ref() != Some(&last) && Instant::now() < deadline {
        tab.drain();
    }
    assert_eq!(
        updated(&tab),
        Some(last),
        "the tab's row ends on the run's last record"
    );
    let pushed = tab
        .frames
        .iter()
        .filter(|frame| frame["type"] == "run.changed")
        .count();
    let interval = poll * onepipeline_ui::live::ROW_POLLS_PER_READ;
    let most = usize::try_from(elapsed.as_millis() / interval.as_millis()).expect("small") + 2;
    assert!(
        (1..=most).contains(&pushed),
        "{appended} appends over {elapsed:?} pushed {pushed} rows; at most {most} at one per {interval:?}"
    );
    assert!(
        pushed < appended,
        "every append was pushed: {pushed} rows for {appended} appends"
    );
}

#[test]
fn a_stream_asked_for_gzip_sends_each_frame_encoded_as_it_happens() {
    let live = Live::start(|root| growing_run(root, fixture_run::RUN_ID));
    let subscribed = live.subscribe(&json!({
        "view": { "type": "detail", "run_id": fixture_run::RUN_ID }
    }));
    let subscription = subscribed["subscription"].as_str().expect("an id");
    let after = subscribed["initial"]["snapshot"]["id"]
        .as_str()
        .expect("a snapshot id");
    let mut stream = http::gzip_stream(
        live.address(),
        &format!("/api/v2/events?subscription={subscription}&after={after}"),
    );
    assert_eq!(stream.status, 200);
    assert_eq!(stream.header("content-encoding"), Some("gzip"));
    assert_eq!(stream.header("vary"), Some("accept-encoding"));
    assert!(stream
        .header("content-type")
        .is_some_and(|value| value.starts_with("text/event-stream")));
    let journal = live.journal(fixture_run::RUN_ID);
    let mut decoded = 0;
    for marker in 0..3 {
        live_journal::append_lines(
            &journal,
            &[activity(
                &journal,
                fixture_run::RUN_ID,
                fixture_run::NODE_ID,
                &format!("encoded {marker}"),
            )],
        );
        // The record's patch decodes from what has arrived, with no frame
        // after it: the encoder flushed it rather than holding it for the
        // next. Its run's sidebar row may come first.
        let deadline = Instant::now() + PATIENCE;
        let frame = loop {
            let frame = stream
                .frame_within(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|| panic!("record {marker}'s patch was held back"));
            decoded += frame.id.len() + frame.event.len() + frame.data.len();
            if frame.event == "detail.patch" {
                break frame;
            }
            assert_eq!(frame.event, "run.changed");
        };
        let data = frame.json();
        assert_eq!(data["subscription"], subscription);
        assert!(
            frame.data.contains(&format!("encoded {marker}")),
            "the frame carries record {marker}: {}",
            frame.data
        );
        while let Some(frame) = stream.frame_within(QUIET) {
            decoded += frame.id.len() + frame.event.len() + frame.data.len();
        }
    }
    // What crossed the wire is smaller than what it decoded to.
    assert!(
        stream.wire < decoded,
        "{} encoded bytes for {decoded} decoded ones",
        stream.wire
    );
}
