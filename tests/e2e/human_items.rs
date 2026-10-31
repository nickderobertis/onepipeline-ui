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

use onepipeline::human_items::{HumanItemDetail, HumanItemReceipt, HumanItemView};
use serde_json::{json, Value};
use tempfile::TempDir;

use crate::fixture_run;
use crate::github_board::GitHubBoard;
use crate::http;
use crate::serving::Serving;
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
        let board = GitHubBoard::start(&base);
        let config = base.join("config");
        std::fs::create_dir_all(config.join("onepipeline")).expect("config dir");
        std::fs::create_dir_all(config.join("onetaskgraph")).expect("config dir");
        std::fs::create_dir_all(base.join("intents")).expect("intents dir");
        std::fs::create_dir_all(base.join("work")).expect("work dir");
        std::fs::write(base.join("design-keys.json"), "{}").expect("keys");
        let adapter = base.join("approve-design.py");
        std::fs::write(&adapter, APPROVAL_AUTHORITY).expect("the approval authority");
        std::fs::write(
            config.join("onepipeline/config.yaml"),
            format!(
                "human_items:\n  enabled: {enabled}\n  task_source: {BOARD}\n  \
                 approval_adapters:\n    approve-design:\n      command: [\"python3\", {adapter:?}, \
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

/// The approval authority a design review completes through: it keeps the
/// current version of each document (`argv[1]`) and, when asked to approve the
/// version it holds, appends the approval record (`argv[2]`) and answers that
/// version; asked about another, it records nothing and answers the current one.
const APPROVAL_AUTHORITY: &str = r#"import json, sys
request = json.load(sys.stdin)
current = json.load(open(sys.argv[1])).get(request["board_copy"])
if current is None:
    sys.exit(3)
if current == request["key"]:
    with open(sys.argv[2], "a") as log:
        log.write(json.dumps({"board_copy": request["board_copy"], "key": current,
                              "actor": request["actor"],
                              "on_behalf_of": request["on_behalf_of"]}) + "\n")
print(json.dumps({"board_copy": request["board_copy"], "key": current}))
"#;

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
fn a_queue_raised_across_ten_sessions_is_served_to_each_owner_in_the_engines_order() {
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
        assert_eq!(
            served, selected,
            "{session}'s list is what the CLI selects for it"
        );
        assert!(served
            .iter()
            .all(|view| view["item"]["owner"]["session"] == session.as_str()));
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
        let mut owned = ids(&served);
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
    let server = world.serve(Some(owner));
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
/// to the owning session's watch alone. A repeat is the engine's conflict and
/// writes nothing; an action of the wrong kind is refused and changes nothing.
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
            json!({"actor": owner, "on_behalf_of": null, "text": text, "reason": reason}),
            "{verb} is the acting session's own, on nobody's behalf"
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
            json!({"actor": format!("session:{owner}"), "on_behalf_of": format!("user:{USER}"), "text": text, "reason": reason})
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
            json!({"board_copy": "docs/design/action-items.md", "key": "sha256:5d1c0a", "actor": owner, "on_behalf_of": null}),
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

/// A long body is stored, served and printed whole: the CLI's list and report
/// print every line of it, questions included.
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
        let printed = world.ok(None, &["human-items", verb]);
        assert!(printed.contains(body.trim_end()), "{verb}: {printed}");
    }
}

/// Content and writes belong to the owning session: another session is
/// served neither its content nor any write to it, an unattributed server owns
/// nothing, and a raise as anyone but the acting session is refused — all
/// without changing the journal.
#[test]
fn another_sessions_items_are_neither_read_nor_written() {
    let world = World::new();
    let owner = "manager-owner";
    let mine = world.raise(
        owner,
        &input(
            owner,
            "mine",
            "question",
            "high",
            json!({"scope": "nothing"}),
        ),
    );
    let journal = world.root.join(onepipeline::human_items::JOURNAL_PATH);
    let before = std::fs::read(&journal).unwrap();
    for server in [world.serve(Some("manager-intruder")), world.serve(None)] {
        assert!(items(&http::get(server.address, "/api/human-items")).is_empty());
        let read = error(
            &http::get(server.address, &format!("/api/human-items/{mine}")),
            403,
            "human_item_not_owner",
        );
        assert!(!read.contains("Should mine"), "{read}");
        for (verb, body) in [
            ("answer", r#"{"text":"x"}"#),
            ("complete", "{}"),
            ("dismiss", "{}"),
        ] {
            error(
                &http::post(
                    server.address,
                    &format!("/api/human-items/{mine}/{verb}"),
                    body,
                ),
                403,
                "human_item_not_owner",
            );
        }
        error(
            &http::post(
                server.address,
                "/api/human-items",
                &input(owner, "forged", "task", "low", json!({"scope": "nothing"})).to_string(),
            ),
            403,
            "human_item_not_owner",
        );
    }
    assert_eq!(
        std::fs::read(&journal).unwrap(),
        before,
        "nothing was written"
    );
    // The owner reconnects — a new server for the same session — and finds it.
    let server = world.serve(Some(owner));
    assert_eq!(
        ids(&items(&http::get(server.address, "/api/human-items"))),
        [mine]
    );
    error(
        &http::get(server.address, "/api/human-items/hi-0000000000000000000a"),
        404,
        "human_item_not_found",
    );
    error(
        &http::get(server.address, "/api/human-items/not%20an%20id"),
        422,
        "invalid_human_item_id",
    );
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

/// Every timestamp and tracker reference the clock or the board chose, pinned.
fn pin_clock(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, held) in map.iter_mut() {
                if matches!(key.as_str(), "created_at" | "updated_at") && held.is_string() {
                    *held = json!("2026-01-01T00:00:00.000Z");
                } else {
                    pin_clock(held);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(pin_clock),
        _ => {}
    }
}
