//! The linked plan store's copy boundary, over real Markdown records on disk.
use onetaskgraph_core::{CopyItems, CopyRequest, CopyScope, GlobalId};
use std::fs;

#[tokio::test]
async fn a_copied_project_document_keeps_its_budget_fragment_at_the_destination() {
    let dir = tempfile::tempdir().expect("a workspace");
    let source = dir.path().join("authoring");
    let destination = dir.path().join("board");
    for root in [&source, &destination] {
        for kind in ["projects", "tasks/plan", "documents"] {
            fs::create_dir_all(root.join(kind)).expect("store directories");
        }
    }
    fs::write(
        source.join("projects/plan.md"),
        "---\ntitle: Plan\n---\nPlan\n",
    )
    .expect("the project");
    let task = source.join("tasks/plan/task.md");
    fs::write(
        &task,
        "---\ntitle: Task\nproject: plan\n---\n## Budgets\nDetails\n",
    )
    .expect("the task");
    fs::write(dir.path().join("onetaskgraph.yaml"), format!(
        "sources:\n  authoring:\n    plugin: local-md\n    config:\n      root: {:?}\n  board:\n    plugin: local-md\n    config:\n      root: {:?}\n", source, destination,
    )).expect("the store configuration");
    let loaded = onetaskgraph_core::config::load(
        dir.path(),
        &onetaskgraph_core::Environment::from_os_pairs(Vec::new()),
        &onetaskgraph_core::config::Layer::default(),
    )
    .expect("the configuration loads");
    let engine = onetaskgraph_core::Engine::build(&loaded.config, &loaded.secrets);
    let source_task = engine
        .task(
            &"authoring:plan/task"
                .parse::<GlobalId>()
                .expect("a task id"),
        )
        .await
        .expect("read the authoring task");
    let Some(onetaskgraph_plugin_api::Location::Path(source_location)) =
        &source_task.items[0].item.location
    else {
        panic!("a local Markdown task has a file location");
    };
    fs::write(
        source.join("documents/design.md"),
        format!("---\ntitle: Design\nproject: plan\n---\n[Budget]({source_location}#budgets)\n"),
    )
    .expect("the project document");
    let request = |id: &str, scope| CopyRequest {
        items: CopyItems::new(vec![id.parse::<GlobalId>().expect("a qualified id")])
            .expect("one item"),
        scope,
        destination: onetaskgraph_plugin_api::SourceName::new("board").expect("a source name"),
        match_by: None,
        recreate: false,
        create: false,
        dry_run: false,
    };
    let plan = engine
        .copy(&request(
            "authoring:plan",
            CopyScope::Projects { tasks: true },
        ))
        .await
        .expect("copy the plan and its tasks first");
    let report = engine
        .copy(&request("authoring:design", CopyScope::Documents))
        .await
        .expect("copy the project document after its tasks");
    assert_eq!(report.references_rewritten, 1);
    let document = engine
        .document(report.items[0].destination().expect("a copied document id"))
        .await
        .expect("read the copied document");
    let content = document.items[0]
        .item
        .content
        .as_deref()
        .expect("document content");
    let copied_task = engine
        .task(
            plan.items
                .iter()
                .find(|item| item.source.to_string() == "authoring:plan/task")
                .expect("the task was copied")
                .destination()
                .expect("a copied task id"),
        )
        .await
        .expect("read the copied task");
    let location = copied_task.items[0]
        .item
        .location
        .as_ref()
        .expect("task location");
    let onetaskgraph_plugin_api::Location::Path(location) = location else {
        panic!("a local Markdown task has a file location");
    };
    assert!(content.contains(&format!("{location}#budgets")));
    assert!(!content.contains(source_location));
    assert!(
        engine
            .copy(&request("authoring:missing", CopyScope::Documents))
            .await
            .is_err(),
        "a missing document must be refused"
    );
}
