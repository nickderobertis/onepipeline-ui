//! The linked plan store's copy into Linear, over a loopback Linear served on a real socket.
//!
//! The read API serves no route that creates a Linear project, so the store it links —
//! `onetaskgraph_core::Engine`, with the Linear plugin it carries — is the interface this is
//! reached by. The stand-in answers only the GraphQL documents that plugin sends, matched by the
//! plugin's own constants, and answers them as Linear does: a read of an id it does not hold is
//! an errored `Entity not found: <kind>` rather than a null, and a create under an id a record
//! already holds — a deleted one's included — is refused under HTTP 200 with
//! `conflict on insert of <kind>`. Both are the responses onetaskgraph's change #3867 recorded
//! Linear giving on a live run (2026-11-03) and holds its own loopback fixtures to.
use onetaskgraph_core::{
    CopyAction, CopyConditions, CopyItems, CopyRequest, CopyScope, GlobalId, StatusPolicy,
};
use onetaskgraph_linear::graphql;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

/// What the loopback Linear holds, and every document it was sent.
#[derive(Default)]
struct Workspace {
    projects: Vec<Value>,
    issues: Vec<Value>,
    /// Ids no create may take: held by a record this workspace no longer answers for.
    burnt: Vec<String>,
    /// Whether the next `projectCreate` finds its id already held by a deleted project, as a
    /// retry after an undo of an earlier attempt does.
    first_project_id_held: bool,
    /// The ids each `projectCreate` was sent under, in order.
    project_creates: Vec<String>,
    /// Documents this stand-in does not answer, which the plugin must never have sent.
    unexpected: Vec<String>,
}

/// Linear's errored answer to a read by an id of `kind` it does not hold.
fn not_found(kind: &str) -> (u16, Value) {
    (
        400,
        json!({"data": null, "errors": [{"message": format!("Entity not found: {kind}"),
            "extensions": {"type": "invalid input", "code": "INPUT_ERROR", "statusCode": 400,
                "userError": true,
                "userPresentableMessage": format!("Could not find referenced {kind}.")}}]}),
    )
}

/// Linear's refusal of a `kind` create sent under an `id` a record already holds.
fn id_conflict(kind: &str, id: &str) -> (u16, Value) {
    (
        200,
        json!({"data": null, "errors": [{"message": format!("conflict on insert of {kind}"),
            "path": [format!("{}Create", kind.to_ascii_lowercase())],
            "extensions": {"code": "INPUT_ERROR", "statusCode": 400, "type": "invalid input",
                "userError": true,
                "userPresentableMessage": format!("Entity {kind} with id {id} already exists.")}}]}),
    )
}

/// One page of `rows` of at most `first`, as a connection answers it.
fn page(rows: &[Value], first: &Value) -> Value {
    let first = first.as_u64().map_or(rows.len(), |first| {
        usize::try_from(first).unwrap_or(usize::MAX)
    });
    let more = rows.len() > first;
    json!({"nodes": rows.iter().take(first).collect::<Vec<_>>(),
        "pageInfo": {"hasNextPage": more, "endCursor": if more { json!("more") } else { Value::Null }}})
}

fn resolution() -> Value {
    json!({"organization": {"id": "ORG"},
        "teams": {"nodes": [{"id": "TEAM", "states": {"nodes": [
            {"id": "STATE-TODO", "name": "Todo", "type": "unstarted"},
            {"id": "STATE-DONE", "name": "Done", "type": "completed"}],
            "pageInfo": {"hasNextPage": false}}}]},
        "projectStatuses": {"nodes": [
            {"id": "STATUS-TODO", "name": "Todo", "type": "planned", "position": 1.0},
            {"id": "STATUS-DONE", "name": "Done", "type": "completed", "position": 2.0}],
            "pageInfo": {"hasNextPage": false}}})
}

/// The filter a listing of the configured team's issues carries.
fn team_filter() -> Value {
    json!({"team": {"key": {"eqIgnoreCase": "ENG"}}})
}

const STAMP: &str = "2026-11-03T00:00:00.000Z";

fn status_of(input: &Value, states: &[(&str, &str, &str)], field: &str) -> Value {
    let id = input[field].as_str().unwrap_or_default();
    states.iter().find(|(state, ..)| *state == id).map_or(
        Value::Null,
        |(_, name, kind)| json!({"name": name, "type": kind}),
    )
}

impl Workspace {
    fn answer(&mut self, query: &str, variables: &Value) -> (u16, Value) {
        let id = variables["id"].as_str().unwrap_or_default();
        let input = &variables["input"];
        let data = match query {
            q if q == graphql::RESOLUTION => resolution(),
            // The plugin narrows the issues by origin and confirms every row itself, so every
            // row held is an honest answer to the lookup.
            q if q == graphql::COUNTERPART_LOOKUPS => {
                let mut data = resolution();
                data["originIssues"] = page(&self.issues, &variables["issuesFirst"]);
                data["originProjects"] = page(&self.projects, &variables["projectsFirst"]);
                data
            }
            q if q == graphql::PROJECT || q == graphql::PROJECT_CACHED => {
                match self.projects.iter().find(|project| project["id"] == id) {
                    Some(project) => json!({"project": project}),
                    None => return not_found("Project"),
                }
            }
            q if q == graphql::ISSUE || q == graphql::ISSUE_CACHED => {
                match self.issues.iter().find(|issue| issue["id"] == id) {
                    Some(issue) => json!({"issue": issue}),
                    None => return not_found("Issue"),
                }
            }
            q if q == graphql::ISSUE_RESOLVED => {
                let mut data = resolution();
                match self.issues.iter().find(|issue| issue["id"] == id) {
                    Some(issue) => data["issue"] = issue.clone(),
                    None => return not_found("Issue"),
                }
                data
            }
            // A team-wide listing, which every row of this one-team workspace answers.
            q if q == graphql::ISSUES && variables["filter"] == team_filter() => {
                json!({"issues": page(&self.issues, &variables["first"])})
            }
            // This workspace holds no document, so every read of one names nothing.
            q if q == graphql::DOCUMENT => return not_found("Document"),
            q if q == graphql::PROJECT_CREATE => {
                let id = input["id"].as_str().unwrap_or_default().to_owned();
                self.project_creates.push(id.clone());
                if std::mem::take(&mut self.first_project_id_held) {
                    self.burnt.push(id.clone());
                }
                if self.burnt.contains(&id) || self.projects.iter().any(|p| p["id"] == id) {
                    return id_conflict("Project", &id);
                }
                let project = json!({"id": id, "name": input["name"],
                    "content": input["content"], "url": format!("https://linear.app/p/{id}"),
                    "createdAt": STAMP, "updatedAt": STAMP, "archivedAt": null,
                    "status": status_of(input, &[("STATUS-TODO", "Todo", "planned"),
                        ("STATUS-DONE", "Done", "completed")], "statusId"),
                    "labels": {"nodes": []}});
                self.projects.push(project.clone());
                json!({"projectCreate": {"success": true, "project": project}})
            }
            q if q == graphql::ISSUE_CREATE => {
                let id = input["id"].as_str().unwrap_or_default().to_owned();
                if self.burnt.contains(&id) || self.issues.iter().any(|i| i["id"] == id) {
                    return id_conflict("Issue", &id);
                }
                let project = input["projectId"].as_str();
                if project.is_some_and(|p| !self.projects.iter().any(|held| held["id"] == p)) {
                    return not_found("Project");
                }
                let issue = json!({"id": id,
                    "identifier": format!("ENG-{}", self.issues.len() + 1),
                    "title": input["title"], "description": input["description"],
                    "url": format!("https://linear.app/i/{id}"), "createdAt": STAMP,
                    "updatedAt": STAMP, "archivedAt": null,
                    "state": status_of(input, &[("STATE-TODO", "Todo", "unstarted"),
                        ("STATE-DONE", "Done", "completed")], "stateId"),
                    "priority": input["priority"].as_u64().unwrap_or(0),
                    "labels": {"nodes": []},
                    "project": project.map(|p| json!({"id": p}))});
                self.issues.push(issue.clone());
                json!({"issueCreate": {"success": true, "issue": issue}})
            }
            _ => {
                eprintln!("unanswered document: {query}\nvariables: {variables}");
                self.unexpected.push(query.to_owned());
                return (
                    400,
                    json!({"errors": [{"message":
                        format!("the stand-in does not answer this document: {query} {variables}")}]}),
                );
            }
        };
        (200, json!({ "data": data }))
    }
}

/// Serve `workspace` as Linear's GraphQL endpoint on a loopback socket, answering until the
/// test process exits.
fn serve(workspace: Arc<Mutex<Workspace>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback socket");
    let endpoint = format!(
        "http://{}/graphql",
        listener.local_addr().expect("its address")
    );
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let Some(request) = read_request(&stream) else {
                continue;
            };
            let (status, body) = workspace.lock().expect("the workspace").answer(
                request["query"].as_str().unwrap_or_default(),
                &request["variables"],
            );
            let text = body.to_string();
            let reason = if status == 200 { "OK" } else { "Bad Request" };
            let _ = write!(
                stream,
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
        }
    });
    endpoint
}

fn read_request(mut stream: &TcpStream) -> Option<Value> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
        let Some(split) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&bytes[..split]).to_ascii_lowercase();
        let length = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())?;
        if bytes.len() >= split + 4 + length {
            return serde_json::from_slice(&bytes[split + 4..split + 4 + length]).ok();
        }
    }
}

fn id(text: &str) -> GlobalId {
    text.parse().expect("a qualified id")
}

#[tokio::test]
async fn a_plan_copied_into_linear_creates_its_project_and_an_absent_id_reads_absent() {
    let workspace = Arc::new(Mutex::new(Workspace {
        first_project_id_held: true,
        ..Workspace::default()
    }));
    let endpoint = serve(Arc::clone(&workspace));
    let dir = tempfile::tempdir().expect("a workspace");
    let plan = dir.path().join("plan");
    for kind in ["projects", "tasks/harbor", "documents"] {
        fs::create_dir_all(plan.join(kind)).expect("store directories");
    }
    fs::write(
        plan.join("projects/harbor.md"),
        "---\ntitle: Harbor rollout\nstatus: todo\n---\nMove the harbor cranes.\n",
    )
    .expect("the project");
    let tasks = ["Harbor crane 0", "Harbor crane 1"];
    for (index, title) in tasks.iter().enumerate() {
        fs::write(
            plan.join(format!("tasks/harbor/crane-{index}.md")),
            format!(
                "---\ntitle: {title}\nstatus: todo\nproject: harbor\n---\nCrane step {index}.\n"
            ),
        )
        .expect("a task");
    }
    fs::write(
        dir.path().join("onetaskgraph.yaml"),
        format!(
            "sources:\n  plan:\n    plugin: local-md\n    config:\n      root: {plan:?}\n  linear:\n    plugin: linear\n    config:\n      endpoint: {endpoint:?}\n      team: ENG\n      api_key_env: LINEAR_API_KEY\n      status_mapping:\n        todo: Todo\n        done: Done\n",
        ),
    )
    .expect("the store configuration");
    let loaded = onetaskgraph_core::config::load(
        dir.path(),
        &onetaskgraph_core::Environment::from_os_pairs(vec![(
            "LINEAR_API_KEY".into(),
            "fixture-key".into(),
        )]),
        &onetaskgraph_core::config::Layer::default(),
    )
    .expect("the configuration loads");
    let engine = onetaskgraph_core::Engine::build(&loaded.config, &loaded.secrets);

    let report = engine
        .copy(&CopyRequest {
            items: CopyItems::new(vec![id("plan:harbor")]).expect("one item"),
            scope: CopyScope::Projects { tasks: true },
            status_policy: StatusPolicy::Source,
            destination: onetaskgraph_plugin_api::SourceName::new("linear").expect("a source name"),
            match_by: None,
            target_task: None,
            recreate: false,
            create: false,
            dry_run: false,
            comments: false,
            expect: None,
            no_link: false,
            statuses: Vec::new(),
            conditions: CopyConditions::default(),
        })
        .await
        .expect("copy the plan into Linear");

    {
        // What the stand-in holds once the copy settled.
        let held = workspace.lock().expect("the workspace");
        assert!(
            held.unexpected.is_empty(),
            "the plugin sent documents the stand-in does not answer: {:#?}",
            held.unexpected
        );
        let created = |source: &str| {
            report
                .items
                .iter()
                .find(|item| item.source.to_string() == source)
                .map(|item| &item.action)
        };
        let Some(CopyAction::Created {
            destination: Some(project),
            ..
        }) = created("plan:harbor")
        else {
            panic!("the project must be reported created: {report:#?}");
        };
        assert_eq!(project.source.as_str(), "linear");
        assert_eq!(
            held.projects.len(),
            1,
            "one new project: {:#?}",
            held.projects
        );
        assert_eq!(held.projects[0]["id"], project.native.0.as_str());
        assert_eq!(held.projects[0]["name"], "Harbor rollout");
        // The first id the create was sent under was held by a deleted project and refused, so the
        // project stands under another.
        assert_eq!(held.project_creates.len(), 2, "{:?}", held.project_creates);
        assert_ne!(held.projects[0]["id"], held.project_creates[0].as_str());
        assert_eq!(held.issues.len(), tasks.len(), "{:#?}", held.issues);
        for title in tasks {
            let filed: Vec<_> = held
                .issues
                .iter()
                .filter(|issue| issue["title"] == title)
                .collect();
            assert_eq!(filed.len(), 1, "{title} is filed once: {:#?}", held.issues);
            assert_eq!(filed[0]["project"]["id"], project.native.0.as_str());
        }
        for index in 0..tasks.len() {
            assert!(
                matches!(
                    created(&format!("plan:harbor/crane-{index}")),
                    Some(CopyAction::Created {
                        destination: Some(_),
                        ..
                    })
                ),
                "task {index} must be reported created: {report:#?}"
            );
        }
    }

    let absent = "0b7d2f6e-3a91-4c58-8e2d-5f4a1c9b7e30";
    let task = engine
        .task(&id(&format!("linear:{absent}")))
        .await
        .expect("read an absent issue");
    assert!(task.items.is_empty() && task.errors.is_empty(), "{task:#?}");
    let project = engine
        .project(&id(&format!("linear:{absent}")))
        .await
        .expect("read an absent project");
    assert!(
        project.items.is_empty() && project.errors.is_empty(),
        "{project:#?}"
    );
    let document = engine
        .document(&id(&format!("linear:{absent}")))
        .await
        .expect("read an absent document");
    assert!(
        document.items.is_empty() && document.errors.is_empty(),
        "{document:#?}"
    );
    let held = workspace.lock().expect("the workspace");
    assert!(held.unexpected.is_empty(), "{:#?}", held.unexpected);
}
