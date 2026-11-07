#!/usr/bin/env python3
"""Add the first-screen spike's reads to a copy of the engine, whatever line numbers it has.

Written as an insertion rather than a diff so it applies over `engine.patch`, which the
earlier spike keeps in its own form. Off until `src/live/first_screen.rs` calls it.
"""
import sys
from pathlib import Path

engine = Path(sys.argv[1])

views = engine / "src/views.rs"
text = views.read_text()
marker = "impl RunView {\n    /// Read one run, or report why it cannot be read.\n"
assert marker in text
views.write_text(text.replace(marker, '''impl RunView {
    /// Spike `first-screen`: a view of a run over records a reader chose, its state
    /// either folded from those records or resumed from the run's checkpoint. Cross-run
    /// edges are resolved only for a consumer that has not settled, because a settled
    /// node's status no longer reads them and each one is another run's whole ledger.
    pub fn spike_selected(
        paths: &RunPaths,
        events: Vec<Envelope>,
        from_checkpoint: bool,
        every_edge: bool,
    ) -> crate::Result<Self> {
        let mut state = if from_checkpoint {
            crate::checkpoint::fold_and_checkpoint(paths)
        } else {
            crate::projection::fold(&events)
        };
        let mut launch: LaunchRecord = ledger::read_json(&paths.launch())?;
        (launch.labels, launch.group) = crate::labels::effective(paths, &launch)?;
        landings_the_run_re_read(&mut state, paths);
        crate::heartbeat::apply(paths, &mut state);
        let root = paths
            .dir
            .parent()
            .map_or_else(ledger::runs_root, Path::to_path_buf);
        state.cross_dag = if every_edge {
            crate::crossdag::resolve_quietly(&root, &state.graph)
        } else {
            crate::crossdag::spike_resolve_open(&root, &state.graph, &|node| {
                state.recorded.contains_key(node)
            })
        };
        let refresh = RefreshCursor {
            dir: paths.dir.clone(),
            stamp: None,
            receipt: None,
            coverage: crate::checkpoint::Coverage::default(),
            result: ledger::read_json_opt(&paths.result()),
            upstreams: None,
        };
        Ok(Self {
            paths: paths.clone(),
            launch,
            events,
            state,
            refresh,
        })
    }

    /// Spike `first-screen`: `open_current`'s steps, each timed, with the bytes of the
    /// checkpoint document, and the same document parsed into nothing, which is the
    /// floor of any read of it.
    pub fn spike_open_current_steps(paths: &RunPaths) -> crate::Result<Vec<(String, f64)>> {
        let mut steps = crate::checkpoint::spike_open_steps(paths);
        let mut state = crate::checkpoint::fold_and_checkpoint(paths);
        let mut time = |name: &str, step: &mut dyn FnMut()| {
            let began = std::time::Instant::now();
            step();
            steps.push((name.to_owned(), began.elapsed().as_secs_f64() * 1000.0));
        };
        let mut launch = None;
        time("launch and labels", &mut || {
            launch = ledger::read_json::<LaunchRecord>(&paths.launch())
                .ok()
                .map(|mut launch| {
                    if let Ok((labels, group)) = crate::labels::effective(paths, &launch) {
                        launch.labels = labels;
                        launch.group = group;
                    }
                    launch
                });
        });
        time("landing re-read", &mut || {
            landings_the_run_re_read(&mut state, paths);
        });
        time("member heartbeats", &mut || {
            crate::heartbeat::apply(paths, &mut state);
        });
        time("cross-run resolution", &mut || {
            let root = paths
                .dir
                .parent()
                .map_or_else(ledger::runs_root, Path::to_path_buf);
            state.cross_dag = crate::crossdag::resolve_quietly(&root, &state.graph);
        });
        Ok(steps)
    }

    /// Read one run, or report why it cannot be read.
'''))

crossdag = engine / "src/crossdag.rs"
text = crossdag.read_text()
marker = "fn resolve_with(\n"
assert marker in text
crossdag.write_text(text.replace(marker, '''/// Spike `first-screen`: only the edges a node that has not settled still waits on.
pub(crate) fn spike_resolve_open(
    root: &Path,
    graph: &Graph,
    settled: &dyn Fn(&str) -> bool,
) -> BTreeMap<String, NodeStatus> {
    edges(graph)
        .into_iter()
        .filter(|(_, consumers)| consumers.iter().any(|node| !settled(node)))
        .filter_map(|(dependency, _)| {
            let reference = parse(&dependency)?;
            let status = satisfied_status(settled_status_recently(root, &reference));
            Some((dependency, status))
        })
        .collect()
}

''' + marker, 1))

checkpoint = engine / "src/checkpoint.rs"
text = checkpoint.read_text()
marker = "pub(crate) fn fold_and_checkpoint(paths: &RunPaths) -> RunState {"
assert marker in text
head, tail = text.split(marker, 1)
checkpoint.write_text(head.rstrip() + "\n\n" + '''/// Spike `first-screen`: what opening the checkpoint spends, step by step.
pub(crate) fn spike_open_steps(paths: &RunPaths) -> Vec<(String, f64)> {
    let mut steps = Vec::new();
    let began = std::time::Instant::now();
    let bytes = std::fs::read(paths.checkpoint()).unwrap_or_default();
    steps.push(("read the file".to_owned(), began.elapsed().as_secs_f64() * 1000.0));
    steps.push(("checkpoint bytes".to_owned(), bytes.len() as f64));
    let began = std::time::Instant::now();
    let _ = serde_json::from_slice::<serde::de::IgnoredAny>(&bytes);
    steps.push(("parse into nothing".to_owned(), began.elapsed().as_secs_f64() * 1000.0));
    let began = std::time::Instant::now();
    let parsed = serde_json::from_slice::<Checkpoint>(&bytes).ok();
    steps.push(("parse into the document".to_owned(), began.elapsed().as_secs_f64() * 1000.0));
    if let Some(checkpoint) = parsed {
        let began = std::time::Instant::now();
        let sealed = checkpoint.coverage.corroborated_by(
            &paths.journal(),
            &checkpoint.state,
            &checkpoint.tally,
        );
        steps.push(("seal".to_owned(), began.elapsed().as_secs_f64() * 1000.0));
        steps.push(("seal holds".to_owned(), f64::from(u8::from(sealed))));
        let began = std::time::Instant::now();
        let state = checkpoint.state.clone();
        let tally = checkpoint.tally.clone();
        steps.push(("clone the state".to_owned(), began.elapsed().as_secs_f64() * 1000.0));
        drop((state, tally));
    }
    let began = std::time::Instant::now();
    let _ = Projected::open_with(paths, Persist::No);
    steps.push((
        "the whole fold, resumed, with nothing written".to_owned(),
        began.elapsed().as_secs_f64() * 1000.0,
    ));
    let began = std::time::Instant::now();
    let _ = fold_and_checkpoint(paths);
    steps.push((
        "the whole fold, resumed, as open_current takes it".to_owned(),
        began.elapsed().as_secs_f64() * 1000.0,
    ));
    steps
}

''' + marker + tail)
