//! The linked plan store's copy into Linear, over a loopback Linear served on a real socket.
//!
//! The read API serves no route that creates a Linear project, so the store it links —
//! `onetaskgraph_core::Engine`, with the Linear plugin it carries — is the interface this is
//! reached by. The stand-in answers only the GraphQL documents that plugin sends, matched by the
//! plugin's own constants, and answers them as Linear does: a read of an id it does not hold is
//! an errored `Entity not found: <kind>` rather than a null, and a create under an id a record
//! already holds — a deleted one's included — is refused under HTTP 200 with
//! `conflict on insert of <kind>`. Both are what onetaskgraph's change #3867 recorded Linear
//! answering on a live run, and both are spelled here by that plugin's own `graphql` constants,
//! which its live project-create journey checks against Linear on every credentialed run — so
//! this file holds no second copy of either.
use onetaskgraph_core::{
    CopyAction, CopyConditions, CopyItems, CopyRequest, CopyScope, GlobalId, StatusPolicy,
};
use onetaskgraph_linear::graphql;
use onetaskgraph_plugin_api::MetadataRecord;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

/// A batched document this stand-in refused at one of its aliases.
struct BatchRefusal {
    /// The refused error's `path`, whose first element names the alias.
    path: Value,
    /// The `title` each alias's `input` carried, in alias order.
    titles: Vec<Value>,
    /// The titles of the issues held once the refusal was answered.
    issues_after: Vec<Value>,
}

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
    project_creates: Vec<String>,
    /// The title of an issue whose first create finds its id already held, as a create
    /// colliding with a record Linear holds does.
    issue_id_held: Option<String>,
    /// Every batched document refused at one alias, in the order it was answered.
    batch_refusals: Vec<BatchRefusal>,
    /// Documents this stand-in does not answer, which the plugin must never have sent.
    unexpected: Vec<String>,
}

// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] The stand-in this journey's
// task requires for a service this repository holds no credential for and runs no live journey
// against: the envelopes and rows below are the ones the linked plugin reads — a shape it cannot
// read fails this journey through the plugin itself — and their authority is reconciled upstream,
// where onetaskgraph-linear-e2e's live project-create journey (onetaskgraph#3867) runs this same
// plugin release against Linear on every credentialed run. Every message is that plugin's constant.
/// Linear's errored answer to a read by an id of a `record` it does not hold.
fn not_found(record: MetadataRecord) -> (u16, Value) {
    let (message, presentable) = match record {
        MetadataRecord::Task => (
            graphql::ISSUE_NOT_FOUND_MESSAGE,
            graphql::ISSUE_NOT_FOUND_PRESENTABLE,
        ),
        MetadataRecord::Project => (
            graphql::PROJECT_NOT_FOUND_MESSAGE,
            graphql::PROJECT_NOT_FOUND_PRESENTABLE,
        ),
        MetadataRecord::Document => (
            graphql::DOCUMENT_NOT_FOUND_MESSAGE,
            graphql::DOCUMENT_NOT_FOUND_PRESENTABLE,
        ),
    };
    (
        400,
        json!({"data": null, "errors": [{"message": message,
            "extensions": {"type": "invalid input", "code": "INPUT_ERROR", "statusCode": 400,
                "userError": true, "userPresentableMessage": presentable}}]}),
    )
}

/// Linear's refusal, under HTTP 200, of a `record` create sent under an `id` a record holds.
fn id_conflict(record: MetadataRecord, root: &str, id: &str) -> (u16, Value) {
    (
        200,
        json!({"data": null, "errors": [{"message": graphql::id_conflict_message(record),
            "path": [root],
            "extensions": {"code": "INPUT_ERROR", "statusCode": 400, "type": "invalid input",
                "userError": true,
                "userPresentableMessage": graphql::id_conflict_presentable(record, id)}}]}),
    )
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
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

fn required<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input[field]
        .as_str()
        .ok_or_else(|| format!("`{field}` must be a string, not {}", input[field]))
}

fn optional<'a>(input: &'a Value, field: &str) -> Result<Option<&'a str>, String> {
    match &input[field] {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text)),
        other => Err(format!("`{field}` must be a string, not {other}")),
    }
}

fn page(rows: &[Value], first: &Value) -> Result<Value, String> {
    let first = first
        .as_u64()
        .and_then(|first| usize::try_from(first).ok())
        .ok_or_else(|| format!("a page size must be a whole number, not {first}"))?;
    let more = rows.len() > first;
    Ok(json!({"nodes": rows.iter().take(first).collect::<Vec<_>>(),
        "pageInfo": {"hasNextPage": more, "endCursor": if more { json!("more") } else { Value::Null }}}))
}

/// The filter a listing of the configured team's issues carries.
fn team_filter() -> Value {
    json!({"team": {"key": {"eqIgnoreCase": "ENG"}}})
}

const STAMP: &str = "2026-11-03T00:00:00.000Z";

fn status_of(input: &Value, states: &[(&str, &str, &str)], field: &str) -> Result<Value, String> {
    let Some(id) = optional(input, field)? else {
        return Ok(Value::Null);
    };
    states
        .iter()
        .find(|(state, ..)| *state == id)
        .map(|(_, name, kind)| json!({"name": name, "type": kind}))
        .ok_or_else(|| format!("`{field}` names no status this workspace holds: {id}"))
}

impl Workspace {
    fn answer(&mut self, query: &str, variables: &Value) -> (u16, Value) {
        match self.answer_valid(query, variables) {
            Ok(answer) => answer,
            // A document this stand-in does not answer, or one it does with variables Linear
            // would refuse, is a request the plugin must never have sent: the journey fails on it.
            Err(why) => {
                eprintln!("refused: {why}\ndocument: {query}\nvariables: {variables}");
                self.unexpected.push(format!("{why}: {query}"));
                (
                    400,
                    json!({"errors": [{"message": format!("the stand-in refuses this request: {why}")}]}),
                )
            }
        }
    }

    /// A document the plugin composed of several of its own single-root documents, each under
    /// its alias `a<i>` with its variables renamed `$<name>_<i>`, answered as Linear answers one
    /// (`graphql::composed`): every alias as its document alone, under that alias — or, when one
    /// alias is refused, that refusal alone, at that alias's path, with no `data` and nothing of
    /// any alias applied.
    fn answer_batch(
        &mut self,
        singles: &[&str],
        variables: &Value,
    ) -> Result<(u16, Value), String> {
        let records = (self.projects.clone(), self.issues.clone());
        let titles = (0..singles.len())
            .map(|at| variables[format!("input_{at}")]["title"].clone())
            .collect();
        let mut data = serde_json::Map::new();
        for (at, single) in singles.iter().enumerate() {
            let alias = format!("a{at}");
            let suffix = format!("_{at}");
            let own: serde_json::Map<String, Value> = variables
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(name, value)| {
                    name.strip_suffix(&suffix)
                        .map(|name| (name.to_owned(), value.clone()))
                })
                .collect();
            let (status, mut answer) = self.answer_valid(single, &Value::Object(own))?;
            if let Some(error) = answer["errors"].get_mut(0) {
                let rest: Vec<Value> = error["path"]
                    .as_array()
                    .map(|path| path.iter().skip(1).cloned().collect())
                    .unwrap_or_default();
                error["path"] = std::iter::once(json!(alias)).chain(rest).collect();
                let error = error.take();
                (self.projects, self.issues) = records;
                self.batch_refusals.push(BatchRefusal {
                    path: error["path"].clone(),
                    titles,
                    issues_after: self.issues.iter().map(|i| i["title"].clone()).collect(),
                });
                return Ok((status, json!({"data": null, "errors": [error]})));
            }
            let root = answer["data"]
                .as_object_mut()
                .and_then(|roots| roots.values_mut().next())
                .map(Value::take)
                .ok_or_else(|| format!("`{alias}` answered no root"))?;
            data.insert(alias, root);
        }
        Ok((200, json!({ "data": data })))
    }

    fn answer_valid(&mut self, query: &str, variables: &Value) -> Result<(u16, Value), String> {
        if let Some(singles) = graphql::decomposed(query) {
            return self.answer_batch(&singles, variables);
        }
        let input = &variables["input"];
        let data = match query {
            q if q == graphql::RESOLUTION => resolution(),
            // The plugin narrows the issues by origin and confirms every row itself, so every
            // row held is an honest answer to the lookup.
            q if q == graphql::COUNTERPART_LOOKUPS => {
                let mut data = resolution();
                data["originIssues"] = page(&self.issues, &variables["issuesFirst"])?;
                data["originProjects"] = page(&self.projects, &variables["projectsFirst"])?;
                data
            }
            q if q == graphql::PROJECT || q == graphql::PROJECT_CACHED => {
                let id = required(variables, "id")?;
                match self.projects.iter().find(|project| project["id"] == id) {
                    Some(project) => json!({"project": project}),
                    None => return Ok(not_found(MetadataRecord::Project)),
                }
            }
            q if q == graphql::ISSUE || q == graphql::ISSUE_CACHED => {
                let id = required(variables, "id")?;
                match self.issues.iter().find(|issue| issue["id"] == id) {
                    Some(issue) => json!({"issue": issue}),
                    None => return Ok(not_found(MetadataRecord::Task)),
                }
            }
            q if q == graphql::ISSUE_RESOLVED => {
                let id = required(variables, "id")?;
                let mut data = resolution();
                match self.issues.iter().find(|issue| issue["id"] == id) {
                    Some(issue) => data["issue"] = issue.clone(),
                    None => return Ok(not_found(MetadataRecord::Task)),
                }
                data
            }
            // A team-wide listing, which every row of this one-team workspace answers.
            q if q == graphql::ISSUES && variables["filter"] == team_filter() => {
                json!({"issues": page(&self.issues, &variables["first"])?})
            }
            // This workspace holds no document, so every read of one names nothing.
            q if q == graphql::DOCUMENT => {
                required(variables, "id")?;
                return Ok(not_found(MetadataRecord::Document));
            }
            // llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] The created rows
            // are the stand-in's, on the terms of the block above `not_found`: the shapes the
            // linked plugin reads, whose authority onetaskgraph-linear-e2e's live project-create
            // journey reconciles against Linear upstream, where a credential exists.
            q if q == graphql::PROJECT_CREATE => {
                let id = required(input, "id")?.to_owned();
                let name = required(input, "name")?;
                let content = optional(input, "content")?;
                let status = status_of(
                    input,
                    &[
                        ("STATUS-TODO", "Todo", "planned"),
                        ("STATUS-DONE", "Done", "completed"),
                    ],
                    "statusId",
                )?;
                self.project_creates.push(id.clone());
                if std::mem::take(&mut self.first_project_id_held) {
                    self.burnt.push(id.clone());
                }
                if self.burnt.contains(&id) || self.projects.iter().any(|p| p["id"] == id) {
                    return Ok(id_conflict(MetadataRecord::Project, "projectCreate", &id));
                }
                let project = json!({"id": id, "name": name, "content": content,
                    "url": format!("https://linear.app/p/{id}"),
                    "createdAt": STAMP, "updatedAt": STAMP, "archivedAt": null,
                    "status": status, "labels": {"nodes": []}});
                self.projects.push(project.clone());
                json!({"projectCreate": {"success": true, "project": project}})
            }
            q if q == graphql::ISSUE_CREATE => {
                let id = required(input, "id")?.to_owned();
                let title = required(input, "title")?;
                let description = optional(input, "description")?;
                let project = optional(input, "projectId")?;
                let state = status_of(
                    input,
                    &[
                        ("STATE-TODO", "Todo", "unstarted"),
                        ("STATE-DONE", "Done", "completed"),
                    ],
                    "stateId",
                )?;
                let priority = match &input["priority"] {
                    Value::Null => 0,
                    other => other
                        .as_u64()
                        .ok_or_else(|| format!("`priority` must be a whole number, not {other}"))?,
                };
                if self.issue_id_held.as_deref() == Some(title) {
                    self.issue_id_held = None;
                    self.burnt.push(id.clone());
                }
                if self.burnt.contains(&id) || self.issues.iter().any(|i| i["id"] == id) {
                    return Ok(id_conflict(MetadataRecord::Task, "issueCreate", &id));
                }
                if project.is_some_and(|p| !self.projects.iter().any(|held| held["id"] == p)) {
                    return Ok(not_found(MetadataRecord::Project));
                }
                let issue = json!({"id": id,
                    "identifier": format!("ENG-{}", self.issues.len() + 1),
                    "title": title, "description": description,
                    "url": format!("https://linear.app/i/{id}"), "createdAt": STAMP,
                    "updatedAt": STAMP, "archivedAt": null, "state": state,
                    "priority": priority, "labels": {"nodes": []},
                    "project": project.map(|p| json!({"id": p}))});
                self.issues.push(issue.clone());
                json!({"issueCreate": {"success": true, "issue": issue}})
            }
            // A whole rewrite of an issue this workspace holds, answered with the relations it
            // holds, which in this workspace are none.
            q if q == graphql::ISSUE_REWRITE => {
                let id = required(variables, "id")?;
                let state = status_of(
                    input,
                    &[
                        ("STATE-TODO", "Todo", "unstarted"),
                        ("STATE-DONE", "Done", "completed"),
                    ],
                    "stateId",
                )?;
                let Some(issue) = self.issues.iter_mut().find(|issue| issue["id"] == id) else {
                    return Ok(not_found(MetadataRecord::Task));
                };
                for field in ["title", "description", "priority"] {
                    if let Some(value) = input.get(field) {
                        issue[field] = value.clone();
                    }
                }
                if !state.is_null() {
                    issue["state"] = state;
                }
                if let Some(project) = input.get("projectId") {
                    issue["project"] = json!({"id": project});
                }
                let mut issue = issue.clone();
                issue["relations"] =
                    json!({"nodes": [], "pageInfo": {"hasNextPage": false, "endCursor": null}});
                json!({"issueUpdate": {"success": true, "issue": issue}})
            }
            // llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
            _ => return Err("the stand-in does not answer this document".to_owned()),
        };
        Ok((200, json!({ "data": data })))
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

/// The titles of the plan's tasks, in the order the plugin batches their creates.
const HARBOR_TASKS: [&str; 2] = ["Harbor crane 0", "Harbor crane 1"];

fn id(text: &str) -> GlobalId {
    text.parse().expect("a qualified id")
}

/// The two-task plan `harbor`, copied with its tasks into a loopback Linear serving `workspace`:
/// the store's directory, the engine that copied it, and what the copy answered.
async fn copy_harbor(
    workspace: &Arc<Mutex<Workspace>>,
) -> (
    tempfile::TempDir,
    onetaskgraph_core::Engine,
    Result<onetaskgraph_core::CopyReport, onetaskgraph_core::EngineError>,
) {
    let endpoint = serve(Arc::clone(workspace));
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
    for (index, title) in HARBOR_TASKS.iter().enumerate() {
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
            scope: CopyScope::Projects {
                tasks: true,
                documents: false,
            },
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
        .await;
    (dir, engine, report)
}

#[tokio::test]
async fn a_plan_copied_into_linear_creates_its_project_and_an_absent_id_reads_absent() {
    let workspace = Arc::new(Mutex::new(Workspace {
        first_project_id_held: true,
        ..Workspace::default()
    }));
    let (_dir, engine, report) = copy_harbor(&workspace).await;
    let report = report.expect("copy the plan into Linear");
    let tasks = HARBOR_TASKS;

    {
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

#[tokio::test]
async fn a_batch_refused_at_a_later_alias_applies_none_of_it_and_every_task_lands_once() {
    let workspace = Arc::new(Mutex::new(Workspace {
        issue_id_held: Some(HARBOR_TASKS[1].to_owned()),
        ..Workspace::default()
    }));
    let (_dir, _engine, report) = copy_harbor(&workspace).await;

    let held = workspace.lock().expect("the workspace");
    // The plugin sent both creates as one document, and the stand-in refused it at the second
    // alias — the later task, whose id was held — after the first alias had been applied.
    let [refusal] = held.batch_refusals.as_slice() else {
        panic!(
            "exactly one batched document is refused: {} were",
            held.batch_refusals.len()
        );
    };
    assert_eq!(refusal.titles, HARBOR_TASKS.map(Value::from));
    assert_eq!(refusal.path[0], "a1", "the refusal names the later alias");
    // Nothing of the refused document stands: the earlier alias's issue was undone with it.
    assert!(
        refusal.issues_after.is_empty(),
        "the refused document left issues applied: {:?}",
        refusal.issues_after
    );
    assert!(held.unexpected.is_empty(), "{:#?}", held.unexpected);
    // The plugin then sent the refused create on its own and the rest again, so each task is
    // filed exactly once and reported created.
    let report = report.expect("copy the plan into Linear");
    assert_eq!(held.issues.len(), HARBOR_TASKS.len(), "{:#?}", held.issues);
    for (index, title) in HARBOR_TASKS.iter().enumerate() {
        let filed = held
            .issues
            .iter()
            .filter(|issue| issue["title"] == *title)
            .count();
        assert_eq!(filed, 1, "{title} is filed once: {:#?}", held.issues);
        assert!(
            report.items.iter().any(|item| {
                item.source.to_string() == format!("plan:harbor/crane-{index}")
                    && matches!(
                        item.action,
                        CopyAction::Created {
                            destination: Some(_),
                            ..
                        }
                    )
            }),
            "task {index} must be reported created: {report:#?}"
        );
    }
    assert!(
        held.issues
            .iter()
            .all(|issue| issue["id"] != held.burnt[0].as_str()),
        "no issue stands under the held id"
    );
}
