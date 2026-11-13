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
use crate::serving::{self, Serving};

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
        Self::start_with_args(build, extra, &[])
    }

    fn start_with_args(
        build: impl FnOnce(&Path),
        extra: &[(&str, &str)],
        arguments: &[&str],
    ) -> Self {
        let trace_dir = tempfile::tempdir().expect("a trace directory");
        let trace = trace_dir.path().join("live.jsonl");
        let trace_text = trace.to_str().expect("utf-8").to_owned();
        let mut environment = vec![
            (onepipeline_ui::live::TRACE_ENV, trace_text.as_str()),
            (onepipeline_ui::live::TELEMETRY_REFOLD_ENV, "0"),
        ];
        environment.extend_from_slice(extra);
        let serving = Serving::start_with_env_and_args(build, &environment, arguments);
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

    /// Every line the server traced, in order.
    fn traced(&self) -> Vec<Value> {
        fs::read_to_string(&self.trace)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// Every refresh the server traced, in order.
    fn refreshes(&self) -> Vec<Value> {
        let mut lines = self.traced();
        lines.retain(|line| line.get("refresh").is_some());
        lines
    }

    /// Every subscription's first answer the server traced, in order.
    fn first_answers(&self) -> Vec<Value> {
        let mut lines = self.traced();
        lines.retain(|line| line.get("subscribe").is_some());
        lines
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
        let mut tab = Self {
            subscription,
            stream,
            applied,
            state: snapshot,
            frames: Vec::new(),
        };
        // A run view settles once: the sidebar's rows, then the rest of the run.
        // A journey about what comes before that opens with `Tab::first`.
        tab.settle();
        tab
    }

    /// A tab that has only the first answer, for a journey that holds what comes
    /// before the rest.
    fn first(live: &Live, view: &Value) -> Self {
        let subscribed = live.subscribe(&json!({ "view": view }));
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

    /// Read until the sidebar and the run's complete read have both landed.
    fn settle(&mut self) {
        while self.state["sidebar"].is_null()
            || !self.detail_complete()
            || !self.timeline_complete()
        {
            assert!(
                self.receive(PATIENCE).is_some(),
                "the stream went quiet before the run was complete: {:#}",
                self.state["visible"]["detail"]["progress"]
            );
        }
        self.frames.clear();
    }

    /// [`Self::settle`], keeping the frames read for what a journey holds of them.
    fn settle_after_first(&mut self) {
        while self.state["sidebar"].is_null()
            || !self.detail_complete()
            || !self.timeline_complete()
        {
            assert!(self.receive(PATIENCE).is_some(), "the rest never came");
        }
    }

    fn detail_complete(&self) -> bool {
        let progress = &self.state["visible"]["detail"]["progress"];
        progress.is_null() || progress["complete"] == true
    }

    fn timeline_complete(&self) -> bool {
        let progress = &self.state["visible"]["timeline"]["progress"];
        progress.is_null() || progress["complete"] == true
    }

    /// Read until the stream goes quiet, applying each frame in order.
    fn drain(&mut self) -> Vec<Value> {
        let mut read = Vec::new();
        while let Some(data) = self.receive(QUIET) {
            read.push(data);
        }
        read
    }

    /// Read until a frame `wanted` names arrives, applying each in order, and
    /// return every frame read up to and including it. Only a stream that
    /// never sends one within [`PATIENCE`] fails: how long the server takes
    /// is not what a journey holds it to.
    ///
    /// Compiled only where a journey that calls it is: every caller so far
    /// holds a run open with a unix-only lock.
    #[cfg(unix)]
    fn until(&mut self, what: &str, wanted: impl Fn(&Value) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + PATIENCE;
        let mut read = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.receive(left) {
                Some(data) => {
                    let done = wanted(&data);
                    read.push(data);
                    if done {
                        return read;
                    }
                }
                None => panic!("the stream never sent {what}: it sent {read:#?}"),
            }
        }
    }

    /// Read until the state this tab holds satisfies `done`, applying each
    /// frame in order, and return how many frames that took. Only a stream that
    /// goes [`PATIENCE`] without a frame fails: how long the server takes is
    /// not what a journey holds it to.
    fn until_listed(&mut self, what: &str, done: impl Fn(&Self) -> bool) -> usize {
        let mut read = 0;
        while !done(self) {
            assert!(
                self.receive(PATIENCE).is_some(),
                "the stream went quiet before {what} was listed, after {read} frames"
            );
            read += 1;
        }
        read
    }

    /// The next frame within `patience`, checked against its SSE framing and
    /// applied.
    fn receive(&mut self, patience: Duration) -> Option<Value> {
        let frame = self.stream.frame_within(patience)?;
        let data = frame.json();
        assert_eq!(frame.id, data["id"], "the SSE id is the frame's id");
        assert_eq!(
            frame.event, data["type"],
            "the SSE event is the frame's type"
        );
        assert_eq!(data["subscription"], self.subscription.as_str());
        self.apply(&data);
        self.frames.push(data.clone());
        Some(data)
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
            Some("sidebar.snapshot") => {
                self.state["sidebar"] = frame["rows"].clone();
            }
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

/// What a subscription's payload and a route's complete document have in common:
/// the subscription's `progress`, `telemetry.as_of` and each span's windowed
/// list are its own, and a span's list is held to the complete one by page.
fn comparable(payload: &Value) -> Value {
    let mut payload = payload.clone();
    if let Some(object) = payload.as_object_mut() {
        object.remove("progress");
        if let Some(telemetry) = object.get_mut("telemetry").and_then(Value::as_object_mut) {
            telemetry.remove("as_of");
        }
        if let Some(spans) = object.get_mut("spans").and_then(Value::as_array_mut) {
            for span in spans.iter_mut().filter_map(Value::as_object_mut) {
                span.remove("events");
                span.remove("events_total");
            }
        }
    }
    payload
}

/// Hold a patched payload to a fresh read, naming what differs rather than
/// printing both whole.
fn same(patched: &Value, fresh: &Value, what: &str) {
    let (patched, fresh) = (&comparable(patched), &comparable(fresh));
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
    let _settled = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
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
        same(
            &unstamped(frame["snapshot"]["visible"]["detail"].clone()),
            &fresh(
                live.address(),
                &format!("/api/v2/runs/{run}?include_conversations=false"),
            ),
            "the reset",
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
    // The subscription has to record more frames than it retains while its
    // stream is away, and how fast a server makes frames is the host's: a
    // moved run's row is the SDK folding its summary and syncing the cache,
    // and sixty runs grown together made fewer than five frames a second on a
    // loaded Windows runner. So the frames are made from the sidebar's two cheapest changes —
    // a run going away, which reads nothing, and coming back with the summary
    // its journal already matches, which folds nothing — and each step waits
    // for its own frames, so the journey reaches the boundary on any host
    // rather than racing one to it.
    let runs: Vec<String> = (0..64)
        .map(|index| format!("retained-{index:02}"))
        .collect();
    // Longer than any host takes to make the frames: a subscription the grace
    // retired would be answered `410 expired`, which is not what this holds.
    let grace = Duration::from_secs(24 * 60 * 60);
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
    // retained frames behind, and on reconnecting from the snapshot it never
    // read past is answered with the one explicit re-send rather than a replay
    // that lost frames.
    let stalled = Tab::open(&live, &json!({ "type": "sidebar" }));
    let journals: Vec<(PathBuf, PathBuf)> = runs
        .iter()
        .map(|run| {
            let journal = live.journal(run);
            let away = journal.with_extension("jsonl.away");
            (journal, away)
        })
        .collect();
    let listed = |tab: &Tab| -> usize {
        tab.state["sidebar"]
            .as_array()
            .expect("rows")
            .iter()
            .filter(|row| runs.iter().any(|run| row["id"] == run.as_str()))
            .count()
    };
    counter.until_listed("every run", |tab| listed(tab) == runs.len());
    let mut counted = counter.frames.len();
    while counted <= onepipeline_ui::contract::RETAINED_FRAMES {
        for (journal, away) in &journals {
            rename(journal, away);
        }
        counted += counter.until_listed("every run gone", |tab| listed(tab) == 0);
        for (journal, away) in &journals {
            rename(away, journal);
        }
        counted += counter.until_listed("every run back", |tab| listed(tab) == runs.len());
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
        frame["base"],
        snapshot_id.as_str(),
        "the reset echoes the cursor it refused"
    );
    assert_eq!(
        frame["snapshot"]["sidebar"].as_array().map(Vec::len),
        Some(runs.len())
    );
    assert!(
        stream.frame_within(QUIET).is_none(),
        "one reset, nothing replayed after it"
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

/// Move a run's journal, the way a run is taken out from under the root and put
/// back. Windows refuses a rename while another process holds the file without
/// sharing its deletion — a scanner opening a file just written does — so a
/// refusal is retried for as long as a journey waits on the server.
fn rename(from: &Path, to: &Path) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return,
            Err(err) => {
                assert!(
                    Instant::now() < deadline,
                    "move {} to {}: {err}",
                    from.display(),
                    to.display()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// Hold the server's next look at the runs root inside its read of `run`, and
/// hand back that run's summary path and what releases the look: drop the
/// writer, and the look reads an empty summary, folds the run and finishes.
///
/// Reading a moved run's row is the SDK folding its summary and writing the
/// cache back, which a host with slow syncs takes seconds over — longer, on
/// Windows, than a client waits. This makes that read take exactly as long as
/// a journey wants: the run's cached summary is replaced by a FIFO, so the
/// look blocks opening it until a writer does and then reading it until the
/// writer closes. The summary must already be cached — a subscription's first
/// look caches every run's.
#[cfg(unix)]
fn hold_a_look_on(live: &Live, run: &str) -> (PathBuf, fs::File) {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;

    let summary = live.serving.run_dir(run).join("summary.json");
    assert!(summary.is_file(), "the first look cached the run's summary");
    // llmlint: ignore-block[tests_mirror_real_usage] the condition under test is storage that answers slower than a client waits — what a Windows host's syncs did to this server's look — and no request a client can make produces that on demand: a genuinely slow fold is the host's timing, which these journeys must not depend on. The FIFO is that storage at the filesystem boundary the server reads the runs root through; the server is the real binary, nothing in it is stubbed, and every request these journeys hold to an answer is the HTTP one a tab makes.
    fs::remove_file(&summary).expect("remove the cached summary");
    let path = std::ffi::CString::new(summary.as_os_str().as_bytes()).expect("a path");
    // SAFETY: `path` is a NUL-terminated path this test owns.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
    // llmlint: ignore-end[tests_mirror_real_usage]
    // The summary's stamp moved, so the next look reads the run again and
    // blocks opening the FIFO; a writer can open it once that reader has, and
    // from then on the look blocks reading it until the writer closes.
    let deadline = Instant::now() + PATIENCE;
    loop {
        match fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&summary)
        {
            Ok(writer) => return (summary, writer),
            Err(err) if err.raw_os_error() == Some(libc::ENXIO) => {
                assert!(
                    Instant::now() < deadline,
                    "the server never looked at the run's summary again"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(err) => panic!("open the summary FIFO: {err}"),
        }
    }
}

/// A stream is answered while the sidebar is still reading a run.
///
/// A sidebar of many moving runs can take longer to read than a client waits
/// for a status line: on Windows `a_cursor_older_than_the_retained_frames_is_answered_stale`
/// timed out reading one. With a look held mid-read, the requests a tab makes
/// are held to being answered.
#[cfg(unix)]
#[test]
fn a_stream_and_a_subscription_are_answered_while_the_sidebar_is_reading_a_run() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    // The first subscription reads every row, so the run's summary is now the
    // cache the SDK wrote for it.
    let subscribed = live.subscribe(&json!({ "view": { "type": "sidebar" } }));
    let subscription = subscribed["subscription"]
        .as_str()
        .expect("an id")
        .to_owned();
    let snapshot_id = subscribed["initial"]["snapshot"]["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let (summary, writer) = hold_a_look_on(&live, run);

    // The look is reading now, and stays reading until `writer` closes.
    let stream = http::stream(
        live.address(),
        &format!("/api/v2/events?subscription={subscription}&after={snapshot_id}"),
        None,
    );
    assert_eq!(stream.status, 200, "the stream is answered mid-look");
    let (epoch, _) = snapshot_id.split_once(':').expect("epoch:seq");
    let mut reset = http::stream(
        live.address(),
        &format!("/api/v2/events?subscription={subscription}&after={epoch}:999999"),
        None,
    );
    let frame = reset.frame_within(PATIENCE).expect("a reset").json();
    assert_eq!(frame["type"], "reset");
    assert_eq!(frame["reason"], "unknown-cursor");
    assert_eq!(
        frame["snapshot"]["sidebar"][0]["id"], run,
        "the reset carries the rows the sidebar holds"
    );
    let another = live.subscribe(&json!({ "view": { "type": "sidebar" } }));
    assert_eq!(another["initial"]["snapshot"]["sidebar"][0]["id"], run);

    // Let the look finish: an empty summary is no cache, so the run is folded
    // and its cache written again in the FIFO's place.
    drop(writer);
    let deadline = Instant::now() + PATIENCE;
    while !summary.is_file() {
        assert!(
            Instant::now() < deadline,
            "the look never finished once the summary could be read"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);
}

/// A subscription to a run no look has listed yet lists it in its snapshot,
/// and every subscription already made is sent its row.
///
/// The sidebar's rows are only as current as the poller's last look, and a tab
/// reads them as the runs that are served: a run whose detail a snapshot
/// carried but whose row it did not was one the browser took for unserved, and
/// it opened the newest run instead — the header journey that wrote a run and
/// opened it at once watched another run's Stop button. The look is held here
/// for as long as the journey runs, so no look can list the run first.
#[cfg(unix)]
#[test]
fn a_run_no_look_has_listed_yet_is_in_the_snapshot_of_a_subscription_to_it() {
    let quiet = fixture_run::RUN_ID;
    let fresh = "written-after-the-look";
    let live = Live::start(|root| growing_run(root, quiet));
    let mut sidebar = Tab::open(&live, &json!({ "type": "sidebar" }));
    let (summary, writer) = hold_a_look_on(&live, quiet);
    // Written while the look is held, so no look has seen it.
    growing_run(&live.serving.runs_root(), fresh);

    let mut opened = Tab::first(&live, &json!({ "type": "detail", "run_id": fresh }));
    assert_eq!(opened.state["visible"]["run_id"], fresh);
    assert!(
        opened.state["sidebar"].is_null(),
        "a run view's first answer waits on no rows"
    );
    let snapshot_frame = frame_of(&mut opened, "sidebar.snapshot");
    let snapshot = json!({ "sidebar": snapshot_frame["rows"].clone() });
    let listed: Vec<&str> = snapshot["sidebar"]
        .as_array()
        .expect("rows")
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    assert!(
        listed.contains(&fresh),
        "the snapshot serves {fresh}'s detail but lists only {listed:?}"
    );
    let row = snapshot["sidebar"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == fresh))
        .expect("the row")
        .clone();
    // The sidebar tab already open is sent that row, as a look would send it.
    // The look is still held, so nothing but the subscription can send it.
    sidebar.until(&format!("{fresh}'s row"), |frame| {
        frame["type"] == "run.changed" && frame["row"]["id"] == fresh
    });
    assert!(sidebar.state["sidebar"]
        .as_array()
        .expect("rows")
        .iter()
        .any(|held| held["id"] == fresh));

    // Released, the look finishes and its rows are the sidebar's: the row the
    // snapshot carried is the one a look reads.
    drop(writer);
    let deadline = Instant::now() + PATIENCE;
    while !summary.is_file() {
        assert!(Instant::now() < deadline, "the look never finished");
        std::thread::sleep(Duration::from_millis(20));
    }
    let after = live.subscribe(&json!({ "view": { "type": "sidebar" } }));
    let looked = after["initial"]["snapshot"]["sidebar"]
        .as_array()
        .and_then(|rows| rows.iter().find(|held| held["id"] == fresh))
        .expect("the look lists the run")
        .clone();
    assert_eq!(row, looked, "the row is the one a look reads");
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
    same(
        &unstamped(tab.state["visible"]["detail"].clone()),
        &fresh(
            live.address(),
            &format!("/api/v2/runs/{run}?include_conversations=false"),
        ),
        "the detail",
    );
    same(
        &unstamped(tab.state["visible"]["timeline"].clone()),
        &fresh(
            live.address(),
            &format!("/api/v2/runs/{run}/timeline?scope=run"),
        ),
        "the timeline",
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
    let mut as_written = BTreeMap::new();
    let live = Live::start(|root| {
        fixture_run::write(root, run);
        fixture_run::write(root, fixture_run::OTHER_RUN_ID);
        // The run this journey removes is settled the way the engine's writer
        // leaves one — its summary and checkpoint current — so no read the
        // server makes of it folds and writes them: the journey is then its
        // only writer, and it has finished before the server starts.
        fixture_run::summarize(root, fixture_run::OTHER_RUN_ID);
        as_written = serving::tree(&root.join(fixture_run::OTHER_RUN_ID));
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
    // A run view's rows are its stream's first frame.
    let mut first_stream = http::stream(
        live.address(),
        &format!(
            "/api/v2/events?subscription={}",
            subscribed["subscription"].as_str().expect("an id")
        ),
        None,
    );
    let sidebar_snapshot = first_stream
        .frame_within(PATIENCE)
        .expect("the sidebar's rows")
        .json();
    assert_eq!(sidebar_snapshot["type"], "sidebar.snapshot");
    drop(first_stream);
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
    // A run taken out of the root is removed from every sidebar. Nothing has
    // written into it since the journey did — the sidebar has read it, and
    // read it without writing — so nothing is left to race its removal, and
    // after one rename nothing can reach it: the server's poll reports it gone,
    // never makes it again, and the moved copy is still byte for byte what
    // the journey wrote when it is deleted.
    let other = live.serving.run_dir(fixture_run::OTHER_RUN_ID);
    assert_eq!(
        serving::tree(&other),
        as_written,
        "the server wrote into a run it only read"
    );
    let taken_out = live.serving.take_out(fixture_run::OTHER_RUN_ID);
    let removed = frame_of(&mut sidebar, "run.removed");
    assert!(!other.exists(), "the server made the removed run again");
    assert_eq!(
        serving::tree(&taken_out),
        as_written,
        "something wrote into the run after it left the root"
    );
    fs::remove_dir_all(&taken_out).expect("remove the other run");
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
            pin(&sidebar_snapshot),
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
    // A tab on the run, so the server holds it open and refreshes it too.
    let _tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let mut seen = live.refreshes().len();
    // The engine's own writer appends, then the fixture writer, then the engine.
    surface("the engine writes first");
    let engine_first = receipt();
    live.next_refresh(run, &mut seen);
    // The linked engine's long-lived reader, opened once the engine's write and
    // its receipt are both on disk and refreshed once the fixture writer has
    // exited, so it reads the append whole. The server's poller is the same
    // reader on a tick of its own, and a tick that falls between the fixture's
    // record and its receipt is a re-read whatever the receipt says — on a
    // loaded Windows host, where the receipt's rename waits out the server
    // holding the old one open, it did. So the server's refresh is held to the
    // receipts rather than to the kind of read it made.
    let paths = onepipeline::views::RunPaths::under(
        journal
            .parent()
            .and_then(Path::parent)
            .expect("a runs root"),
        run,
    );
    let mut reader = onepipeline::views::RunView::open(&paths).expect("the engine reads the run");
    let before = reader.events.len();
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
    live.next_refresh(run, &mut seen);
    assert_eq!(
        receipt(),
        fixture,
        "the server's refresh left the fixture's receipt as the fixture wrote it"
    );
    let refresh = reader.refresh().expect("the engine refreshes the run");
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
    // And the engine read the fixture's append as an append of one record.
    assert_eq!(
        refresh,
        onepipeline::views::Refreshed::Appended { first: before }
    );
    assert_eq!(reader.events.len(), before + 1);
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
    let interval = Duration::from_millis(1_500);
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
        &[(
            onepipeline_ui::live::TELEMETRY_REFOLD_ENV,
            &interval.as_millis().to_string(),
        )],
    );
    // A ready writer for every record there is to append, before anything
    // starts the fold's clock: an append after a fold landed on a change is
    // measured from that change, so a writer started then would put node's
    // start back into the fold's age.
    let mut writers = live_journal::Writer::start_many(held_back.len()).into_iter();
    // The subscription folds the run while it is being made, so the fold is
    // taken between these two instants.
    let opening = Instant::now();
    let mut tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let mut folded = opening..Instant::now();
    let mut held_back = held_back.into_iter();
    let mut seen = live.refreshes().len();
    // Append the next held-back record and say whether the refresh it caused
    // folded. A tick that appended something folds only once the fold is two
    // intervals behind, so a fold on one is held to the instants that bound
    // the last fold: a runner slow enough to pass that point is told apart
    // from a change that waited on a fold it was not yet owed.
    let mut change =
        |writer: live_journal::Writer, folded: &mut std::ops::Range<Instant>, seen: &mut usize| {
            let record = held_back.next().expect("a held-back record left to append");
            let appending = Instant::now();
            writer.append_lines(&live.journal(run), &[record]);
            let refresh = live.next_refresh(run, seen);
            let read = Instant::now();
            // The writer's receipt lands just after the record, and a poll
            // between the two is answered with a re-read; either is a tick
            // that carried a change, which is all the fold's timing turns on.
            assert!(
                ["appended", "reread"].contains(&refresh["refresh"].as_str().unwrap_or_default()),
                "{refresh}"
            );
            if refresh["telemetry_fold_ms"].is_null() {
                return false;
            }
            assert!(
                read - folded.start >= interval * 2,
                "the change waited on a fold less than two intervals behind: {refresh}"
            );
            *folded = appending..read;
            true
        };
    // Let the fold age past the interval, so the change is one the refold has
    // to catch up with, and see it sent without the fold.
    loop {
        let writer = writers.next().expect("a ready writer");
        std::thread::sleep(interval.saturating_sub(folded.end.elapsed()));
        if !change(writer, &mut folded, &mut seen) {
            break;
        }
    }
    // A change straight after is sent at once, without the fold either.
    while change(
        writers.next().expect("a ready writer"),
        &mut folded,
        &mut seen,
    ) {}
    let _ = frame_of(&mut tab, "detail.patch");
    // Then, with nothing appended, the fold catches up within the interval
    // and the detail becomes what a fresh read serves.
    let deadline = Instant::now() + PATIENCE;
    loop {
        let refolded = live.refreshes()[seen..]
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
    // The load writer appends every 25 ms, faster than the 50 ms poll.
    // Keep it alive beyond the observation deadline, rather than taking one
    // trace snapshot after a fixed workload has already stopped.
    // Writer exit does not synchronize with a server tick: on a slow host
    // that snapshot can contain only a refresh from before a fold was owed.
    struct Writing(std::process::Child);
    impl Drop for Writing {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let root = live
        .serving
        .run_dir(run)
        .parent()
        .expect("a runs root")
        .to_path_buf();
    let log = live._trace_dir.path().join("appended.jsonl");
    let options = json!({
        "root": root, "log": log, "durationMs": PATIENCE.as_millis() * 2, "rate": 2_400,
        "runs": [{ "run": run, "node": fixture_run::NODE_ID }],
        "burst": 0, "burstRun": run, "burstAt": 0, "openRun": run,
    });
    let mut writer = Writing(
        std::process::Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/dag-ui-e2e/load/writer.mjs"))
            .arg(options.to_string())
            .spawn()
            .expect("node runs the load writer"),
    );
    let deadline = Instant::now() + PATIENCE;
    // Startup time is not writing time. Subscribe only after the first append,
    // so the writer is already active before the subscription's first interval.
    while fs::metadata(&log).map_or(true, |metadata| metadata.len() == 0) {
        assert!(
            writer.0.try_wait().expect("writer status").is_none(),
            "the load writer exited before its first append"
        );
        assert!(Instant::now() < deadline, "the load writer never appended");
        std::thread::sleep(Duration::from_millis(20));
    }
    let _tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let mut moving_since = Instant::now();
    let mut seen = live.refreshes().len();
    let mut eligible = false;
    loop {
        let read_started = Instant::now();
        let refreshes = live.refreshes();
        assert!(
            Instant::now() < deadline,
            "the fold never caught up while the run kept moving: {refreshes:#?}"
        );
        assert!(
            writer.0.try_wait().expect("writer status").is_none(),
            "the load writer finished before a qualifying fold: {refreshes:#?}"
        );
        for refresh in &refreshes[seen..] {
            if refresh["run"] != run {
                continue;
            }
            if refresh["refresh"] == "unchanged" {
                // A quiet tick cannot contribute to the continuous-writing
                // window, even when the host delayed the writer's timer.
                moving_since = Instant::now();
                eligible = false;
            } else if eligible && !refresh["telemetry_fold_ms"].is_null() {
                // Appended and reread both mean the journal moved. Check the
                // writer again at observation, including after reading the log.
                assert!(
                    writer.0.try_wait().expect("writer status").is_none(),
                    "the load writer finished before the fold was observed: {refreshes:#?}"
                );
                return;
            }
        }
        seen = refreshes.len();
        // Only the NEXT batch can qualify: its records were not in this
        // snapshot, so they were logged after read_started. Stamp before
        // reading, not after: a scheduling pause after the read must never
        // make an earlier fold eligible. Quiet ticks reset this lower bound.
        if read_started.saturating_duration_since(moving_since) > Duration::from_millis(600) * 2 {
            eligible = true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
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
    let _settled = Tab::open(
        &live,
        &json!({ "type": "detail", "run_id": fixture_run::RUN_ID }),
    );
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
            assert!(
                matches!(frame.event.as_str(), "run.changed" | "sidebar.snapshot"),
                "only a sidebar frame may come first: {}",
                frame.event
            );
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

/// Each path `DETAIL_FIRST_KEPT` names, and `progress`, `node_details`, walking
/// `detail` — so a member the contract does not name fails by name.
fn only_named_members(detail: &Value) {
    fn walk(value: &Value, path: &str, allowed: &[String], out: &mut Vec<String>) {
        let starred = format!("{path}.*");
        let is_starred = !path.is_empty() && allowed.iter().any(|name| name.starts_with(&starred));
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, &starred, allowed, out);
                }
            }
            Value::Object(object) => {
                for (key, member) in object {
                    let joined = if path.is_empty() {
                        key.clone()
                    } else if is_starred {
                        format!("{path}.*")
                    } else {
                        format!("{path}.{key}")
                    };
                    if allowed.contains(&joined) {
                        continue;
                    }
                    if allowed
                        .iter()
                        .any(|name| name.starts_with(&format!("{joined}.")))
                    {
                        walk(member, &joined, allowed, out);
                    } else {
                        out.push(joined);
                    }
                }
            }
            _ => {}
        }
    }
    let allowed: Vec<String> = onepipeline_ui::contract::DETAIL_FIRST_KEPT
        .iter()
        .chain(
            [
                "run.turns",
                "progress",
                "node_details",
                "observed_at",
                "api_version",
                "telemetry_schema_version",
            ]
            .iter(),
        )
        .map(|path| (*path).to_owned())
        .collect();
    let mut extra = Vec::new();
    walk(detail, "", &allowed, &mut extra);
    assert!(
        extra.is_empty(),
        "members the contract does not name: {extra:?}"
    );
}

const HOLD: (&str, &str) = (onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "1500");

#[test]
fn a_first_answer_is_selective_and_the_rest_arrives_in_one_patch() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(
        |root| {
            fixture_run::write(root, run);
        },
        &[HOLD],
    );
    let mut tab = Tab::first(&live, &json!({ "type": "detail", "run_id": run }));
    assert!(tab.state["sidebar"].is_null(), "no rows in the answer");
    let detail = tab.state["visible"]["detail"].clone();
    only_named_members(&detail);
    assert_eq!(detail["run"]["turns"], json!({ "loading": true }));
    assert_eq!(
        detail["progress"],
        json!({ "complete": false, "loading": ["run.turns"] })
    );
    assert!(detail["telemetry"].is_null(), "no telemetry until the rest");
    let full = fresh(
        live.address(),
        &format!("/api/v2/runs/{run}?include_conversations=false"),
    );
    for path in ["state", "phase"] {
        assert_eq!(detail["run"][path], full["run"][path], "{path}");
    }
    assert_eq!(
        detail["run"]["timing"]["wall_seconds"],
        full["run"]["timing"]["wall_seconds"]
    );
    assert_eq!(detail["graph"]["node_status"], full["graph"]["node_status"]);
    // The stream's first frame is the rows; one patch is the rest.
    let first = tab.receive(PATIENCE).expect("the rows");
    assert_eq!(first["type"], "sidebar.snapshot");
    assert!(first["rows"]
        .as_array()
        .is_some_and(|rows| !rows.is_empty()));
    let rest = tab.receive(PATIENCE).expect("the rest");
    assert_eq!(rest["type"], "detail.patch");
    assert_eq!(
        tab.state["visible"]["detail"]["progress"],
        json!({ "complete": true, "loading": [] })
    );
    assert!(tab.state["visible"]["detail"]["run"]["turns"].is_u64());
    assert!(tab.state["visible"]["detail"]["telemetry"]["as_of"].is_string());
    same(
        &unstamped(tab.state["visible"]["detail"].clone()),
        &full,
        "the opened detail",
    );
    assert!(
        tab.drain()
            .iter()
            .all(|frame| frame["type"] != "detail.patch"),
        "one patch"
    );
    // A tab opening a run already read has it whole.
    let second = Tab::first(&live, &json!({ "type": "detail", "run_id": run }));
    assert_eq!(
        second.state["visible"]["detail"]["progress"]["complete"],
        true
    );
}

#[test]
fn overall_holds_every_span_without_its_events_and_the_rest_adds_sessions_and_totals() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(
        |root| {
            fixture_run::write(root, run);
            fixture_run::point_sessions(root, run);
        },
        &[HOLD],
    );
    let mut tab = Tab::first(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "run" }),
    );
    let timeline = tab.state["visible"]["timeline"].clone();
    assert_eq!(
        timeline["progress"]["loading"],
        json!(["spans[harness_scope]"])
    );
    let spans = timeline["spans"].as_array().expect("spans");
    assert!(!spans.is_empty());
    for span in spans {
        assert!(span.get("harness_scope").is_none(), "{span}");
        assert_eq!(span["events"], json!([]), "{span}");
        assert!(span.get("detail").is_none(), "{span}");
        assert!(span.get("events_total").is_none(), "{span}");
    }
    let full = fresh(
        live.address(),
        &format!("/api/v2/runs/{run}/timeline?scope=run"),
    );
    let held: Vec<_> = full["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .filter(|span| span.get("harness_scope").is_none())
        .collect();
    assert_eq!(
        held.len(),
        spans.len(),
        "every span but a harness session's"
    );
    for (mine, whole) in spans.iter().zip(&held) {
        for field in ["id", "kind", "status", "started_at", "ended_at"] {
            assert_eq!(mine[field], whole[field], "{field} of {}", whole["id"]);
        }
    }
    tab.settle_after_first();
    same(
        &unstamped(tab.state["visible"]["timeline"].clone()),
        &full,
        "the opened timeline",
    );
    let total: usize = tab.state["visible"]["timeline"]["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .map(|span| span["events_total"].as_u64().expect("a total") as usize)
        .sum();
    assert_eq!(
        total,
        full["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .map(|span| span["events"].as_array().map_or(0, Vec::len))
            .sum::<usize>(),
    );
    assert!(
        tab.state["visible"]["timeline"]["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .all(|span| span["events"] == json!([])),
        "no frame carried a span's whole list",
    );
    assert!(
        tab.frames
            .iter()
            .all(|frame| !frame.to_string().contains("\"events\":[{")),
        "a frame carried events",
    );
}

#[test]
fn a_nodes_window_is_its_latest_rows_and_pages_reach_every_row_either_side_of_the_rest() {
    node_window_and_pages(false);
}

/// The same, over a journal long enough that the node's first answer is a
/// selective read of it: a page before the rest is then served from that read,
/// which holds every record of the node, rather than from the journal again.
#[test]
fn a_selective_first_answer_serves_its_nodes_pages_before_the_rest() {
    node_window_and_pages(true);
}

/// With no view of the run open, as a reader of the API alone asks: over a
/// journal too long to read whole, a node's pages and one of its span's pages
/// hold every row the node's complete document lists, each once and in its
/// order, built from the one selective reading the page opens, which holds every
/// record of the node.
#[test]
fn with_no_view_open_pages_over_a_long_journal_are_the_complete_rows() {
    let run = fixture_run::RUN_ID;
    let node = fixture_run::NODE_ID;
    let live = Live::start_with(
        |root| {
            growing_run(root, run);
            let journal = root.join(run).join("events.jsonl");
            pad_past_a_whole_read(&journal, run);
            for marker in 0..55 {
                let line = activity(&journal, run, node, &format!("row {marker}"));
                live_journal::append_lines(&journal, &[line]);
            }
        },
        &[],
    );
    let ids = |rows: &[Value]| -> Vec<Value> { rows.iter().map(|row| row["id"].clone()).collect() };
    let in_order = |document: &Value| -> Vec<Value> {
        let mut every: Vec<Value> = Vec::new();
        for span in document["spans"].as_array().expect("spans") {
            for row in span["events"].as_array().into_iter().flatten() {
                if !every.iter().any(|held| held["id"] == row["id"]) {
                    every.push(row.clone());
                }
            }
        }
        every.sort_by_key(|row| {
            (
                row["at"].as_str().unwrap_or_default().to_owned(),
                row["journal_order"].as_u64(),
            )
        });
        every
    };

    let node_document = fresh(
        live.address(),
        &format!("/api/v2/runs/{run}/timeline?scope=node&node={node}"),
    );
    let every = in_order(&node_document);
    assert!(every.len() > 55, "the node's rows: {}", every.len());
    assert_eq!(
        ids(&walk_node_pages(&live, run, node)),
        ids(&every),
        "the node's pages with no view open"
    );
    let span = node_document["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .max_by_key(|span| span["events"].as_array().map_or(0, Vec::len))
        .expect("a span");
    let walked = walk_pages(&live, run, node, span["id"].as_str().expect("an id"));
    assert_eq!(
        walked,
        *span["events"].as_array().expect("events"),
        "a span's pages with no view open"
    );
}

/// A page's document naming a run, as a browser asks for it before it runs the page,
/// starts that run's opening; the subscription the page then makes takes that reading
/// rather than opening the run again, and answers exactly what a server asked nothing
/// before it answers over the same run. A document naming a run that is not there, or
/// no valid run at all, is the page as ever, and the subscription is refused as it
/// always was.
#[test]
fn a_page_starts_its_runs_opening_and_its_subscription_answers_as_ever() {
    let run = fixture_run::RUN_ID;
    let node = fixture_run::NODE_ID;
    let (_source, source) = fixture_run::workspace();
    growing_run(&source, run);
    let journal = source.join(run).join("events.jsonl");
    pad_past_a_whole_read(&journal, run);
    for marker in 0..12 {
        let line = activity(&journal, run, node, &format!("row {marker}"));
        live_journal::append_lines(&journal, &[line]);
    }
    let copy = |root: &Path| {
        copy_run(&source.join(run), &root.join(run));
        let records = fixture_run::graph_records_for(&source);
        if records.is_dir() {
            copy_run(&records, &fixture_run::graph_records_for(root));
        }
    };
    let paged = Live::start_with_args(copy, &[], &["--ui"]);
    let unpaged = Live::start_with(copy, &[]);
    let view = json!({
        "view": {
            "type": "timeline",
            "run_id": run,
            "scope": "node",
            "node": node,
            "filter": "detailed",
        }
    });

    let page = http::get_raw(
        paged.address(),
        &format!("/?run={run}&view=graph&node={node}"),
    );
    assert_eq!(page.status, 200);
    assert_eq!(
        page.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    let deadline = Instant::now() + PATIENCE;
    let prepared = loop {
        let lines: Vec<Value> = paged
            .traced()
            .into_iter()
            .filter(|line| line.get("prepared").is_some())
            .collect();
        if !lines.is_empty() {
            break lines;
        }
        assert!(Instant::now() < deadline, "the page opened no run");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(prepared, [json!({ "prepared": run, "opened": true })]);

    let answer = paged.subscribe(&view);
    let first = paged.first_answers();
    assert_eq!(first.len(), 1, "{first:#?}");
    // The opening's own figures go with the reading to the answer that took it: a
    // reading of the journal's heads, which this journal is long enough to need.
    assert!(first[0]["heads_ms"].is_number(), "{first:#?}");
    let visible = |answer: &Value| unstamped(answer["initial"]["snapshot"]["visible"].clone());
    let mut taken = visible(&answer);
    let mut opened = visible(&unpaged.subscribe(&view));
    for held in [&mut taken, &mut opened] {
        for part in ["detail", "timeline"] {
            if let Some(object) = held[part].as_object_mut() {
                object.remove("observed_at");
            }
        }
    }
    assert_eq!(taken, opened, "the answer from the page's opening");
    // Opened once: the subscription took the page's reading, where a server no page
    // asked opens the run for the subscription itself.
    let unprepared = |live: &Live| -> Vec<Value> {
        live.traced()
            .into_iter()
            .filter_map(|line| line.get("unprepared").cloned())
            .collect()
    };
    assert_eq!(unprepared(&paged), Vec::<Value>::new());
    assert_eq!(unprepared(&unpaged), [json!(run)]);

    for (address, refused) in [
        ("/?run=no-such-run&view=overall", Some("no-such-run")),
        ("/?run=..%2Foutside&view=overall", None),
    ] {
        let page = http::get_raw(paged.address(), address);
        assert_eq!(page.status, 200, "{address}");
        assert_eq!(
            page.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        if let Some(missing) = refused {
            let response = http::post(
                paged.address(),
                "/api/v2/subscriptions",
                &json!({ "view": { "type": "detail", "run_id": missing } }).to_string(),
            );
            assert_eq!(response.status, 404, "{}", response.body);
            assert_eq!(response.json()["error"]["code"], "run_not_found");
        }
    }
    let named: Vec<Value> = paged
        .traced()
        .into_iter()
        .filter_map(|line| line.get("prepared").cloned())
        .collect();
    assert_eq!(
        named,
        [json!(run), json!("no-such-run")],
        "a malformed run is never opened"
    );
}

/// Pages naming runs open each run once however often they are asked for, and at most
/// two runs ahead of their subscriptions at once; an opening nobody took is let go after
/// its hold, which makes room for another, and the subscription that comes after it
/// opens the run itself.
#[test]
fn pages_open_each_run_once_two_at_a_time_and_an_untaken_opening_is_let_go() {
    let runs = [
        "run-20260807-prep01",
        "run-20260807-prep02",
        "run-20260807-prep03",
    ];
    let hold = (onepipeline_ui::live::PREPARED_HOLD_ENV, "1500");
    let live = Live::start_with_args(
        |root| {
            for run in runs {
                growing_run(root, run);
            }
        },
        &[hold],
        &["--ui"],
    );
    let page = |run: &str| {
        let page = http::get_raw(live.address(), &format!("/?run={run}&view=overall"));
        assert_eq!(page.status, 200, "{run}");
    };
    let prepared = || -> Vec<Value> {
        live.traced()
            .into_iter()
            .filter_map(|line| line.get("prepared").cloned())
            .collect()
    };
    let until = |what: &str, done: &dyn Fn(&[Value]) -> bool| -> Vec<Value> {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let seen = prepared();
            if done(&seen) {
                return seen;
            }
            assert!(
                Instant::now() < deadline,
                "{what}: {seen:?}; the server traced {:#?}",
                live.traced()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    };

    // The first run asked for twice, then a second and a third, all at once.
    page(runs[0]);
    page(runs[0]);
    page(runs[1]);
    page(runs[2]);
    until("the first two runs opened", &|seen| seen.len() >= 2);
    std::thread::sleep(Duration::from_millis(300));
    // The two open beside each other, so either may finish first.
    let mut first = prepared();
    first.sort_by_key(ToString::to_string);
    assert_eq!(
        first,
        [json!(runs[0]), json!(runs[1])],
        "each run once, and no third while two are held"
    );

    // Once the hold lets the untaken openings go, a third run's page opens it.
    let seen = until(
        "the third run opened once the others were let go",
        &|seen| {
            page(runs[2]);
            seen.contains(&json!(runs[2]))
        },
    );
    assert_eq!(seen.len(), 3, "{seen:?}");
    assert_eq!(seen[2], json!(runs[2]));
    // The first run's opening was let go, so its subscription opens it itself.
    let answer = live.subscribe(&json!({ "view": { "type": "detail", "run_id": runs[0] } }));
    assert_eq!(answer["initial"]["snapshot"]["visible"]["type"], "detail");
    let unprepared: Vec<Value> = live
        .traced()
        .into_iter()
        .filter_map(|line| line.get("unprepared").cloned())
        .collect();
    assert_eq!(unprepared, [json!(runs[0])]);
}

/// Copy a directory, so two servers read the same records.
fn copy_run(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("a run directory");
    for entry in fs::read_dir(from).expect("the run's directory") {
        let entry = entry.expect("an entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("a file type").is_dir() {
            copy_run(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("a copy");
        }
    }
}

/// Another node's records, appended to `journal` until it is past the size a
/// first answer reads whole.
fn pad_past_a_whole_read(journal: &Path, run: &str) {
    let template: Value = serde_json::from_str(&activity(
        journal,
        run,
        "padding-node",
        &"padding ".repeat(250),
    ))
    .expect("json");
    let first = template["seq"].as_u64().expect("a seq");
    let lines: Vec<String> = (0..700_u64)
        .map(|offset| {
            let mut line = template.clone();
            line["seq"] = json!(first + offset);
            line.to_string()
        })
        .collect();
    live_journal::append_lines(journal, &lines);
    assert!(
        fs::metadata(journal).expect("a journal").len() > 1024 * 1024 + 64 * 1024,
        "a journal past a whole read"
    );
}

fn node_window_and_pages(selective: bool) {
    let run = fixture_run::RUN_ID;
    let node = fixture_run::NODE_ID;
    let live = Live::start_with(
        |root| {
            growing_run(root, run);
            let journal = root.join(run).join("events.jsonl");
            if selective {
                pad_past_a_whole_read(&journal, run);
            }
            for marker in 0..55 {
                let line = activity(&journal, run, node, &format!("row {marker}"));
                live_journal::append_lines(&journal, &[line]);
            }
            // The node's latest records are ones no span lists, so a page's window
            // cannot learn from its records alone whether an older page is left.
            for _ in 0..12 {
                let mut line: Value =
                    serde_json::from_str(&activity(&journal, run, node, "beat")).expect("json");
                line["kind"] = json!("member-heartbeat");
                line["payload"] = json!({});
                live_journal::append_lines(&journal, &[line.to_string()]);
            }
        },
        &[(onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "2500")],
    );
    let mut tab = Tab::first(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "node", "node": node }),
    );
    let path = format!("/api/v2/runs/{run}/timeline?scope=node&node={node}");
    let full = fresh(live.address(), &path);
    let holder = |spans: &[Value]| -> Value {
        spans
            .iter()
            .max_by_key(|span| span["events"].as_array().map_or(0, Vec::len))
            .expect("a span")
            .clone()
    };
    let whole = holder(full["spans"].as_array().expect("spans"));
    let whole_rows = whole["events"].as_array().expect("events");
    assert!(whole_rows.len() > 40, "a span longer than the window");
    let held: Value = tab.state["visible"]["timeline"]["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .find(|span| span["id"] == whole["id"])
        .expect("the span")
        .clone();
    assert_eq!(held["events_total"], json!(whole_rows.len()));
    assert_eq!(
        held["events"],
        json!(whole_rows[whole_rows.len() - 40..].to_vec())
    );
    assert!(held.get("detail").is_none());
    // Before the rest: every page of the span, newest first, is the whole list.
    let walked = walk_pages(&live, run, node, whole["id"].as_str().expect("an id"));
    assert_eq!(walked, *whole_rows, "pages before the rest");
    // And every row of the node, page by page across its spans, each once, in
    // the timeline's order: a page whose window renders only itself still says
    // when an older page is left.
    let mut every: Vec<Value> = Vec::new();
    for span in full["spans"].as_array().expect("spans") {
        for row in span["events"].as_array().into_iter().flatten() {
            if !every.iter().any(|held| held["id"] == row["id"]) {
                every.push(row.clone());
            }
        }
    }
    every.sort_by_key(|row| {
        (
            row["at"].as_str().unwrap_or_default().to_owned(),
            row["journal_order"].as_u64(),
        )
    });
    let ids = |rows: &[Value]| -> Vec<Value> { rows.iter().map(|row| row["id"].clone()).collect() };
    let across = walk_node_pages(&live, run, node);
    assert_eq!(
        ids(&across),
        ids(&every),
        "the node's pages before the rest"
    );
    tab.settle_after_first();
    assert_eq!(
        tab.state["visible"]["timeline"]["progress"]["complete"],
        true
    );
    let walked = walk_pages(&live, run, node, whole["id"].as_str().expect("an id"));
    assert_eq!(walked, *whole_rows, "the same rows after the rest");
    let across = walk_node_pages(&live, run, node);
    assert_eq!(ids(&across), ids(&every), "the node's pages after the rest");
    // `span` adds the span's whole fields but its list.
    let page = http::get(
        live.address(),
        &format!(
            "/api/v2/runs/{run}/timeline/events?scope=node&node={node}&span={}&limit=1",
            whole["id"].as_str().expect("an id")
        ),
    )
    .json();
    assert_eq!(page["span"]["id"], whole["id"]);
    assert!(page["span"].get("events").is_none());
    assert_eq!(page["total"], json!(whole_rows.len()));
}

/// A history page's bounds, filter and total, held to the complete document
/// before the rest arrives and after: `from` and `to` admit the rows stamped at
/// them, a filter narrows the rows as it narrows the document, and every page of
/// one query says the same total, which is the rows its pages hold.
#[test]
fn a_pages_bounds_filter_and_total_are_the_complete_documents() {
    let run = fixture_run::RUN_ID;
    let node = fixture_run::NODE_ID;
    let live = Live::start_with(
        |root| {
            growing_run(root, run);
            let journal = root.join(run).join("events.jsonl");
            for marker in 0..30 {
                let line = activity(&journal, run, node, &format!("row {marker}"));
                live_journal::append_lines(&journal, &[line]);
            }
        },
        &[(onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "2500")],
    );
    let mut tab = Tab::first(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "node", "node": node }),
    );
    let document = |filter: &str| -> Vec<Value> {
        let full = fresh(
            live.address(),
            &format!("/api/v2/runs/{run}/timeline?scope=node&node={node}{filter}"),
        );
        let mut every: Vec<Value> = Vec::new();
        for span in full["spans"].as_array().expect("spans") {
            for row in span["events"].as_array().into_iter().flatten() {
                if !every.iter().any(|held| held["id"] == row["id"]) {
                    every.push(row.clone());
                }
            }
        }
        every.sort_by_key(|row| {
            (
                row["at"].as_str().unwrap_or_default().to_owned(),
                row["journal_order"].as_u64(),
            )
        });
        every
    };
    let ids = |rows: &[Value]| -> Vec<Value> { rows.iter().map(|row| row["id"].clone()).collect() };
    let every = document("");
    let planned = document("&filter=planner");
    assert!(every.len() > 20, "rows enough to bound");
    assert!(
        !planned.is_empty() && planned.len() < every.len(),
        "a filter that narrows: {} of {}",
        planned.len(),
        every.len()
    );
    let from = every[5]["at"].as_str().expect("a stamp").to_owned();
    let to = every[every.len() - 6]["at"]
        .as_str()
        .expect("a stamp")
        .to_owned();
    let bounded: Vec<Value> = every
        .iter()
        .filter(|row| {
            let at = row["at"].as_str().unwrap_or_default();
            at >= from.as_str() && at <= to.as_str()
        })
        .cloned()
        .collect();
    assert!(bounded.len() < every.len(), "bounds that leave rows out");
    let check = |phase: &str| {
        let (rows, totals) = walk_query(&live, run, &format!("scope=node&node={node}&limit=3"));
        assert_eq!(ids(&rows), ids(&every), "{phase}: every row");
        assert!(
            totals.iter().all(|total| *total == every.len()),
            "{phase}: totals {totals:?}"
        );
        let query = format!("scope=node&node={node}&limit=3&from={from}&to={to}");
        let (rows, totals) = walk_query(&live, run, &query);
        assert_eq!(
            ids(&rows),
            ids(&bounded),
            "{phase}: rows within the bounds, theirs included"
        );
        assert!(
            totals.iter().all(|total| *total == bounded.len()),
            "{phase}: bounded totals {totals:?}"
        );
        let (rows, totals) = walk_query(
            &live,
            run,
            &format!("scope=node&node={node}&limit=3&filter=planner"),
        );
        assert_eq!(ids(&rows), ids(&planned), "{phase}: filtered rows");
        assert!(
            totals.iter().all(|total| *total == planned.len()),
            "{phase}: filtered totals {totals:?}"
        );
    };
    check("before the rest");
    tab.settle_after_first();
    assert_eq!(
        tab.state["visible"]["timeline"]["progress"]["complete"],
        true
    );
    check("after the rest");
}

/// Every row of one page query, oldest first, and the total each page said.
fn walk_query(live: &Live, run: &str, query: &str) -> (Vec<Value>, Vec<usize>) {
    let mut rows: Vec<Value> = Vec::new();
    let mut totals = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut path = format!("/api/v2/runs/{run}/timeline/events?{query}");
        if let Some(cursor) = &cursor {
            path.push_str(&format!("&cursor={cursor}"));
        }
        let page = http::get(live.address(), &path);
        assert_eq!(page.status, 200, "{path}: {}", page.body);
        let page = page.json();
        totals.push(usize::try_from(page["total"].as_u64().expect("a total")).expect("a count"));
        let mut held: Vec<Value> = page["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                let mut row = row.clone();
                row.as_object_mut().expect("a row").remove("span_id");
                row
            })
            .collect();
        held.extend(rows);
        rows = held;
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => return (rows, totals),
        }
    }
}

/// Every row of a node's pages across its spans, newest page first, walked
/// back to the first with a limit far below the node's rows.
fn walk_node_pages(live: &Live, run: &str, node: &str) -> Vec<Value> {
    let mut rows: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut path = format!("/api/v2/runs/{run}/timeline/events?scope=node&node={node}&limit=5");
        if let Some(cursor) = &cursor {
            path.push_str(&format!("&cursor={cursor}"));
        }
        let page = http::get(live.address(), &path);
        assert_eq!(page.status, 200, "{path}: {}", page.body);
        let page = page.json();
        let mut held: Vec<Value> = page["rows"].as_array().expect("rows").clone();
        held.extend(rows);
        rows = held;
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => return rows,
        }
    }
}

fn walk_pages(live: &Live, run: &str, node: &str, span: &str) -> Vec<Value> {
    let mut rows: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut path = format!(
            "/api/v2/runs/{run}/timeline/events?scope=node&node={node}&span={span}&limit=7"
        );
        if let Some(cursor) = &cursor {
            path.push_str(&format!("&cursor={cursor}"));
        }
        let page = http::get(live.address(), &path);
        assert_eq!(page.status, 200, "{path}: {}", page.body);
        let page = page.json();
        let mut held: Vec<Value> = page["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                let mut row = row.clone();
                row.as_object_mut().expect("a row").remove("span_id");
                row
            })
            .collect();
        held.extend(rows);
        rows = held;
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => return rows,
        }
    }
}

#[test]
fn a_page_refuses_what_it_cannot_answer() {
    let run = fixture_run::RUN_ID;
    let live = Live::start(|root| growing_run(root, run));
    let base = format!("/api/v2/runs/{run}/timeline/events");
    for (query, status, code) in [
        ("?scope=node".to_owned(), 422, "invalid_node_id"),
        ("?scope=sideways".to_owned(), 422, "invalid_request"),
        (
            format!("?scope=node&node={}&limit=0", fixture_run::NODE_ID),
            422,
            "invalid_request",
        ),
        (
            format!("?scope=node&node={}&limit=501", fixture_run::NODE_ID),
            422,
            "invalid_request",
        ),
        (
            format!("?scope=node&node={}&cursor=nope", fixture_run::NODE_ID),
            422,
            "invalid_request",
        ),
        (
            format!("?scope=node&node={}&from=yesterday", fixture_run::NODE_ID),
            422,
            "invalid_request",
        ),
        (
            "?scope=node&node=no-such-node".to_owned(),
            404,
            "node_not_found",
        ),
        (
            format!("?scope=node&node={}&span=none", fixture_run::NODE_ID),
            404,
            "span_not_found",
        ),
    ] {
        let answer = http::get(live.address(), &format!("{base}{query}"));
        assert_eq!(answer.status, status, "{query}: {}", answer.body);
        assert_eq!(
            answer.json()["error"]["code"],
            code,
            "{query}: {}",
            answer.body
        );
    }
    let missing = http::get(
        live.address(),
        "/api/v2/runs/run-no-such/timeline/events?scope=run",
    );
    assert_eq!(missing.status, 404);
}

#[test]
fn a_held_nodes_queued_id_is_counted_over_the_whole_store_before_the_rest() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(
        |root| {
            fixture_run::write_held(root, run);
            // Three of the node's records the selective read holds two of, before
            // its hold: the stream's middle one is not kept.
            let journal = root.join(run).join("events.jsonl");
            let extra: String = (1..=3)
                .map(|seq| {
                    format!(
                        "{}\n",
                        json!({
                            "v": 1, "ts": "2026-08-07T12:00:00.500Z", "stream": "extra-stream",
                            "seq": seq, "source": "agentgraph", "kind": "turn-activity",
                            "labels": { "run_id": run, "node": fixture_run::HELD_BEHIND_NODE_ID },
                            "payload": { "kind": "tool_call", "name": "Bash", "detail": "x" },
                            "artifacts": [],
                        })
                    )
                })
                .collect();
            let body = fs::read_to_string(&journal).expect("a journal");
            fs::write(&journal, format!("{extra}{body}")).expect("rewritten");
        },
        &[HOLD],
    );
    let mut tab = Tab::first(
        &live,
        &json!({ "type": "timeline", "run_id": run, "scope": "run" }),
    );
    let queued = |timeline: &Value| -> Vec<String> {
        timeline["spans"]
            .as_array()
            .expect("spans")
            .iter()
            .filter(|span| span["kind"] == "queued")
            .map(|span| span["id"].as_str().expect("an id").to_owned())
            .collect()
    };
    let held = queued(&tab.state["visible"]["timeline"]);
    assert!(!held.is_empty(), "the fixture holds a node");
    let full = fresh(
        live.address(),
        &format!("/api/v2/runs/{run}/timeline?scope=run"),
    );
    assert_eq!(held, queued(&full), "before the rest");
    tab.settle_after_first();
    assert_eq!(
        queued(&tab.state["visible"]["timeline"]),
        held,
        "the rest moves no id"
    );
}

#[test]
fn a_run_still_appending_is_patched_from_the_selective_read_and_publishing_moves_nothing_back() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(|root| growing_run(root, run), &[HOLD]);
    let mut tab = Tab::first(&live, &json!({ "type": "detail", "run_id": run }));
    let journal = live.journal(run);
    let seq = |tab: &Tab| {
        tab.state["visible"]["detail"]["graph"]["last_seq"]
            .as_u64()
            .expect("a seq")
    };
    let before = seq(&tab);
    let line = activity(&journal, run, fixture_run::NODE_ID, "during");
    live_journal::append_lines(&journal, &[line]);
    tab.until_listed("the appended record", |tab| seq(tab) > before);
    assert_eq!(
        tab.state["visible"]["detail"]["progress"]["complete"], false,
        "held"
    );
    let during = seq(&tab);
    tab.settle_after_first();
    assert!(seq(&tab) >= during, "the rest moved nothing back");
    let line = activity(&journal, run, fixture_run::NODE_ID, "after");
    live_journal::append_lines(&journal, &[line]);
    let after = seq(&tab);
    tab.until_listed("the record after the rest", |tab| seq(tab) > after);
    tab.drain();
    same(
        &unstamped(tab.state["visible"]["detail"].clone()),
        &fresh(
            live.address(),
            &format!("/api/v2/runs/{run}?include_conversations=false"),
        ),
        "the detail after the rest",
    );
}

#[test]
fn a_complete_read_that_fails_keeps_the_screen_says_why_and_a_later_tab_retries() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(
        |root| growing_run(root, run),
        &[(onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "1200")],
    );
    let launch = live.serving.run_dir(run).join("launch.json");
    let kept = fs::read(&launch).expect("a launch record");
    let mut tab = Tab::first(&live, &json!({ "type": "detail", "run_id": run }));
    fs::remove_file(&launch).expect("the launch record goes");
    tab.until_listed("the failure", |tab| {
        tab.state["visible"]["detail"]["progress"]["failed"].is_string()
    });
    let progress = tab.state["visible"]["detail"]["progress"].clone();
    assert_eq!(progress["complete"], false);
    assert!(
        tab.state["visible"]["detail"]["graph"]["node_status"].is_object(),
        "the screen stands"
    );
    fs::write(&launch, kept).expect("the launch record back");
    // A later subscription starts the read again.
    let mut retry = Tab::first(&live, &json!({ "type": "detail", "run_id": run }));
    retry.settle_after_first();
    assert!(retry.state["visible"]["detail"]["progress"]
        .get("failed")
        .is_none());
}

#[test]
fn a_channel_view_opens_on_the_first_detail_without_waiting_for_the_rest() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(|root| growing_run(root, run), &[HOLD]);
    let tab = Tab::first(&live, &json!({ "type": "channel", "run_id": run }));
    assert_eq!(tab.state["visible"]["type"], "channel");
    assert_eq!(
        tab.state["visible"]["detail"]["progress"]["complete"],
        false
    );
    assert!(tab.state["visible"]["channel"].is_object());
}

#[test]
fn a_fold_past_its_overdue_point_draws_as_loading_until_it_lands() {
    let run = fixture_run::RUN_ID;
    let live = Live::start_with(
        |root| growing_run(root, run),
        &[
            (onepipeline_ui::live::TELEMETRY_REFOLD_ENV, "100"),
            (onepipeline_ui::live::FOLD_HOLD_ENV, "2500"),
        ],
    );
    let mut tab = Tab::open(&live, &json!({ "type": "detail", "run_id": run }));
    let as_of = tab.state["visible"]["detail"]["telemetry"]["as_of"].clone();
    assert!(as_of.is_string());
    std::thread::sleep(Duration::from_millis(600));
    let line = activity(&live.journal(run), run, fixture_run::NODE_ID, "stale");
    live_journal::append_lines(&live.journal(run), &[line]);
    tab.until_listed("the fold falling overdue", |tab| {
        tab.state["visible"]["detail"]["progress"]["loading"]
            == json!(["telemetry", "run.usage", "run.timing"])
    });
    assert_eq!(tab.state["visible"]["detail"]["progress"]["complete"], true);
    tab.until_listed("the fold landing", |tab| {
        tab.state["visible"]["detail"]["telemetry"]["as_of"] != as_of
    });
    assert_eq!(
        tab.state["visible"]["detail"]["progress"]["loading"],
        json!([])
    );
}

/// The kinds whose payload no first screen reads but in its opened node, as the
/// test states them apart from the server: a long run's first answer fetches every
/// other record whole, every record carrying evidence, and, of a node it is opened
/// on, its latest rows and every record but a heartbeat or a tool call.
const HEADED_KINDS: [&str; 5] = [
    "member-heartbeat",
    "turn-activity",
    "turn-message",
    "turn-started",
    "turn-completed",
];

/// A node's window, as `docs/contract.md` states it.
const NODE_WINDOW: usize = onepipeline_ui::contract::NODE_WINDOW_EVENTS;

/// A first answer's members with the instant each part was read left out, which no
/// two reads share.
fn first_screen_of(subscribed: &Value) -> Value {
    let mut visible = subscribed["initial"]["snapshot"]["visible"].clone();
    for part in ["detail", "timeline"] {
        if let Some(object) = visible.get_mut(part).and_then(Value::as_object_mut) {
            object.remove("observed_at");
        }
    }
    visible
}

/// A stamp `offset_ms` after 13:00 on the fixture's day, in the writers' form.
fn generated_stamp(offset_ms: u64) -> String {
    let (seconds, ms) = (offset_ms / 1000, offset_ms % 1000);
    format!(
        "2026-08-07T{:02}:{:02}:{:02}.{ms:03}Z",
        13 + seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

/// The fixture run, grown past the length a first answer reads whole by records of
/// the kinds a first screen reads only the heads of, each with a payload no other
/// record carries: turns, their messages, tool calls and closes, and heartbeats, on
/// three streams of their own, most of them the fixture node's and the rest its
/// reviewer's, a few carrying evidence. Deterministic, so two roots written by it hold
/// the same journal byte for byte.
fn distinct_long_run(root: &Path, run: &str) {
    distinct_long_run_then(root, run, &[]);
}

/// [`distinct_long_run`], then `after`: lines of the run's own, in the writers' form.
fn distinct_long_run_then(root: &Path, run: &str, after: &[String]) {
    let dir = fixture_run::write(root, run);
    let journal = dir.join("events.jsonl");
    let worker = json!({
        "run_id": run, "node": fixture_run::NODE_ID, "member": "worker",
        "persona": "worker", "session": fixture_run::CONVERSATION_ID,
    });
    let reviewer = json!({
        "run_id": run, "node": fixture_run::REVIEW_NODE_ID, "member": "judge",
        "persona": "judge", "session": fixture_run::REVIEW_CONVERSATION_ID,
    });
    let mut seqs = [0_u64; 3];
    let mut lines = Vec::new();
    for index in 0..1400_u64 {
        let at = generated_stamp(index * 250);
        let lane = usize::try_from(index % 3).expect("a lane");
        seqs[lane] += 1;
        let kind = HEADED_KINDS[usize::try_from(index % 5).expect("a kind")];
        let words = format!("{kind} {index}: {}", "distinct words ".repeat(50));
        let turn = index / 5 + 2;
        let payload = match kind {
            "turn-started" => json!({
                "turn": turn, "role": "worker", "instruction": words, "started_at": at,
            }),
            "turn-message" => json!({ "turn": turn, "role": "worker", "text": words }),
            "turn-activity" => json!({
                "kind": "tool_call", "name": "Bash", "detail": words, "index": index,
            }),
            "turn-completed" => json!({
                "turn": turn, "role": "worker",
                "usage": { "input_tokens": index, "output_tokens": index + 1 },
                "started_at": at, "finished_at": at,
            }),
            _ => json!({ "beat": index, "note": words }),
        };
        let artifacts = if index % 400 == 101 {
            json!([{ "id": format!("artifact-generated-{index}"), "kind": "report", "bytes": 10 }])
        } else {
            json!([])
        };
        let stream = ["generated-a", "generated-b", "generated-c"][lane];
        let labels = if index % 7 == 6 {
            reviewer.clone()
        } else {
            worker.clone()
        };
        lines.push(
            json!({
                "v": 1,
                "ts": at,
                "stream": stream,
                "seq": seqs[lane],
                "source": "agentgraph",
                "kind": kind,
                "labels": labels,
                "payload": payload,
                "artifacts": artifacts,
            })
            .to_string(),
        );
    }
    // Last, one long turn of the node's agent: opened, then more tool calls than its
    // window holds, then its words and close, so a row in the window is numbered among
    // the session's agent turns by records long before it — the generated turns above
    // are the other party's, which only their payloads say.
    let long_turn = 1000;
    let mut at = 1400 * 250;
    let mut long = |kind: &str, payload: Value| {
        at += 250;
        seqs[0] += 1;
        json!({
            "v": 1, "ts": generated_stamp(at), "stream": "generated-a", "seq": seqs[0],
            "source": "agentgraph", "kind": kind, "labels": worker.clone(),
            "payload": payload, "artifacts": [],
        })
        .to_string()
    };
    lines.push(long(
        "turn-started",
        json!({ "turn": long_turn, "role": "assistant", "instruction": "the long turn" }),
    ));
    for call in 0..u64::try_from(NODE_WINDOW + 5).expect("a count") {
        lines.push(long(
            "turn-activity",
            json!({ "kind": "tool_call", "name": "Bash", "detail": format!("long call {call}"), "index": call }),
        ));
    }
    lines.push(long(
        "turn-message",
        json!({ "turn": long_turn, "role": "assistant", "text": "the long turn's words" }),
    ));
    lines.push(long(
        "turn-completed",
        json!({ "turn": long_turn, "role": "assistant", "usage": { "input_tokens": 1 } }),
    ));
    let mut text = fs::read_to_string(&journal).expect("a journal");
    for line in lines.iter().chain(after) {
        text.push_str(line);
        text.push('\n');
    }
    fs::write(&journal, text).expect("the journal");
    live_journal::receipt_for(&journal);
}

/// A `turn-message` of the fixture node's, in the writers' form, whose payload no
/// reader parses: its opening and its artifacts are a record's, and its middle is not.
/// The engine heads it off its opening and answers a fetch of it as moved, and the
/// complete read drops it.
fn unreadable_message(run: &str, artifacts: &str) -> String {
    format!(
        concat!(
            r#"{{"v":1,"ts":"2026-08-07T14:00:00.000Z","stream":"generated-d","seq":1,"#,
            r#""source":"agentgraph","kind":"turn-message","labels":{{"run_id":"{run}","#,
            r#""node":"{node}","member":"worker","persona":"worker","session":"{session}"}},"#,
            r#""payload":{{"turn":9,"role":"worker","text":unquoted}},"artifacts":{artifacts}}}"#,
        ),
        run = run,
        node = fixture_run::NODE_ID,
        session = fixture_run::CONVERSATION_ID,
        artifacts = artifacts,
    )
}

/// Both servers' first answers to `view`, the long run read as its heads by one and
/// whole by the other, each with the line `after` appended, and the first's trace of it.
fn first_answers_over(after: &[String], view: &Value) -> (Value, Value, Value) {
    let run = fixture_run::RUN_ID;
    let hold = (onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "120000");
    let whole_read = u64::MAX.to_string();
    let headed = Live::start_with(|root| distinct_long_run_then(root, run, after), &[hold]);
    let whole = Live::start_with(
        |root| distinct_long_run_then(root, run, after),
        &[hold, (onepipeline_ui::live::WHOLE_READ_ENV, &whole_read)],
    );
    let mine = first_screen_of(&headed.subscribe(&json!({ "view": view })));
    let theirs = first_screen_of(&whole.subscribe(&json!({ "view": view })));
    let traced = headed
        .first_answers()
        .last()
        .cloned()
        .expect("the first answer is traced");
    (mine, theirs, traced)
}

/// Name what differs between two first answers rather than printing both whole.
fn same_first_answer(mine: &Value, theirs: &Value, what: &str) {
    if mine != theirs {
        let mut ops = Vec::new();
        patch::diff(mine, theirs, &mut ops).expect("both answers are objects");
        let ops: Vec<Value> = ops.iter().map(Op::to_json).collect();
        panic!("{what} differs from a whole read's by {ops:#?}");
    }
}

/// What a refresh appends to the long run, in order after what it holds: a
/// repetition of its latest record, as a producer that re-relays one writes it, and
/// a record new to it a second later.
fn appended_to(journal: &Path) -> [String; 2] {
    let text = fs::read_to_string(journal).expect("a journal");
    let held = text.lines().last().expect("a latest record").to_owned();
    let mut fresh: Value = serde_json::from_str(&held).expect("a record");
    let at = time::OffsetDateTime::parse(
        fresh["ts"].as_str().expect("a stamp"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("an RFC 3339 stamp");
    fresh["ts"] = json!((at + time::Duration::seconds(1))
        .format(&time::format_description::well_known::Rfc3339)
        .expect("a stamp"));
    let last_seq = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record["stream"] == fresh["stream"])
        .filter_map(|record| record["seq"].as_u64())
        .max()
        .expect("the stream's sequence");
    fresh["seq"] = json!(last_seq + 1);
    [held, fresh.to_string()]
}

/// A long run opened from its heads tells what a refresh appends as a whole read
/// tells it: a repetition of a record it holds counts once, and a new record once
/// and at its place in the journal, though the heads read gave the records' places
/// and none of their identities. Overall and the appended records' node are held to
/// a whole read of the same journal; the node's rows carry each record's place.
#[test]
fn after_a_heads_read_an_appended_repetition_counts_once_as_a_whole_read_counts_it() {
    let run = fixture_run::RUN_ID;
    let hold = (onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "120000");
    let headed = Live::start_with(|root| distinct_long_run(root, run), &[hold]);
    let journal = headed.journal(run);
    let after = appended_to(&journal);
    let latest: Value = serde_json::from_str(&after[0]).expect("a record");
    let node = latest["labels"]["node"]
        .as_str()
        .expect("the latest record's node");
    let views = [
        json!({ "view": { "type": "timeline", "run_id": run, "scope": "run" } }),
        json!({ "view": { "type": "timeline", "run_id": run, "scope": "node", "node": node } }),
    ];
    for view in &views {
        headed.subscribe(view);
    }
    assert!(
        headed
            .first_answers()
            .iter()
            .any(|traced| traced["heads_ms"].is_number()),
        "the run was not opened from its heads: {:#?}",
        headed.first_answers()
    );
    let mut seen = headed.refreshes().len();
    live_journal::append_lines(&journal, &after);
    let refreshed = headed.next_refresh(run, &mut seen);
    assert_eq!(refreshed["refresh"], "appended", "{refreshed}");
    assert_eq!(refreshed["records"], 2, "{refreshed}");

    let whole_read = u64::MAX.to_string();
    let whole = Live::start_with(
        |root| distinct_long_run_then(root, run, &after),
        &[hold, (onepipeline_ui::live::WHOLE_READ_ENV, &whole_read)],
    );
    // Overall whole; the node by the appended records' rows, since a node's view
    // kept live renders every row and a whole read's first answer its window.
    let [overall, node_view] = &views;
    same_first_answer(
        &first_screen_of(&headed.subscribe(overall))["timeline"],
        &first_screen_of(&whole.subscribe(overall))["timeline"],
        "Overall after a refresh appended a repetition and a new record",
    );
    let fresh: Value = serde_json::from_str(&after[1]).expect("a record");
    let ids = [&latest, &fresh].map(|record| {
        format!(
            "{}.{}",
            record["stream"].as_str().expect("a stream"),
            record["seq"]
        )
    });
    let rows_of = |answer: &Value| -> Vec<(String, Value)> {
        first_screen_of(answer)["timeline"]["spans"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|span| span["events"].as_array().into_iter().flatten())
            .filter_map(|event| {
                let id = event["record_id"].as_str()?;
                ids.iter()
                    .any(|wanted| wanted == id)
                    .then(|| (id.to_owned(), event["journal_order"].clone()))
            })
            .collect()
    };
    let mine = rows_of(&headed.subscribe(node_view));
    // Each record is a row of every span it falls in, and at one place in all of them.
    let places: BTreeMap<&String, std::collections::BTreeSet<String>> =
        mine.iter().fold(BTreeMap::new(), |mut places, (id, at)| {
            places.entry(id).or_default().insert(at.to_string());
            places
        });
    assert!(
        places.len() == 2 && places.values().all(|at| at.len() == 1),
        "each appended record is a row of {node} at one place: {mine:?}"
    );
    assert_eq!(
        mine,
        rows_of(&whole.subscribe(node_view)),
        "{node}'s appended rows"
    );
}

/// A record a first screen reads whole that cannot be fetched — a line rewritten under
/// the heads read, as the engine answers one it headed and cannot read — has the run
/// read whole for that first answer instead, which is then the whole read's.
#[test]
fn a_first_answer_whose_records_cannot_be_fetched_is_read_whole_instead() {
    let evidence = r#"[{"id":"artifact-unreadable","kind":"report","bytes":10}]"#;
    let view = json!({ "type": "detail", "run_id": fixture_run::RUN_ID });
    let (mine, theirs, traced) =
        first_answers_over(&[unreadable_message(fixture_run::RUN_ID, evidence)], &view);
    same_first_answer(
        &mine,
        &theirs,
        "Graph's first answer over an unfetchable record",
    );
    // Read whole: no record was fetched, and none headed.
    assert!(traced["fetched"].is_null(), "{traced}");
    assert!(traced["records"].is_null(), "{traced}");
}

/// A node whose window holds a record that cannot be fetched has its every record read
/// as its share instead, so its first answer is still the whole read's.
#[test]
fn a_nodes_window_that_cannot_be_fetched_is_read_as_its_share_instead() {
    let view = json!({
        "type": "timeline", "run_id": fixture_run::RUN_ID,
        "scope": "node", "node": fixture_run::NODE_ID,
    });
    let (mine, theirs, traced) =
        first_answers_over(&[unreadable_message(fixture_run::RUN_ID, "[]")], &view);
    same_first_answer(
        &mine["timeline"],
        &theirs["timeline"],
        "the node's timeline over an unfetchable record in its window",
    );
    // Its heads were read and their records fetched; the window's fetch was not made.
    assert!(traced["heads_ms"].is_number(), "{traced}");
    assert!(traced["fetched"].is_u64(), "{traced}");
}

/// A page of a node's history asked for before the rest, from a reading opened as the
/// run's heads, whose records include one that cannot be fetched — a line rewritten
/// under the heads read — reads the node's share apart instead, so the page, and the
/// one after it, are the pages a server reading the journal whole serves.
#[test]
fn a_page_before_the_rest_whose_records_cannot_be_fetched_reads_its_share_instead() {
    let run = fixture_run::RUN_ID;
    let node = fixture_run::NODE_ID;
    let hold = (onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "120000");
    let whole_read = u64::MAX.to_string();
    let after = [unreadable_message(run, "[]")];
    let headed = Live::start_with(|root| distinct_long_run_then(root, run, &after), &[hold]);
    let whole = Live::start_with(
        |root| distinct_long_run_then(root, run, &after),
        &[hold, (onepipeline_ui::live::WHOLE_READ_ENV, &whole_read)],
    );
    // Overall reads a turn's message as its head, so this first answer fetches none
    // of the unreadable record.
    let overall = json!({ "view": { "type": "timeline", "run_id": run, "scope": "run" } });
    headed.subscribe(&overall);
    whole.subscribe(&overall);
    let traced = headed
        .first_answers()
        .last()
        .cloned()
        .expect("a first answer");
    assert!(
        traced["heads_ms"].is_number(),
        "read as its heads: {traced}"
    );

    let page = |live: &Live, cursor: Option<&str>| -> Value {
        let mut path = format!("/api/v2/runs/{run}/timeline/events?scope=node&node={node}&limit=3");
        if let Some(cursor) = cursor {
            path.push_str(&format!("&cursor={cursor}"));
        }
        let answer = http::get(live.address(), &path);
        assert_eq!(answer.status, 200, "{path}: {}", answer.body);
        unstamped(answer.json())
    };
    let mine = page(&headed, None);
    let theirs = page(&whole, None);
    same_first_answer(&mine, &theirs, "the node's page over an unfetchable record");
    assert!(!mine["rows"].as_array().expect("rows").is_empty(), "{mine}");
    let next = mine["next_cursor"].as_str().expect("an older page");
    same_first_answer(
        &page(&headed, Some(next)),
        &page(&whole, Some(next)),
        "the node's next page",
    );
}

/// A long run's first answers, Graph's, Overall's and a node's, fetch whole only the
/// records this crate decides a first screen reads, and are the first answers the
/// same server gives when it reads the journal whole first: no value a first screen
/// draws is read from a record it did not fetch.
#[test]
fn a_long_runs_first_answers_fetch_only_what_a_first_screen_reads_and_are_the_whole_reads() {
    let run = fixture_run::RUN_ID;
    let node = fixture_run::NODE_ID;
    // The complete read holds off for the journey's length, so all three views are
    // answered from the one first reading.
    let hold = (onepipeline_ui::live::COMPLETE_READ_HOLD_ENV, "120000");
    let whole_read = u64::MAX.to_string();
    let headed = Live::start_with(|root| distinct_long_run(root, run), &[hold]);
    let whole = Live::start_with(
        |root| distinct_long_run(root, run),
        &[hold, (onepipeline_ui::live::WHOLE_READ_ENV, &whole_read)],
    );
    let journal = headed.journal(run);
    assert!(
        fs::metadata(&journal).expect("a journal").len() > onepipeline_ui::live::WHOLE_READ_BYTES,
        "a journal past a whole read"
    );
    let records: Vec<Value> = fs::read_to_string(&journal)
        .expect("a journal")
        .lines()
        .map(|line| serde_json::from_str(line).expect("a record"))
        .collect();
    let headed_only = |record: &Value| {
        HEADED_KINDS.contains(&record["kind"].as_str().expect("a kind"))
            && record["artifacts"].as_array().is_none_or(Vec::is_empty)
    };
    let read_whole = records.iter().filter(|record| !headed_only(record)).count();
    // The node's latest rows are the generator's last records of it, each later
    // than every record before it.
    let window: Vec<&Value> = records
        .iter()
        .filter(|record| record["labels"]["node"] == node)
        .rev()
        .take(NODE_WINDOW)
        .collect();
    assert!(
        window.iter().all(|record| record["stream"]
            .as_str()
            .is_some_and(|stream| stream.starts_with("generated-"))),
        "the node's window is generated records"
    );
    // And the node's own turns, wherever they lie: its rows are numbered by them.
    let node_headed = ["member-heartbeat", "turn-activity"];
    let window_fetched = records
        .iter()
        .filter(|record| record["labels"]["node"] == node && headed_only(record))
        .filter(|record| {
            window.contains(record)
                || !node_headed.contains(&record["kind"].as_str().expect("a kind"))
        })
        .count();
    assert!(read_whole > 0 && window_fetched > 0);
    assert!(
        records.iter().filter(|record| headed_only(record)).count() > window_fetched,
        "records a first screen reads only the heads of"
    );

    let views = [
        (
            "Graph",
            json!({ "type": "detail", "run_id": run }),
            Some(read_whole),
        ),
        (
            "Overall",
            json!({ "type": "timeline", "run_id": run, "scope": "run" }),
            None,
        ),
        (
            "the node",
            json!({ "type": "timeline", "run_id": run, "scope": "node", "node": node }),
            Some(window_fetched),
        ),
    ];
    for (name, view, fetched) in views {
        let mine = headed.subscribe(&json!({ "view": view }));
        let theirs = whole.subscribe(&json!({ "view": view }));
        let (mine, theirs) = (first_screen_of(&mine), first_screen_of(&theirs));
        if mine != theirs {
            let mut ops = Vec::new();
            patch::diff(&mine, &theirs, &mut ops).expect("both answers are objects");
            let ops: Vec<Value> = ops.iter().map(Op::to_json).collect();
            panic!("{name}'s first answer differs from a whole read's by {ops:#?}");
        }
        let traced = headed.first_answers();
        let traced = traced.last().expect("the first answer is traced");
        assert_eq!(traced["subscribe"], view, "{name}");
        // The reading is opened once, for Graph: Overall fetches nothing more and a
        // node only its window's records.
        assert_eq!(
            traced["fetched"].as_u64().map(|count| count as usize),
            fetched,
            "{name}'s fetch: {traced}"
        );
        if fetched.is_some() {
            assert_eq!(traced["records"], json!(records.len()), "{name}: {traced}");
        }
    }
    // A whole read fetches nothing at all.
    assert!(
        whole
            .first_answers()
            .iter()
            .all(|line| line["fetched"].is_null()),
        "{:#?}",
        whole.first_answers()
    );
}
