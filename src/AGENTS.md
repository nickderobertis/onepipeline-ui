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
- **The interval one dispatched session ran over.** The journal brackets a
  *node*, not a session: `payload::session_interval` reads one from the attempt
  that ran it — the `node-dispatched` it appeared after, closed by the next
  dispatch, the settlement, the `session-closed` or the session's own
  `member-settled`, joined by the `{stream}.{member}` rule schema 14 already
  resolves a report by. Every session of one attempt opens at that attempt's
  dispatch, including one the attempt reached only later: the run records no
  boundary between the members inside an attempt, and a session opened from its
  own first word is not bracketed by anything the run said. A node re-asked in
  place otherwise reads as having run its attempts over one window, which cannot
  say what was running at a given moment.
- **The party a record's session ran under.** `transportRoleSchema` is a pair
  with `agentRoleSchema`, and nothing stamps the transport half as such;
  `payload::transport_role` reads it off the record — the `role` `oneagentgraph`
  writes where it writes one, else the graph `member`, else the persona — and
  falls back to the agent side, which is the one side every dispatch has.
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
payload each one carries. Those two modules are the inventory; do not restate it
here.

`onepipeline`'s own vocabulary is an enum this crate imports, with one exception:
the compiled operations an `edit-committed` carries. That library declares
`edits::Operation` and `edits::Delivery` in a private module, so `payload::edits`
quotes their wire strings on the same terms as the `onevcs` ones above. What is
public beside them is the submitted `channel::Command`, and `tests/contract.rs`
gates this crate's reading against it.

`oneagentgraph` declares its own vocabulary in a public module, so
`tests/contract.rs` holds this crate's copy of it to that library's types. So
does `onevcs`: its `event` module is private, but it re-exports `EventKind` from
its crate root, so its kinds are reachable and are gated the same way. **A
private module is not the same as an unreachable type — read the crate root
before concluding a gate is unavailable.** What genuinely has none is a payload
*value* neither library declares to a consumer: `onevcs`'s pre-push command, its
gate verdict word and its non-blocking check conclusions, and
`oneagentgraph`'s turn number — that last one reconciled instead against the
public `render::line` that reads it. Where nothing at all is reachable, the
fixture — written in the records that library emits — is the whole of the gate,
and the constant says so where it is declared.

**Gate a copied vocabulary against the type that writes it, never against one
that merely declares it.** `oneagentgraph` declares an `event::Usage` it never
writes — it relays a settling member's usage copied verbatim out of the onejudge
report — so `payload::graph`'s usage keys are `onejudge::Usage`'s. Each exception
in that module says so where it is declared.

**`payload::vcs::SILENT_ON_PUBLICATION` is a negative list on purpose.** A
publication span opens at the first relayed record that is not one of them.
`onevcs` adds to its vocabulary, and naming the publication steps positively
instead would silently open the span late every time it did. A `fetch` is on that
list although that library also fetches to publish: the record does not say which
of the two it was, so opening a publication on one would open a publication for
every node ever dispatched.

Two readings of a record are the producer's and not this crate's. A verdict is
read in the words the library that wrote it uses — `onevcs` rules a gate `pass`,
says whether a push was `accepted`, and treats three check conclusions as not
blocking a merge — because reading a check's `completed` as a pipeline status is
what would make every passing check look like a failure.

**A turn record is a `turn-started` or a `turn-completed`, and nothing else.**
`oneagentgraph` stamps a `session` label on the `turn-*` kinds and on no other,
so a `member-settled` or a `member-died` can never *be* a transcript turn, and
the count beside a node has to agree with the transcript opened from it. A
`turn-activity` and a `turn-interrupted` are published from *inside* a turn and
are not turns either. `payload::is_turn_record` and
`payload::conversation_document` must agree on all of this: a turn's id is its
position in the transcript and the timeline numbers the same session by the same
rule, so a kind admitted by one alone leaves a plotted moment pointing at the
wrong turn.

**A summary belongs to the turn record before it, not the one after it.**
`oneagentgraph` opens a turn and *then* streams its activities.

## The report a settled member left, which is what a transcript is

The journal records *that* a session reported and what tools it called, and none
of the prose, the tool returns or the per-turn cost and clock — so a transcript is
the **stored onejudge report**, and `payload::conversation_document` reads it.
`onejudge` is *linked* for that, not copied: a whole versioned document this
repository does not own is exactly what a second source of truth is made of. It is
unpinned for the reason `oneagentgraph` is — `onepipeline` resolves it and the
lock follows.

Four joins, each the one the obvious alternative gets wrong:

- **A session to its report, by `{stream}.{member}`** — that pair is how a session
  id is minted, so a `member-settled` needs no `session` label. Do not add one
  upstream for it.
- **A turn to its measurements, by the producer's own `turn` number** — not by
  position among the records relayed, because a turn that called no tool relays no
  `turn-started`.
- **A figure to the turn that spent it, off the attribution candidate that `ran`**
  — never off the report's top-level `usage`, which is the dispatch's total over
  both sides and would repeat on every turn.
- **A clock to the side that reported it: `telemetry.sessions` at `role: agent`
  alone.** A report's two `role` vocabularies are different closed sets — who
  wrote a message, and which side ran — and in practice every row a report holds
  is the judge's, so matching by index puts the judge's clock on the agent's turn.

A report that is absent, uncopied or unreadable leaves the transcript as the
journal relayed it. All three are "the report says nothing", and none is "the
session recorded nothing".

**And it is the whole of what any run holds about the judge that supervised the
dispatch.** A plan node dispatches one graph member — `worker`, in
`graphs/node-scope.yaml` — and the judge runs *inside* onejudge, so no judge
session is ever relayed: `payload::conversations_under` groups on the `session`
label a relayed envelope carries and `payload::node_spans` brackets exactly those
records, and neither can produce anything for a side that relays none. No
producer change here reaches it; the report does, and only once the member
settles. So `payload::judge_conversation` serves a second conversation per
settled session — the worker's id with `.judge` after it, which `check_segment`
admits as a bare identifier — and `payload::judge_span` serves the lane it is
reachable through, as a sibling of the dispatch rather than a row beside it.

Three constraints on that reading, each because the obvious alternative is worse:

- **The gate is the report's `role: judge` `SessionLink` rows.** They are the only
  per-turn bounds any report here holds for that side, and they are what the lane
  is drawn over — so a report holding none has no judge turn to serve. Serving an
  empty conversation instead would say the judge recorded nothing, which is a
  different fact.
- **A judge turn is bounded, not transcribed.** The report keys no text to one,
  and this crate invents no pairing: judge turns outnumber the agent's by one or
  two in every report on this host and nothing records the correspondence. The
  judge's authored prose already reaches the wire as each agent turn's `user`
  message. `user` is served empty only because `conversationTurnSchema` types it
  a non-nullable string, which is the one place here an absence cannot be spelled
  as one.
- **Its conclusion is keyed to the dispatch, not to a turn**, so it is one closing
  turn rather than smeared over them: `verdicts`, `assessment`,
  `completion_reason` and `stopped_early`, with bounds and usage absent because
  the report records none for it. The structure lands in the turn's `unknown`,
  which is the field this wire already carries a producer's own record on — no
  field is added and neither closed role vocabulary moves, because both already
  carry `judge`.

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
  as `contract::PathSegment`, the store as a `contract::NamedStore`, which is
  absolute and non-climbing. A record is external input exactly as a URL is, and
  joining one unchecked is the arbitrary-file read the retention contract exists
  to prevent.
- **And checking how a path is spelled is not confining where it lands.** Those
  checks are lexical, and every component they clear is still a name in somebody
  else's directory: a bare name that climbs nowhere reaches anywhere on the host
  if what it names is a symlink, which the store's project layer and its session
  files both can be. So the resolved path is proved to sit under a
  `contract::StoreRoot` — the store canonicalized, which exists only once the
  directory has been read, on `cli::RunsRoot`'s own terms — and only what
  `Confined::Under` returns is opened. `Confined` is three-valued because a path
  that resolved *outside* and a path that resolved *nowhere* are different facts
  about the host: the first is said to the operator's log, naming the artifact
  and never where it went, and the second is a transcript that was rotated away
  and is a plain `404`. The wire cannot tell them apart on purpose.

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
- **Time inside a model, per party** (`timing.*_model_ms`, their fractions, and
  `node_work_ms`). No producer in this stack reports it: `onepipeline`'s buckets
  are wall clock, and the usage record a `turn-completed` carries is
  `onejudge::Usage`, which has no interval in it at all. So `payload::model_lanes`
  serves all three lanes absent, and the presence flags beside them say `false`.

  **Do not fold a turn's elapsed time into them.** A settled member's report does
  record how long one invocation ran, as its ran candidate's `duration_ms` — but
  that is an invocation's wall clock, not a model's, and it belongs to a *turn*
  rather than to a party. It is served where it is measured, on the turn, as
  `durationMs`. The upstream change that fills them: a producer that reports
  model time per party.
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
