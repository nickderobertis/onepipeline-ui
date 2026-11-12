//! The human-item routes, against the real binary and the engine's live
//! runtime.
//!
//! Every journey builds a [`World`]: a runs root, the host-local
//! configuration that enables human items, a `local-md` plan store whose plans
//! are made of `kind: human` steps, a configured design-review phase with its
//! approval authority, and a GitHub board the engine projects every task onto.
//! Runs are launched by the provisioned `onepipeline` CLI of the release this
//! crate links — its own `start`, scheduler and driver — and items are raised,
//! read and resolved through that CLI and through `onepipeline-api serve` over
//! the same runs root, so both surfaces read and write the one journal the
//! engine keeps (`onepipeline::human_items::JOURNAL_PATH`). What the owning
//! session's watch is told is read with `onepipeline human-items watch`.
//!
//! Nothing inside the engine is stood in for. Two processes outside it are:
//! the GitHub board (`tests/support/github_board.py`, a loopback answering the
//! requests onetaskgraph's `github-projects` source sends) and the approval
//! authority a design review completes through, which a host configures as a
//! command and which here is a script keeping the current version of each
//! design document and the approval records it wrote.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use onepipeline::human_items::{HumanItemDetail, HumanItemReceipt, HumanItemState, HumanItemView};
use onepipeline_ui::patch::{self, Op};
use serde_json::{json, Value};
use tempfile::TempDir;

use crate::fixture_run;
use crate::github_board::GitHubBoard;
use crate::http;
use crate::live_journal;
use crate::serving::{Serving, POLL_INTERVAL_FLAG};
use crate::sibling;

/// The plan-store source every journey's plans live in.
const SOURCE: &str = "local";
/// The tracker source every task is projected onto.
const BOARD: &str = "board";
/// The host name task projection is keyed to.
const HOST: &str = "projection-host";
/// The login a CLI acting for a manager acts on behalf of.
const USER: &str = "operator";
/// The phase a design review is raised from.
const DESIGN_REVIEW: &str = "design-review";
/// What the engine refuses a design review whose document changed with.
const REREAD: &str = "Re-read the current document";

/// One step of a plan: a `kind: human` task of the plan store.
struct Step<'a> {
    id: &'a str,
    title: &'a str,
    deps: &'a [&'a str],
    /// The store priority, which the step's item is raised at.
    priority: &'a str,
    /// A question rather than a task, with this body.
    question: Option<&'a str>,
}

const fn step<'a>(id: &'a str, title: &'a str, deps: &'a [&'a str]) -> Step<'a> {
    Step {
        id,
        title,
        deps,
        priority: "low",
        question: None,
    }
}

/// A host whose human items are enabled, with a plan store, a tracker and an
/// approval authority of its own.
struct World {
    dir: TempDir,
    root: PathBuf,
    board: GitHubBoard,
}

impl World {
    fn new() -> Self {
        Self::configured(true)
    }

    /// A world whose configuration enables human items only when `enabled`.
    fn configured(enabled: bool) -> Self {
        let (dir, root) = fixture_run::workspace();
        let base = dir.path().to_path_buf();
        // llmlint: ignore[e2e_not_mocked] GitHub is the external tracker these journeys may double; the loopback answers only the requests the github-projects source sends, and everything of onepipeline under test is real.
        let board = GitHubBoard::start(&base);
        let config = base.join("config");
        std::fs::create_dir_all(config.join("onepipeline")).expect("config dir");
        std::fs::create_dir_all(config.join("onetaskgraph")).expect("config dir");
        std::fs::create_dir_all(base.join("intents")).expect("intents dir");
        std::fs::create_dir_all(base.join("work")).expect("work dir");
        std::fs::write(base.join("design-keys.json"), "{}").expect("keys");
        let adapter = Path::new(env!("CARGO_MANIFEST_DIR")).join(APPROVAL_AUTHORITY);
        std::fs::write(
            config.join("onepipeline/config.yaml"),
            format!(
                "human_items:\n  enabled: {enabled}\n  task_source: {BOARD}\n  \
                 approval_adapters:\n    approve-design:\n      command: [\"python3\", {adapter:?}, \
                 {keys:?}, {log:?}]\n      undo: [\"python3\", {adapter:?}, \"--undo\", \
                 {keys:?}, {log:?}]\n  hooks:\n    - phase: {DESIGN_REVIEW}\n      kind: task\n      \
                 title: \"Review {{{{ document }}}}\"\n      body: \"Read {{{{ document }}}} as it \
                 stands and approve it, or say what to change.\"\n      priority: high\n      \
                 block: {{scope: nothing}}\n      approval: {{adapter: approve-design}}\n",
                adapter = adapter.display().to_string(),
                keys = base.join("design-keys.json").display().to_string(),
                log = base.join("approvals.ndjson").display().to_string(),
            ),
        )
        .expect("the human-items configuration");
        std::fs::write(
            config.join("onetaskgraph/config.yaml"),
            format!(
                "sources:\n  {SOURCE}:\n    plugin: local-md\n    config:\n      root: {store:?}\n  \
                 {BOARD}:\n    plugin: github-projects\n    task_projection:\n      host: {HOST}\n      \
                 directory: {intents:?}\n      project: plan\n    config:\n      owner: generic\n      \
                 project_number: 1\n      repository: generic/approval\n      token_env: \
                 CACHE_BOARD_TOKEN\n      endpoint: {endpoint}/graphql\n      status_mapping:\n        \
                 todo: Todo\n        queued: Queued\n        in-progress: In Progress\n        \
                 unknown: Needs Attention\n        done: Done\n        cancelled: Canceled\n      \
                 priority_mapping:\n        urgent: Urgent\n        high: High\n        medium: \
                 Medium\n        low: Low\n",
                store = base.join("plan-store").display().to_string(),
                intents = base.join("intents").display().to_string(),
                endpoint = board.url,
            ),
        )
        .expect("the plan-store configuration");
        std::fs::write(
            base.join("node-scope.yaml"),
            "version: 1\nname: node-scope\nmembers:\n  worker:\n    kind: oneharness\n    \
             oneharness_config: ./child.toml\n",
        )
        .expect("the node graph");
        Self { dir, root, board }
    }

    fn base(&self) -> &Path {
        self.dir.path()
    }

    /// The environment every process of this world runs in: its runs root,
    /// its configuration and state, its tracker's credential and host name —
    /// and an agent graph that refuses, so no step of any run here can reach a
    /// model however its holds resolve.
    fn environment(&self) -> Vec<(String, String)> {
        let base = self.base();
        vec![
            (
                "XDG_CONFIG_HOME".into(),
                base.join("config").display().to_string(),
            ),
            (
                "XDG_STATE_HOME".into(),
                base.join("state").display().to_string(),
            ),
            ("CACHE_BOARD_TOKEN".into(), self.board.token.clone()),
            ("HOSTNAME".into(), HOST.into()),
            ("USER".into(), USER.into()),
            (
                "ONEPIPELINE_NODE_GRAPH".into(),
                base.join("node-scope.yaml").display().to_string(),
            ),
            ("ONEPIPELINE_ONEAGENTGRAPH_BIN".into(), "false".into()),
            (
                onepipeline_ui::store::GRAPH_RECORDS_ENV.into(),
                fixture_run::graph_records_for(&self.root)
                    .display()
                    .to_string(),
            ),
        ]
    }

    /// What this suite's own environment carries that would reach past this
    /// world: the dispatch's plan-store sources and its host configuration.
    fn foreign() -> Vec<String> {
        std::env::vars_os()
            .filter_map(|(name, _)| name.into_string().ok())
            .filter(|name| name.starts_with("ONETASKGRAPH_"))
            .chain(["ONEPIPELINE_CONFIG".to_owned()])
            .collect()
    }

    /// `onepipeline ARGS…` in this world, as `session` — a manager session
    /// acting on the user's behalf — or as the user directly for `None`.
    fn cli(&self, session: Option<&str>, arguments: &[&str]) -> Output {
        let mut command = Command::new(sibling::binary());
        command
            .args(arguments)
            .current_dir(self.base().join("work"))
            .env(onepipeline_ui::store::RUNS_DIR_ENV, &self.root)
            .env_remove(onepipeline_ui::cli::SESSION_ENV)
            .env_remove(onepipeline::cli::WAKE_BUDGET_ENV)
            .envs(self.environment());
        for name in Self::foreign() {
            command.env_remove(name);
        }
        if let Some(session) = session {
            command.env(onepipeline_ui::cli::SESSION_ENV, session);
        }
        command
            .output()
            .expect("the provisioned onepipeline starts")
    }

    /// The same, which must succeed; answers what it printed.
    fn ok(&self, session: Option<&str>, arguments: &[&str]) -> String {
        let output = self.cli(session, arguments);
        assert!(
            output.status.success(),
            "`onepipeline {}` failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("utf-8 output")
    }

    fn json(&self, session: Option<&str>, arguments: &[&str]) -> Value {
        let printed = self.ok(session, arguments);
        serde_json::from_str(&printed).unwrap_or_else(|err| panic!("{err}: printed {printed}"))
    }

    /// Every item `human-items list --json ARGS…` selects.
    fn listed(&self, arguments: &[&str]) -> Vec<Value> {
        let mut all = vec!["human-items", "list", "--json"];
        all.extend_from_slice(arguments);
        match self.json(None, &all) {
            Value::Array(views) => views,
            other => panic!("the CLI listed {other}"),
        }
    }

    /// The item `id` as the journal now holds it, whatever its state.
    fn stored(&self, id: &str) -> Value {
        self.json(None, &["human-items", "show", id, "--json"])["item"].clone()
    }

    /// Raise `input` through the CLI as `session`; answers the item's id.
    fn raise(&self, session: &str, input: &Value) -> String {
        let path = self.base().join(format!(
            "raise-{}.json",
            input["dedup_key"].as_str().expect("a dedup key")
        ));
        std::fs::write(&path, input.to_string()).expect("the raise input");
        let receipt = self.json(
            Some(session),
            &[
                "human-items",
                "raise",
                "--input",
                path.to_str().expect("utf-8"),
            ],
        );
        receipt["item"]["item"]["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    /// Raise a design review of `document` at `version` as `session`, through
    /// the configured phase; answers the task's id.
    fn raise_design(&self, session: &str, document: &str, version: &str) -> String {
        self.set_version(document, version);
        let path = self.base().join(format!("design-{}.json", slug(document)));
        std::fs::write(
            &path,
            json!({
                "owner": {"session": session, "run": null, "plan": null},
                "dedup_key": slug(document),
                "vars": {"document": document},
                "approval": {"board_copy": document, "key": version},
            })
            .to_string(),
        )
        .expect("the phase context");
        let receipt = self.json(
            Some(session),
            &[
                "human-items",
                "raise",
                "--phase",
                DESIGN_REVIEW,
                "--context",
                path.to_str().expect("utf-8"),
            ],
        );
        receipt["item"]["item"]["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    /// The version of `document` the approval authority holds as current.
    fn set_version(&self, document: &str, version: &str) {
        let path = self.base().join("design-keys.json");
        let mut keys: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("keys")).expect("keys");
        keys[document] = json!(version);
        std::fs::write(&path, keys.to_string()).expect("keys");
    }

    /// Every approval record the authority wrote, in order.
    fn approvals(&self) -> Vec<Value> {
        std::fs::read_to_string(self.base().join("approvals.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("an approval record"))
            .collect()
    }

    /// The item events delivered to `session` that its watch had not printed.
    fn watch(&self, session: &str) -> Vec<Value> {
        let output = self.cli(None, &["human-items", "watch", "--session", session]);
        // Nothing pending is the watch's own "elapsed" exit, and is no failure.
        assert!(
            output.status.success() || output.status.code() == Some(5),
            "the watch of {session} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|line| serde_json::from_str(line).expect("a delivered envelope"))
            .collect()
    }

    /// Write plan `name` into the plan store: its steps, in the order given.
    fn plan(&self, name: &str, steps: &[Step<'_>]) -> String {
        let store = self.base().join("plan-store");
        write_document(
            &store.join("projects").join(format!("{name}.md")),
            &[
                ("title", json!(name)),
                (
                    "metadata",
                    json!({
                        "onepipeline.schema_version": 2,
                        "onepipeline.goal": {"text": format!("Deliver {name}")},
                        "onepipeline.concurrency": 4,
                    }),
                ),
            ],
            "",
        );
        for (index, step) in steps.iter().enumerate() {
            let mut metadata = json!({"onepipeline.id": step.id, "onepipeline.kind": "human"});
            if let Some(body) = step.question {
                metadata["onepipeline.human_item"] = json!({
                    "kind": "question",
                    "priority": step.priority,
                    "title": step.title,
                    "body": body,
                });
            }
            let deps: Vec<Value> = step
                .deps
                .iter()
                .map(|dep| {
                    let at = steps
                        .iter()
                        .position(|other| other.id == *dep)
                        .expect("a dependency names a step of the plan");
                    json!(format!("{name}/{at:03}-{dep}"))
                })
                .collect();
            let mut front = vec![
                ("title", json!(step.title)),
                ("project", json!(name)),
                ("priority", json!(step.priority)),
            ];
            if !deps.is_empty() {
                front.push(("depends_on", json!(deps)));
            }
            front.push(("metadata", metadata));
            write_document(
                &store
                    .join("tasks")
                    .join(name)
                    .join(format!("{index:03}-{}.md", step.id)),
                &front,
                &format!("Do {}.", step.id),
            );
        }
        format!("{SOURCE}:{name}")
    }

    /// Launch `plan` as `session` with the engine's own `start`, driving it
    /// until nothing more can happen without a person; answers the run id.
    fn start(&self, session: &str, plan: &str) -> String {
        let printed = self.ok(Some(session), &["start", plan, "--attach"]);
        let last = printed
            .lines()
            .rev()
            .find(|line| line.starts_with('{'))
            .unwrap_or_else(|| panic!("`start` printed no settlement: {printed}"));
        serde_json::from_str::<Value>(last).expect("the settlement")["run_id"]
            .as_str()
            .expect("a run id")
            .to_owned()
    }

    /// The run journal's records of `kind`.
    fn events_of(&self, run: &str, kind: &str) -> Vec<Value> {
        std::fs::read_to_string(self.root.join(run).join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|event| event["kind"] == kind)
            .collect()
    }

    /// A server over this world's runs root, acting as `session`.
    fn serve(&self, session: Option<&str>) -> Serving {
        let (served, _) = self.workspace_view();
        let environment = self.environment();
        let environment: Vec<(&str, &str)> = environment
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        match session {
            Some(session) => Serving::start_in_as_with_env_removing(
                served,
                session,
                &environment,
                &Self::foreign(),
            ),
            None => Serving::start_in_with_env_removing(served, &environment, &Self::foreign()),
        }
    }

    /// A server over this world's runs root, acting as `session`, whose poll
    /// never comes round again once a journey is under way: what such a server
    /// shows of a later write it read for some other reason.
    fn serve_without_polling(&self, session: &str) -> Serving {
        let (served, _) = self.workspace_view();
        let environment = self.environment();
        let environment: Vec<(&str, &str)> = environment
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        Serving::start_in_as_with_env_removing_and_args(
            served,
            session,
            &environment,
            &Self::foreign(),
            &[POLL_INTERVAL_FLAG, "3600000"],
        )
    }

    /// A workspace a [`Serving`] may own whose runs root, configuration and
    /// graph records are this world's, so several servers — one per session —
    /// read and write the one journal while the world outlives each of them.
    fn workspace_view(&self) -> (TempDir, PathBuf) {
        let served = tempfile::tempdir().expect("temp dir");
        for name in [
            fixture_run::RUNS_DIR,
            "config",
            fixture_run::GRAPH_RECORDS_DIR,
        ] {
            let target = self.base().join(name);
            std::fs::create_dir_all(&target).expect("the shared directory");
            std::os::unix::fs::symlink(&target, served.path().join(name))
                .expect("link the shared directory");
        }
        let runs = served.path().join(fixture_run::RUNS_DIR);
        (served, runs)
    }
}

/// The approval authority a design review completes through, configured as a
/// host configures its own command: it keeps the current version of each
/// document and appends every approval it records (its header says how).
const APPROVAL_AUTHORITY: &str = "tests/support/approval_authority.py";

/// The approval authority run as the engine runs it, `request` on stdin.
fn authorize(versions: &Path, log: &Path, request: &str) -> Output {
    use std::io::Write;
    let mut child = Command::new("python3")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join(APPROVAL_AUTHORITY))
        .args([versions, log])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the approval authority starts");
    child
        .stdin
        .take()
        .expect("its stdin")
        .write_all(request.as_bytes())
        .expect("send the request");
    child
        .wait_with_output()
        .expect("the approval authority ends")
}

/// The authority the journeys configure records only what the engine's request
/// shape can mean: a request or versions file of any other shape is refused
/// before anything is recorded, and a well-formed one is recorded once.
#[test]
fn the_configured_approval_authority_refuses_input_of_any_other_shape() {
    let dir = TempDir::new().expect("authority workspace");
    let versions = dir.path().join("versions.json");
    let log = dir.path().join("approvals.ndjson");
    std::fs::write(&versions, r#"{"docs/a.md": "v1"}"#).expect("versions");
    let good = json!({"board_copy": "docs/a.md", "key": "v1", "actor": "s", "on_behalf_of": null});
    for refused in [
        "not json".to_owned(),
        json!(["docs/a.md"]).to_string(),
        json!({"board_copy": "docs/a.md", "key": "v1", "actor": "s"}).to_string(),
        json!({"board_copy": "docs/a.md", "key": "v1", "actor": "s", "on_behalf_of": null, "x": 1})
            .to_string(),
        json!({"board_copy": "docs/a.md", "key": 1, "actor": "s", "on_behalf_of": null})
            .to_string(),
        json!({"board_copy": "docs/a.md", "key": "v1", "actor": "", "on_behalf_of": null})
            .to_string(),
        json!({"board_copy": "docs/a.md", "key": "v1", "actor": "s", "on_behalf_of": 7})
            .to_string(),
    ] {
        let output = authorize(&versions, &log, &refused);
        assert_eq!(output.status.code(), Some(2), "{refused}");
        assert!(
            String::from_utf8_lossy(&output.stderr).starts_with("approval_authority: "),
            "{refused}"
        );
        assert!(!log.exists(), "{refused}: nothing is recorded");
    }
    std::fs::write(&versions, r#"{"docs/a.md": ["v1"]}"#).expect("versions");
    let output = authorize(&versions, &log, &good.to_string());
    assert_eq!(
        output.status.code(),
        Some(2),
        "a version that is not a string"
    );
    assert!(!log.exists());
    std::fs::write(&versions, r#"{"docs/a.md": "v1"}"#).expect("versions");
    let output = authorize(&versions, &log, &good.to_string());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).expect("its answer"),
        json!({"board_copy": "docs/a.md", "key": "v1"})
    );
    let recorded = std::fs::read_to_string(&log).expect("the record");
    assert_eq!(recorded.lines().count(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(recorded.trim()).expect("a record"),
        good
    );
}

fn slug(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Write a plan-store document the way an operator writes one by hand: YAML
/// front matter whose values are JSON flow scalars, and a body.
fn write_document(path: &Path, front: &[(&str, Value)], body: &str) {
    std::fs::create_dir_all(path.parent().expect("a directory")).expect("a store directory");
    let mut document = String::from("---\n");
    for (key, value) in front {
        match value.as_object() {
            Some(entries) => {
                document.push_str(&format!("{key}:\n"));
                for (entry, value) in entries {
                    document.push_str(&format!("  {entry}: {value}\n"));
                }
            }
            None => document.push_str(&format!("{key}: {value}\n")),
        }
    }
    document.push_str(&format!("---\n\n{body}\n"));
    std::fs::write(path, document).expect("a store document");
}

/// A raise input owned by `session`.
fn input(session: &str, dedup: &str, kind: &str, priority: &str, block: Value) -> Value {
    let (run, plan) = match &block {
        Value::Object(held) if held["scope"] == "work" => {
            (held.get("run").cloned().unwrap_or(Value::Null), Value::Null)
        }
        Value::Object(held) if held["scope"] == "plan" => (Value::Null, held["plan"].clone()),
        _ => (Value::Null, Value::Null),
    };
    json!({
        "schema_version": 1,
        "dedup_key": dedup,
        "kind": kind,
        "title": if kind == "question" { format!("Should {dedup} go ahead?") } else { format!("Settle {dedup}") },
        "body": format!("What {dedup} needs from a person, and nothing more."),
        "priority": priority,
        "owner": {"session": session, "run": run, "plan": plan},
        "block": block,
        "approval": null,
    })
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

/// The `(kind, item_id)` of every delivered envelope.
fn delivered(events: &[Value]) -> Vec<(String, String)> {
    events
        .iter()
        .map(|event| {
            (
                event["kind"].as_str().expect("a kind").to_owned(),
                event["payload"]["item_id"]
                    .as_str()
                    .expect("an item")
                    .to_owned(),
            )
        })
        .collect()
}

const WIRE_ORDER: [&str; 4] = ["urgent", "high", "medium", "low"];

/// Whether `views` are in the engine's declared order: blocking first, then
/// urgent, high, medium and low.
fn in_declared_order(views: &[Value]) -> bool {
    let rank = |view: &Value| {
        let blocking =
            view["item"]["state"] == "open" && view["item"]["block"]["scope"] != "nothing";
        let priority = WIRE_ORDER
            .iter()
            .position(|p| view["item"]["priority"] == *p)
            .expect("a wire priority");
        (!blocking, priority)
    };
    views
        .windows(2)
        .all(|pair| rank(&pair[0]) <= rank(&pair[1]))
}

/// The ten manager sessions the queue is raised across.
fn sessions() -> Vec<String> {
    (0..10).map(|n| format!("manager-{n}")).collect()
}

/// The plan every queue journey launches: one human gate holding four steps,
/// and a second, independent branch.
fn release_plan(world: &World, name: &str) -> String {
    world.plan(
        name,
        &[
            Step {
                priority: "high",
                ..step("gate", "Approve the release", &[])
            },
            step("build", "Build the release", &["gate"]),
            step("test", "Test the release", &["build"]),
            step("lint", "Lint the release", &["gate"]),
            step("docs", "Document the release", &["gate"]),
            Step {
                priority: "medium",
                question: Some("Pick the region the canary runs in; it decides who sees it first."),
                ..step("region", "Which region should the canary run in?", &[])
            },
            step("deploy", "Deploy the canary", &["region"]),
            step("verify", "Verify the canary", &["deploy"]),
        ],
    )
}

/// Ten sessions each raise a task and a question; one launches a real run
/// whose human steps the engine raises itself. Every session's server lists
/// exactly what the CLI selects for that session, in the engine's declared
/// order, and each session's watch was told of its own items and no other's.
#[test]
fn a_queue_raised_across_ten_sessions_is_served_host_wide_in_the_engines_order() {
    let world = World::new();
    let sessions = sessions();
    let plan = release_plan(&world, "release");
    let run = world.start(&sessions[0], &plan);
    let blocks = [
        json!({"scope": "host"}),
        json!({"scope": "plan", "plan": plan}),
        json!({"scope": "work", "run": run, "node": "test"}),
        json!({"scope": "nothing"}),
    ];
    for (n, session) in sessions.iter().enumerate() {
        world.raise(
            session,
            &input(
                session,
                &format!("task-{n}"),
                "task",
                WIRE_ORDER[n % 4],
                blocks[n % 4].clone(),
            ),
        );
        world.raise(
            session,
            &input(
                session,
                &format!("question-{n}"),
                "question",
                WIRE_ORDER[(n + 1) % 4],
                blocks[(n + 2) % 4].clone(),
            ),
        );
    }
    let everything = world.listed(&[]);
    // Two per session, and the run's two eligible human steps.
    assert_eq!(everything.len(), 22, "{everything:#?}");
    assert!(in_declared_order(&everything), "{:#?}", ids(&everything));
    for view in &everything {
        serde_json::from_value::<HumanItemView>(view.clone()).expect("the engine's view");
    }

    for session in &sessions {
        let server = world.serve(Some(session));
        let served = items(&http::get(server.address, "/api/human-items"));
        let selected = world.listed(&["--session", session]);
        assert_eq!(served, everything, "{session} sees the entire host queue");
        assert!(in_declared_order(&served), "{:#?}", ids(&served));
        let kinds: Vec<&str> = served
            .iter()
            .map(|v| v["item"]["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"task") && kinds.contains(&"question"),
            "{kinds:?}"
        );
        let mut told: Vec<String> = delivered(&world.watch(session))
            .into_iter()
            .map(|(kind, id)| {
                assert_eq!(kind, "human-item-raised");
                id
            })
            .collect();
        told.sort();
        // A run's human step is raised again — with its derived impact — as
        // its run is driven; it is still one item, told to its owner alone.
        told.dedup();
        let mut owned = ids(&selected);
        owned.sort();
        assert_eq!(
            told, owned,
            "{session}'s watch was told of its own raises and nothing else"
        );
    }
}

/// Mixed holds: the run's gate holds its four downstream steps, the region
/// question its two, a plan hold every undispatched step of the plan and a
/// host hold everything — each counted per plan without repeats, previewed to
/// three, and drilled into in full, exactly as `human-items show` shows them.
#[test]
fn blocked_steps_are_counted_previewed_and_enumerated_as_the_engine_derives_them() {
    let world = World::new();
    let owner = "manager-holds";
    let plan = release_plan(&world, "holds");
    let run = world.start(owner, &plan);
    let host = world.raise(
        owner,
        &input(owner, "outage", "task", "urgent", json!({"scope": "host"})),
    );
    let freeze = world.raise(
        owner,
        &input(
            owner,
            "freeze",
            "question",
            "low",
            json!({"scope": "plan", "plan": plan}),
        ),
    );
    let server = world.serve(Some(owner));
    let served = items(&http::get(server.address, "/api/human-items"));
    assert_eq!(served, world.listed(&[]));
    let view = |id: &str| {
        served
            .iter()
            .find(|v| v["item"]["id"] == id)
            .expect("listed")
            .clone()
    };
    let by_node = |node: &str| {
        served
            .iter()
            .find(|v| v["item"]["dedup_key"] == format!("run:{run}#{node}"))
            .unwrap_or_else(|| panic!("no item for {node}: {served:#?}"))
            .clone()
    };

    let gate = by_node("gate");
    assert_eq!(
        gate["item"]["block"],
        json!({"scope": "work", "run": run, "node": "gate"})
    );
    assert_eq!(gate["blocked"]["total"], 4);
    assert_eq!(gate["blocked"]["plans"][0]["plan"], plan.as_str());
    assert_eq!(gate["blocked"]["plans"][0]["count"], 4);
    let preview: Vec<&str> = gate["blocked"]["plans"][0]["preview"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["node"].as_str().unwrap())
        .collect();
    assert_eq!(
        preview,
        ["build", "test", "lint"],
        "the first three in plan order"
    );
    let region = by_node("region");
    assert_eq!(region["item"]["kind"], "question");
    assert_eq!(region["blocked"]["total"], 2);

    // A plan hold and a host hold each name every undispatched step once.
    for id in [&host, &freeze] {
        let held = view(id);
        assert_eq!(held["blocked"]["total"], 8, "{held}");
        assert_eq!(held["blocked"]["plans"].as_array().unwrap().len(), 1);
    }

    for (id, count) in [(id_of(&gate), 4), (id_of(&region), 2), (host.clone(), 8)] {
        let response = http::get(server.address, &format!("/api/human-items/{id}"));
        assert_eq!(response.status, 200, "{}", response.body);
        let detail = response.json();
        serde_json::from_value::<HumanItemDetail>(detail.clone()).expect("the engine's detail");
        assert_eq!(
            detail,
            world.json(None, &["human-items", "show", &id, "--json"])
        );
        assert_eq!(detail["nodes"].as_array().unwrap().len(), count, "{detail}");
        let mut nodes: Vec<&str> = detail["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["node"].as_str().unwrap())
            .collect();
        nodes.dedup();
        assert_eq!(nodes.len(), count, "no step is enumerated twice");
    }

    // The words a person reads: every blocking item says what it blocks.
    let report = world.ok(None, &["human-items", "report"]);
    assert!(report.contains("blocks all work on this host"), "{report}");
    assert!(
        report.contains(&format!("blocks all of {plan}")),
        "{report}"
    );
    assert!(
        report.contains(&format!("blocks 4 steps in {plan}")),
        "{report}"
    );
}

fn id_of(view: &Value) -> String {
    view["item"]["id"].as_str().expect("an id").to_owned()
}

/// Every selector the route accepts selects what the CLI's `list` selects,
/// because both are the engine's own `HumanItemFilter`.
#[test]
fn every_filter_selects_what_the_cli_selects() {
    let world = World::new();
    let owner = "manager-filters";
    let plan = release_plan(&world, "filters");
    let run = world.start(owner, &plan);
    world.raise(
        owner,
        &input(owner, "outage", "task", "urgent", json!({"scope": "host"})),
    );
    world.raise(
        owner,
        &input(
            owner,
            "freeze",
            "question",
            "low",
            json!({"scope": "plan", "plan": plan}),
        ),
    );
    let cache = world.raise(
        owner,
        &input(
            owner,
            "cache",
            "question",
            "medium",
            json!({"scope": "nothing"}),
        ),
    );
    let export = world.raise(
        owner,
        &input(owner, "export", "task", "low", json!({"scope": "nothing"})),
    );
    world.ok(
        Some(owner),
        &["human-items", "answer", &cache, "--text", "Reuse it."],
    );
    world.ok(Some(owner), &["human-items", "dismiss", &export]);
    world.raise(
        "another-owner",
        &input(
            "another-owner",
            "foreign-filter",
            "task",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    let server = world.serve(Some("foreign-filter-reader"));
    for (query, arguments) in [
        ("", vec![]),
        ("kind=task", vec!["--kind", "task"]),
        ("kind=question", vec!["--kind", "question"]),
        ("blocking=true", vec!["--blocking", "yes"]),
        ("blocking=false", vec!["--blocking", "no"]),
        ("priority=urgent", vec!["--priority", "Critical"]),
        ("priority=high", vec!["--priority", "high"]),
        ("priority=medium", vec!["--priority", "MEDIUM"]),
        ("priority=low", vec!["--priority", "Low"]),
        ("state=answered", vec!["--state", "answered"]),
        ("state=dismissed", vec!["--state", "dismissed"]),
        ("state=completed", vec!["--state", "completed"]),
        ("host=true", vec!["--host"]),
        ("host=false", vec!["--host", "false"]),
    ] {
        let served = items(&http::get(
            server.address,
            &format!("/api/human-items?{query}"),
        ));
        assert_eq!(served, world.listed(&arguments), "?{query}");
    }
    let plan_query = format!("plan={plan}");
    let run_query = format!("run={run}");
    let session_query = format!("session={owner}");
    for (query, arguments) in [
        (plan_query.as_str(), vec!["--plan", plan.as_str()]),
        (run_query.as_str(), vec!["--run", run.as_str()]),
        (session_query.as_str(), vec!["--session", owner]),
    ] {
        let served = items(&http::get(
            server.address,
            &format!("/api/human-items?{query}"),
        ));
        assert!(!served.is_empty(), "?{query} selects something");
        assert_eq!(served, world.listed(&arguments), "?{query}");
    }
    let urgent = items(&http::get(
        server.address,
        "/api/human-items?priority=urgent",
    ));
    assert!(urgent.iter().all(|v| v["item"]["priority"] == "urgent") && !urgent.is_empty());
    for refused in [
        "/api/human-items?scope=host",
        "/api/human-items?priority=critical",
        "/api/human-items?owner_ended=true",
    ] {
        error(&http::get(server.address, refused), 422, "invalid_request");
    }
}

/// Answer, complete, and dismiss with and without a reason, each made through
/// the route: one durable write each, as the acting session with nobody acted
/// for, the engine's receipt, the journal's state, and a resolution delivered
/// to the owning session's watch alone. Submitted again, an action answers the
/// same receipt and writes nothing, while any other resolution of the resolved
/// item is the engine's conflict; an action of the wrong kind is refused and
/// changes nothing.
#[test]
fn every_action_through_the_route_resolves_once_and_reaches_only_its_owners_watch() {
    let world = World::new();
    let owner = "manager-acts";
    let other = "manager-watches";
    let question = world.raise(
        owner,
        &input(
            owner,
            "region",
            "question",
            "high",
            json!({"scope": "nothing"}),
        ),
    );
    let task = world.raise(
        owner,
        &input(owner, "rotate", "task", "medium", json!({"scope": "host"})),
    );
    let reasoned = world.raise(
        owner,
        &input(owner, "legacy", "task", "low", json!({"scope": "nothing"})),
    );
    let bare = world.raise(
        owner,
        &input(
            owner,
            "nightly",
            "question",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    let theirs = world.raise(
        other,
        &input(
            other,
            "theirs",
            "question",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    world.watch(owner);
    world.watch(other);
    let server = world.serve(Some(owner));
    let post = |id: &str, verb: &str, body: &str| {
        http::post(
            server.address,
            &format!("/api/human-items/{id}/{verb}"),
            body,
        )
    };

    // The wrong kind is refused before anything is written.
    let before = world.stored(&task);
    assert!(error(
        &post(&task, "answer", r#"{"text":"x"}"#),
        409,
        "human_item_conflict"
    )
    .contains("cannot be answered"));
    assert!(error(
        &post(&question, "complete", "{}"),
        409,
        "human_item_conflict"
    )
    .contains("question"));
    assert_eq!(world.stored(&task), before);
    assert_eq!(world.stored(&question)["state"], "open");

    let cases = [
        (
            &question,
            "answer",
            r#"{"text":"eu-west"}"#,
            "answered",
            json!("eu-west"),
            Value::Null,
        ),
        (
            &task,
            "complete",
            "{}",
            "completed",
            Value::Null,
            Value::Null,
        ),
        (
            &reasoned,
            "dismiss",
            r#"{"reason":"Superseded by the new export"}"#,
            "dismissed",
            Value::Null,
            json!("Superseded by the new export"),
        ),
        (&bare, "dismiss", "", "dismissed", Value::Null, Value::Null),
    ];
    let mut expected = Vec::new();
    for (id, verb, body, state, text, reason) in cases {
        let response = post(id, verb, body);
        assert_eq!(response.status, 200, "{verb}: {}", response.body);
        let receipt: HumanItemReceipt =
            serde_json::from_value(response.json()).expect("the engine's receipt");
        assert_eq!(receipt.item.item.id, *id);
        let stored = world.stored(id);
        assert_eq!(stored["state"], state);
        assert_eq!(
            stored["resolution"],
            json!({"actor": format!("browser:session:{owner}"), "on_behalf_of": null, "text": text, "reason": reason, "provenance": "user"}),
            "{verb} is a press in the browser through the acting session, on nobody's behalf, in the user's words"
        );
        assert_eq!(serde_json::to_value(&receipt.item.item).unwrap(), stored);
        let kind = match verb {
            "answer" => "human-item-answered",
            "complete" => "human-item-completed",
            _ => "human-item-dismissed",
        };
        expected.push((kind.to_owned(), (*id).clone()));
        // Submitted again — a double click, a retried request — it answers the
        // same receipt and writes nothing; any other resolution of it is the
        // engine's conflict, and writes nothing either.
        let journal =
            std::fs::read_to_string(world.root.join(onepipeline::human_items::JOURNAL_PATH))
                .unwrap();
        let repeated = post(id, verb, body);
        assert_eq!(repeated.status, 200, "{}", repeated.body);
        assert_eq!(repeated.json()["event_id"], json!(receipt.event_id));
        let (other, other_body) = if verb == "dismiss" {
            ("complete", "{}")
        } else {
            ("dismiss", "{}")
        };
        error(&post(id, other, other_body), 409, "human_item_conflict");
        assert_eq!(
            std::fs::read_to_string(world.root.join(onepipeline::human_items::JOURNAL_PATH))
                .unwrap(),
            journal
        );
    }
    assert_eq!(
        delivered(&world.watch(owner)),
        expected,
        "each resolution reached its owner once"
    );
    assert!(
        world.watch(other).is_empty(),
        "another session's watch hears none of it"
    );
    assert_eq!(world.stored(&theirs)["state"], "open");
    // A blank answer is refused as the engine refuses it.
    let blank = world.raise(
        owner,
        &input(
            owner,
            "blank",
            "question",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    error(
        &post(&blank, "answer", r#"{"text":"  "}"#),
        409,
        "human_item_conflict",
    );
    assert_eq!(world.stored(&blank)["state"], "open");
}

/// The same four resolutions made through the CLI by a manager acting on the
/// user's behalf: the record says so, the route serves what the CLI wrote, and
/// the owning session's watch alone is told.
#[test]
fn every_action_through_the_cli_is_served_by_the_route_and_reaches_only_its_owner() {
    let world = World::new();
    let owner = "manager-cli";
    let question = world.raise(
        owner,
        &input(
            owner,
            "region",
            "question",
            "high",
            json!({"scope": "nothing"}),
        ),
    );
    let task = world.raise(
        owner,
        &input(
            owner,
            "rotate",
            "task",
            "medium",
            json!({"scope": "nothing"}),
        ),
    );
    let reasoned = world.raise(
        owner,
        &input(owner, "legacy", "task", "low", json!({"scope": "nothing"})),
    );
    let bare = world.raise(
        owner,
        &input(
            owner,
            "nightly",
            "question",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    world.watch(owner);
    world.watch("manager-elsewhere");
    let refused = world.cli(
        Some(owner),
        &["human-items", "answer", &task, "--text", "x"],
    );
    assert!(!refused.status.success());
    assert_eq!(world.stored(&task)["state"], "open");
    world.ok(
        Some(owner),
        &["human-items", "answer", &question, "--text", "eu-west"],
    );
    world.ok(Some(owner), &["human-items", "complete", &task]);
    world.ok(
        Some(owner),
        &[
            "human-items",
            "dismiss",
            &reasoned,
            "--reason",
            "Superseded",
        ],
    );
    world.ok(Some(owner), &["human-items", "dismiss", &bare]);
    let server = world.serve(Some(owner));
    for (id, state, text, reason) in [
        (&question, "answered", json!("eu-west"), Value::Null),
        (&task, "completed", Value::Null, Value::Null),
        (&reasoned, "dismissed", Value::Null, json!("Superseded")),
        (&bare, "dismissed", Value::Null, Value::Null),
    ] {
        let detail = http::get(server.address, &format!("/api/human-items/{id}")).json();
        assert_eq!(detail["item"]["state"], state);
        assert_eq!(
            detail["item"]["resolution"],
            json!({"actor": format!("session:{owner}"), "on_behalf_of": format!("user:{USER}"), "text": text, "reason": reason}),
            "a CLI resolution with no `--as` is the manager's, which writes no provenance key"
        );
        let history: Vec<(Value, Value)> = detail["history"]
            .as_array()
            .expect("the engine's history of the item")
            .iter()
            .map(|entry| (entry["action"].clone(), entry["provenance"].clone()))
            .collect();
        assert_eq!(
            history.last(),
            Some(&(json!(format!("human-item-{state}")), json!("manager"))),
            "the route serves the CLI's resolution as the manager's: {history:?}"
        );
    }
    assert_eq!(delivered(&world.watch(owner)).len(), 4);
    assert!(world.watch("manager-elsewhere").is_empty());
}

/// A design review is an ordinary task: completing it — through the route,
/// then through a manager's CLI — runs the configured approval authority with
/// the version stored when it was raised, which records exactly one approval
/// as whoever acted before the task completes. Nobody supplies a key.
#[test]
fn completing_a_current_design_review_records_its_approval_through_each_surface() {
    let world = World::new();
    let owner = "manager-design";
    let browser = world.raise_design(owner, "docs/design/action-items.md", "sha256:5d1c0a");
    let chat = world.raise_design(owner, "docs/design/dashboard.md", "sha256:c4e2f9");
    let stored = world.stored(&browser);
    assert_eq!(stored["kind"], "task");
    assert_eq!(
        stored["approval"],
        json!({"board_copy": "docs/design/action-items.md", "key": "sha256:5d1c0a"})
    );
    let server = world.serve(Some(owner));
    let response = http::post(
        server.address,
        &format!("/api/human-items/{browser}/complete"),
        "{}",
    );
    assert_eq!(response.status, 200, "{}", response.body);
    world.ok(Some(owner), &["human-items", "complete", &chat]);
    assert_eq!(
        world.approvals(),
        [
            json!({"board_copy": "docs/design/action-items.md", "key": "sha256:5d1c0a", "actor": format!("browser:session:{owner}"), "on_behalf_of": null}),
            json!({"board_copy": "docs/design/dashboard.md", "key": "sha256:c4e2f9", "actor": format!("session:{owner}"), "on_behalf_of": format!("user:{USER}")}),
        ]
    );
    assert_eq!(world.stored(&browser)["state"], "completed");
    assert_eq!(world.stored(&chat)["state"], "completed");
    // An approval reference in a plain raise is refused: only the phase sets one.
    let mut forged = input(owner, "forged", "task", "low", json!({"scope": "nothing"}));
    forged["approval"] = json!({"board_copy": "docs/design/x.md", "key": "k"});
    let refused = http::post(server.address, "/api/human-items", &forged.to_string());
    error(&refused, 409, "human_item_conflict");
}

/// A design document that changed since its review was raised: completing the
/// task records no approval, refuses with the engine's re-read text, dismisses
/// the obsolete task and raises one replacement for the new version — through
/// the route and through the CLI alike.
#[test]
fn completing_a_stale_design_review_replaces_it_and_records_no_approval() {
    let world = World::new();
    let owner = "manager-stale";
    let server = world.serve(Some(owner));
    for (document, surface) in [
        ("docs/design/action-items.md", "route"),
        ("docs/design/dashboard.md", "cli"),
    ] {
        let obsolete = world.raise_design(owner, document, "v1");
        world.set_version(document, "v2");
        let refusal = match surface {
            "route" => error(
                &http::post(
                    server.address,
                    &format!("/api/human-items/{obsolete}/complete"),
                    "{}",
                ),
                409,
                "human_item_conflict",
            ),
            _ => {
                let output = world.cli(Some(owner), &["human-items", "complete", &obsolete]);
                assert!(!output.status.success());
                String::from_utf8_lossy(&output.stderr).into_owned()
            }
        };
        assert!(refusal.contains(REREAD), "{surface}: {refusal}");
        assert!(
            world.approvals().is_empty(),
            "{surface}: no stale approval is recorded"
        );
        assert_eq!(world.stored(&obsolete)["state"], "dismissed");
        let replacements: Vec<Value> = world
            .listed(&[])
            .into_iter()
            .filter(|v| v["item"]["approval"]["board_copy"] == document)
            .collect();
        assert_eq!(
            replacements.len(),
            1,
            "{surface}: one replacement: {replacements:#?}"
        );
        assert_eq!(replacements[0]["item"]["approval"]["key"], "v2");
        assert_ne!(id_of(&replacements[0]), obsolete);
    }
}

/// Every task is projected onto the configured tracker, and the link the
/// engine stores is the issue GitHub serves; questions never are.
#[test]
fn every_task_carries_the_tracker_issue_the_engine_projected_it_to() {
    let world = World::new();
    let owner = "manager-tracker";
    let task = world.raise(
        owner,
        &input(owner, "rotate", "task", "urgent", json!({"scope": "host"})),
    );
    let question = world.raise(
        owner,
        &input(owner, "ask", "question", "low", json!({"scope": "nothing"})),
    );
    let server = world.serve(Some(owner));
    let detail = http::get(server.address, &format!("/api/human-items/{task}")).json();
    let url = detail["item"]["tracker"]["url"]
        .as_str()
        .expect("a tracker link")
        .to_owned();
    assert!(
        url.starts_with("https://github.com/generic/approval/issues/"),
        "{url}"
    );
    let issues = world.board.state()["issues"].clone();
    let filed: Vec<&Value> = issues
        .as_object()
        .unwrap()
        .values()
        .filter(|issue| issue["title"] == "Settle rotate")
        .collect();
    assert_eq!(filed.len(), 1, "{issues:#?}");
    assert_eq!(filed[0]["url"], url.as_str());
    assert_eq!(filed[0]["priority"], "Urgent");
    let asked = http::get(server.address, &format!("/api/human-items/{question}")).json();
    assert_eq!(asked["item"]["tracker"], Value::Null);
    let output = world.ok(None, &["human-items", "list"]);
    assert!(output.contains("Critical"), "{output}");
}

/// A run's end retires the holds that were its own, with the reason "the run
/// ended", and tells their owner: stopping a run dismisses its work and plan
/// holds, a host-wide hold and another run's items survive it, and a manager's
/// question raised outside any run stays open until it is answered — which
/// reaches that session's next watch.
#[test]
fn a_run_stopped_or_settled_retires_only_its_own_holds_and_tells_their_owner() {
    let world = World::new();
    let owner = "manager-lifecycle";
    let stopped_plan = release_plan(&world, "stopped");
    let stopped = world.start(owner, &stopped_plan);
    let settled_plan = world.plan(
        "settled",
        &[
            step("sign", "Sign the release", &[]),
            step("ship", "Ship the release", &["sign"]),
            step("notes", "Write the release notes", &[]),
        ],
    );
    let settled = world.start(owner, &settled_plan);
    let work = world.raise(
        owner,
        &input(
            owner,
            "hold-test",
            "task",
            "high",
            json!({"scope": "work", "run": stopped, "node": "test"}),
        ),
    );
    let mut plan_hold = input(
        owner,
        "freeze",
        "question",
        "medium",
        json!({"scope": "plan", "plan": stopped_plan}),
    );
    plan_hold["owner"]["run"] = json!(stopped);
    let plan_hold = world.raise(owner, &plan_hold);
    let host = world.raise(
        owner,
        &input(owner, "outage", "task", "urgent", json!({"scope": "host"})),
    );
    let outside = world.raise(
        owner,
        &input(
            owner,
            "outside",
            "question",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    let step_items: Vec<String> = world
        .listed(&["--run", &stopped])
        .iter()
        .filter(|v| v["item"]["dedup_key"].as_str().unwrap().starts_with("run:"))
        .map(id_of)
        .collect();
    assert_eq!(step_items.len(), 2);
    world.watch(owner);

    world.ok(Some(owner), &["stop", &stopped]);
    for id in step_items.iter().chain([&work, &plan_hold]) {
        let stored = world.stored(id);
        assert_eq!(stored["state"], "dismissed", "{stored}");
        assert_eq!(stored["resolution"]["reason"], "the run ended");
    }
    for id in [&host, &outside] {
        assert_eq!(world.stored(id)["state"], "open");
    }
    let mut told: Vec<String> = delivered(&world.watch(owner))
        .into_iter()
        .map(|(kind, id)| {
            assert_eq!(kind, "human-item-auto-resolved");
            id
        })
        .collect();
    told.sort();
    let mut retired: Vec<String> = step_items
        .iter()
        .cloned()
        .chain([work, plan_hold])
        .collect();
    retired.sort();
    assert_eq!(told, retired);
    // A run that settles retires its own holds the same way. Every hold blocks
    // its human steps too, so the host hold is resolved first; the settled run's
    // own hold is on a step it already finished, so it holds nothing back.
    let server = world.serve(Some(owner));
    let complete = |id: &str| {
        let response = http::post(
            server.address,
            &format!("/api/human-items/{id}/complete"),
            "{}",
        );
        assert_eq!(response.status, 200, "{}", response.body);
    };
    let gate = |node: &str| {
        id_of(
            world
                .listed(&["--run", &settled])
                .iter()
                .find(|v| v["item"]["dedup_key"] == format!("run:{settled}#{node}"))
                .expect("the step's item"),
        )
    };
    complete(&host);
    complete(&gate("notes"));
    let settles = world.raise(
        owner,
        &input(
            owner,
            "settles",
            "task",
            "low",
            json!({"scope": "work", "run": settled, "node": "notes"}),
        ),
    );
    complete(&gate("sign"));
    world.ok(Some(owner), &["adopt", &settled, "--attach"]);
    complete(&gate("ship"));
    world.ok(Some(owner), &["adopt", &settled, "--attach"]);
    assert!(
        world.root.join(&settled).join("result.json").is_file(),
        "the run settled"
    );
    assert_eq!(world.stored(&settles)["state"], "dismissed");
    assert_eq!(
        world.stored(&settles)["resolution"]["reason"],
        "the run ended"
    );
    assert_eq!(world.stored(&outside)["state"], "open");
    world.watch(owner);
    let answered = http::post(
        server.address,
        &format!("/api/human-items/{outside}/answer"),
        r#"{"text":"Yes."}"#,
    );
    assert_eq!(answered.status, 200, "{}", answered.body);
    drop(server);
    assert_eq!(
        delivered(&world.watch(owner)),
        [("human-item-answered".to_owned(), outside)]
    );
}

/// An open host item is blocking and holds the host's dispatch: a run launched
/// under it dispatches nothing while it stays open.
#[test]
fn an_open_host_item_is_blocking_and_holds_every_dispatch_on_the_host() {
    let world = World::new();
    let owner = "manager-host";
    let host = world.raise(
        owner,
        &input(owner, "outage", "task", "urgent", json!({"scope": "host"})),
    );
    let name = "dispatching";
    let store = world.base().join("plan-store");
    write_document(
        &store.join("projects").join(format!("{name}.md")),
        &[
            ("title", json!(name)),
            (
                "metadata",
                json!({"onepipeline.schema_version": 2, "onepipeline.goal": {"text": "run"}, "onepipeline.concurrency": 1}),
            ),
        ],
        "",
    );
    write_document(
        &store.join("tasks").join(name).join("000-build.md"),
        &[
            ("title", json!("Build it")),
            ("project", json!(name)),
            (
                "metadata",
                json!({"onepipeline.id": "build", "onepipeline.persona": "engineer"}),
            ),
        ],
        "## What\nBuild it.\n\n## Why\nSo it ships.\n\n## Acceptance criteria\n- it is built.",
    );
    let launched: Value = serde_json::from_str(
        world
            .ok(
                Some(owner),
                &["start", &format!("{SOURCE}:{name}"), "--detach"],
            )
            .lines()
            .last()
            .unwrap(),
    )
    .expect("start prints its launch");
    let run = launched["run_id"].as_str().expect("a run id").to_owned();
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        assert!(
            world.events_of(&run, "node-dispatched").is_empty(),
            "the host hold let a step dispatch"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let server = world.serve(Some(owner));
    let blocking = items(&http::get(server.address, "/api/human-items?blocking=true"));
    assert_eq!(ids(&blocking), std::slice::from_ref(&host));
    assert_eq!(blocking[0]["blocked"]["total"], 1, "{}", blocking[0]);
    let report = world.ok(None, &["human-items", "report"]);
    assert!(report.contains("blocks all work on this host"), "{report}");
    world.ok(Some(owner), &["stop", &run, "--force"]);
    assert_eq!(
        world.stored(&host)["state"],
        "open",
        "ending one run leaves the host hold"
    );
}

/// Priorities are words wherever a person reads them and the wire vocabulary
/// wherever a program does: Critical is `urgent`, and no P-label is printed.
#[test]
fn priorities_are_words_in_text_and_the_wire_vocabulary_in_json() {
    let world = World::new();
    let owner = "manager-words";
    for (n, priority) in WIRE_ORDER.iter().enumerate() {
        world.raise(
            owner,
            &input(
                owner,
                &format!("p{n}"),
                "task",
                priority,
                json!({"scope": "nothing"}),
            ),
        );
    }
    let text = world.ok(None, &["human-items", "list"]);
    let report = world.ok(None, &["human-items", "report"]);
    for printed in [&text, &report] {
        for word in ["Critical", "High", "Medium", "Low"] {
            assert!(printed.contains(word), "{word}: {printed}");
        }
        for label in ["P0", "P1", "P2", "P3"] {
            assert!(!printed.contains(label), "{label}: {printed}");
        }
    }
    let critical = world.listed(&["--priority", "CRITICAL"]);
    assert_eq!(critical.len(), 1);
    assert_eq!(critical[0]["item"]["priority"], "urgent");
    let server = world.serve(Some(owner));
    let served = items(&http::get(
        server.address,
        "/api/human-items?priority=urgent",
    ));
    assert_eq!(served, critical);
}

/// A long body is stored and served whole, and printed whole on asking: the
/// CLI's list and report give its first line by default and every line of it
/// under `--full`, questions included.
#[test]
fn a_long_body_is_served_and_printed_in_full() {
    let world = World::new();
    let owner = "manager-long";
    let body: String = (1..=9)
        .map(|n| format!("Line {n} of what this needs from a person.\n"))
        .collect();
    let mut long = input(
        owner,
        "long",
        "question",
        "high",
        json!({"scope": "nothing"}),
    );
    long["body"] = json!(body.trim_end());
    let id = world.raise(owner, &long);
    let server = world.serve(Some(owner));
    let detail = http::get(server.address, &format!("/api/human-items/{id}")).json();
    assert_eq!(detail["item"]["body"], body.trim_end());
    for verb in ["list", "report"] {
        let brief = world.ok(None, &["human-items", verb]);
        assert!(brief.contains("Line 1 of"), "{verb}: {brief}");
        assert!(!brief.contains("Line 2 of"), "{verb}: {brief}");
        let printed = world.ok(None, &["human-items", verb, "--full"]);
        assert!(
            printed.contains(body.trim_end()),
            "{verb} --full: {printed}"
        );
    }
}

/// What the engine writes after a resolution is served as it wrote it: a note on a
/// completed task is the completion's comment, a reopen takes the resolution back,
/// and every read says whether the item can be reopened. A note on an open item is
/// refused and leaves what the route serves alone.
#[test]
fn a_note_and_a_reopen_are_served_as_the_engine_wrote_them() {
    let world = World::new();
    let owner = "manager-reopen";
    let id = world.raise(
        owner,
        &input(owner, "reopen", "task", "low", json!({"scope": "nothing"})),
    );
    let server = world.serve(Some(owner));
    let path = format!("/api/human-items/{id}");
    let open = http::get(server.address, &path).json();
    assert_eq!(open["reopen"]["available"], false);
    assert_eq!(
        open["reopen"]["reason"],
        "the item is open, so there is nothing to reopen"
    );

    let refused = world.cli(
        Some(owner),
        &["human-items", "note", &id, "--text", "Too early."],
    );
    assert!(
        !refused.status.success(),
        "a note on an open item is refused"
    );
    assert_eq!(http::get(server.address, &path).json(), open);

    world.ok(Some(owner), &["human-items", "complete", &id]);
    let completed = http::get(server.address, &path).json();
    assert_eq!(completed["item"]["state"], "completed");
    assert_eq!(completed["item"]["resolution"]["text"], Value::Null);
    assert_eq!(
        completed["reopen"],
        json!({"available": true, "reason": null})
    );

    world.ok(
        Some(owner),
        &["human-items", "note", &id, "--text", "Done by hand."],
    );
    let noted = http::get(server.address, &path).json();
    assert_eq!(noted["item"]["state"], "completed");
    assert_eq!(noted["item"]["resolution"]["text"], "Done by hand.");
    assert_eq!(noted["reopen"], json!({"available": true, "reason": null}));

    world.ok(Some(owner), &["human-items", "reopen", &id]);
    let reopened = http::get(server.address, &path).json();
    assert_eq!(reopened["item"]["state"], "open");
    assert_eq!(reopened["item"]["resolution"], Value::Null);
    assert_eq!(reopened["reopen"], open["reopen"]);
    let listed = http::get(server.address, "/api/human-items").json();
    assert_eq!(listed["items"][0]["item"]["id"], id.as_str());
    assert_eq!(listed["items"][0]["reopen"], open["reopen"]);
}

/// Reopening and noting through the routes are a press in the browser: the
/// engine's `Reopen` and `Note`, attributed `browser:session:<id>` — or `browser`
/// through a server acting as no session — in the event's `by`, delivered to the
/// owner's watch alone and leaving who resolved the item as it was. A design
/// review's approval is taken back by its adapter's undo, and an undo that
/// refuses leaves the task completed with the script's own words.
#[test]
fn reopen_and_note_through_the_routes_are_a_browser_press_and_run_the_adapters_undo() {
    for session in [Some("manager-presses"), None] {
        let world = World::new();
        let owner = "manager-owns";
        let actor = session.map_or_else(
            || "browser".to_owned(),
            |id| format!("browser:session:{id}"),
        );
        let task = world.raise(
            owner,
            &input(owner, "reopen", "task", "low", json!({"scope": "nothing"})),
        );
        let dismissed = world.raise(
            owner,
            &input(owner, "noted", "task", "low", json!({"scope": "nothing"})),
        );
        let server = world.serve(session);
        let post = |id: &str, verb: &str, body: &str| {
            http::post(
                server.address,
                &format!("/api/human-items/{id}/{verb}"),
                body,
            )
        };
        world.watch(owner);

        // Nothing is resolved yet: both are the engine's refusals, in its words.
        assert!(
            error(&post(&task, "reopen", "{}"), 409, "human_item_conflict")
                .contains("nothing to reopen")
        );
        error(
            &post(&task, "note", r#"{"text":"Too early."}"#),
            409,
            "human_item_conflict",
        );
        // A body naming who acted, or a note without text, is refused unread.
        for (verb, body) in [
            ("reopen", r#"{"actor":"someone"}"#),
            ("note", r#"{"text":"x","on_behalf_of":"someone"}"#),
            ("note", "{}"),
        ] {
            error(&post(&task, verb, body), 422, "invalid_request");
        }
        assert!(world.watch(owner).is_empty(), "a refusal tells no one");

        let response = post(&task, "complete", "");
        assert_eq!(response.status, 200, "{}", response.body);
        let noted = post(&task, "note", r#"{"text":"Done by hand."}"#);
        assert_eq!(noted.status, 200, "{}", noted.body);
        let receipt: HumanItemReceipt =
            serde_json::from_value(noted.json()).expect("the engine's receipt");
        assert_eq!(receipt.item.item.state, HumanItemState::Completed);
        let stored = world.stored(&task);
        assert_eq!(
            stored["resolution"],
            json!({"actor": actor, "on_behalf_of": null, "text": "Done by hand.", "reason": null, "provenance": "user"}),
            "a note is the comment; who resolved it stays who resolved it"
        );
        error(
            &post(&task, "note", r#"{"text":"  "}"#),
            409,
            "human_item_conflict",
        );
        let reopened = post(&task, "reopen", "");
        assert_eq!(reopened.status, 200, "{}", reopened.body);
        assert_eq!(world.stored(&task)["state"], "open");
        assert_eq!(world.stored(&task)["resolution"], Value::Null);

        assert_eq!(post(&dismissed, "dismiss", "{}").status, 200);
        let reason = post(
            &dismissed,
            "note",
            r#"{"text":"Superseded by the new export"}"#,
        );
        assert_eq!(reason.status, 200, "{}", reason.body);
        assert_eq!(
            world.stored(&dismissed)["resolution"]["reason"],
            "Superseded by the new export",
            "a dismissed item's note is its reason"
        );

        let events = world.watch(owner);
        assert_eq!(
            delivered(&events),
            [
                ("human-item-completed".to_owned(), task.clone()),
                ("human-item-noted".to_owned(), task.clone()),
                ("human-item-reopened".to_owned(), task.clone()),
                ("human-item-dismissed".to_owned(), dismissed.clone()),
                ("human-item-noted".to_owned(), dismissed.clone()),
            ]
        );
        for event in &events {
            let after_the_fact = matches!(
                event["kind"].as_str(),
                Some("human-item-noted" | "human-item-reopened")
            );
            assert_eq!(
                event["payload"].get("by").cloned(),
                after_the_fact
                    .then(|| json!({"actor": actor, "on_behalf_of": null, "provenance": "user"})),
                "{event}"
            );
        }

        // A design review: reopening runs its adapter's undo, which takes the
        // approval back; an undo with nothing to take back refuses in its words.
        let review = world.raise_design(owner, "docs/design/action-items.md", "sha256:5d1c0a");
        assert_eq!(post(&review, "complete", "{}").status, 200);
        assert_eq!(world.approvals().len(), 1);
        let view = http::get(server.address, &format!("/api/human-items/{review}")).json();
        assert_eq!(view["reopen"], json!({"available": true, "reason": null}));
        let undone = post(&review, "reopen", "{}");
        assert_eq!(undone.status, 200, "{}", undone.body);
        assert!(
            world.approvals().is_empty(),
            "the undo removed the approval"
        );
        assert_eq!(world.stored(&review)["state"], "open");
        assert_eq!(post(&review, "complete", "{}").status, 200);
        assert_eq!(world.approvals().len(), 1);
        std::fs::write(world.base().join("approvals.ndjson"), "").expect("withdraw it elsewhere");
        let refusal = error(&post(&review, "reopen", "{}"), 409, "human_item_conflict");
        assert!(refusal.contains("nothing to take back"), "{refusal}");
        assert_eq!(world.stored(&review)["state"], "completed");

        error(
            &post("hi-0000000000000000000a", "reopen", "{}"),
            404,
            "human_item_not_found",
        );
        error(
            &post("hi-0000000000000000000a", "note", r#"{"text":"x"}"#),
            404,
            "human_item_not_found",
        );
    }
}

/// The provenance each journal event about `id` records, oldest first: the
/// event's `by` on a reopen or a note, a resolution's on an answer, a
/// completion or a dismissal, and no entry where neither is (a raise). An absent key is
/// what the engine writes for the manager's words, so it reads as `manager`.
fn recorded_provenance(world: &World, id: &str) -> Vec<(String, String)> {
    std::fs::read_to_string(world.root.join(onepipeline::human_items::JOURNAL_PATH))
        .expect("the journal")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a journal line"))
        .filter(|envelope| envelope["payload"]["item_id"] == id)
        .filter_map(|envelope| {
            let payload = &envelope["payload"];
            let party = [&payload["by"], &payload["resolution"]]
                .into_iter()
                .find(|record| record.is_object())?;
            Some((
                payload["action"].as_str().expect("an action").to_owned(),
                party["provenance"].as_str().unwrap_or("manager").to_owned(),
            ))
        })
        .collect()
}

/// **Everything a person submits through the routes is the user's words.**
/// Every action route — `answer`, the batch `answers`, `complete`, `dismiss`,
/// `reopen` and `note` — reaches the engine with provenance `user`, which the
/// engine writes on the item's event in `human-items/events.ndjson`. A body
/// naming a `provenance` of its own, whichever party it claims, is refused
/// `422 invalid_request` with the journal left byte for byte as it was: the
/// party is the server's to state, as the actor is.
#[test]
fn every_action_through_the_routes_is_recorded_as_the_users_and_no_body_can_say_otherwise() {
    let world = World::new();
    let owner = "manager-provenance";
    let raise = |dedup: &str, kind: &str| {
        world.raise(
            owner,
            &input(owner, dedup, kind, "low", json!({"scope": "nothing"})),
        )
    };
    let answered = raise("answered", "question");
    let batched = raise("batched", "question");
    let completed = raise("completed", "task");
    let dismissed = raise("dismissed", "task");
    let server = world.serve(Some(owner));
    let post = |path: &str, body: &str| http::post(server.address, path, body);
    let journal = || {
        std::fs::read_to_string(world.root.join(onepipeline::human_items::JOURNAL_PATH))
            .expect("the journal")
    };

    // Refused first, on every route and for either party, with nothing written.
    let before = journal();
    for party in ["manager", "user"] {
        for (path, body) in [
            (
                format!("/api/human-items/{answered}/answer"),
                json!({"text": "eu-west", "provenance": party}),
            ),
            (
                "/api/human-items/answers".to_owned(),
                json!({"answers": [{"id": batched, "text": "eu-west"}], "provenance": party}),
            ),
            (
                "/api/human-items/answers".to_owned(),
                json!({"answers": [{"id": batched, "text": "eu-west", "provenance": party}]}),
            ),
            (
                format!("/api/human-items/{completed}/complete"),
                json!({"provenance": party}),
            ),
            (
                format!("/api/human-items/{dismissed}/dismiss"),
                json!({"reason": "Superseded", "provenance": party}),
            ),
            (
                format!("/api/human-items/{completed}/reopen"),
                json!({"provenance": party}),
            ),
            (
                format!("/api/human-items/{completed}/note"),
                json!({"text": "Done by hand.", "provenance": party}),
            ),
        ] {
            let message = error(&post(&path, &body.to_string()), 422, "invalid_request");
            assert!(
                message.contains("provenance"),
                "{path} names the field it refused: {message}"
            );
        }
    }
    assert_eq!(journal(), before, "a refused body records nothing");

    // Then each action through its route, recorded as the user's.
    for (path, body) in [
        (
            format!("/api/human-items/{answered}/answer"),
            json!({"text": "eu-west"}),
        ),
        (
            "/api/human-items/answers".to_owned(),
            json!({"answers": [{"id": batched, "text": "us-east"}]}),
        ),
        (format!("/api/human-items/{completed}/complete"), json!({})),
        (
            format!("/api/human-items/{dismissed}/dismiss"),
            json!({"reason": "Superseded"}),
        ),
        (
            format!("/api/human-items/{dismissed}/note"),
            json!({"text": "Replaced by the new export."}),
        ),
        (format!("/api/human-items/{completed}/reopen"), json!({})),
    ] {
        let response = post(&path, &body.to_string());
        assert_eq!(response.status, 200, "{path}: {}", response.body);
    }
    let user = |action: &str| (format!("human-item-{action}"), "user".to_owned());
    assert_eq!(recorded_provenance(&world, &answered), [user("answered")]);
    assert_eq!(recorded_provenance(&world, &batched), [user("answered")]);
    assert_eq!(
        recorded_provenance(&world, &completed),
        [user("completed"), user("reopened")]
    );
    assert_eq!(
        recorded_provenance(&world, &dismissed),
        [user("dismissed"), user("noted")]
    );
    // The engine's own history, as the detail route serves it, says the same.
    let history = http::get(server.address, &format!("/api/human-items/{completed}")).json()
        ["history"]
        .clone();
    let parties: Vec<(Value, Value, Value)> = history
        .as_array()
        .expect("the history")
        .iter()
        .map(|entry| {
            (
                entry["action"].clone(),
                entry["actor"].clone(),
                entry["provenance"].clone(),
            )
        })
        .collect();
    // A raise is its asker's own, read as the manager's; the engine records a
    // task's projection to its tracker as a raise of its own, so how many
    // raises lead the history is the engine's to say.
    let raises = parties
        .iter()
        .take_while(|(action, _, _)| action == "human-item-raised")
        .count();
    assert!(raises > 0, "the history opens with the raise: {parties:?}");
    for raise in &parties[..raises] {
        assert_eq!(
            raise,
            &(
                json!("human-item-raised"),
                json!(format!("session:{owner}")),
                json!("manager")
            )
        );
    }
    assert_eq!(
        parties[raises..],
        [
            (
                json!("human-item-completed"),
                json!(format!("browser:session:{owner}")),
                json!("user")
            ),
            (
                json!("human-item-reopened"),
                json!(format!("browser:session:{owner}")),
                json!("user")
            ),
        ],
        "the detail serves the engine's history, oldest first"
    );
}

/// A person's press in the browser and a manager's own CLI action over the
/// same journal are told apart by what each records.
#[test]
fn a_browser_press_and_a_managers_cli_action_record_different_actors() {
    let world = World::new();
    let owner = "manager-tells-apart";
    let pressed = world.raise(
        owner,
        &input(owner, "pressed", "task", "low", json!({"scope": "nothing"})),
    );
    let commanded = world.raise(
        owner,
        &input(
            owner,
            "commanded",
            "task",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    let server = world.serve(Some(owner));
    let response = http::post(
        server.address,
        &format!("/api/human-items/{pressed}/complete"),
        "{}",
    );
    assert_eq!(response.status, 200, "{}", response.body);
    world.ok(Some(owner), &["human-items", "complete", &commanded]);
    assert_eq!(
        world.stored(&pressed)["resolution"]["actor"],
        format!("browser:session:{owner}")
    );
    assert_eq!(
        world.stored(&pressed)["resolution"]["on_behalf_of"],
        Value::Null
    );
    assert_eq!(
        world.stored(&commanded)["resolution"],
        json!({"actor": format!("session:{owner}"), "on_behalf_of": format!("user:{USER}"), "text": null, "reason": null}),
        "the manager's own action names its session, on the user's behalf"
    );
}

/// Content and writes belong to the owning session: another session is
/// served neither its content nor any write to it, an unattributed server owns
/// nothing, and a raise as anyone but the acting session is refused — all
/// without changing the journal.
#[test]
fn foreign_and_unattributed_servers_resolve_items_but_cannot_raise_for_another_owner() {
    for session in [Some("manager-intruder"), None] {
        let world = World::new();
        let owner = "manager-owner";
        let server = world.serve(session);
        let actor = session.map_or_else(
            || "browser".to_owned(),
            |id| format!("browser:session:{id}"),
        );
        for (key, kind, verb, body, state, event) in [
            (
                "question",
                "question",
                "answer",
                r#"{"text":"Yes"}"#,
                "answered",
                "human-item-answered",
            ),
            (
                "task",
                "task",
                "complete",
                "{}",
                "completed",
                "human-item-completed",
            ),
            (
                "dismiss",
                "task",
                "dismiss",
                r#"{"reason":"Superseded"}"#,
                "dismissed",
                "human-item-dismissed",
            ),
        ] {
            let id = world.raise(
                owner,
                &input(owner, key, kind, "high", json!({"scope":"nothing"})),
            );
            world.watch(owner);
            assert_eq!(
                ids(&items(&http::get(server.address, "/api/human-items"))).as_slice(),
                std::slice::from_ref(&id)
            );
            let detail = http::get(server.address, &format!("/api/human-items/{id}"));
            assert_eq!(detail.status, 200, "{}", detail.body);
            let original_owner = world.stored(&id)["owner"].clone();
            for field in ["actor", "on_behalf_of"] {
                let mut spoof: Value = serde_json::from_str(body).unwrap();
                spoof[field] = json!("someone");
                error(
                    &http::post(
                        server.address,
                        &format!("/api/human-items/{id}/{verb}"),
                        &spoof.to_string(),
                    ),
                    422,
                    "invalid_request",
                );
            }
            if kind == "question" {
                error(
                    &http::post(
                        server.address,
                        &format!("/api/human-items/{id}/answer"),
                        r#"{"text":" "}"#,
                    ),
                    409,
                    "human_item_conflict",
                );
                error(
                    &http::post(
                        server.address,
                        &format!("/api/human-items/{id}/complete"),
                        "{}",
                    ),
                    409,
                    "human_item_conflict",
                );
            }
            let response = http::post(
                server.address,
                &format!("/api/human-items/{id}/{verb}"),
                body,
            );
            assert_eq!(response.status, 200, "{}", response.body);
            let stored = world.stored(&id);
            assert_eq!(stored["state"], state);
            assert_eq!(stored["owner"], original_owner);
            assert_eq!(stored["resolution"]["actor"], actor);
            assert_eq!(stored["resolution"]["on_behalf_of"], Value::Null);
            assert_eq!(
                delivered(&world.watch(owner)),
                [(event.to_owned(), id.clone())]
            );
            assert!(items(&http::get(server.address, "/api/human-items")).is_empty());
            let conflicting = if verb == "dismiss" {
                "complete"
            } else {
                "dismiss"
            };
            error(
                &http::post(
                    server.address,
                    &format!("/api/human-items/{id}/{conflicting}"),
                    "{}",
                ),
                409,
                "human_item_conflict",
            );
        }
        let review = world.raise_design(owner, "docs/design/action-items.md", "sha256:5d1c0a");
        let original_owner = world.stored(&review)["owner"].clone();
        world.watch(owner);
        let response = http::post(
            server.address,
            &format!("/api/human-items/{review}/complete"),
            "{}",
        );
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(
            world.approvals(),
            [
                json!({"board_copy":"docs/design/action-items.md", "key":"sha256:5d1c0a", "actor":actor, "on_behalf_of":null})
            ]
        );
        let stored = world.stored(&review);
        assert_eq!(stored["state"], "completed");
        assert_eq!(stored["owner"], original_owner);
        assert_eq!(stored["resolution"]["actor"], actor);
        assert_eq!(stored["resolution"]["on_behalf_of"], Value::Null);
        assert_eq!(
            delivered(&world.watch(owner)),
            [("human-item-completed".to_owned(), review)]
        );
        error(
            &http::post(
                server.address,
                "/api/human-items",
                &input(owner, "forged", "task", "low", json!({"scope":"nothing"})).to_string(),
            ),
            403,
            "human_item_not_owner",
        );
        for path in [
            "/api/human-items/hi-0000000000000000000a",
            "/api/human-items/hi-0000000000000000000a/answer",
        ] {
            let response = if path.ends_with("answer") {
                http::post(server.address, path, r#"{"text":"Yes"}"#)
            } else {
                http::get(server.address, path)
            };
            error(&response, 404, "human_item_not_found");
        }
        error(
            &http::get(server.address, "/api/human-items/not%20an%20id"),
            422,
            "invalid_human_item_id",
        );
    }
}

/// Raising over the route is the owner's: it answers the engine's receipt,
/// delivers to the owner's watch, and a raise repeated under its dedup key is
/// the same item. A body naming an actor is refused.
#[test]
fn raising_an_item_is_the_owners_and_answers_the_engines_receipt() {
    let world = World::new();
    let owner = "manager-raises";
    let server = world.serve(Some(owner));
    let body = input(
        owner,
        "nightly",
        "question",
        "low",
        json!({"scope": "nothing"}),
    )
    .to_string();
    let response = http::post(server.address, "/api/human-items", &body);
    assert_eq!(response.status, 200, "{}", response.body);
    let receipt: HumanItemReceipt = serde_json::from_value(response.json()).expect("a receipt");
    assert_eq!(receipt.item.item.owner.session, owner);
    assert_eq!(
        delivered(&world.watch(owner)),
        [("human-item-raised".to_owned(), receipt.item.item.id.clone())]
    );
    // Raised again under its dedup key — a retry — it is the same one item.
    let again = http::post(server.address, "/api/human-items", &body);
    assert_eq!(again.status, 200, "{}", again.body);
    assert_eq!(
        again.json()["item"]["item"]["id"],
        json!(receipt.item.item.id)
    );
    let mut acted = input(
        owner,
        "acted",
        "question",
        "low",
        json!({"scope": "nothing"}),
    );
    acted["actor"] = json!("someone");
    assert_eq!(
        http::post(server.address, "/api/human-items", &acted.to_string()).status,
        422
    );
    assert_eq!(world.listed(&[]).len(), 1);
}

/// Writes made at once — through two servers and the CLI — each land once,
/// because every writer is serialized by the engine's own journal lock.
#[test]
fn writes_made_at_once_each_land() {
    let world = World::new();
    let owner = "manager-busy";
    let ids: Vec<String> = (0..12)
        .map(|n| {
            world.raise(
                owner,
                &input(
                    owner,
                    &format!("q{n}"),
                    "question",
                    "low",
                    json!({"scope": "nothing"}),
                ),
            )
        })
        .collect();
    let first = world.serve(Some(owner));
    let second = world.serve(Some(owner));
    std::thread::scope(|scope| {
        for (n, id) in ids.iter().enumerate() {
            let address = [first.address, second.address][n % 2];
            let world = &world;
            scope.spawn(move || {
                if n % 3 == 0 {
                    world.ok(Some(owner), &["human-items", "answer", id, "--text", "cli"]);
                } else {
                    let response = http::post(
                        address,
                        &format!("/api/human-items/{id}/answer"),
                        r#"{"text":"route"}"#,
                    );
                    assert_eq!(response.status, 200, "{}", response.body);
                }
            });
        }
    });
    assert!(world.listed(&[]).is_empty());
    assert_eq!(world.listed(&["--state", "answered"]).len(), 12);
    let events =
        std::fs::read_to_string(world.root.join(onepipeline::human_items::JOURNAL_PATH)).unwrap();
    assert_eq!(
        events.lines().count(),
        24,
        "twelve raises and twelve answers, none twice"
    );
}

/// A host whose configuration does not enable human items serves the engine's
/// own `unavailable` refusal on every route, as the CLI refuses.
#[test]
fn a_host_that_has_not_enabled_human_items_is_refused_on_every_route() {
    let world = World::configured(false);
    let server = world.serve(Some("manager-off"));
    for response in [
        http::get(server.address, "/api/human-items"),
        http::get(server.address, "/api/human-items/hi-0000000000000000000a"),
        http::post(
            server.address,
            "/api/human-items/hi-0000000000000000000a/complete",
            "{}",
        ),
        http::post(
            server.address,
            "/api/human-items/hi-0000000000000000000a/dismiss",
            "",
        ),
        http::post(
            server.address,
            "/api/human-items/hi-0000000000000000000a/answer",
            r#"{"text":"x"}"#,
        ),
        http::post(
            server.address,
            "/api/human-items/answers",
            r#"{"answers":[{"id":"hi-0000000000000000000a","text":"x"}]}"#,
        ),
        // Off is off before a batch's shape is judged.
        http::post(
            server.address,
            "/api/human-items/answers",
            r#"{"answers":[]}"#,
        ),
        http::post(
            server.address,
            "/api/human-items",
            &input(
                "manager-off",
                "x",
                "task",
                "low",
                json!({"scope": "nothing"}),
            )
            .to_string(),
        ),
    ] {
        assert_eq!(
            error(&response, 503, "human_items_unavailable"),
            "human-items unavailable against live state"
        );
    }
    assert!(!world.cli(None, &["human-items", "list"]).status.success());
}

/// The configuration is read for every request, so a host that turns human
/// items off under a running server is refused from its next request on, one
/// whose configuration cannot be read is refused naming it, and one that turns
/// them back on is served again — the same journal, untouched.
#[test]
fn a_configuration_changed_under_a_running_server_is_the_one_its_next_request_acts_under() {
    let world = World::new();
    let owner = "manager-reconfigured";
    let id = world.raise(
        owner,
        &input(
            owner,
            "kept",
            "question",
            "low",
            json!({"scope": "nothing"}),
        ),
    );
    let server = world.serve(Some(owner));
    assert_eq!(
        ids(&items(&http::get(server.address, "/api/human-items"))),
        std::slice::from_ref(&id)
    );
    let path = world.base().join("config/onepipeline/config.yaml");
    let enabled = std::fs::read_to_string(&path).expect("the configuration");
    std::fs::write(&path, enabled.replace("enabled: true", "enabled: false"))
        .expect("disable human items");
    error(
        &http::get(server.address, "/api/human-items"),
        503,
        "human_items_unavailable",
    );
    error(
        &http::post(
            server.address,
            &format!("/api/human-items/{id}/answer"),
            r#"{"text":"x"}"#,
        ),
        503,
        "human_items_unavailable",
    );
    // A configuration the engine cannot read is refused in its own words,
    // naming the file, until it is corrected.
    std::fs::write(&path, "human_items: [not, a, mapping]\n").expect("break the configuration");
    let refused = error(
        &http::get(server.address, "/api/human-items"),
        409,
        "human_item_conflict",
    );
    assert!(refused.contains("config.yaml"), "{refused}");
    std::fs::write(&path, &enabled).expect("enable human items again");
    assert_eq!(
        ids(&items(&http::get(server.address, "/api/human-items"))),
        std::slice::from_ref(&id)
    );
    assert_eq!(
        world.stored(&id)["state"],
        "open",
        "the refused answer wrote nothing"
    );
}

/// A server whose working directory was removed before it started has no
/// directory to read the human-items configuration from. Every human-item route
/// says so rather than reading some other directory's configuration in its
/// place, and what the server serves beside them still answers.
#[test]
fn a_server_started_in_a_removed_directory_refuses_human_items_naming_why() {
    let (workspace, runs) = fixture_run::workspace();
    let gone = workspace.path().join("gone");
    std::fs::create_dir(&gone).expect("a directory to start in");
    let binary = assert_cmd::cargo::cargo_bin("onepipeline-api");
    // The shell enters the directory, removes it, and execs the server there,
    // which is the only way a process starts with a working directory that no
    // longer exists.
    let mut child = Command::new("sh")
        .args([
            "-c",
            r#"cd "$1" && rmdir "$1" && exec "$2" serve --runs-root "$3" --bind 127.0.0.1:0"#,
            "sh",
        ])
        .arg(&gone)
        .arg(&binary)
        .arg(&runs)
        .env_remove(onepipeline_ui::cli::SESSION_ENV)
        .env("XDG_CONFIG_HOME", workspace.path().join("config"))
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("sh runs");
    let address = crate::serving::address_of(&mut child);
    assert!(!gone.exists(), "the server's directory is gone");
    let refused = error(
        &http::get(address, "/api/human-items"),
        503,
        "human_items_unavailable",
    );
    assert!(
        refused.contains("the directory this server was started in cannot be read"),
        "{refused}"
    );
    error(
        &http::post(
            address,
            "/api/human-items/hi-0000000000000000000a/answer",
            r#"{"text":"x"}"#,
        ),
        503,
        "human_items_unavailable",
    );
    assert_eq!(http::get(address, "/healthz").status, 200);
    child.kill().expect("stop the server");
    child.wait().expect("reap the server");
}

/// A question offering `choices`, each `(id, title)`, otherwise as [`input`] raises one.
fn question_offering(session: &str, dedup: &str, choices: &[(&str, &str)]) -> Value {
    let mut raised = input(
        session,
        dedup,
        "question",
        "low",
        json!({"scope": "nothing"}),
    );
    raised["choices"] = choices
        .iter()
        .map(|(id, title)| json!({"id": id, "title": title, "description": format!("Why *{title}*.")}))
        .collect();
    raised
}

/// One answer route takes a choice, words, or both, and refuses as it always has.
#[test]
fn a_single_answer_takes_a_choice_words_or_both_and_keeps_its_refusals() {
    let world = World::new();
    let owner = "manager";
    let offered = [("eu", "Europe"), ("us", "United States")];
    let [choice, words, both, stray] = ["choice", "words", "both", "stray"]
        .map(|dedup| world.raise(owner, &question_offering(owner, dedup, &offered)));
    let server = world.serve(Some(owner));
    let answer = |id: &str, body: Value| {
        http::post(
            server.address,
            &format!("/api/human-items/{id}/answer"),
            &body.to_string(),
        )
    };

    for (id, body, picked, text) in [
        (&choice, json!({"choice": "eu"}), json!("eu"), Value::Null),
        (
            &words,
            json!({"choice": null, "text": "Neither"}),
            Value::Null,
            json!("Neither"),
        ),
        (
            &both,
            json!({"choice": "us", "text": "For now"}),
            json!("us"),
            json!("For now"),
        ),
    ] {
        let response = answer(id, body);
        assert_eq!(response.status, 200, "{}", response.body);
        assert!(response.json()["event_id"].is_string(), "{}", response.body);
        let stored = world.stored(id);
        assert_eq!(stored["state"], "answered");
        assert_eq!(
            stored["resolution"]["choice"],
            if picked.is_null() {
                Value::Null
            } else {
                picked
            }
        );
        assert_eq!(stored["resolution"]["text"], text);
        assert_eq!(
            stored["resolution"]["actor"],
            format!("browser:session:{owner}")
        );
    }

    assert!(error(
        &answer(&stray, json!({"choice": "mars"})),
        409,
        "human_item_conflict"
    )
    .contains("mars"));
    error(
        &answer(&stray, json!({"text": "   "})),
        409,
        "human_item_conflict",
    );
    error(&answer(&stray, json!({})), 409, "human_item_conflict");
    error(
        &answer(&choice, json!({"choice": "us"})),
        409,
        "human_item_conflict",
    );
    error(
        &answer("hi-0000000000000000000a", json!({"choice": "eu"})),
        404,
        "human_item_not_found",
    );
    error(
        &answer(&stray, json!({"text": "x", "actor": "someone"})),
        422,
        "invalid_request",
    );
    assert_eq!(world.stored(&stray)["state"], "open");
}

/// One request is the engine's one batch: a mixed one answers what it can, tells
/// the rest why, and reaches the owner's watch as events carrying one batch id.
#[test]
fn a_batch_answers_what_it_can_and_reports_every_refusal_in_the_engines_receipt() {
    let world = World::new();
    let owner = "manager";
    let offered = [("eu", "Europe"), ("us", "United States")];
    let [choice, words, both, wrong, settled] = ["choice", "words", "both", "wrong", "settled"]
        .map(|dedup| world.raise(owner, &question_offering(owner, dedup, &offered)));
    world.ok(Some(owner), &["human-items", "dismiss", &settled]);
    world.watch(owner);
    let server = world.serve(None);
    let batch = json!({"answers": [
        {"id": choice, "choice": "eu"},
        {"id": words, "choice": null, "text": "Neither"},
        {"id": both, "choice": "us", "text": "For now"},
        {"id": wrong, "choice": "mars"},
        {"id": settled, "text": "Too late"},
        {"id": "hi-0000000000000000000a", "text": "Nobody"},
    ]});

    let response = http::post(
        server.address,
        "/api/human-items/answers",
        &batch.to_string(),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let receipt = response.json();
    let batch_id = receipt["batch"]
        .as_str()
        .expect("an accepted batch's id")
        .to_owned();
    assert_eq!(
        receipt["answered"]
            .as_array()
            .expect("answered")
            .iter()
            .map(|r| id_of(&r["item"]))
            .collect::<Vec<_>>(),
        [choice.clone(), words.clone(), both.clone()]
    );
    let refused = receipt["refused"].as_array().expect("refused");
    assert_eq!(
        refused
            .iter()
            .map(|r| r["id"].as_str().expect("an id"))
            .collect::<Vec<_>>(),
        [wrong.as_str(), settled.as_str(), "hi-0000000000000000000a"]
    );
    assert!(refused[0]["refusal"]["reason"]
        .as_str()
        .expect("a reason")
        .contains("mars"));
    assert_eq!(world.stored(&wrong)["state"], "open");
    assert_eq!(world.stored(&settled)["state"], "dismissed");
    assert_eq!(world.stored(&choice)["resolution"]["actor"], "browser");
    assert_eq!(world.stored(&choice)["resolution"]["choice"], "eu");
    assert_eq!(world.stored(&both)["resolution"]["text"], "For now");

    let delivered = world.watch(owner);
    assert_eq!(delivered.len(), 3, "{delivered:?}");
    for event in &delivered {
        assert_eq!(
            event["payload"]["batch"]["id"],
            batch_id.as_str(),
            "{event}"
        );
        assert_eq!(event["payload"]["batch"]["size"], 3, "{event}");
    }

    // Every entry refused is still a receipt, and it carries no batch id.
    let response = http::post(
        server.address,
        "/api/human-items/answers",
        &json!({"answers": [{"id": wrong, "choice": "mars"}]}).to_string(),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let receipt = response.json();
    assert!(receipt.get("batch").is_none(), "{receipt}");
    assert_eq!(receipt["answered"], json!([]));
    assert_eq!(receipt["refused"].as_array().expect("refused").len(), 1);
}

/// A batch malformed as a whole is the error contract, and writes nothing.
#[test]
fn a_malformed_batch_is_refused_whole_with_nothing_written() {
    let world = World::new();
    let owner = "manager";
    let question = world.raise(
        owner,
        &question_offering(owner, "open", &[("eu", "Europe")]),
    );
    let journal = world
        .base()
        .join(fixture_run::RUNS_DIR)
        .join(onepipeline::human_items::JOURNAL_PATH);
    let before = std::fs::read(&journal).expect("the journal");
    let server = world.serve(Some(owner));
    let many: Vec<Value> = (0..51)
        .map(|n| json!({"id": format!("hi-{n:020x}"), "text": "x"}))
        .collect();
    for body in [
        json!({"answers": []}),
        json!({"answers": many}),
        json!({"answers": [{"id": question, "text": "a"}, {"id": question, "text": "b"}]}),
        json!({"answers": [{"id": question}]}),
        json!({"answers": [{"id": question, "choice": null, "text": null}]}),
        json!({"answers": [{"id": question, "text": "   "}]}),
        json!({"answers": [{"id": "not an id", "text": "x"}]}),
        json!({"answers": [{"id": question, "text": "x", "actor": "someone"}]}),
    ] {
        error(
            &http::post(
                server.address,
                "/api/human-items/answers",
                &body.to_string(),
            ),
            422,
            "invalid_request",
        );
    }
    error(
        &http::post(server.address, "/api/human-items/answers", "not json"),
        422,
        "invalid_request",
    );
    assert_eq!(
        std::fs::read(&journal).expect("the journal"),
        before,
        "nothing was written"
    );
    assert_eq!(world.stored(&question)["state"], "open");
}

/// What each human-item route served from the live engine, held to the
/// goldens `tests/contract.rs` maps to the route table and reconciles with the
/// engine's own types. Timestamps are the clock's and are pinned before the
/// comparison; everything else — ids, event ids, order, counts — is the
/// engine's own deterministic answer. `UPDATE_CONTRACT_FIXTURES=1` rewrites them.
#[test]
fn every_human_item_route_serves_the_payload_its_golden_pins() {
    let world = World::new();
    let owner = "claude-code-supervising-session";
    let plan = release_plan(&world, "golden");
    let run = world.start(owner, &plan);
    let canary = id_of(
        world
            .listed(&[])
            .iter()
            .find(|v| v["item"]["kind"] == "question")
            .expect("the region question"),
    );
    let host = world.raise(
        owner,
        &input(owner, "outage", "task", "urgent", json!({"scope": "host"})),
    );
    let gate = id_of(
        world
            .listed(&["--run", &run])
            .iter()
            .find(|v| v["item"]["dedup_key"] == format!("run:{run}#gate"))
            .unwrap(),
    );
    let server = world.serve(Some(owner));
    let raise = input(
        owner,
        "nightly",
        "question",
        "low",
        json!({"scope": "nothing"}),
    )
    .to_string();
    let goldens = [
        (
            "human-items.json",
            http::get(server.address, "/api/human-items"),
        ),
        (
            "human-item.json",
            http::get(server.address, &format!("/api/human-items/{gate}")),
        ),
        (
            "human-items-raise.json",
            http::post(server.address, "/api/human-items", &raise),
        ),
        (
            "human-item-answer.json",
            http::post(
                server.address,
                &format!("/api/human-items/{canary}/answer"),
                r#"{"text":"eu-west"}"#,
            ),
        ),
        (
            "human-item-answers.json",
            http::post(
                server.address,
                "/api/human-items/answers",
                &json!({"answers": [{"id": onepipeline::human_items::item_id_for("nightly"), "text": "Yes"}]}).to_string(),
            ),
        ),
        (
            "human-item-complete.json",
            http::post(
                server.address,
                &format!("/api/human-items/{gate}/complete"),
                "{}",
            ),
        ),
        (
            "human-item-dismiss.json",
            http::post(
                server.address,
                &format!("/api/human-items/{host}/dismiss"),
                "{}",
            ),
        ),
        (
            "human-item-note.json",
            http::post(
                server.address,
                &format!("/api/human-items/{host}/note"),
                r#"{"text":"The outage ended on its own."}"#,
            ),
        ),
        (
            "human-item-reopen.json",
            http::post(
                server.address,
                &format!("/api/human-items/{host}/reopen"),
                "{}",
            ),
        ),
    ];
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for (name, response) in goldens {
        assert_eq!(response.status, 200, "{name}: {}", response.body);
        let mut served = response.json();
        pin_clock(&mut served);
        let served = format!(
            "{}\n",
            serde_json::to_string_pretty(&served).expect("serialize")
        );
        let path = dir.join(name);
        if std::env::var_os("UPDATE_CONTRACT_FIXTURES").is_some() {
            std::fs::write(&path, &served).expect("write the golden");
        }
        assert_eq!(
            std::fs::read_to_string(&path).unwrap_or_default(),
            served,
            "{name} differs from what the route served; rerun with UPDATE_CONTRACT_FIXTURES=1 if \
             the change is deliberate"
        );
    }
}

/// The human-items view's answer and its frame are what the golden pins, which
/// `@onepipeline-ui/dag-model`'s journey reads through its own parsers: the
/// answer naming an open item, a patch that resolves it, and one that takes it
/// away.
#[test]
fn the_served_human_items_view_and_its_frame_are_the_golden_the_contract_pins() {
    let world = World::new();
    let item = raised(&world, "pinned", "question");
    let server = world.serve(Some("manager-of-items"));
    let view = json!({ "type": "human-items", "filter": { "kind": "question" }, "item": item });
    let subscribed = subscribe(&server, &json!({ "view": view }));
    let mut tab = HumanItemsTab::over(&server, view, &subscribed);
    world.ok(
        None,
        &["human-items", "answer", &item, "--text", "go ahead"],
    );
    let resolved = tab.receive(PATIENCE).expect("the answer's patch");
    let directory = world.root.join("human-items");
    std::fs::rename(&directory, world.root.join("human-items.away")).expect("take the items away");
    let vanished = tab.receive(PATIENCE).expect("the vanishing's patch");

    let (epoch, _) = tab.applied.split_once(':').expect("epoch:seq");
    let render = json!({ "subscribed": subscribed, "frames": [resolved, vanished] })
        .to_string()
        .replace(&tab.subscription, "00000000-0000-4000-8000-00000005ab00")
        .replace(epoch, "00000000-0000-4000-8000-0000000e9c00");
    let mut served: Value = serde_json::from_str(&render).expect("still JSON");
    pin_clock(&mut served);
    // A patch names the instant it moved as an op's value, not under its key.
    for frame in served["frames"].as_array_mut().expect("frames") {
        for op in frame["ops"].as_array_mut().expect("ops") {
            if op["p"].as_array().and_then(|path| path.last()) == Some(&json!("updated_at")) {
                op["v"] = json!("2026-01-01T00:00:00.000Z");
            }
        }
    }
    let served = format!(
        "{}\n",
        serde_json::to_string_pretty(&served).expect("serialize")
    );
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/subscription-human-items.json");
    if std::env::var_os("UPDATE_CONTRACT_FIXTURES").is_some() {
        std::fs::write(&path, &served).expect("write the golden");
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap_or_default(),
        served,
        "the human-items view differs from its golden; rerun with UPDATE_CONTRACT_FIXTURES=1 if \
         the change is deliberate"
    );
}

/// Every timestamp the clock chose, pinned.
fn pin_clock(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, held) in map.iter_mut() {
                if matches!(key.as_str(), "created_at" | "updated_at") && held.is_string() {
                    *held = json!("2026-01-01T00:00:00.000Z");
                } else if key == "batch" && held.is_string() {
                    // Minted fresh per batch; a golden pins that one is there.
                    *held = json!("golden-batch");
                } else {
                    pin_clock(held);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(pin_clock),
        _ => {}
    }
}

/// How long a stream gets to send a frame before a journey fails: only a stream
/// that never sends one fails, because how long the server takes is not what a
/// journey holds it to.
const PATIENCE: Duration = Duration::from_secs(60);
/// How long a stream is watched to say it sent nothing: several polls.
const QUIET: Duration = Duration::from_secs(2);

/// A tab's one subscription to a view, holding the state its frames patch.
struct HumanItemsTab {
    subscription: String,
    /// Its open stream, or `None` while it is disconnected.
    stream: Option<http::Stream>,
    applied: String,
    state: Value,
    view: Value,
}

impl HumanItemsTab {
    fn open(server: &Serving, view: Value) -> Self {
        let subscribed = subscribe(server, &json!({ "view": view }));
        assert_eq!(subscribed["initial"]["type"], "snapshot");
        Self::over(server, view, &subscribed)
    }

    fn over(server: &Serving, view: Value, subscribed: &Value) -> Self {
        let state = subscribed["initial"]["snapshot"].clone();
        let subscription = subscribed["subscription"]
            .as_str()
            .expect("a subscription id")
            .to_owned();
        let applied = state["id"].as_str().expect("a snapshot id").to_owned();
        let mut tab = Self {
            subscription,
            stream: None,
            applied,
            state,
            view,
        };
        tab.connect(server);
        tab
    }

    /// Open the stream from the last frame this tab applied.
    fn connect(&mut self, server: &Serving) {
        let stream = http::stream(
            server.address,
            &format!(
                "/api/v2/events?subscription={}&after={}",
                self.subscription, self.applied
            ),
            None,
        );
        assert_eq!(stream.status, 200);
        self.stream = Some(stream);
    }

    /// The next frame within `patience`, checked against its framing and applied.
    fn receive(&mut self, patience: Duration) -> Option<Value> {
        let frame = self
            .stream
            .as_mut()
            .expect("a connected tab")
            .frame_within(patience)?;
        let data = frame.json();
        assert_eq!(frame.id, data["id"], "the SSE id is the frame's id");
        assert_eq!(
            frame.event, data["type"],
            "the SSE event is the frame's type"
        );
        assert_eq!(data["subscription"], self.subscription.as_str());
        assert_eq!(
            data["base"],
            self.applied.as_str(),
            "each frame names the last"
        );
        match data["type"].as_str() {
            Some("human-items.patch") => {
                assert_eq!(
                    data.as_object().expect("a frame").len(),
                    5,
                    "id, base, subscription, type and ops, and no run: {data}"
                );
                let ops: Vec<Op> = data["ops"]
                    .as_array()
                    .expect("ops")
                    .iter()
                    .map(|op| Op::from_json(op).expect("an op the contract allows"))
                    .collect();
                patch::apply(&mut self.state["visible"], &ops).expect("the patch applies");
            }
            Some("run.changed" | "run.removed") => {}
            other => panic!("a human-items stream sent {other:?}: {data}"),
        }
        self.applied = data["id"].as_str().expect("an id").to_owned();
        Some(data)
    }

    /// Read until the view holds what `server`'s routes now answer; a stream
    /// that goes quiet before then has lost a change.
    fn until_current(&mut self, server: &Serving) {
        let wanted = routes_answer(server, &self.view);
        while self.state["visible"] != wanted {
            assert!(
                self.receive(PATIENCE).is_some(),
                "the stream went quiet with the view at {} and the routes at {wanted}",
                self.state["visible"],
            );
        }
    }

    /// Every human-item frame read until the stream goes quiet.
    fn drain(&mut self) -> Vec<Value> {
        let mut read = Vec::new();
        while let Some(frame) = self.receive(QUIET) {
            if frame["type"] == "human-items.patch" {
                read.push(frame);
            }
        }
        read
    }
}

fn subscribe(server: &Serving, body: &Value) -> Value {
    let response = http::post(server.address, "/api/v2/subscriptions", &body.to_string());
    assert_eq!(response.status, 201, "{body}: {}", response.body);
    response.json()
}

/// What `view`'s `visible` should hold, as the two human-item routes answer it.
fn routes_answer(server: &Serving, view: &Value) -> Value {
    let mut query = String::new();
    for (selector, value) in view["filter"].as_object().into_iter().flatten() {
        let value = value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned);
        query.push_str(&format!("{selector}={value}&"));
    }
    let list = http::get(server.address, &format!("/api/human-items?{query}"));
    assert_eq!(list.status, 200, "{}", list.body);
    let detail = view["item"].as_str().map_or(Value::Null, |id| {
        let read = http::get(server.address, &format!("/api/human-items/{id}"));
        if read.status == 404 {
            Value::Null
        } else {
            assert_eq!(read.status, 200, "{}", read.body);
            read.json()
        }
    });
    json!({ "type": "human-items", "items": list.json()["items"], "detail": detail })
}

/// An owned item of `kind`, raised through the real CLI.
fn raised(world: &World, dedup: &str, kind: &str) -> String {
    let session = "manager-of-items";
    world.raise(
        session,
        &input(session, dedup, kind, "medium", json!({"scope": "nothing"})),
    )
}

/// The view's snapshot and every frame after it are what the routes answer, as
/// the real CLI raises, answers, completes and dismisses, whichever view a tab
/// holds, and a tab whose filter excludes a change is sent nothing for it.
#[test]
fn a_human_items_view_follows_every_cli_write_to_what_the_routes_answer() {
    let world = World::new();
    let question = raised(&world, "opening", "question");
    let server = world.serve(Some("manager-of-items"));

    let mut unfiltered = HumanItemsTab::open(&server, json!({ "type": "human-items" }));
    assert_eq!(
        unfiltered.state["visible"],
        routes_answer(&server, &unfiltered.view),
        "the snapshot is the routes' answer"
    );
    assert_eq!(
        unfiltered.state["visible"]["items"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(unfiltered.state["visible"]["detail"], Value::Null);
    assert!(
        unfiltered.state["sidebar"].is_array(),
        "it still carries the sidebar"
    );
    let mut questions = HumanItemsTab::open(
        &server,
        json!({ "type": "human-items", "filter": { "kind": "question" } }),
    );
    let mut opened =
        HumanItemsTab::open(&server, json!({ "type": "human-items", "item": question }));
    assert_eq!(
        opened.state["visible"]["detail"]["item"]["id"],
        question.as_str()
    );
    assert_eq!(
        opened.state["visible"],
        routes_answer(&server, &opened.view)
    );
    let mut answered = HumanItemsTab::open(
        &server,
        json!({ "type": "human-items", "filter": { "state": "answered" } }),
    );

    assert!(
        unfiltered.drain().is_empty(),
        "a journal untouched sends nothing"
    );

    // A task, which the question filter and the answered filter both exclude.
    let task = raised(&world, "second", "task");
    unfiltered.until_current(&server);
    assert_eq!(
        unfiltered.state["visible"]["items"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    opened.until_current(&server);
    assert!(
        questions.drain().is_empty(),
        "the filter excludes that change"
    );
    assert!(
        answered.drain().is_empty(),
        "the filter excludes that change"
    );

    world.ok(
        None,
        &["human-items", "answer", &question, "--text", "go ahead"],
    );
    unfiltered.until_current(&server);
    assert_eq!(
        unfiltered.state["visible"]["items"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    questions.until_current(&server);
    assert_eq!(
        questions.state["visible"]["items"].as_array().map(Vec::len),
        Some(0)
    );
    answered.until_current(&server);
    assert_eq!(
        answered.state["visible"]["items"].as_array().map(Vec::len),
        Some(1)
    );
    opened.until_current(&server);
    assert_eq!(
        opened.state["visible"]["detail"]["item"]["state"],
        "answered"
    );

    world.ok(None, &["human-items", "complete", &task]);
    unfiltered.until_current(&server);
    let dismissed = raised(&world, "third", "task");
    unfiltered.until_current(&server);
    world.ok(
        None,
        &["human-items", "dismiss", &dismissed, "--reason", "not now"],
    );
    unfiltered.until_current(&server);
    assert_eq!(
        unfiltered.state["visible"]["items"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );

    // A write through this server's own route arrives the same way.
    let another = raised(&world, "fourth", "question");
    unfiltered.until_current(&server);
    let answer = http::post(
        server.address,
        &format!("/api/human-items/{another}/answer"),
        &json!({ "text": "through the route" }).to_string(),
    );
    assert_eq!(answer.status, 200, "{}", answer.body);
    unfiltered.until_current(&server);

    // A view replaced for another: the old stream ends, the new view holds.
    let replaced = subscribe(
        &server,
        &json!({
            "view": { "type": "human-items", "filter": { "state": "completed" } },
            "replaces": unfiltered.subscription,
        }),
    );
    assert_eq!(
        replaced["view"],
        json!({ "type": "human-items", "filter": { "state": "completed" } }),
        "the view is served back as it was asked for"
    );
    let completed = HumanItemsTab::over(
        &server,
        json!({ "type": "human-items", "filter": { "state": "completed" } }),
        &replaced,
    );
    assert_eq!(
        completed.state["visible"],
        routes_answer(&server, &completed.view)
    );
}

/// A sidebar or run-view subscription carries no human-item state, is sent no
/// human-item frame, and reads nothing for them: the engine's first read of a
/// host's items makes their directory, so no such directory means no read.
#[test]
fn only_a_human_items_view_is_sent_human_items_and_only_it_reads_them() {
    let world = World::new();
    fixture_run::write(&world.root, fixture_run::RUN_ID);
    let server = world.serve(Some("manager-of-items"));
    let directory = world.root.join("human-items");
    let mut sidebar = http::stream(
        server.address,
        &format!(
            "/api/v2/events?subscription={}",
            subscribe(&server, &json!({ "view": { "type": "sidebar" } }))["subscription"]
                .as_str()
                .expect("an id")
        ),
        None,
    );
    let run_view = subscribe(
        &server,
        &json!({ "view": { "type": "detail", "run_id": fixture_run::RUN_ID } }),
    );
    let snapshot = &run_view["initial"]["snapshot"]["visible"];
    assert!(snapshot.get("items").is_none(), "{snapshot}");
    let mut detail = http::stream(
        server.address,
        &format!(
            "/api/v2/events?subscription={}",
            run_view["subscription"].as_str().expect("an id")
        ),
        None,
    );
    while sidebar.frame_within(QUIET).is_some() {}
    assert!(
        !directory.exists(),
        "a server no tab of which shows human items read them"
    );

    // The CLI writes while those tabs are connected, beside a tab that shows them.
    raised(&world, "beside", "task");
    let mut shown = HumanItemsTab::open(&server, json!({ "type": "human-items" }));
    raised(&world, "beside-too", "task");
    shown.until_current(&server);
    for stream in [&mut sidebar, &mut detail] {
        while let Some(frame) = stream.frame_within(QUIET) {
            assert_ne!(frame.event, "human-items.patch", "{}", frame.json());
        }
    }
}

/// A reconnect loses no change and replays none; a cursor the subscription
/// cannot resume from is one reset to what the routes then answer, patches
/// following; and a tab whose subscription is gone is reset by recreating it.
#[test]
fn a_human_items_stream_resumes_every_change_or_resets_to_what_the_routes_answer() {
    let world = World::new();
    raised(&world, "first", "task");
    let server = world.serve(Some("manager-of-items"));
    let mut tab = HumanItemsTab::open(&server, json!({ "type": "human-items" }));

    // Written while no stream is open, and replayed once it is.
    tab.stream = None;
    raised(&world, "while-away", "task");
    // Twice, so a reconnect has more than one frame to replay: each write waits
    // on a fresh subscriber's frame, so the away tab has recorded it too.
    let mut witness = HumanItemsTab::open(&server, json!({ "type": "human-items" }));
    raised(&world, "while-away-too", "task");
    witness.until_current(&server);
    tab.connect(&server);
    let mut replayed = 0;
    while tab.state["visible"] != routes_answer(&server, &tab.view) {
        tab.receive(PATIENCE).expect("every change it missed");
        replayed += 1;
    }
    assert!(replayed >= 2, "{replayed} frames replayed");
    assert!(tab.drain().is_empty(), "nothing replayed twice");

    // A cursor it never issued, with a change it has not been sent.
    raised(&world, "behind-the-cursor", "task");
    witness.until_current(&server);
    let (epoch, _) = tab.applied.split_once(':').expect("epoch:seq");
    let refused = format!("{epoch}:999999");
    let mut reset = http::stream(
        server.address,
        &format!(
            "/api/v2/events?subscription={}&after={refused}",
            tab.subscription
        ),
        None,
    );
    let frame = reset.frame_within(PATIENCE).expect("a reset").json();
    assert_eq!(frame["type"], "reset");
    assert_eq!(frame["reason"], "unknown-cursor");
    assert_eq!(frame["base"], refused.as_str());
    assert_eq!(
        frame["snapshot"]["visible"],
        routes_answer(&server, &tab.view)
    );
    tab.stream = Some(reset);
    tab.state = frame["snapshot"].clone();
    tab.applied = frame["id"].as_str().expect("an id").to_owned();
    let after_reset = raised(&world, "after-the-reset", "task");
    tab.until_current(&server);
    assert!(
        tab.state["visible"]["items"]
            .as_array()
            .expect("items")
            .iter()
            .any(|view| view["item"]["id"] == after_reset.as_str()),
        "patches follow the reset"
    );

    // The subscription is gone: its recreation answers a reset of its own.
    let cursor = tab.applied.clone();
    let retired = http::delete(
        server.address,
        &format!("/api/v2/subscriptions/{}", tab.subscription),
    );
    assert_eq!(retired.status, 204);
    let recreated = subscribe(
        &server,
        &json!({ "view": { "type": "human-items" }, "resume": cursor }),
    );
    assert_eq!(recreated["initial"]["type"], "reset");
    assert_eq!(recreated["initial"]["reason"], "unknown-cursor");
    assert_eq!(
        recreated["initial"]["snapshot"]["visible"],
        routes_answer(&server, &tab.view)
    );
}

/// A cursor older than what the subscription retains is a `stale-cursor` reset
/// to what the routes then answer, with patches following it.
#[test]
fn a_stale_human_items_cursor_is_reset_to_what_the_routes_answer() {
    let world = World::new();
    // Sidebar rows are the cheapest frames a subscription records: a run going
    // away and coming back with the summary its journal matches, as the same
    // journey over a sidebar view makes them.
    let runs: Vec<String> = (0..64)
        .map(|index| format!("retained-{index:02}"))
        .collect();
    for run in &runs {
        fixture_run::write(&world.root, run);
        live_journal::receipt_for(&world.root.join(run).join("events.jsonl"));
    }
    let grace = Duration::from_secs(24 * 60 * 60).as_millis().to_string();
    let environment: Vec<(String, String)> = world.environment();
    let mut environment: Vec<(&str, &str)> = environment
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    environment.push((onepipeline_ui::live::DISCONNECTED_GRACE_ENV, &grace));
    let (served, _) = world.workspace_view();
    let server = Serving::start_in_as_with_env_removing(
        served,
        "manager-of-items",
        &environment,
        &World::foreign(),
    );
    let subscribed = subscribe(&server, &json!({ "view": { "type": "human-items" } }));
    let cursor = subscribed["initial"]["snapshot"]["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let subscription = subscribed["subscription"]
        .as_str()
        .expect("an id")
        .to_owned();
    // A second tab, connected, counts what the first records while away.
    let mut counter = HumanItemsTab::open(&server, json!({ "type": "human-items" }));
    let listed = |frames: &mut usize, counter: &mut HumanItemsTab, kind: &str| {
        let mut seen = 0;
        while seen < runs.len() {
            let frame = counter.receive(PATIENCE).expect("a sidebar frame");
            *frames += 1;
            if frame["type"] == kind {
                seen += 1;
            }
        }
    };
    let mut frames = 0;
    let journals: Vec<(PathBuf, PathBuf)> = runs
        .iter()
        .map(|run| {
            let journal = world.root.join(run).join("events.jsonl");
            let away = journal.with_extension("jsonl.away");
            (journal, away)
        })
        .collect();
    while frames <= onepipeline_ui::contract::RETAINED_FRAMES {
        for (journal, away) in &journals {
            std::fs::rename(journal, away).expect("take a journal away");
        }
        listed(&mut frames, &mut counter, "run.removed");
        for (journal, away) in &journals {
            std::fs::rename(away, journal).expect("put a journal back");
        }
        listed(&mut frames, &mut counter, "run.changed");
    }
    raised(&world, "after-the-boundary", "task");
    counter.until_current(&server);

    let mut stream = http::stream(
        server.address,
        &format!("/api/v2/events?subscription={subscription}&after={cursor}"),
        None,
    );
    let frame = stream.frame_within(PATIENCE).expect("a reset").json();
    assert_eq!(frame["type"], "reset");
    assert_eq!(frame["reason"], "stale-cursor");
    let view = json!({ "type": "human-items" });
    assert_eq!(frame["snapshot"]["visible"], routes_answer(&server, &view));
    let mut resumed = HumanItemsTab {
        subscription,
        stream: Some(stream),
        applied: frame["id"].as_str().expect("an id").to_owned(),
        state: frame["snapshot"].clone(),
        view,
    };
    raised(&world, "after-the-reset", "task");
    resumed.until_current(&server);
}

/// A filter that selects by nothing is no filter: the answer names none, and the
/// view is the unfiltered one, the same list as a subscription that named none.
#[test]
fn an_empty_human_items_filter_is_normalized_away() {
    let world = World::new();
    raised(&world, "listed", "task");
    let server = world.serve(Some("manager-of-items"));
    let unfiltered = json!({ "type": "human-items" });
    let subscribed = subscribe(
        &server,
        &json!({ "view": { "type": "human-items", "filter": {} } }),
    );
    assert_eq!(subscribed["view"], unfiltered);
    assert_eq!(
        subscribed["initial"]["snapshot"]["visible"],
        routes_answer(&server, &unfiltered)
    );
}

/// A malformed selector is refused like every other view; an item that no
/// longer reads is `detail: null` rather than a refusal, and one that vanishes
/// under an open tab patches `detail` to `null`.
#[test]
fn a_bad_selector_is_refused_and_an_item_that_does_not_read_is_null() {
    let world = World::new();
    let item = raised(&world, "vanishing", "task");
    let server = world.serve(Some("manager-of-items"));
    for view in [
        json!({ "type": "human-items", "filter": { "kind": "chore" } }),
        json!({ "type": "human-items", "filter": { "priority": "whenever" } }),
        json!({ "type": "human-items", "filter": { "state": "maybe" } }),
        json!({ "type": "human-items", "filter": { "blocking": "yes" } }),
        json!({ "type": "human-items", "filter": { "colour": "red" } }),
        json!({ "type": "human-items", "filter": "kind=task" }),
        json!({ "type": "human-items", "item": 7 }),
        json!({ "type": "human-items", "item": "../outside" }),
        json!({ "type": "human-items", "run_id": fixture_run::RUN_ID }),
    ] {
        let body = json!({ "view": view }).to_string();
        let response = http::post(server.address, "/api/v2/subscriptions", &body);
        assert_eq!(response.status, 400, "{body}: {}", response.body);
        assert_eq!(
            response.json()["error"]["code"],
            "invalid_subscription",
            "{body}"
        );
    }

    let never = subscribe(
        &server,
        &json!({ "view": { "type": "human-items", "item": "hi-0000000000000000000a" } }),
    );
    assert_eq!(
        never["initial"]["snapshot"]["visible"]["detail"],
        Value::Null,
        "an item that does not read is null, never a refused subscription"
    );

    let mut open = HumanItemsTab::open(&server, json!({ "type": "human-items", "item": item }));
    assert_eq!(open.state["visible"]["detail"]["item"]["id"], item.as_str());
    let directory = world.root.join("human-items");
    std::fs::rename(&directory, world.root.join("human-items.away")).expect("take the items away");
    let frame = open.receive(PATIENCE).expect("a patch");
    assert_eq!(frame["type"], "human-items.patch");
    assert_eq!(open.state["visible"]["detail"], Value::Null);
    assert_eq!(open.state["visible"], routes_answer(&server, &open.view));
}

/// A reset answers what the routes answer at that moment, not what the poll last
/// read, and what catching up for it moved is an ordinary frame to every tab on
/// the view. Its read refused, the reset re-sends what was last read rather than
/// failing, and the next read that can sends the rest.
#[test]
fn a_reset_catches_up_ahead_of_the_poll_and_rides_out_a_read_it_is_refused() {
    let world = World::new();
    raised(&world, "first", "task");
    let server = world.serve_without_polling("manager-of-items");
    let view = json!({ "type": "human-items" });
    let tab = HumanItemsTab::open(&server, view.clone());
    let mut beside = HumanItemsTab::open(&server, view.clone());
    let reset = |tab: &HumanItemsTab| {
        let (epoch, _) = tab.applied.split_once(':').expect("epoch:seq");
        let mut stream = http::stream(
            server.address,
            &format!(
                "/api/v2/events?subscription={}&after={epoch}:999999",
                tab.subscription
            ),
            None,
        );
        let frame = stream.frame_within(PATIENCE).expect("a reset").json();
        assert_eq!(frame["type"], "reset");
        assert_eq!(frame["reason"], "unknown-cursor");
        frame["snapshot"]["visible"].clone()
    };

    // No poll reads this write: the tabs hear nothing of it until a reset asks.
    raised(&world, "behind-the-poll", "task");
    assert!(beside.drain().is_empty(), "the poll came round");
    let caught_up = routes_answer(&server, &view);
    assert_eq!(reset(&tab), caught_up);
    beside.receive(PATIENCE).expect("the catching up's patch");
    assert_eq!(beside.state["visible"], caught_up);

    // Every read refused, with a write it has not read: the reset says what it
    // last read and the tab's subscription stays.
    raised(&world, "behind-a-refusal", "task");
    let written = routes_answer(&server, &view);
    let directory = world.root.join("human-items");
    let away = world.root.join("human-items.away");
    std::fs::rename(&directory, &away).expect("take the items away");
    std::fs::write(&directory, "not a directory").expect("a file in their place");
    assert_eq!(reset(&tab), caught_up);

    // Readable again: the next reset reads what the refused one could not.
    std::fs::remove_file(&directory).expect("remove the file");
    std::fs::rename(&away, &directory).expect("put the items back");
    assert_eq!(reset(&tab), written);
    assert_ne!(written, caught_up);
    beside.receive(PATIENCE).expect("the recovery's patch");
    assert_eq!(beside.state["visible"], written);
}

/// A journal that cannot be read under an open tab sends nothing and retires
/// nothing: the tab holds what it last showed, and the first poll that can read
/// again sends what it missed, on the same stream, with no resubscription.
#[test]
fn an_open_view_rides_out_a_journal_it_cannot_read_and_catches_up_on_the_same_stream() {
    let world = World::new();
    raised(&world, "before", "task");
    let server = world.serve(Some("manager-of-items"));
    let mut tab = HumanItemsTab::open(&server, json!({ "type": "human-items" }));
    let shown = tab.state["visible"].clone();

    // A directory where the engine opens its index lock refuses every read for
    // several polls. The items stay where they are throughout, so a poll landing
    // while the lock is swapped reads what the tab already shows.
    let lock = world.root.join("human-items").join("index.lock");
    let deadline = Instant::now() + PATIENCE;
    while std::fs::remove_file(&lock)
        .and_then(|()| std::fs::create_dir(&lock))
        .is_err()
    {
        assert!(Instant::now() < deadline, "a poll kept the index lock");
    }
    error(
        &http::get(server.address, "/api/human-items"),
        409,
        "human_item_conflict",
    );
    assert!(tab.drain().is_empty(), "a refused read sends nothing");
    assert_eq!(tab.state["visible"], shown);

    // Put back, with a change it has not read: a read that was refused was not
    // forgotten, so the same stream carries it with nothing asked of the tab.
    std::fs::remove_dir(&lock).expect("give the lock back");
    raised(&world, "after", "task");
    tab.until_current(&server);
    assert_eq!(
        tab.state["visible"]["items"].as_array().map(Vec::len),
        Some(2)
    );
}

/// A host that has not enabled human items refuses the view as it refuses every
/// human-item route, and still serves every other view.
#[test]
fn a_host_that_has_not_enabled_human_items_refuses_the_view() {
    let world = World::configured(false);
    let server = world.serve(Some("manager-off"));
    let body = json!({ "view": { "type": "human-items" } }).to_string();
    let refused = http::post(server.address, "/api/v2/subscriptions", &body);
    assert_eq!(
        error(&refused, 503, "human_items_unavailable"),
        "human-items unavailable against live state"
    );
    subscribe(&server, &json!({ "view": { "type": "sidebar" } }));
}
