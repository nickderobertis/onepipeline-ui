# src/AGENTS.md

What this crate may and may not compute, and what it cannot answer at all.

The rule it serves is the root's: payload records come from the onepipeline SDK,
not from here. Everything below is the record of where that rule is currently
bent, so a reader of `src/payload.rs` and `src/store.rs` finds the reason beside
the code rather than in a repo-wide file.

## Computations proposed for the SDK

`src/payload.rs` and `src/store.rs` derive a handful of things the SDK does not
compute yet. Each one is presentation-worthy, so each belongs *there* rather than
here — until it lands, this list is the record of what an agent reading the CLI
cannot currently see that a human in the UI can. Do not add to it silently:
anything new here is a proposal to make upstream first.

- **The eight-way timing breakdown, and the per-party usage.** Both are the
  SDK's own fold and neither is recomputed here — but its `telemetry` module is
  private, so the document is read through `onepipeline telemetry <run>` rather
  than imported. `src/telemetry.rs` owns that seam; making the fold importable is
  the proposal, and a server would then read it without starting a process.
- **A dispatch id.** The journal stamps a dispatch with its run and node but
  mints no id for it; schema 10 serves one, so `payload::dispatch_key` derives it
  from the pair. Execution is continuous, so the pair is the whole of what
  identifies a dispatch — the round that used to be its third part is not a thing
  any run has.
- **An opaque session key.** The raw launching session id may be sensitive and is
  never served, so runs are grouped by a digest of it.
- **The run list's order.** `RunStore::run_list` orders by most recent progress,
  newest first, because a client opens the first row and an operator came to look
  at the run that moved last. `onepipeline runs` orders by run id, so the two
  listings disagree about what leads.
- **A verification record from stored evidence.** onepipeline's event vocabulary
  names no verification, so `payload::evidence` reads one out of what a node
  *kept*: each `ArtifactRef` on one of its events, with the verdict and bounded
  prose of the event that stored it. The interval it is drawn over is the two
  neighbouring records that bracket it — the tightest one the journal holds.
- **The graph-level summary of a node's sessions.** `payload::role_rollups`
  counts a node's dispatched sessions per *pair* of roles so the graph reading is
  a reading rather than a download: a node that dispatched two hundred of them is
  two hundred spans at `scope=node` and one per category at `scope=run`. The SDK
  counts neither.
- **The party a record's session ran under.** `transportRoleSchema` is a pair
  with `agentRoleSchema`, and nothing stamps the transport half as such;
  `payload::transport_role` reads it off the record — the `role` `oneagentgraph`
  writes where it writes one, else the graph `member`, else the persona — and
  falls back to the agent side, which is the one side every dispatch has.
- **Time inside a model.** The SDK's buckets are wall clock — where the *run's*
  time went — and the wire also carries how long each party spent in a model,
  which no fold of a clock can answer. `payload::measured` reads it off each
  `turn-completed`'s own `usage.duration`, and it is absent for a party that
  reported no turn rather than zero.
- **The last account of each observed check.** `onevcs` reports every transition
  of every check it waits on, and `payload::observed_checks` keeps the last of
  each with the state it moved from. The transitions themselves are still served,
  as the node's own records.
- **Which of three accounts of a node's status is the one to serve.**
  `payload::recorded_statuses` orders them — what the journal settled for that
  node, then what the run's own `result.json` held for it, then what the graph
  derives for it — because the SDK exposes the fold and the document separately
  and nothing in it rules on which speaks for a node they disagree about. The
  ordering is what the three *are*: the first two are records of the node, the
  third is a gate recomputed on every read.
- **Whether an in-flight node's turn can be redirected.** `payload::node_control`
  answers, per node the run has in flight, what `onepipeline`'s reconciler answers
  by pulling the lever — which a read surface must not do, because serving a run
  would then interrupt it. What it can read is the same stream the engine
  reads its `TurnAddress` from: whether a member is in a turn this run can address,
  and the record of every interrupt anybody has already pulled, which
  `oneagentgraph` publishes for *every* attempt carrying its own reason.

  **What it deliberately does not do is claim to know the harness's answer.** The
  published stack exposes no authoritative *current-turn* control state to any
  process but the one running the turn, and each route out is closed for a reason
  worth writing down, because the next person to try will find them in this order:

  1. `onejudge::Report.control` is the authoritative answer, and onejudge reports
     it **only on the finished run** — its own words. `oneagentgraph`'s
     `record_control` states the consequence: "a member that spent its whole life
     on a harness with no lever looked addressable until now."
  2. `onejudge::Provider::control()` *is* live and authoritative, and it is an
     in-process accessor (`self.control_outcome.borrow()`) inside the member's own
     process. It is serialized nowhere while the run is in flight.
  3. `oneagentgraph`'s `control.json` is written at spawn as an unconditional
     provisional `Turn::Open` for **every** member, whatever its harness, and
     replaced with the real answer only at finish. Reading it live would report
     every in-flight node as reachable — worse than reading nothing. It is
     also unaddressable here: the member's scratch path reaches the journal only
     on `member-settled`.
  4. The control protocol has no probe. `oneharness_core::domain::control::ControlVerb`
     has exactly one variant, `Interrupt`, and an interrupt with no input still
     aborts the turn. Learning the answer costs the turn.

  A **previous** dispatch's report is not a substitute, and must never be read as
  one: `provider.control` is asked for per run and `Provider::reset` puts the
  outcome back to `NotRequested` for the next, so a settled report describes a
  dispatch that is over. `tests/e2e/server.rs` holds that line with a node whose
  earlier member settled reporting `control: null` and whose re-asked dispatch's
  turn must still read as addressable. Under rounds those two were told apart by
  their round labels; there are none, and the reading must still not borrow the
  old answer.

  So the field is `addressable`, and it means exactly what this crate can prove:
  **this run has a turn it can address for that node**. It is the engine's own
  precondition for delivering a note. Naming it `interruptible` would have been the
  overclaim a planner acts on — whether the harness *takes* the redirection is
  onejudge's `control`, which is the answer none of the routes above can supply.

  The upstream change that would make it one, and the only one that will:
  onejudge reports `control` for the *running* conversation rather than only the
  finished one, and `oneagentgraph` writes that answer into `control.json` at spawn
  and relays it — at which point this reading becomes a read rather than a fold.
  A smaller one beside it: `onepipeline` publishes `edits::Operation` and
  `edits::Delivery`, which `payload::edits` copies as wire strings for want of a
  type to gate against.

## Where a reader's filter may reach, and where it may not

`?filter=` is this crate's own — the CLI is told once, at launch, what to put on
a stream, and a read API is asked per request by a reader who did not launch the
run. `src/filter.rs` owns the grammar (duplicated per repository by design, like
the envelope) and the two profiles every run answers to; `src/store.rs` resolves
a request's spec against the run being read.

**It reaches exactly two places, and both are listings of events:** the events a
timeline span carries (`payload::Lens`), and the transcripts a detail carries
(`payload::conversations_under`). Beside them sit the two change tokens an open
stream compares — `payload::signature` and `payload::conversation_signature` —
which are filtered for the same reason: the stream invalidates rather than
restating state, so a run whose only new records this reader excluded has not
moved as far as they are concerned.

Everywhere else reads the **whole** journal, whatever the filter said. Every
status, settlement, decision, count, piece of evidence and timing a payload
carries is a fold, and a fold taken over a narrowed store is a different answer
about the run rather than a narrower listing of it — `node_control` under a
decisions-only filter reported every in-flight node as having no member, which
is the opposite of the truth on the one field a planner decides whether to cancel
by. `tests/e2e/server.rs`'s `a_filter_shapes_the_response_and_never_the_run` is
the guard, and it is the test that caught it.

Two consequences worth stating because they look like oversights:

- **The telemetry document is asked for unfiltered.** It describes the run, not
  the reading of it, and a reader narrowing their attention must not be told the
  run spent less time than it did.
- **The turn numbering is built over the whole store.** A turn's id is its
  position in its session's transcript, so numbering a filtered store would hand
  a client an id naming a different turn than the one the transcript route serves
  under it.

## What the siblings record and this crate reads

`onevcs` and `oneagentgraph` are independent tools with general integration hooks
only — neither knows this stack exists — so what they record is read as the wire
strings they write, quoted in `payload::vcs` and `payload::graph` beside the
payload each one carries. Read today: `session-opened`, `lock-wait`,
`gate-started`, `gate-verdict`, `push`, `change-opened`, `change-check`,
`change-merged`, `merge-completed`, `commit-preserved` and `sync-conflict` from
`onevcs`; `turn-activity`, `turn-started`, `turn-completed`, `turn-interrupted`,
`member-died` and `member-settled` from `oneagentgraph`.

`onepipeline`'s own vocabulary is an enum this crate imports, with one exception:
the compiled operations an `edit-committed` carries. That library declares
`edits::Operation` and `edits::Delivery` in a private module, so `payload::edits`
quotes their wire strings on the same terms as the `onevcs` ones above. What is
public beside them is the submitted `channel::Command`, and `tests/contract.rs`
gates this crate's reading against it.

`oneagentgraph` declares its own vocabulary in a public module, so
`tests/contract.rs` holds this crate's copy of it to that library's types.
`onevcs` declares its in a private one, so the wire is the only declaration a
consumer can reach and the fixture — written in the records that library emits —
is the whole of the gate there.

Deliberately not read: `fetch`, `lock-acquired`, `merge-queued`,
`session-closed`, `recovery-attested`. Each is a real record and none of them
answers a field the wire asks for; they still reach a reader, as the node's own
timeline events.

Two readings of a record are the producer's and not this crate's. A verdict is
read in the words the library that wrote it uses — `onevcs` rules a gate `pass`,
says whether a push was `accepted`, and treats three check conclusions as not
blocking a merge — because reading a check's `completed` as a pipeline status is
what would make every passing check look like a failure. And a tool summary is
carried on the turn it was published from, never as a turn of its own:
`turn-activity` is streamed *during* a turn, so counting one as a turn would
report a turn that had not happened. A `turn-interrupted` is excluded on exactly
those terms: it is published from inside a turn too, and it is the moment a
planner changed what the turn already running was doing rather than a turn of its
own. Both `payload::is_turn_record` and `payload::conversation_document` have to
exclude it, because a turn's id is its position in the transcript and the timeline
numbers the same session by the same rule — excluding it in one alone would leave
a plotted moment pointing at the wrong turn.

## The one store this crate opens that no run owns

A `oneharness_session` artifact's bytes are the only ones this API serves from
outside the runs root: `oneagentgraph` publishes a pointer and nothing is copied,
so `payload::harness_session` opens another tool's directory. Four constraints on
it, each because the obvious alternative is worse:

- **Link `oneharness-core`; never spawn the `oneharness` CLI.** A process is a
  second contract — arguments, output shape, version — that nothing here pins.
- **Read, never write, never lock.** `find_record_by_id` reconciles the store's
  index under an exclusive `flock`; a read surface must not stand in the way of
  the single writer the engine runs.
- **The record names the store; nothing here does.** No flag, no config key. A
  second source for that path is how a reader and a writer come to disagree about
  where the transcripts are.
- **Every component of the pointer is checked before it is used** — the two names
  as `contract::PathSegment`, the store as absolute and non-climbing. A record is
  external input exactly as a URL is, and joining one unchecked is the
  arbitrary-file read the retention contract exists to prevent.

## What the wire asks for and no record fills

Not derivations but gaps: a client's model has fields this API cannot fill from
any run, so no browser journey asserts them. Each needs a producing library to
record it before anything here can serve it.

- **A merge commit's url, and a branch url.** The commit itself *is* recorded —
  `merge-completed` and `change-merged` both carry the sha, and it is served as
  `publication.commit` — but the urls that would open either are the host's own
  and `onevcs` writes neither.
- **A check's url.** `change-check` carries the check's name, whether it is
  required, its transition and its conclusion, and its log as an artifact. No
  link to the host's own page for it, so `checks[].url` is absent and a reader
  opens the stored log instead.
- **Turn bodies and reasoning.** The journal records that a session reported and
  what tools it called, not the prose it wrote, so a served turn carries the tool
  calls `turn-activity` published and no assistant text of its own.
- **Time inside a tool call** (`timing.tool_ms`). `turn-activity` reports *what* a
  turn did and carries no interval, so the presence flag beside that zero says it
  was never measured — which is the wire's own way of telling an unmeasured zero
  from a measured one, and is why nothing here is hardcoded to it.
- **Any artifact that is neither a settled member's report nor a oneharness
  session.** Those two resolve — a `worker_report` through `onepipeline`'s own
  `RunPaths::report_for`, a `oneharness_session` through the store above. Every
  other recorded artifact — the `log` `onevcs` stores on a `gate-verdict` or a
  `change-check` — resolves under `runs/<run>/artifacts/`, and **no library in
  this stack creates that directory**, so the route answers `404` and only the
  bytes are missing: the record still reaches a reader with the id the producer
  stored. The upstream change that fills it: `onepipeline` retains what the other
  producers store on the same terms it retains a report. Nothing here may copy or
  follow a producer's own path — that is the arbitrary-file read the retention
  contract exists to prevent.
- **A provider refusal's own evidence** (`providerFailureSchema`). A member that
  died records a classified cause, but the identity, the chain and the reset time
  a planner would act on are `oneagentgraph`'s to relay and are not on the
  envelope this crate reads.
