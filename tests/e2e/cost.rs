//! What a read costs, counted against the real server over a real runs root.
//!
//! One fact made this server expensive and every symptom an operator reported
//! followed from it: **listing anything read everything**. A run list opened and
//! folded every run under the root and then sliced a page off the result, so a
//! page of one cost more than a page of fifty; every route about one named run
//! surveyed the root to find it; each served row started a subprocess; and an
//! open subscriber re-took that survey twice a second to compute change tokens,
//! which is one core, continuously, per connection, emitting nothing.
//!
//! These journeys are the bound. They count what the process asked the kernel
//! for — bytes read, files opened, metadata looked up, processes started — over
//! stores this suite writes, through the compiled binary on a real socket.
//! `tests/support/cost.rs` is how the counting is done and why it is operations
//! rather than time.
//!
//! **What a page size can and cannot bound**, stated once here because every
//! journey below is written against it: the list is ordered by last activity, so
//! answering "the most recently active N" needs every run's last activity, and
//! that lives one fixed-size document per run with no root-level index above it.
//! The cost of a listing is therefore *not* independent of how many runs a root
//! holds, and nothing here asks it to be. What the page size bounds is
//! everything else — a page of one reads one row's worth of every per-row cost,
//! and one fixed-size record for each run it does not serve.

#![cfg(target_os = "linux")]

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::cost_support::{Counts, Traced, TRACED_POLL_MS};
use crate::fixture_run;
use crate::http;

/// A run id of a fixed width, so two stores' runs sort the same way and their
/// summary documents are the same size.
///
/// Both matter to what is asserted below: the order decides which row a page of
/// one serves, and the document's size is what a run the page does *not* serve
/// costs.
fn nth_run(n: usize) -> String {
    format!("run-20260807-{n:06}")
}

/// The run every page of one serves, in every store built here.
///
/// Every fixture run records its last write at the same instant, so the order
/// falls through to the id — and this one sorts first.
const FIRST_RUN: &str = "run-20260807-000000";

/// A store of `runs` recorded runs, each with a current summary document.
///
/// Summarised the way a run recorded by the current engine already is: its
/// journal's writer keeps the document current a record at a time. A fixture
/// writes a journal by hand and so has none until something reads it, and a
/// journey about what a *listing* costs must not be measuring the one fold that
/// backfills them.
fn store_of(runs: usize) -> impl FnOnce(&Path) {
    move |root: &Path| {
        for n in 0..runs {
            let run = nth_run(n);
            fixture_run::write(root, &run);
            fixture_run::summarize(root, &run);
        }
    }
}

/// The whole run list, as an operator's first request asks for it.
const WHOLE_LIST: &str = "/api/v2/runs?include_settled=true";

/// How many bulky records an inflated journal carries.
///
/// Fixed across every inflated run, so two runs differ in their journals' *size*
/// and in nothing else a summary records — same graph, same record count, same
/// last instant — which is what lets what reading each of them cost be compared.
const BULK_RECORDS: usize = 200;

#[test]
fn a_row_is_read_from_the_summary_however_large_the_journal_behind_it() {
    // The same store twice over, differing only in how much one run has
    // recorded: a thousand bytes of prose per record against a hundred thousand.
    // A reading that folded the journal would grow by the difference; one that
    // reads the summary beside it does not move at all.
    let costs: Vec<(u64, Counts)> = [1_000, 100_000]
        .into_iter()
        .map(|bytes| {
            let serving = Traced::start(|root| {
                fixture_run::write(root, FIRST_RUN);
                fixture_run::inflate(root, FIRST_RUN, BULK_RECORDS, bytes);
                fixture_run::summarize(root, FIRST_RUN);
            });
            let journal = std::fs::metadata(serving.run_dir(FIRST_RUN).join("events.jsonl"))
                .expect("the journal")
                .len();
            let run_dir = serving.run_dir(FIRST_RUN);
            let marker = serving.mark("marker-listing");
            let listed = http::get(serving.address, WHOLE_LIST).json();
            assert_eq!(listed["runs"][0]["run_id"], json!(FIRST_RUN), "{listed}");
            let cost = serving.finish().since(&marker);
            assert_eq!(
                cost.processes_started(),
                0,
                "a served row started a process for its clock"
            );
            (journal, cost.under(&run_dir))
        })
        .collect();

    let [(small, cheap), (large, dear)] = costs.as_slice() else {
        panic!("two stores were measured")
    };
    assert!(
        large > &(small * 50),
        "the two journals are {small} and {large} bytes, which is not far enough apart for \
         this to be asking anything"
    );
    assert_eq!(
        (cheap.opens, cheap.lookups),
        (dear.opens, dear.lookups),
        "a run-list row did more work over the larger journal: {cheap:?} against {dear:?}"
    );
    // **What the bytes can and cannot be held to.** The two rows cannot read the
    // *same* number of bytes and no repository state could make them: a summary
    // records the length of the journal it describes, so a journal seventy times
    // longer has a summary two decimal digits wider. What they can be held to is
    // the difference, which is those digits and nothing else — a fold would put
    // the whole journal here.
    assert!(
        dear.bytes.abs_diff(cheap.bytes) < 32,
        "the row over the {large}-byte journal read {} bytes against {} over the \
         {small}-byte one, which is more than the recorded length can account for",
        dear.bytes,
        cheap.bytes
    );
    assert!(
        dear.bytes < *small,
        "the row read {} bytes of a run whose summary is a fraction of that",
        dear.bytes
    );
}

#[test]
fn a_run_list_over_summarised_runs_folds_no_journal_and_starts_no_process() {
    // Three runs, each with a journal far larger than the row it is listed as,
    // and each with the summary the engine keeps beside it.
    let serving = Traced::start(|root| {
        for n in 0..3 {
            let run = nth_run(n);
            fixture_run::write(root, &run);
            fixture_run::inflate(root, &run, BULK_RECORDS, 5_000);
            fixture_run::summarize(root, &run);
        }
    });
    let marker = serving.mark("marker-no-fold");
    let listed = http::get(serving.address, WHOLE_LIST).json();
    assert_eq!(listed["runs"].as_array().map(Vec::len), Some(3), "{listed}");
    let root = serving.runs_root();
    let journals: Vec<std::path::PathBuf> = (0..3)
        .map(|n| root.join(nth_run(n)).join("events.jsonl"))
        .collect();
    let cost = serving.finish().since(&marker);
    for journal in &journals {
        assert_eq!(
            cost.under(journal).bytes,
            0,
            "the list folded {}",
            journal.display()
        );
    }
    // And the fourth operation, which is what fifty rows used to be fifty of.
    assert_eq!(
        cost.processes_started(),
        0,
        "the list started a process per row"
    );
}

#[test]
fn the_work_a_page_does_per_row_does_not_grow_with_the_store() {
    // Two stores an order of magnitude apart, asked the same question: give me
    // one row. What is inherently per run — reading each summary, ordering by
    // what they say — is not what this counts; what it counts is everything
    // done *to the run that is served*, which is the work a page size bounds.
    let costs: Vec<Counts> = [3, 30]
        .into_iter()
        .map(|runs| {
            let serving = Traced::start(store_of(runs));
            let served = serving.run_dir(FIRST_RUN);
            let marker = serving.mark("marker-one-row");
            let listed =
                http::get(serving.address, "/api/v2/runs?include_settled=true&limit=1").json();
            assert_eq!(listed["runs"].as_array().map(Vec::len), Some(1), "{listed}");
            assert_eq!(listed["runs"][0]["run_id"], json!(FIRST_RUN), "{listed}");
            let cost = serving.finish().since(&marker);
            assert_eq!(cost.processes_started(), 0);
            cost.under(&served)
        })
        .collect();
    assert_eq!(
        costs[0], costs[1],
        "serving one row cost more in the larger store: {costs:?}"
    );
    assert!(costs[0].opens > 0, "the served row was not read at all");
}

#[test]
fn a_run_the_page_does_not_serve_costs_its_summary_and_nothing_else() {
    // Two runs of the same shape whose journals are three orders of magnitude
    // apart, neither of them served: the page is one row and the run that fills
    // it is a third one.
    const SMALL: &str = "run-20260807-000001";
    const LARGE: &str = "run-20260807-000002";
    let serving = Traced::start(|root| {
        for (run, bytes) in [(FIRST_RUN, 10), (SMALL, 100), (LARGE, 100_000)] {
            fixture_run::write(root, run);
            // The served run is inflated too, so all three record their last
            // write at the same instant and the order falls through to the id —
            // which puts the run this page serves first and leaves the two being
            // compared unserved.
            fixture_run::inflate(root, run, BULK_RECORDS, bytes);
            fixture_run::summarize(root, run);
        }
    });
    let root = serving.runs_root();
    let sizes: Vec<u64> = [SMALL, LARGE]
        .iter()
        .map(|run| fixture_run::summary_len(&root, run))
        .collect();
    let marker = serving.mark("marker-unserved");
    let listed = http::get(serving.address, "/api/v2/runs?include_settled=true&limit=1").json();
    assert_eq!(listed["runs"][0]["run_id"], json!(FIRST_RUN), "{listed}");
    let cost = serving.finish().since(&marker);

    for (run, summary) in [SMALL, LARGE].iter().zip(&sizes) {
        let dir = root.join(run);
        // **Equality, and against the one number that makes it falsifiable.**
        // The literal reading — the two runs cost the same — cannot be asked of
        // any tree: a summary records the length of the journal it describes, so
        // two journals orders of magnitude apart have summaries that differ by
        // the decimal width of that one number and can never be the same size.
        // What is asked instead is exact and stronger: each unserved run cost
        // its own summary document and not one byte more.
        assert_eq!(
            cost.under(&dir).bytes,
            *summary,
            "{run} cost more than its summary, so the page read something else about it"
        );
        assert_eq!(
            cost.under(&dir.join("events.jsonl")).bytes,
            0,
            "{run}'s journal was read for a row nobody asked for"
        );
        assert_eq!(
            cost.under(&dir).opens,
            1,
            "{run} was opened more than once, so the summary is not all that was read"
        );
    }
    assert!(
        sizes[0].abs_diff(sizes[1]) < 32,
        "the two summaries differ by {} bytes, which is more than the recorded journal \
         length can account for — so this journey is comparing two different documents",
        sizes[0].abs_diff(sizes[1])
    );
}

#[test]
fn a_run_with_no_summary_is_folded_once_across_two_listings() {
    // The engine's own fallback: a run recorded by a build that predates the
    // summary document has none, so the first reader folds it and caches what it
    // folded. What this server must not do is add a fold of its own beside it.
    let serving = Traced::start(|root| {
        fixture_run::write(root, FIRST_RUN);
        fixture_run::inflate(root, FIRST_RUN, BULK_RECORDS, 5_000);
    });
    let journal_path = serving.run_dir(FIRST_RUN).join("events.jsonl");
    let journal = std::fs::metadata(&journal_path).expect("the journal").len();

    let first = serving.mark("marker-first-listing");
    assert_eq!(
        http::get(serving.address, WHOLE_LIST).json()["runs"][0]["run_id"],
        json!(FIRST_RUN)
    );
    let second = serving.mark("marker-second-listing");
    assert_eq!(
        http::get(serving.address, WHOLE_LIST).json()["runs"][0]["run_id"],
        json!(FIRST_RUN)
    );
    let cost = serving.finish();

    let folding = cost.since(&first).under(&journal_path).bytes;
    let after = cost.since(&second).under(&journal_path).bytes;
    // The engine's own cold open, and nothing beside it. `RunView::open` reads
    // the journal whole for the view's events and whole again to fold it into
    // the checkpoint it writes beside the summary, and then reads back the
    // prefix that checkpoint covers to seal it — a third read that is at most
    // the journal again. That is the price the linked engine puts on a run it
    // has never summarized; one more whole read would be this server folding
    // beside it rather than reading what it cached.
    assert!(
        (journal * 2..=journal * 3).contains(&folding),
        "the first listing read {folding} bytes of a {journal}-byte journal, which is not \
         the engine's own cold open of it"
    );
    assert_eq!(
        after, 0,
        "the second listing folded the journal again, so nothing was cached"
    );
}

#[test]
fn asking_for_one_row_never_costs_more_than_asking_for_fifty() {
    // The operator's own measurement, inverted. Theirs was a page of one at
    // 2m44s against a page of fifty at 1m46s, because the limit was a slice
    // taken after every run had already been read.
    let serving = Traced::start(store_of(30));
    let root = serving.runs_root();

    let one = serving.mark("marker-page-of-one");
    assert_eq!(
        http::get(serving.address, "/api/v2/runs?include_settled=true&limit=1").json()["runs"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    let fifty = serving.mark("marker-page-of-fifty");
    assert_eq!(
        http::get(
            serving.address,
            "/api/v2/runs?include_settled=true&limit=50"
        )
        .json()["runs"]
            .as_array()
            .map(Vec::len),
        Some(30)
    );
    let closing = serving.mark("marker-page-done");
    let cost = serving.finish();

    let small = cost.between(&one, &fifty);
    let large = cost.between(&fifty, &closing);
    let (asked_less, asked_more) = (small.under(&root), large.under(&root));
    assert!(
        asked_less.bytes <= asked_more.bytes
            && asked_less.opens <= asked_more.opens
            && asked_less.lookups <= asked_more.lookups
            && small.processes_started() <= large.processes_started()
            && small.listings_of(&root) <= large.listings_of(&root),
        "asking for one row cost more than asking for fifty: {asked_less:?} against \
         {asked_more:?}"
    );
}

#[test]
fn an_idle_subscriber_opens_nothing_reads_nothing_and_does_not_spin() {
    // The single largest cost this server had: one connected subscriber pinned a
    // core, continuously, while emitting nothing, because every poll tick
    // re-surveyed the whole root to compute change tokens.
    let serving = Traced::start(store_of(3));
    let root = serving.runs_root();
    let mut stream = http::stream(serving.address, "/api/v2/events", None);
    let snapshot = stream
        .next_frame()
        .expect("a connection opens with a snapshot");
    assert_eq!(snapshot.event, "snapshot");

    // Everything after this point is ticks over a store in which nothing is
    // recording anything.
    let marker = serving.mark("marker-idle-stream");
    let opened = Instant::now();
    let idle = Duration::from_millis(TRACED_POLL_MS * 10);
    assert!(
        stream.frame_within(idle).is_none(),
        "a store where nothing recorded anything woke its subscriber"
    );
    let elapsed = opened.elapsed();
    drop(stream);
    let cost = serving.finish().since(&marker);

    // The ticks the connection took, counted from the one thing each of them is
    // allowed to do. A tick is one listing of the runs root — which is what lets
    // a run that appeared since the last tick be noticed.
    let ticks = cost.listings_of(&root);
    // A count of poll intervals inside a bounded wait this journey itself set,
    // so the quotient is tens rather than anything a `usize` could lose.
    #[allow(clippy::cast_possible_truncation)]
    let due = (elapsed.as_millis() / u128::from(TRACED_POLL_MS)) as usize;
    assert!(
        ticks <= due + 1,
        "the subscriber took {ticks} ticks over {elapsed:?}, where a poll of \
         {TRACED_POLL_MS}ms is {due} — it is spinning rather than waiting"
    );
    assert!(
        ticks + 1 >= due,
        "the subscriber took {ticks} ticks over {elapsed:?}, where a poll of \
         {TRACED_POLL_MS}ms is {due} — it is not polling at all"
    );

    for n in 0..3 {
        let dir = root.join(nth_run(n));
        let counts = cost.under(&dir);
        assert_eq!(
            counts.bytes,
            0,
            "an idle tick read {} bytes of {}",
            counts.bytes,
            dir.display()
        );
        assert_eq!(
            counts.opens,
            0,
            "an idle tick opened a file under {}",
            dir.display()
        );
        // One metadata lookup per run per tick, and no second one: that lookup
        // is the whole of how a tick tells a run that moved from one that did
        // not.
        assert!(
            counts.lookups <= ticks,
            "an idle tick looked {} up {} times over {ticks} ticks",
            dir.display(),
            counts.lookups
        );
    }
    assert_eq!(
        cost.processes_started(),
        0,
        "an idle subscriber started a process"
    );
}

#[test]
fn an_idle_subscribers_tick_grows_only_by_one_lookup_per_run() {
    // The same idle stream against two stores an order of magnitude apart. What
    // may grow is the one metadata lookup each; nothing else may move at all.
    let measured: Vec<(usize, Counts, usize)> = [3, 30]
        .into_iter()
        .map(|runs| {
            let serving = Traced::start(store_of(runs));
            let root = serving.runs_root();
            let mut stream = http::stream(serving.address, "/api/v2/events", None);
            assert_eq!(
                stream.next_frame().expect("a snapshot").event,
                "snapshot",
                "a connection opens with a snapshot"
            );
            let marker = serving.mark("marker-idle-scale");
            assert!(stream
                .frame_within(Duration::from_millis(TRACED_POLL_MS * 5))
                .is_none());
            drop(stream);
            let cost = serving.finish().since(&marker);
            assert_eq!(cost.processes_started(), 0);
            (runs, cost.under(&root), cost.listings_of(&root))
        })
        .collect();

    for (runs, under, ticks) in &measured {
        assert_eq!(
            under.bytes, 0,
            "an idle stream over {runs} runs read {} bytes",
            under.bytes
        );
        assert_eq!(
            under.opens, 0,
            "an idle stream over {runs} runs opened a file"
        );
        // The one thing that may grow with the store, and the whole of what a
        // tick is allowed: one lookup per run, to ask whether its journal moved.
        assert!(
            under.lookups <= ticks * runs,
            "an idle stream over {runs} runs looked something up {} times in {ticks} ticks, \
             which is more than once per run per tick",
            under.lookups
        );
    }
    let (small, large) = (measured[0].2, measured[1].2);
    assert!(
        small.abs_diff(large) <= 2,
        "an idle stream listed the root {small} times over three runs and {large} times over \
         thirty, so its per-tick work grows with the store"
    );
}

#[test]
fn a_route_serving_one_named_run_touches_that_run_alone() {
    // A store whose other runs would be expensive to touch, and a route about
    // one of them. Under the reading this replaces, every one of these routes
    // surveyed the root to find the run it was asked for — which is why a
    // transcript that is not large took as long as the gigabytes beside it.
    const ASKED: &str = "run-20260807-000000";
    const OTHER: &str = "run-20260807-000001";
    let serving = Traced::start(|root| {
        for run in [ASKED, OTHER] {
            fixture_run::write(root, run);
        }
        fixture_run::inflate(root, OTHER, BULK_RECORDS, 5_000);
        fixture_run::summarize(root, OTHER);
    });
    let root = serving.runs_root();
    let marker = serving.mark("marker-one-run");
    for route in [
        format!("/api/v2/runs/{ASKED}/timeline?scope=run"),
        format!(
            "/api/v2/runs/{ASKED}/conversations/{}",
            fixture_run::CONVERSATION_ID
        ),
    ] {
        let answered = http::get(serving.address, &route).json();
        assert!(answered.get("error").is_none(), "{route}: {answered}");
    }
    let cost = serving.finish().since(&marker);

    assert!(
        cost.under(&root.join(OTHER)).is_nothing(),
        "a route about one run touched another: {:?}",
        cost.under(&root.join(OTHER))
    );
    assert_eq!(
        cost.listings_of(&root),
        0,
        "a route about one run surveyed the whole root to find it"
    );
    assert!(
        cost.under(&root.join(ASKED)).bytes > 0,
        "the run that was asked for was not read at all"
    );
}

#[test]
fn a_selection_touches_only_the_runs_it_names() {
    // The reason the selection exists: an invalidation names the run that moved,
    // and refreshing that one row must cost one row. A selection that surveyed
    // the store would leave the browser's refresh costing what refetching the
    // first page costs, which is the defect it was added to remove.
    const NAMED: &str = "run-20260807-000000";
    let serving = Traced::start(store_of(20));
    let root = serving.runs_root();
    let marker = serving.mark("marker-selection");
    let answered = http::get(serving.address, &format!("/api/v2/runs?select={NAMED}")).json();
    assert_eq!(answered["runs"][0]["run_id"], json!(NAMED), "{answered}");
    let cost = serving.finish().since(&marker);

    for n in 1..20 {
        let dir = root.join(nth_run(n));
        assert!(
            cost.under(&dir).is_nothing(),
            "a selection of one touched {}: {:?}",
            dir.display(),
            cost.under(&dir)
        );
    }
    assert_eq!(
        cost.listings_of(&root),
        0,
        "a selection surveyed the runs root instead of opening what it was given"
    );
    assert_eq!(cost.processes_started(), 0, "a selection started a process");
    assert!(
        cost.under(&root.join(NAMED)).opens > 0,
        "the run that was named was not read"
    );
}

#[test]
fn a_run_detail_starts_no_process_and_folds_its_clock_once_per_change() {
    // The one process this server used to start, and does not: a run's detail
    // read its clock through `onepipeline telemetry`, and reads it now through
    // the SDK's own fold over the view the route already holds. The cache that
    // kept the process to one per change keeps the fold to one per change — so
    // a reader refreshing a run that has not moved reads its journal once for
    // the two details, rather than walking it again for the clock.
    let serving = Traced::start(|root| {
        fixture_run::write(root, FIRST_RUN);
    });
    let marker = serving.mark("marker-detail-twice");
    for _ in 0..2 {
        let detail = http::get(serving.address, &format!("/api/v2/runs/{FIRST_RUN}")).json();
        assert_eq!(detail["run"]["run_id"], json!(FIRST_RUN), "{detail}");
        assert!(
            !detail["run"]["timing"]["wall_ms"].is_null(),
            "the fold did not answer, so this journey is counting nothing"
        );
    }
    let cost = serving.finish().since(&marker);
    assert_eq!(
        cost.processes_started(),
        0,
        "a run's detail started a process for its clock"
    );
}

#[test]
fn a_subscriber_whose_filter_narrows_nothing_pays_nothing_to_narrow_it() {
    // The browser's **Detailed activity** setting is a named profile rather than
    // an absence, so the ordinary subscription arrives filtered. If a filter cost
    // a read whether or not it could narrow anything, that setting would fold
    // every run in the root at the moment a tab opened — which is the defect
    // these bounds exist to remove, arriving by another door.
    //
    // A filter that *can* narrow does pay, once, and the price is exact: with
    // nothing to compare the admitted records against, the first movement of
    // every run would announce and a reader who narrowed their attention would
    // be woken by the very records they excluded. What neither pays is a tick.
    let measured: Vec<(&str, u64, u64)> = ["detailed", "planner"]
        .into_iter()
        .map(|profile| {
            let serving = Traced::start(|root| {
                for n in 0..3 {
                    let run = nth_run(n);
                    fixture_run::write(root, &run);
                    fixture_run::inflate(root, &run, BULK_RECORDS, 5_000);
                    fixture_run::summarize(root, &run);
                }
            });
            let root = serving.runs_root();
            let journals: Vec<std::path::PathBuf> = (0..3)
                .map(|n| root.join(nth_run(n)).join("events.jsonl"))
                .collect();
            let opening = serving.mark("marker-filtered-open");
            let mut stream = http::stream(
                serving.address,
                &format!("/api/v2/events?filter={profile}"),
                None,
            );
            assert_eq!(
                stream.next_frame().expect("a snapshot").event,
                "snapshot",
                "a filtered connection opens with a snapshot too"
            );
            let idle = serving.mark("marker-filtered-idle");
            assert!(stream
                .frame_within(Duration::from_millis(TRACED_POLL_MS * 5))
                .is_none());
            drop(stream);
            let cost = serving.finish();
            let folded = |taken: &crate::cost_support::Cost| -> u64 {
                journals.iter().map(|at| taken.under(at).bytes).sum()
            };
            (
                profile,
                folded(&cost.between(&opening, &idle)),
                folded(&cost.since(&idle)),
            )
        })
        .collect();

    let narrows_nothing = measured[0];
    let can_narrow = measured[1];
    assert_eq!(
        narrows_nothing.1, 0,
        "a subscription on `{}` folded {} bytes of journal to open, and it narrows nothing",
        narrows_nothing.0, narrows_nothing.1
    );
    assert!(
        can_narrow.1 > 0,
        "a subscription on `{}` read no journal to open, so it has nothing to compare its \
         admitted records against and will announce every first movement",
        can_narrow.0
    );
    for (profile, _, per_tick) in measured {
        assert_eq!(
            per_tick, 0,
            "a `{profile}` subscription read {per_tick} bytes of journal while nothing \
             recorded anything"
        );
    }
}

/// A history store as a long-lived host holds one: the legacy whole-store
/// indexes the core before the dated segments kept, and the sessions of every
/// project that has run there since.
///
/// Both legacy indexes exist and cannot be opened, so a recorder or a reader
/// that reconciled them on open could not answer at all; and the sessions are
/// numerous enough, across enough projects, that one which walked the store to
/// find what an index would have told it pays for it on the trace.
struct LongLivedStore {
    dir: tempfile::TempDir,
    /// Every file the store held before anything was recorded, with its bytes.
    held: Vec<(std::path::PathBuf, Vec<u8>)>,
}

/// How many sessions other projects left behind in the store.
const OTHER_SESSIONS: usize = 1_200;

/// How many project directories they are spread across.
const OTHER_PROJECTS: usize = 6;

/// The two legacy indexes, by the names the core before the dated segments
/// wrote them under.
const LEGACY_INDEXES: [&str; 2] = [".index.jsonl", ".event-index.jsonl"];

impl LongLivedStore {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("the oneharness history store");
        // A real session's bytes, recorded by the linked writer into a scratch
        // store, so every file the store holds is one the reader could parse.
        let scratch = tempfile::tempdir().expect("a scratch store");
        let sample = crate::harness_history::record(
            scratch.path(),
            "an earlier worker",
            "do the earlier task",
            "the earlier task is done",
        );
        let bytes = std::fs::read(&sample.path).expect("the sample session");
        let mut held = Vec::new();
        let mut legacy = String::new();
        for n in 0..OTHER_SESSIONS {
            let project = format!("-home-dev-project-{}", n % OTHER_PROJECTS);
            let session = format!("earlier-worker-20250101T000000Z-{n}");
            let path = dir.path().join(&project).join(format!("{session}.jsonl"));
            std::fs::create_dir_all(path.parent().expect("a project")).expect("a project dir");
            std::fs::write(&path, &bytes).expect("an earlier session");
            legacy.push_str(&format!(
                "{{\"project\":\"{project}\",\"session\":\"{session}\"}}\n"
            ));
            held.push((path, bytes.clone()));
        }
        for name in LEGACY_INDEXES {
            let path = dir.path().join(name);
            std::fs::write(&path, &legacy).expect("a legacy index");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000))
                .expect("make the legacy index unopenable");
            held.push((path, legacy.clone().into_bytes()));
        }
        Self { dir, held }
    }

    /// The store, as the writer spells it once it has resolved it.
    fn path(&self) -> std::path::PathBuf {
        std::fs::canonicalize(self.dir.path()).expect("the store")
    }

    /// Every file the store held before, as it holds it now — the legacy
    /// indexes read back by restoring the permission they were refused under.
    fn held_now(&self) -> Vec<(std::path::PathBuf, Vec<u8>)> {
        use std::os::unix::fs::PermissionsExt;

        self.held
            .iter()
            .map(|(path, _)| {
                let legacy = LEGACY_INDEXES
                    .iter()
                    .any(|name| path.file_name() == Some(std::ffi::OsStr::new(name)));
                if legacy {
                    let mode = std::fs::metadata(path)
                        .expect("the legacy index is still there")
                        .permissions()
                        .mode()
                        & 0o777;
                    assert_eq!(mode, 0, "{} was made openable", path.display());
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o400))
                        .expect("read the legacy index back");
                }
                let bytes = std::fs::read(path).unwrap_or_else(|error| {
                    panic!("{} is no longer readable: {error}", path.display())
                });
                (path.clone(), bytes)
            })
            .collect()
    }
}

/// The UTC date a UUIDv7 history id was minted on, as `YYYY-MM-DD` — the date
/// whose dated segment its index entry lands in.
fn minted_on(history_id: &str) -> String {
    let millis = u64::from_str_radix(&history_id.replace('-', "")[..12], 16)
        .expect("a UUIDv7 carries its instant in its first 48 bits");
    let date = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .expect("an instant")
        .date();
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// The realtime clock the tracer stamps each call with.
fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs_f64()
}

/// A run is recorded, and its session served, without reading an index or
/// walking the history store — on a store a long-lived host really holds.
///
/// Every run a dispatch records goes through the core this binary links, and
/// the core it linked before re-read the whole legacy index and walked every
/// session file on each one: a host with gigabytes of history queued every
/// worker behind one lock. The linked core records into a dated segment
/// instead, and the server resolves a session by the project and file its
/// pointer names. Both halves are held here against the kernel's own record of
/// every open and listing the test process and the server it starts make —
/// granted or refused, because a reader that tries an index it cannot open and
/// falls back to a walk has done the forbidden thing on its first attempt.
#[test]
fn a_session_is_recorded_and_served_without_reading_an_index_or_walking_the_store() {
    use crate::cost_support::{Reach, Watch};
    use oneharness_core::domain::history::HistoryShowEntry;
    use oneharness_core::io::history;

    const STREAM: &str = "node-scope-1786925518098-3163646";
    let store = LongLivedStore::new();
    let root = store.path();
    let lock = root.join(".index.lock");
    assert!(!lock.exists(), "the store starts with no lock file");
    let projects = tempfile::tempdir().expect("the directories the harnesses ran in");
    let tasks = [
        (
            "contract worker",
            "land the wire contract",
            "the route table is landed",
        ),
        ("judge", "judge the contract", "the contract holds"),
        ("observer", "watch the run", "the run settled"),
    ];
    for (n, _) in tasks.iter().enumerate() {
        std::fs::create_dir_all(projects.path().join(format!("project-{n}")))
            .expect("a project the harness ran in");
    }

    let watch = Watch::this_process();
    let mut recorded = Vec::new();
    let mut recording = Vec::new();
    for (n, (name, prompt, text)) in tasks.iter().enumerate() {
        recording.push(now());
        recorded.push(crate::harness_history::record_from(
            &root,
            &projects.path().join(format!("project-{n}")),
            name,
            prompt,
            text,
        ));
    }
    let starting = now();
    let serving = crate::serving::Serving::start(|runs| {
        let dir = fixture_run::write(runs, fixture_run::RUN_ID);
        for session in &recorded {
            fixture_run::relay_harness_session(
                &dir,
                &fixture_run::HarnessSession {
                    stream: STREAM,
                    node: fixture_run::NODE_ID,
                    member: "worker",
                    history_dir: Some(&session.dir),
                    history_project: &session.project,
                    history_session: &session.session,
                    history_id: &session.history_id,
                    bytes: session.bytes(),
                },
            );
        }
    });
    let mut serving_at = Vec::new();
    let mut served = Vec::new();
    for session in &recorded {
        serving_at.push(now());
        let response = http::get(
            serving.address,
            &format!(
                "/api/v2/runs/{}/artifacts/{}",
                fixture_run::RUN_ID,
                session.history_id
            ),
        );
        assert_eq!(response.status, 200, "{}", response.body);
        served.push(response.json());
    }
    let stopping = now();
    drop(serving);
    let accesses = watch.finish();

    // Each session is served as the linked core renders its finished run.
    for (session, body) in recorded.iter().zip(&served) {
        assert_eq!(body["kind"], json!("oneharness_session"), "{body}");
        let entry = history::read_session_display(&session.path)
            .expect("the recorded session")
            .into_iter()
            .find(|entry| {
                matches!(entry, HistoryShowEntry::Record(record)
                    if record.history_id.to_string() == session.history_id)
            })
            .expect("the session holds its finished run");
        assert_eq!(
            body["content"].as_str(),
            Some(
                serde_json::to_string_pretty(&entry)
                    .expect("a record")
                    .as_str()
            ),
            "the session served is not the record the core renders for {}",
            session.history_id
        );
    }

    // Each run's entry, and the entry for the event it streamed, landed in the
    // segments for the date it was minted on.
    for session in &recorded {
        for kind in ["runs", "events"] {
            let segment = root
                .join(".index.d")
                .join(format!("{kind}-{}.ndjson", minted_on(&session.history_id)));
            let entries = std::fs::read_to_string(&segment)
                .unwrap_or_else(|error| panic!("{}: {error}", segment.display()));
            assert!(
                entries.contains(&session.history_id),
                "{} holds no entry for {}: {entries}",
                segment.display(),
                session.history_id
            );
        }
    }

    // Nothing the store held before changed, and no lock was taken.
    assert!(
        !lock.exists(),
        "recording or reading created {}",
        lock.display()
    );
    for ((path, before), (_, after)) in store.held.iter().zip(store.held_now()) {
        assert!(before == &after, "{} was changed", path.display());
    }

    // And the trace: in each phase, nothing under the store but what that
    // phase's session is allowed to reach.
    let segments = root.join(".index.d");
    let phases: Vec<(f64, f64, Vec<std::path::PathBuf>, String)> = recorded
        .iter()
        .enumerate()
        .map(|(n, session)| {
            let until = recording.get(n + 1).copied().unwrap_or(starting);
            let project = session.path.parent().expect("a project").to_path_buf();
            let date = minted_on(&session.history_id);
            (
                recording[n],
                until,
                vec![
                    session.path.clone(),
                    project,
                    segments.clone(),
                    segments.join(format!("runs-{date}.ndjson")),
                    segments.join(format!("events-{date}.ndjson")),
                ],
                format!("recording {}", session.history_id),
            )
        })
        .chain(std::iter::once((
            starting,
            serving_at[0],
            Vec::new(),
            "starting the server".to_owned(),
        )))
        .chain(recorded.iter().enumerate().map(|(n, session)| {
            let until = serving_at.get(n + 1).copied().unwrap_or(stopping);
            let project = session.path.parent().expect("a project").to_path_buf();
            (
                serving_at[n],
                until,
                vec![session.path.clone(), project],
                format!("serving {}", session.history_id),
            )
        }))
        .collect();
    let in_store: Vec<_> = accesses
        .iter()
        .filter(|access| access.path.starts_with(&root))
        .collect();
    let mut reached = 0;
    for access in &in_store {
        let phase = phases
            .iter()
            .find(|(from, until, _, _)| access.at >= *from && access.at < *until);
        let Some((_, _, allowed, what)) = phase else {
            panic!("{access:?} reached the store outside every phase this journey ran");
        };
        assert!(
            allowed.iter().any(|path| path == &access.path),
            "{what} {} {} — only {allowed:?} may be",
            match access.kind {
                Reach::Open => "opened",
                Reach::List => "listed",
            },
            access.path.display()
        );
        reached += 1;
    }
    // A trace that saw nothing would pass every assertion above: the sessions
    // were written and read, so each of their files was opened.
    for session in &recorded {
        assert!(
            in_store
                .iter()
                .filter(|access| access.path == session.path && access.kind == Reach::Open)
                .count()
                >= 2,
            "the trace never saw {} written and read, so it saw nothing: {reached} accesses",
            session.path.display()
        );
    }
}
