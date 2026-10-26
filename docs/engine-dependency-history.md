# Engine dependency history

Historical reasons for engine upgrades. Run driving belongs to the pinned engine CLI;
this read API serves its records and channel verbs. Current pin constraints live in
[Cargo.toml](../Cargo.toml).

0.51.0 links the onetaskgraph store (`onetaskgraph-core` and its plugins)
where earlier releases spawned an `onetaskgraph` executable, so the driver an
adoption retains reads and projects a run's plan store in process. That family
arrives only through this line, pinned exactly by the engine, and this crate's
own source names none of it.
Its github-projects and linear plugins reach reqwest's native TLS, so a build
of this crate compiles OpenSSL from source through `openssl-src` and needs
`make` beside a C compiler — why visual-docs.yml's capture job installs it.

0.52.0 adds host-owned task templates: `start` resolves a `template_root` and
`require_rendered` (launch-config schema 12), holds the plan to them, and
retains both in the launch record. Adoption reloads no plan from the store and
runs no rendered-only check, so a CLI-driven run keeps what its launch
recorded, and nothing here reads either setting.

0.52.1 lands a change to an item the run's landed baseline
(`writeback-landed.json`) already holds through a targeted update naming only
the fields that changed, where 0.52.0 copied the project. A CLI-driven
run's driver is this line's copy of the engine, so it spends only on what
changed once this moves; this crate reads neither that file nor the
projection record.

0.53.0 delivers a manager's live note off the run's single writer: a note
waiting on a turn that takes it only as it ends no longer holds the run's
journal, so the turn's work and its member's heartbeat go on being recorded
and the run goes on reading as live. It also names, in a `checks-failed`
re-dispatch, the commit the node's branch is published at and requires new
commits on top of it, and adds `onepipeline status --no-providers` and
`watch --log PATH`, CLI shapes a host can allowlist, which nothing here
calls. 0.53.1 links the onetaskgraph release that gives a copied
project's tasks destination-scoped ids. A CLI-driven run is driven by this
line's copy of the engine, so it carries each of these once this moves;
`a_note_waiting_on_an_adopted_runs_held_turn_leaves_the_run_journalling_and_live`
holds the first through the pinned CLI driver and reply route.

0.53.2 has a closing driver finish the identity its maintenance sweep is on
and stop before the next, journalling the pass as cut short, and answers a
blocking decision about a node a committed retry or drop removed rather than
leaving it pending. 0.53.3 links the onetaskgraph release whose store answers
text, metadata and origin queries with GitHub's own search rather than reading
the whole board for each, and whose copies record where an item was copied to
and follow that link on every later copy. A CLI-driven run's driver is
this line's copy of the engine, so its sweep stops, its stale decisions clear
and its board checks and copies spend only on what they ask once this moves.
This crate serves the journal, the decisions and the results those write
through the linked SDK as it finds them, and names neither a board query nor a
copy.

0.54.0 links the onevcs release whose idle retirement pass records each
branch's verdict and reuses it while that branch's inputs are unchanged, reads
the remote's refs in bulk rather than one query per branch, and asks no
existence or ancestry question twice. A CLI-driven run's driver is this
line's copy of the engine, so its idle sweep re-derives only the verdicts
whose branches moved once this moves. The `branches-retired` record reads as
it did, since it never said how a verdict was reached, and this crate serves
it as the journal holds it. It also adds a stop guard that holds a session's
owed runs to a wake budget, a hook surface nothing here calls, and with it a
closure rule that does reach this crate: a run a 0.54 driver drove is owed
until it is closed — stopped, given a verdict whose `completion` is true, or
acknowledged — rather than once its graph completes. A CLI-driven run is
driven by this line's copy of the engine, so `GET /api/v2/unwatched` goes on
reporting it after its graph settles until one of those closes it; the route
forwards the verb's answer unfiltered. The Host surface can read that report;
the run header does not display it.

0.55.0 links oneagentgraph 0.5.4, onejudge 0.17.0 and oneharness-core 0.21.0,
whose streams carry what an agent *said* beside what it did: a turn's
`turn-activity` and its report's harness history now hold `message` and
`reasoning` entries under those kinds as well as tool calls and observations.
A conversation turn serves them as its `assistant` and `reasoning` rather
than as tool events (`src/payload.rs`, `Words`). It also journals
`concurrent-deferred` when a launch's cross-DAG dependency acknowledges the
holder it waits on, and its `watch` wakes on every planner surface and ends
with a `blocking` flag on its `returned` frame. Watching a run is an engine
CLI action, outside this API.

0.56.0 lets a repository's template layer extend the host's and replace only
the blocks it names, recording the layers it resolved through as a `chain` on
`templates::ResolvedTemplate`; this crate serves no template route and reads
no template. It links oneagentgraph 0.5.5, onejudge 0.17.1 and oneharness-core
0.24.0, whose history is indexed in dated pointer segments under `.index.d/`:
recording a run appends to its day's segment and reads no index and walks no
store, so a run this line's engine drives costs the same however much history
the host holds. The session artifact route resolves a session by its own
project and file and nothing else; `serves a recorded session without
reading an index or walking the history store` holds both halves under a
trace. `read_session_display` returns typed entries rather than JSON values,
so a harness session artifact is picked out as the `Record` entry whose
`history_id` it names — an in-flight run, which carries no such id, was never
one — and serialized as before. A CLI-driven run's driver is this line's
copy of the engine, so its templates resolve through those layers once this
moves.

0.57.0 links the onevcs 0.36 release whose publication opens every remote
lifecycle change request as a draft and watches its required checks under
every policy — `change-open` included, so red checks there are now a
`checks-failed` retry rather than an open change. A green `change-open` change
whose approvals are required stays a draft for its own user's review, and the
node settles `done` with the outcome `change-review-draft` and its change
request URL, which `graph.node_results` and the node's publication serve as
they serve a `change-open` settlement. That release journals `change-drafted`
with `kind: "awaiting-checks"`, `checks-settled` (`passed`, or
`passed-with-skipped`), `draft-lifted-early` and `draft-kept-for-review`, and
classifies each `change-check` into a `state` in which a skipped check is never
a passed one; timeline schema 11 serves each as a `review`, and
`a_green_change_kept_a_draft_for_review_is_served_done_with_its_change_request`
holds them. A CLI-driven run's driver is this line's copy of the engine,
so its publications follow that lifecycle once this moves.

0.57.1 changes only the engine's own tests. 0.57.2 links onetaskgraph 0.2.54,
whose `github-projects` store sends a board's text, metadata, project-name and
comment-activity searches in pages of twenty and sends a further page only
while the caller still needs rows, so a caller's limit bounds what is fetched
as well as what is returned; and 0.2.53, whose copy keeps a rendered
document's recorded body digest true of the rendering once it rewrites that
document's references. A CLI-driven run's driver is this line's copy of
the engine, so its board reads spend only on the pages their answer needs once
this moves. This crate names neither a board search nor a copy, and its
`onetaskgraph-*` requirements below move with this line so the lock links the
one copy of that family the engine pins.

0.57.3 links onevcs 0.37, which opens a session continuing a branch whose
moved base conflicts with it by leaving the merge in progress for the session
to conclude, and says so in an optional `conflict` on `session-opened` — the
unmerged `paths`, the `base_commit` merged in and the `branch_tip` before it —
with no new kind. The engine dispatches the worker into that session with a
merge-resolution criterion and raises `session-conflict` only once its
publication budget is spent. A CLI-driven run's driver is this line's
copy of the engine, so its conflicts go back to the worker once this moves.
This crate reads no conflict and serves the record as journalled;
`a_session_opened_on_a_conflicted_merge_is_served_as_the_engine_journalled_it`
holds that through the event, channel and timeline routes.

0.57.3 also makes a correlated verdict the ruling on the question it names,
whether the run is live or settled: `POST /api/v2/runs/{run}/channel/reply?correlation=C`
delivers it to that question's listener through the bus's binding on a
settled run too, answering the engine's `delivered` receipt, and never journals
it as the run's `completion-requested`, however its `completion` is spelled; a
correlation the run never raised is refused. The route's request and receipt
shapes are unchanged, and
`a_correlated_verdict_on_a_settled_run_reaches_its_listener_and_requests_no_completion`
holds it.

0.60.0 runs one plan across its home project and the member projects the home
names at `onetaskgraph.members`, each naming its home at
`onetaskgraph.member_of`, and links onetaskgraph 0.2.57, which carries that
membership, repository routing that files a task into the member project of
the source its repository routes to, and the Linear plugin's `status_mapping`.
A CLI-driven run's driver is this line's copy of the engine, so once this
moves it reads a plan across its home and member projects in different
sources, holds a dependency between two of them as one edge of one graph, and
writes each settlement back where its task lives: the task record of a
member's task names its own `source`, and the landed baseline names each
item's destination in that source.
`an_adopted_run_settles_a_plan_spanning_two_sources_where_each_task_lives`
holds that through the pinned CLI driver and read API. This crate reads no
membership, and its `onetaskgraph-*` requirements below move with this line.

Between 0.57.3 and 0.60.0 the engine journals `driver-exited`, a driver's
account of how it let go of a run, which the browser files under `lifecycle`
beside `driver-adopted`; reads an undriven run's ending off its run-end hook
verdict, so a run whose one human action is outstanding reads `PAUSED` where it
read `DRIVER DEAD` and a stopped one `ENDED stopped`, words `state` serves as
the engine spells them; and gives `drop` an optional `reason`, which the
browser's reply schema carries. A row's `state` is now read through
`views::standing_word_of`, the bounded twin of the fold's `liveness_word`, so
the row and the fold still give one word for one run.

0.60.1 reads a live, quiet driver as `PARKED` — a run that is driven, never one
nothing drives — which `RUN_LIVENESS_NOTHING_DRIVING` in the browser already
excludes, and requires nothing else of this crate. With it, `state` serves
`ended-failed` for a graph that converged with a node `failed` while its
`liveness` stays the driver's `DRIVER DEAD`;
`a_run_that_ended_is_served_as_ended_beside_its_driver_liveness` holds the
endings to the CLI, and `tests/contract.rs`'s
`a_row_read_from_the_summary_is_the_row_a_fold_produces` holds the row to the
fold over a failed, a stopped and a paused run.

0.60.1 also publishes a schema for every pipeline payload, registered under
`agent.pipeline.<kind>@2` in `payload::registry()` and named per kind by
`payload::schema_of`. Every pipeline record an e2e journey serves is held to
it once its server stops (`tests/support/journal_schema.rs`), so a fixture
written by hand cannot drift from what the engine journals. Holding them to it
showed `release-adopted` spells its next-dispatch delivery `next`, never
`deferred`.

0.60.2 lets a cancel or a retry interrupt a publication watch, so a
publication can settle `cancelled`, holds behind a live note only the
commands naming its node, and publishes an out-of-band landing under its
owning node's title. 0.60.3 links onevcs 0.40 and onetaskgraph 0.2.58, and
0.60.4 names a died dispatch's landing rather than its retired branch when its
work landed. This crate serves each as the engine renders or journals it, and
maps none of their words. A CLI-driven run's driver is this line's copy
of the engine, so it carries each of these once this moves; the dev-only
`onevcs` and `onetaskgraph-*` requirements move with it.

0.61.0 adds a lifecycle node's `publish: "preserve"`: at closeout its branch is
put on its identity's origin and it settles `done` as `preserved`, carrying
`branch`, `head` and `remote` and no `landing`. It also adds `telemetry RUN
--changes`, which this crate does not serve. Nothing here enumerates an
outcome, so the word is served as journalled, and a node's publication reads
`merged` only off a merge record or the `merged` outcome, so a kept branch is
never served as landed;
`a_node_its_plan_kept_is_served_done_with_its_branch_and_head_and_never_landed`
holds that through the run and results routes. It links onevcs 0.42, which the
dev-only `onevcs` requirement moves with.

0.61.1 links an engine that accepts a `reparent` of a waiting, unattested
`kind: human` approval and re-gates it behind its new prerequisites, clearing
its recorded wait; every other recorded node, and an `attest` followed by a
`reparent` of one approval in a single envelope, is still refused.
Replies posted through this API are applied by this copy of the engine;
no route or response changes.
`a_waiting_approval_reparented_onto_unfinished_work_is_no_longer_offered_for_attestation`
holds it through the reply, status and attest routes.

0.62.0 links an engine whose kept (`publish: "preserve"`) nodes may depend on
kept nodes and start from the branch their dependency kept: a kept node's
session opens on the branch its same-repository kept base dependency settled,
so a harness one spike builds is the start of every spike that depends on it,
and a plan giving such a node a second answer — its own `base_branch`, or kept
dependencies on separate stacking chains — is refused. A CLI-driven run
uses the pinned engine, so this changes which plans
such a run accepts and where it cuts their sessions, and no route or
response; `a_kept_node_that_depends_on_a_kept_node_starts_from_the_branch_it_kept`
and `a_kept_node_naming_its_own_base_beside_a_kept_dependency_is_refused_and_keeps_nothing`
hold both through the pinned CLI driver and run route over a bare origin. It links
onetaskgraph 0.3.2, which the dev-only `onetaskgraph-*` requirements move with.

0.63.0 links an engine whose write-back worker keeps one onetaskgraph store
for its lifetime, ending each attempt through that store's plugin-agnostic
command boundary and rebuilding it when its configuration changes, a call is
cancelled, or a source could not be built, and whose embedded store takes
onetaskgraph 0.3.2's one `status_mapping` grammar scoped by item kind across
`github-projects` and `linear`: a category maps to one name or to a name per
kind, so a Linear project is written its own project status. A status a source
names nothing for, for that kind, is refused rather than guessed, so a store a
CLI-driven run writes back to that wrote a status before — a `linear`
source with no mapping — now refuses it. This crate configures no store and
changes no route or response. It still links onetaskgraph 0.3.2, which the
dev-only `onetaskgraph-*` requirements now name exactly.

0.63.1 links onetaskgraph 0.3.6, whose document copy rewrites task
locations carrying a fragment while preserving that fragment. The real
local-md store journey in tests/plan_copy.rs holds this adoption.

0.63.2 links onetaskgraph 0.3.9, whose store carries a record's image assets
with it across every copy, so a plan's design document keeps its screenshots
on the board copy a user approves. A CLI-driven run's driver is this
line's copy of the engine, so it carries them once this moves. This crate
serves no asset and changes no route or response; the dev-only
`onetaskgraph-*` requirements move with this line.

0.63.6 links onevcs 0.43 and onetaskgraph 0.3.10. 0.63.5 lets a cancel
preempt a live note its node has not answered, and 0.63.6 replays the
commands a dead driver claimed, so an adoption leaves no claimed envelope
without an outcome. Each `edit-committed` and `command-accepted` now names
the `envelope` it came in. A CLI-driven run's driver is this line's copy
of the engine, so it carries both fixes once this moves. The timeline still
serves an edit as `{author, redirection}`. The dev-only
`onevcs` and `onetaskgraph-*` requirements move
with this line.

0.63.7 links onetaskgraph 0.3.11, whose store gains `onetaskgraph project
graph`, the verb that prints a plan's dependency graph. Nothing here calls it:
the move is so the `onepipeline-api` a host pins links the same engine as its
`onepipeline` pin. This crate changes no route or response; the dev-only
`onetaskgraph-*` requirements move with this line.

0.64.0 links onejudge 0.19 and oneagentgraph 0.5.6. onejudge gives every
judge one evidence contract whatever its mode, so a read-only harness judge
is no longer told never to use its shell; oneagentgraph's schema 10 passes a
`kind: onejudge` member's `judge_settings` and each judge's `settings` through
to onejudge untouched. The `onejudge`, `oneagentgraph` and `oneharness-core`
requirements above move with it to the versions its own lock resolves.
The engine CLI drives runs; this crate reads their records. The dev-only
`onetaskgraph-*` requirements stay at 0.3.11, which this release still pins.

0.65.0 links onetaskgraph 0.4.0, a new minor of the store. Its
`github-projects` source takes `metadata_fields`, each entry projecting one
caller metadata value onto a board text field so a board can filter on it,
and its store checks that block against the plugin's schema when it reads the
configuration — so a host whose `followups` source names
`metadata_fields: [{field: Host, key: orchestrator.follow-up, path: [host]}]`
is read by this line's copy of the engine where the earlier store refused the
whole file as naming an unknown field. It also carries 0.3.12's item
classification: a task created through the store declares who may read it,
and a private one is written only to a destination verified private. A
CLI-driven run's driver reads the host's store configuration through
this copy, so it accepts that source once this moves.
This crate changes no route or response;
the dev-only `onetaskgraph-*` requirements move with this line.

0.66.0 adds flows: `onepipeline flow run` holds a launched program that is
not itself a run under the runs root's `.flows` directory, a run `start`ed
inside one records it as the launch record's `flow`, and `unwatched` counts a
qualifying watch of a live flow as watching the runs launched in it — and
reports a live flow nothing watches as a row of its own, `flow <id>`, which
`GET /api/v2/unwatched` serves beside the run rows, unfiltered, as it serves
every row of that verb. A CLI-driven run's driver is this line's copy of
the engine, so a host can hold its view and its engine to the release that
knows flows once this moves. Run discovery passes over `.flows`.
This crate adds no route and changes no response shape.

0.68.0 enforces the repository publication boundary, linking onevcs 0.46,
which the dev-only `onevcs` requirement moves with. A node's clearance is the
stricter of its task's classification and the visibility `onevcs` holds for
the repositories it names; in a plan mixing a private node with a public one,
an ordinary dependency of public work on private work is refused at load and
at every live edit, and the one way across is an export edge, whose public
consumer starts from a neutral export of one directory. The reply route's
edits use this line's copy of the engine, so its boundary holds here.
0.67.0, which this passes
through, stacks a landing node on its unlanded same-repository parents. This
crate adds no route and changes no response shape.

0.68.1 links onevcs 0.48, which the dev-only `onevcs` requirement moves with.
A `change-auto` or `change-direct` publication that times out with auto-merge
armed is read again within its budget and settles `done` on its landing,
recording the armed change and how many reads it took, rather than sending
its worker back onto work already heading for merge; red checks, exhausted
reads and an unarmed timeout retry as before. This reader serves the records
the engine CLI writes. This crate adds no route and changes no response shape.
Since 0.56.0 its `unwatched` reads `ONEPIPELINE_WAKE_BUDGET`, so
`GET /api/v2/unwatched` asks `verbs::Unwatched::within` under the budget
`verbs::WakeBudget::from_environment` reads from the server's own environment
rather than `verbs::unwatched`, which asks under none; the route and its
shape are unchanged, and
`unwatched_asks_under_the_wake_budget_the_servers_environment_sets` and
`an_owed_run_that_converged_with_a_failure_is_unwatched_until_it_is_closed`
hold it to the CLI.
0.69.0 reads the host without opening whole runs and proves a stopped
pre-registry dispatch gone when its last stop signalled workers and no
adoption followed. `host_reports_a_live_dispatch_and_proves_a_signalled_pre_registry_run_gone`
holds that rendering and a teardown refusal over HTTP.
0.70.0 carries the native unpublished verdict and links onevcs 0.48.1.
The reader links that engine without adding a route or verb.
0.70.1 links onevcs 0.49.0 and onetaskgraph 0.6.0. That onevcs's retirement
keeps open and closed-unmerged change requests and ignores other
repositories' records; that onetaskgraph's plan store carries comments and
caches remote reads. A CLI-driven run is driven by this copy of the
engine, so its retirement uses that release and its driver loads that same
cache configuration; this crate changes no route or response. The test-only
`onevcs` and `onetaskgraph-*` requirements below move with it to the releases
its own lock resolves. This changes the engine types carried by
ApiError::from_engine and the other engine-typed public items.
0.71.1 links onevcs 0.50.1's boundary, which accepts a repository's root
workspace members, so a CLI-driven run's driver publishes such a
repository the way every other dispatch on the host does once this moves.
0.71.0, which this passes through, brings review comments into a run with
their state read from the host. This crate changes no route or response; the
test-only `onevcs` requirement below moves with it to the release its lock
resolves. This changes the engine types carried by ApiError::from_engine and
the other engine-typed public items.
0.72.0 supervises manager-started landings through flows and links onevcs
0.51.2's operation-scoped reader and the significance its producer stamps, so
a CLI-driven run's driver relays the same audience the CLI does once this
moves. Its filter grammar gains `significance` and its `planner` profile reads
it, so `?filter=` accepts that matcher and `planner` is the engine's shipped
profile; the lock follows its own to oneagentgraph 0.5.7. No route is added;
the test-only `onevcs` requirement below moves with it to the release its lock
resolves. This changes the engine types carried by
ApiError::from_engine and the other engine-typed public items.
0.73.0 links onetaskgraph 0.7.0, whose store caches remote plan reads for a
dispatched driver the way a standalone board read does. No
route is added and this crate keeps no cache of its own; the test-only
`onetaskgraph-*` requirements below move with it to the release its lock
resolves. This changes the engine types carried by ApiError::from_engine and
the other engine-typed public items.
0.75.0 and the siblings it links read YAML through serde-saphyr, so no libyaml
translation is left in this graph or in the engine CLI's driver. The engine
dispatches nothing until it has read its project's claim off the store.
0.78.0 is the engine whose harness core launches Codex with plugins off; a
host holds this reader to the engine it pins, so it adopts that only once this
moves. Its reply grammar gains `decline` and its agent scopes `review-reply`,
which the browser's gated copies follow, and its reconciler refuses by kind
as `Error::Rejected`, which `ApiError::from_engine` serves as `422 refused`.
It also stacks, reworks, continues and readjusts drafts from review, so a
CLI-driven run's driver does what the CLI's does, and those records
render here rather than being refused. It links onetaskgraph 0.7.3, whose
loader leaves a source no layer gives a `plugin` unconfigured rather than
refusing the whole configuration, so a CLI-driven run's driver reads its
store on a host whose user layer only routes sources a repository's own
`onetaskgraph.yaml` defines. The dev-only `onevcs` and `onetaskgraph-*`
requirements below move with it to the releases its lock resolves. This
changes the engine types carried by ApiError::from_engine and the other
engine-typed public items.
0.79.0 hands the store the GitHub issues each landing closes and journals what
it did as `landing-closures`, and links onetaskgraph 0.8.0, whose store names a
closed item's status after its closure — `Done` when completed, `Cancelled`
otherwise — and whose `task copy` takes `--status`. A CLI-driven run's
driver is this copy of the engine, so its landings move the cards they close
and its plan reads follow those closures once this moves; this crate serves the
record as journalled and adds no status rule. It links onevcs 0.56.3, whose
`publication-resumed` kind is relayed to the browser. The dev-only `onevcs` and
`onetaskgraph-*` requirements below move with it to the releases its lock
resolves. This changes the engine types carried by ApiError::from_engine and
the other engine-typed public items.
0.79.1 reads the shapes the onevcs 0.56.3 and onetaskgraph 0.8.0 it already
linked carry: a publication held on `Unavailability::HostVisibility` settles
as that unavailable check, a held node's `workspace-wait` names each idle slot
`WorkspaceCapacity::ineligible` lists and why, and a copy the destination
answered malformed is refused as `EngineError::CopyDestinationUncertain`,
naming its destination. A host holds this reader to the engine it pins, so a
CLI-driven run's driver says and refuses those the way the CLI's does
only once this moves; this crate serves each as journalled, matches on none
of them, and changes no route, sibling release or MSRV.
0.80.1 marks a run's home — the plan project it launched from — `done` through
the store once the run settles successfully, journals what the store answered
as `home-status`, and links onetaskgraph 0.9.0, whose store gains
`set_project_status` and names each closure item's `kind`. A CLI-driven
run's driver is this copy of the engine, so its plan's home card reads done
once this moves; this crate serves the record as journalled and adds no status
rule. It also links oneagentgraph 0.6.0 and onejudge 0.20.0, whose
`note-admitted` and `note-withdrawn` kinds, `withdraw-note` reply op and
note `delivery_timeout_seconds` the browser files and validates and offers
no control for. The `oneagentgraph`, `onejudge` and dev-only
`onetaskgraph-*` requirements move with it to the releases its lock resolves.
This changes the engine types carried by ApiError::from_engine and the other
engine-typed public items.
0.80.2 takes a note back while a turn is still running: `withdraw-note`
reaches a note waiting in its live conversation as well as one carried to the
next dispatch, and records `note-withdrawn` naming where it was. With 0.80.1's
`turn-end` delivery and the `turn` its `worker` and `supervisor` dispositions
record, it is the engine a CLI-driven run's driver must link for a
manager's note from the browser to be held and withdrawn the way the CLI's
is; this crate relays both ops unchanged through the reply route and serves
`turn` as timeline schema 12's `redirection.turn`. It links oneagentgraph
0.7.0, so that requirement moves with it to the one release the lock
resolves. This changes the engine types carried by ApiError::from_engine and
the other engine-typed public items.
0.81.0 links onetaskgraph 0.9.2, whose board copy reaches the destination
faster and spends less of the shared board token. A host holds the plan-store
CLI, the engine and this reader to one linked store release, so a copy or
approval on the host is fast only once this moves; this crate serves what
the engine journals and changes no route. The dev-only `onetaskgraph-*`
requirements below move with it to the release its lock resolves. This
changes the engine types carried by ApiError::from_engine and the other
engine-typed public items.
0.82.0 is the engine a host launches a Linear-homed plan with. It links the
same onetaskgraph 0.9.2 as 0.81.0: the release whose copy records a Linear
item's `body_digest` over what Linear stored rather than what was rendered,
and homes a private plan in its private source. A host holds its launch and
this reader to one engine, so only once this moves does a CLI-driven run
of a plan copied into Linear load its tasks under the rendered-only check the
way the host's own launch does, against the digest of what Linear stored, and
write back into that private home. 0.82.0 also names a run by its public id
on every plan store not declared private, which this crate serves no field
of. No route or MSRV changes, and the dev-only `onevcs` and `onetaskgraph-*`
requirements already name the releases its lock resolves. This changes the
engine types carried by ApiError::from_engine and the other engine-typed
public items.
0.84.0 is the engine whose runs carry labels. It serves each run's effective
labels — those recorded at launch with any `labels.json` overlay the `label`
verb wrote laid over them — and resolves the group a run belongs to, through a
board copy's origin where one exists, so `/api/v2/runs` rows and
`/api/v2/projects` groups carry `labels` and `group` under telemetry schema 24.
It also exposes a run's recorded launch time, the structured host reading
`/api/v2/host` serves beside its text, and the telemetry document run detail
carries. A reply that queues a note now finishes once the note is queued rather
than once it is delivered (onepipeline #1094). It links the same onetaskgraph
0.9.2, onevcs 0.56.3 and oneagentgraph 0.7.0 as 0.82.0. This changes the
engine types carried by ApiError::from_engine and the other engine-typed
public items.
0.84.1 links oneharness-core 0.28.8 and oneagentgraph 0.7.1, carrying the
shared Codex app-server cleanup fix (oneharness#1520). The lock follows the
engine release's own resolution. Browser adoption remains removed under the
current contract; this binary reads runs driven by the engine CLI. This
changes the engine types carried by ApiError::from_engine and the other
engine-typed public items.
0.85.0 is the engine whose `RunView` refreshes in place: `refresh` reads,
parses and folds only the records appended since the view last read, answering
`Unchanged`, `Appended { first }` or `Reread`, and a refreshed view equals a
fresh `open`. The read API's subscriptions keep each subscribed run's view
current with it and build their patches from the appended records, rather than
re-reading the whole journal per change. `RunView` gained a private field, so
the timeline's canonical store is read through the crate's own `payload::Run`
rather than a rebuilt view. It links onetaskgraph 0.10.0, so the dev-only
`onetaskgraph-*` requirements move to that release with it. This changes the
engine types carried by ApiError::from_engine and the other engine-typed
public items.
0.86.0 links onetaskgraph 0.11.0 (through 0.10.0), the plan-store release
whose copy binds to an existing destination task the caller names, keeps a
destination item's status on update when asked, and copies named members into
an existing project without reading or writing the project — the cheaper calls
a plan copy and approval on the host make. A host holds its plan-store CLI, the
engine and this reader to one store release, so the dev-only `onetaskgraph-*`
requirements move to 0.11.0 with it, and the journeys' direct `CopyRequest`s
name the new `status_policy` (`Source`, the earlier behaviour) and
`target_task` (none). Its `RunView` gains a private refresh cursor and can no
longer be built field by field, so the timeline route canonicalizes repeated
records in the view's own events and restores them before returning; nothing
it serves changes. It links the same onevcs 0.56.3 and oneagentgraph 0.7.1 as
0.84.1, and no route or MSRV changes. This changes the engine types carried by
ApiError::from_engine and the other engine-typed public items, and
`payload::timeline` now takes the view mutably.
0.87.0 is the released engine this branch's live updates were built against
(engine-incremental-read): its `RunView::refresh` and `Refreshed` are 0.86.0's,
and its writeback copies a run's members into an existing destination project
with a members-only copy, falling back to a full copy only for a routed
destination that has no member project yet. It links the same onetaskgraph
0.11.0, onevcs 0.56.3 and oneagentgraph 0.7.1, and no route or MSRV changes.
The timeline reads its canonical events through the crate's `payload::Run`, so
`payload::timeline` takes the view by shared reference again. This changes the
engine types carried by ApiError::from_engine and the other engine-typed public
items.
0.87.1 is engine-incremental-read's published release, which this branch
adopts in place of 0.87.0. Its library source is 0.87.0's: the release differs
only in its version and in the engine's own test harness, so the linked
dependencies, routes, MSRV and every served payload are unchanged beyond the
release `/healthz` reports. This changes the engine types carried by
ApiError::from_engine and the other engine-typed public items.
0.89.0 is engine-transcript-refs' published release. It links oneagentgraph
0.8.0, whose turn records carry a `transcript` reference into the oneharness
history file the turn was recorded in instead of a bounded copy, and the
engine's public `views::transcript` resolver this crate now reads every turn's
content through. It links oneharness-core 0.29.1, whose history writer opens
every run with a `run-started` line carrying the whole prompt, onejudge
0.21.0, onetaskgraph 0.11.1 and onevcs 0.56.9, which relays each check's
`started_at` and `completed_at`. The test-only `onevcs`, `oneharness-core` and
`onetaskgraph-*` requirements follow its lock. This changes the engine types
carried by ApiError::from_engine and the other engine-typed public items.
The git commit f06d041 on onepipeline's main (#1128), after 0.89.1, is the
engine whose stop ends every process a node dispatch started, including a
provider turn a dispatch starts while the stop is in progress. A host holds
this reader and its engine to one linked engine, so it can adopt that stop
only once this crate links it. No release carries it yet and its library is
still versioned 0.89.1, so this links that commit from git, and
`tests/packaging.rs` holds the lock to that source as well as to the version.
`POST /api/v2/runs/{run}/stop` runs the teardown in this process, so the
server now ends what the stop used to miss. No route, payload or MSRV
changes, and it links the same onetaskgraph 0.11.1, onevcs 0.56.9 and
oneagentgraph 0.8.0 as 0.89.0. This changes the engine types carried by
ApiError::from_engine and the other engine-typed public items.
0.89.2 is the published release carrying that stop fix, which this crate
adopts in place of the git commit, so the lock resolves the engine from
crates.io again and `tests/packaging.rs` holds it to that source. Beside the
stop it carries #1117, whose retirement pass leaves alone a branch a node
comes to name while the pass runs; that is internal to the engine's
maintenance. It links the same onetaskgraph 0.11.1, onevcs 0.56.9,
oneagentgraph 0.8.0 and oneharness-core 0.29.1 as 0.89.0, and no route,
payload or MSRV changes beyond the release `/healthz` reports. This changes the
engine types carried by ApiError::from_engine and the other engine-typed public
items.
0.90.0 is the engine that holds a node only on the trackers its edges name
and, on a provider's rate limit, reads that tracker again at the reset the
provider gave rather than asking every private tracker once a minute. Adopting
a run from the browser makes this crate's linked engine its driver, so the
adopted run is paced the way the command line paces it only once this crate
links that engine. Its `node-held` record's `source` reason now carries `cause`
and, for a rate limit with a reset, `retry_at_ms` on each unanswered source;
the timeline serves that reason by its `kind` as it serves every hold, and a
run journalled before those fields reads as it did. It links onetaskgraph
0.12.0, whose lock-step family the test-only `onetaskgraph-*` requirements
follow, and onevcs 0.56.11, which the test-only `onevcs` requirement follows;
oneagentgraph 0.8.0, oneharness-core 0.29.1 and onejudge 0.21.0 are unchanged,
and no route, payload or MSRV changes beyond the release `/healthz` reports.
This changes the engine types carried by ApiError::from_engine and the other
engine-typed public items.
0.91.0 is the engine that classifies each task of a store project by its own
declaration and repositories, never by the project it is filed under, so a
private coordinating project holding the whole graph and its export edge may
carry a public task, which becomes that edge's consumer; its boundary guidance
(schema 2) says how such a plan is coordinated, and every refusal carries that
in one line. Adopting a run from the browser makes this crate's linked engine
its driver, and every live edit relayed through the reply route is judged by
it, so a coordinating run keeps its export-backed consumer and the refusals this
service relays carry the engine's own guidance only once this crate links that
engine. It links onetaskgraph 0.12.1, whose lock-step family the test-only
`onetaskgraph-*` requirements follow, and that store resolves tokio 1.54;
onevcs 0.56.11, oneagentgraph 0.8.0, oneharness-core 0.29.1 and onejudge 0.21.0
are unchanged, and no route, payload or MSRV changes beyond the release
`/healthz` reports. This changes the engine types carried by
ApiError::from_engine and the other engine-typed public items.
0.91.1 is the engine whose driver ends a settled run's observer graph — and
every process it started, a long-lived command judge included — before the
driver exits. A host holds this reader and its engine to one linked engine, so
it can adopt that fix only once this crate links it. This binary drives no run,
so the fix changes nothing it serves, and a journey shows no route of the read
API starts, adopts or drives a run. It links the same onetaskgraph 0.12.1,
onevcs 0.56.11, oneagentgraph 0.8.0, oneharness-core 0.29.1 and onejudge 0.21.0
as 0.91.0, and no route, payload or MSRV changes beyond the release `/healthz`
reports. This changes the engine types carried by ApiError::from_engine and the
other engine-typed public items.
0.93.0 is the engine that links onetaskgraph 0.12.3, the protected fast-copy
plan store, and the oneagentgraph 0.9.0 and onejudge 0.22.0 that keep a
member's worker side on its own config. A host holds this reader and its engine
to one linked engine, so the run and store state it serves are read through the
engine and plan store its driver runs. It links onetaskgraph 0.12.3, whose
lock-step family the test-only `onetaskgraph-*` requirements follow; onevcs
0.57.0 (the release 0.92.0 moved to), which the test-only `onevcs` requirement
follows; and oneagentgraph 0.9.0 and onejudge 0.22.0, which this crate's own
requirements follow. oneharness-core 0.29.1 is unchanged, and no route, payload
or MSRV changes beyond the release `/healthz` reports. This changes the engine
types carried by ApiError::from_engine and the other engine-typed public items.
