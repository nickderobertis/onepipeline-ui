//! A loopback Linear, at the linked `linear` plugin's real GraphQL boundary.
//!
//! What it holds is one team's projects and issues, written as Linear stores them: a project's
//! long form in `content`, an issue's in `description`, with whatever metadata block or slot the
//! journey wrote there kept byte for byte. Every document it answers is one of the plugin's own
//! `graphql` constants, matched by that constant rather than a second spelling of it; a document
//! it does not answer, or a filter it cannot evaluate, is recorded in
//! [`LinearWorkspace::unexpected`] and refused, so a journey fails on a request the plugin sent
//! that this stand-in would have answered wrongly rather than reading on past it.
//!
//! It serves on a loopback socket from a thread of the test process, so a subprocess — the
//! pinned `onepipeline` CLI, which links the same plugin release — reaches it exactly as it
//! reaches Linear: over HTTP at the `endpoint` its source configuration names.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use onetaskgraph_linear::graphql;
use serde_json::{json, Value};

/// The team key every listing of this workspace is scoped to.
pub const TEAM: &str = "ENG";

/// When every record this workspace holds was written.
const STAMP: &str = "2026-11-20T00:00:00.000Z";

/// The team's workflow states: (id, name, type).
const STATES: [(&str, &str, &str); 2] = [
    ("STATE-TODO", "Todo", "unstarted"),
    ("STATE-DONE", "Done", "completed"),
];

/// The workspace's project statuses: (id, name, type).
const PROJECT_STATUSES: [(&str, &str, &str); 2] = [
    ("STATUS-TODO", "Todo", "planned"),
    ("STATUS-DONE", "Done", "completed"),
];

/// What the loopback Linear holds, and every document it was sent.
#[derive(Default)]
pub struct Held {
    pub projects: Vec<Value>,
    pub issues: Vec<Value>,
    /// Requests this stand-in does not answer, which the plugin must never have sent.
    pub unexpected: Vec<String>,
}

/// A running loopback Linear: the endpoint a source configuration names, and what it holds.
pub struct LinearWorkspace {
    pub endpoint: String,
    held: Arc<Mutex<Held>>,
}

impl LinearWorkspace {
    /// Serve an empty workspace until the test process exits.
    pub fn start() -> Self {
        let held = Arc::new(Mutex::new(Held::default()));
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback socket");
        let endpoint = format!(
            "http://{}/graphql",
            listener.local_addr().expect("its address")
        );
        let serving = Arc::clone(&held);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let serving = Arc::clone(&serving);
                thread::spawn(move || answer_connection(stream, &serving));
            }
        });
        Self { endpoint, held }
    }

    /// Hold a project of the configured team, its long form `content` stored as given.
    pub fn add_project(&self, id: &str, name: &str, content: &str) {
        self.held().projects.push(json!({
            "id": id, "name": name, "content": content, "contentState": null,
            "url": format!("https://linear.app/project/{id}"),
            "createdAt": STAMP, "updatedAt": STAMP, "archivedAt": null,
            "status": {"name": "Todo", "type": "planned"},
            "labels": {"nodes": []},
        }));
    }

    /// Hold an issue of the configured team in `project`, its long form `description` stored as
    /// given.
    pub fn add_issue(&self, id: &str, project: &str, title: &str, description: &str) {
        let mut held = self.held();
        let identifier = format!("{TEAM}-{}", held.issues.len() + 1);
        held.issues.push(json!({
            "id": id, "identifier": identifier, "title": title,
            "description": description, "descriptionState": null,
            "url": format!("https://linear.app/issue/{identifier}"),
            "createdAt": STAMP, "updatedAt": STAMP, "archivedAt": null,
            "state": {"name": "Todo", "type": "unstarted"},
            "priority": 0, "labels": {"nodes": []}, "project": {"id": project},
        }));
    }

    /// What the workspace holds now.
    pub fn held(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().expect("the workspace")
    }
}

fn answer_connection(mut stream: TcpStream, held: &Mutex<Held>) {
    let Some(request) = read_request(&stream) else {
        return;
    };
    let query = request["query"].as_str().unwrap_or_default();
    let (status, body) = {
        let mut held = held.lock().expect("the workspace");
        match answer(&mut held, query, &request["variables"]) {
            Ok(data) => (200, json!({ "data": data })),
            Err(why) => {
                eprintln!(
                    "loopback Linear refused: {why}\ndocument: {query}\nvariables: {}",
                    request["variables"]
                );
                held.unexpected.push(format!("{why}: {query}"));
                (
                    400,
                    json!({"errors": [{"message": format!("the stand-in refuses this request: {why}")}]}),
                )
            }
        }
    };
    let text = body.to_string();
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
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

fn resolution() -> Value {
    let states: Vec<Value> = STATES
        .iter()
        .map(|(id, name, kind)| json!({"id": id, "name": name, "type": kind}))
        .collect();
    let statuses: Vec<Value> = PROJECT_STATUSES
        .iter()
        .enumerate()
        .map(|(at, (id, name, kind))| json!({"id": id, "name": name, "type": kind, "position": at}))
        .collect();
    json!({"organization": {"id": "ORG"},
        "teams": {"nodes": [{"id": "TEAM", "states": {"nodes": states,
            "pageInfo": {"hasNextPage": false}}}]},
        "projectStatuses": {"nodes": statuses, "pageInfo": {"hasNextPage": false}}})
}

/// An empty first page of a connection.
fn empty() -> Value {
    json!({"nodes": [], "pageInfo": {"hasNextPage": false, "endCursor": null}})
}

/// A record as every selection of it reads: itself, with the pages this one-team workspace
/// holds none of — relations, inverse relations and comments — empty.
fn with_pages(record: &Value) -> Value {
    let mut record = record.clone();
    for page in ["relations", "inverseRelations", "comments"] {
        record[page] = empty();
    }
    record
}

fn required<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input[field]
        .as_str()
        .ok_or_else(|| format!("`{field}` must be a string, not {}", input[field]))
}

/// The one operand an `{"eq": <string>}` predicate carries, refusing any other operator or a
/// non-string operand.
fn eq_operand<'a>(predicate: &'a Value, what: &str) -> Result<&'a str, String> {
    match predicate.as_object() {
        Some(operators) if operators.len() == 1 => operators
            .get("eq")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("the {what} predicate {predicate}")),
        _ => Err(format!("the {what} predicate {predicate}")),
    }
}

/// Whether `record` meets `filter`, for the predicates the plugin's listings send. The whole
/// filter is evaluated before it is answered, so any other predicate — in a branch the answer
/// would not have needed included — is refused rather than read as a match.
fn meets(record: &Value, filter: &Value) -> Result<bool, String> {
    let Some(predicates) = filter.as_object() else {
        return match filter {
            Value::Null => Ok(true),
            other => Err(format!("a filter must be an object, not {other}")),
        };
    };
    let mut all = true;
    for (field, predicate) in predicates {
        let met = match field.as_str() {
            "and" | "or" => {
                let parts = predicate
                    .as_array()
                    .ok_or_else(|| format!("`{field}` must be a list, not {predicate}"))?
                    .iter()
                    .map(|part| meets(record, part))
                    .collect::<Result<Vec<bool>, String>>()?;
                if field == "and" {
                    parts.into_iter().all(|met| met)
                } else {
                    parts.into_iter().any(|met| met)
                }
            }
            // Every record of this workspace is the one configured team's.
            "team" if predicate == &json!({"key": {"eqIgnoreCase": TEAM}}) => true,
            "project" if predicate == &json!({"null": true}) => record["project"].is_null(),
            "project" => match predicate.as_object() {
                Some(fields) if fields.len() == 1 => match fields.get("id") {
                    Some(id) => record["project"]["id"] == eq_operand(id, "project id")?,
                    None => return Err(format!("the project predicate {predicate}")),
                },
                _ => return Err(format!("the project predicate {predicate}")),
            },
            "id" => record["id"] == eq_operand(predicate, "id")?,
            other => return Err(format!("the `{other}` predicate {predicate}")),
        };
        all &= met;
    }
    Ok(all)
}

fn page(rows: &[Value], filter: &Value) -> Result<Value, String> {
    let mut nodes = Vec::new();
    for row in rows {
        if meets(row, filter)? {
            nodes.push(with_pages(row));
        }
    }
    Ok(json!({"nodes": nodes, "pageInfo": {"hasNextPage": false, "endCursor": null}}))
}

fn find<'a>(rows: &'a [Value], id: &str, kind: &str) -> Result<&'a Value, String> {
    rows.iter()
        .find(|row| row["id"] == id)
        .ok_or_else(|| format!("no {kind} {id} is held"))
}

/// Apply an update's `input` to `record`: its long form, and the status named by `status_field`
/// out of `statuses` — all a metadata, projection or status write of these records sends.
fn update(
    record: &mut Value,
    input: &Value,
    long_form: &str,
    (status_field, statuses): (&str, &[(&str, &str, &str)]),
) -> Result<(), String> {
    let fields = input
        .as_object()
        .ok_or_else(|| format!("`input` must be an object, not {input}"))?;
    let status_key = if long_form == "content" {
        "status"
    } else {
        "state"
    };
    for (field, value) in fields {
        if field == long_form {
            if !(value.is_string() || value.is_null()) {
                return Err(format!("`{field}` must be a string or null, not {value}"));
            }
            record[long_form] = value.clone();
        } else if field == status_field {
            let (_, name, kind) =
                statuses
                    .iter()
                    .find(|(id, ..)| value == id)
                    .ok_or_else(|| {
                        format!("`{field}` names no status this workspace holds: {value}")
                    })?;
            record[status_key] = json!({"name": name, "type": kind});
        } else {
            return Err(format!("the stand-in does not update `{field}`"));
        }
    }
    Ok(())
}

fn answer(held: &mut Held, query: &str, variables: &Value) -> Result<Value, String> {
    if let Some(singles) = graphql::decomposed(query) {
        let mut data = serde_json::Map::new();
        for (at, single) in singles.iter().enumerate() {
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
            let mut answered = answer(held, single, &Value::Object(own))?;
            let root = answered
                .as_object_mut()
                .and_then(|roots| roots.values_mut().next())
                .map(Value::take)
                .ok_or_else(|| format!("alias a{at} answered no root"))?;
            data.insert(format!("a{at}"), root);
        }
        return Ok(Value::Object(data));
    }
    let q = query;
    Ok(match () {
        () if q == graphql::VIEWER => json!({"viewer": {"id": "VIEWER"}}),
        () if q == graphql::ORGANIZATION => json!({"organization": {"id": "ORG"}}),
        () if q == graphql::RESOLUTION => resolution(),
        () if q == graphql::PROJECT
            || q == graphql::PROJECT_CACHED
            || q == graphql::PROJECT_RELATIONS
            || q == graphql::PROJECT_RELATIONS_CACHED
            || q == graphql::PROJECT_DEPENDS_ON
            || q == graphql::PROJECT_DEPENDED_ON_BY =>
        {
            let id = required(variables, "id")?;
            json!({"project": with_pages(find(&held.projects, id, "project")?)})
        }
        () if q == graphql::ISSUE
            || q == graphql::ISSUE_CACHED
            || q == graphql::ISSUE_DETAIL
            || q == graphql::ISSUE_DETAIL_CACHED
            || q == graphql::ISSUE_RELATIONS
            || q == graphql::ISSUE_RELATIONS_CACHED
            || q == graphql::ISSUE_DEPENDS_ON
            || q == graphql::ISSUE_DEPENDED_ON_BY =>
        {
            let id = required(variables, "id")?;
            json!({"issue": with_pages(find(&held.issues, id, "issue")?)})
        }
        () if q == graphql::ISSUE_RESOLVED => {
            let id = required(variables, "id")?;
            let mut data = resolution();
            data["issue"] = with_pages(find(&held.issues, id, "issue")?);
            data
        }
        () if q == graphql::ISSUES || q == graphql::ISSUES_CACHED => {
            json!({"issues": page(&held.issues, &variables["filter"])?})
        }
        () if q == graphql::PROJECTS || q == graphql::PROJECTS_CACHED => {
            json!({"projects": page(&held.projects, &variables["filter"])?})
        }
        // This workspace holds no document and no label.
        () if q == graphql::DOCUMENTS => json!({"documents": empty()}),
        () if q == graphql::LABELS => json!({"issueLabels": empty()}),
        () if q == graphql::COUNTERPART_LOOKUPS || q == graphql::COUNTERPART_LOOKUPS_CACHED => {
            let mut data = resolution();
            data["originIssues"] = page(&held.issues, &variables["issuesFilter"])?;
            data["originProjects"] = page(&held.projects, &variables["projectsFilter"])?;
            data
        }
        () if q == graphql::PROJECT_UPDATE || q == graphql::PROJECT_STATUS_UPDATE => {
            let id = required(variables, "id")?;
            let project = held
                .projects
                .iter_mut()
                .find(|row| row["id"] == id)
                .ok_or_else(|| format!("no project {id} is held"))?;
            update(
                project,
                &variables["input"],
                "content",
                ("statusId", &PROJECT_STATUSES),
            )?;
            json!({"projectUpdate": {"success": true, "project": project.clone()}})
        }
        () if q == graphql::ISSUE_UPDATE => {
            let id = required(variables, "id")?;
            let issue = held
                .issues
                .iter_mut()
                .find(|row| row["id"] == id)
                .ok_or_else(|| format!("no issue {id} is held"))?;
            update(
                issue,
                &variables["input"],
                "description",
                ("stateId", &STATES),
            )?;
            json!({"issueUpdate": {"success": true, "issue": issue.clone()}})
        }
        () => return Err("the stand-in does not answer this document".to_owned()),
    })
}
