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

- **A plan document a consumer can load.** `onepipeline` reads its plans out of
  the onetaskgraph store now and no longer publishes a loader, but `start` still
  writes `plan.json` and `RunPaths::plan()` still names it — so `payload::plan_of`
  deserializes that file itself, for the run whose journal this host cannot fold.
  The *schema* is still the SDK's `plan::Plan`; only the read is this crate's.
  Republishing a loader beside the path is the proposal.
- **The eight-way timing breakdown, and the per-party usage.** Both are the
  SDK's own fold and neither is recomputed here. **A run-list row now reads it
  without starting anything**: the SDK's bounded summary document carries a whole
  `views::RunTelemetry`, so `telemetry::of_aggregate` takes that document through
  this crate's own validation and a page of fifty rows is no longer fifty
  subprocesses. What is still fetched by process is the **detail** route's, and
  only because the alternative costs more than it saves — asking for the summary
  beside a view this route has already folded would refold the run whenever that
  document is stale. So `onepipeline telemetry <run>` remains the seam
  `src/telemetry.rs` owns, and there is one state in which a row and the detail
  opened from it disagree: a host where that sibling is missing or refuses, where
  the row carries the clock and the detail carries none. The server names that on
  its own log, and `a_rows_clock_and_the_details_are_one_reading` holds the two
  together everywhere else. The proposal that closes it is the same one as
  before, narrowed: publish the *fold* — `telemetry::of_run` over a view a caller
  already holds — so the detail reads what it has rather than asking a process
  for it.
- **How a run is being driven, over the bounded document.** `views::liveness`
  takes a `RunState`, which is the fold of a run's whole merged store — and the
  entire point of the summary is that a listing never takes one. The summary
  carries every input that reading needs and the SDK publishes no entry point
  over them, so `src/liveness.rs` restates it, held to `views::liveness_word` by
  `tests/contract.rs`'s `a_row_read_from_the_summary_is_the_row_a_fold_produces`
  over nine run shapes. **The proposal is `views::liveness_of(&RunSummary)`**, and
  with it that module becomes a call. One half of the reading cannot be restated
  at all: whether a *blocking surface* is outstanding is `channel::ChannelState`,
  which is crate-private, so this asks the wider question the summary can answer
  — any surface a planner has not consumed — which errs toward "still working",
  the direction the SDK's own reading errs in for every input it cannot read.
  Publishing that queue, or `decision_outstanding` over a summary, closes it.
- **A dispatch id.** The journal stamps a dispatch with its run and node but
  mints no id for it; schema 10 serves one, so `payload::dispatch_key` derives it
  from the pair. Execution is continuous, so the pair is the whole of what
  identifies a dispatch — the round that used to be its third part is not a thing
  any run has.
- **An opaque session key.** The raw launching session id may be sensitive and is
  never served, so runs are grouped by a digest of it.
- **The run list's order.** `RunStore::page` serves the SDK's own `Listing`
  order — most recent progress first, ties on the id — which the summary document
  stores `last_write_at` to make answerable without a fold. `onepipeline runs`
  orders by run id, so the two listings still disagree about what leads; the
  ordering itself is no longer this crate's to compute.
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
only — neither knows this stack exists — so what they record is quoted in
`payload::vcs` and `payload::graph` beside the payload each one carries. Those two
modules are the inventory; do not restate it here. Both libraries declare their
vocabularies to a consumer at the versions linked here, so those copies are held
to the producers' own types by `tests/contract.rs` rather than to a second reading
of the wire — with the two exceptions each module names where it declares them.

`onepipeline`'s own vocabulary is an enum this crate imports, with one exception:
the compiled operations an `edit-committed` carries. That library declares
`edits::Operation` and `edits::Delivery` in a private module, so `payload::edits`
quotes their wire strings on the same terms as the `onevcs` ones above. What is
public beside them is the submitted `channel::Command`, and `tests/contract.rs`
gates this crate's reading against it.

`oneagentgraph` declares its own vocabulary in a public module, so
`tests/contract.rs` holds this crate's copy of it to that library's types. So
does `onevcs`, whose `event` module is private but whose crate root re-exports
`EventKind`. **A private module is not the same as an unreachable type — read the
crate root before concluding a gate is unavailable.** Where a payload *value* is
genuinely undeclared to any consumer, the fixture — written in the records that
library emits — is the whole of the gate, and the constant says so where it is
declared.

**A deleted variant is the one case a moved pin makes worse, and `gate-verdict` is
it.** `onevcs` states the rule this crate depends on — a kind is retired by keeping
it recognised and inert, never by deleting it — and records that `gate-started` and
`gate-verdict` went with the host-run gate in its 0.11.0 before that rule was
written down. So `vcs::GATE_VERDICT` is read here with no declaration behind it and
will never have one again, while the runs that recorded one are still runs an
operator opens. It is the only name in `payload::vcs` on those terms, and the
suppression beside it says so.

**Gate a copied vocabulary against the type that writes it, never against one
that merely declares it.** `oneagentgraph` used to declare an `event::Usage` it
never wrote — it relays a settling member's usage copied verbatim out of the
onejudge report — and gating this crate's copy against that declared-but-unwritten
type is what let six keys drift until every served cost and token count read
`null`. Its 0.3 spells that type the way the wire always did, so the two
declarations now agree and `tests/contract.rs` asserts both; the rule stands
whatever they happen to say, because the next one to disagree will do it quietly.

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

**And a turn record of the *other party* is not a row of the transcript.** A
two-party member relays both sides into one session and each side numbers its own
turns from 1, so `payload::relayed_turns` keeps the agent's records and drops the
supervisor's: what the supervisor was asked is the agent's last reply, what it
said is the agent's next instruction, and both already reach a reader on the
agent's own turns. Serving its records as rows put the agent's reply on the user
side of a row of its own — which is what an operator sees as the agent answering
itself — and read every two-party dispatch at twice its length; against a stored
report, whose turns are joined by the number, it matched each of the report's
turns to both sides and served every one of them twice. `payload::agent_turn` is
the predicate, and a record naming **no** party is the agent's: the producer that
predates the party runs one side, so there is no other side for it to be.

**A summary belongs to the turn record before it, not the one after it.**
`oneagentgraph` opens a turn and *then* streams its activities. One published from
inside the supervisor's own invocation belongs to no row and is dropped rather
than folded onto the agent turn before it, which would bill one party's tools to
the other.

## The report a settled member left, which is what a transcript is

The journal records *that* a session reported and what tools it called, and none
of the prose, the tool returns or the per-turn cost and clock — so a transcript is
the **stored onejudge report**, and `payload::conversation_document` reads it.
`onejudge` is *linked* for that, not copied: a whole versioned document this
repository does not own is exactly what a second source of truth is made of. It is
unpinned for the reason `oneagentgraph` is — `onepipeline` resolves it and the
lock follows.

**The report is the set of turns, not only their content.** A producer brackets
some of a member's turns with `turn-started` and some members' with none at all, so
the journal is not a listing of what a dispatch had. Every turn the report recorded
is a row.

**And where the run holds a report, a record that numbers no turn is not one.** The
single `turn-completed` `oneagentgraph` 0.2 published per *dispatch* carries the
member's whole total; beside the report's turns it is a turn the report does not
have, billed for all of them. Its figures are the **run's** usage and are served
there. Where the run holds no report it is the only account of that dispatch and is
served as the row it always was. That producer has since corrected itself — 0.3
numbers every `turn-completed` and names the party that took it — so the rule now
reads the records already on disk rather than the ones being written, and it is not
retired for that: those runs are still opened.

Four joins, each the one the obvious alternative gets wrong:

- **A session to its report, by `{stream}.{member}`**, which is how a session id
  is minted — so do not add a `session` label upstream for it.
- **A turn to its measurements, by the producer's own `turn` number**, not by
  position: a turn that called no tool relays no `turn-started`. The number is
  enough only because the rule above has already dropped the other party's
  records; over both sides it matches twice.
- **A figure to the turn that spent it, off the attribution candidate that
  `ran`**, never off the report's top-level `usage` — that is the dispatch's
  total over both sides, and would repeat on every turn.
- **A clock to the side that reported it, `telemetry.sessions` at `role: agent`
  alone.** The report's two `role` vocabularies are different closed sets, and in
  practice every row one holds is the judge's, so matching by index puts the
  judge's clock on the agent's turn.

A report absent, uncopied or unreadable is "the report says nothing", never "the
session recorded nothing".

**And it is the whole of what any run holds about the judge that supervised the
dispatch.** A plan node dispatches one graph member — `worker`, in
`graphs/node-scope.yaml` — and the judge runs *inside* onejudge, so nothing
relays a judge session and no producer change here can. The report does, and only
once the member settles, which is why `payload::judge_conversation` and
`payload::judge_span` exist at all.

Three constraints on that reading, each because the obvious alternative is worse:

- **The report's `role: judge` `SessionLink` rows are the gate.** They are the
  only per-turn bounds any report here holds for that side, so a report holding
  none has no judge turn to serve — an empty conversation would say the judge
  recorded nothing, which is a different fact.
- **A judge turn is bounded, not transcribed.** The report keys no text to one and
  this crate invents no pairing: the two sides number their turns independently,
  and the judge's authored prose already reaches the wire as each agent turn's
  `user` message.
- **Its conclusion is keyed to the dispatch, not to a turn**, so it is one closing
  turn rather than smeared over them, and it lands in the turn's `unknown` — the
  field this wire already carries a producer's own record on. No field is added
  and neither closed role vocabulary moves, because both already carry `judge`.

## The live half, which is the only half a running dispatch has

A report exists once a member settles and a member that dies never writes one, so
a session's own records are the whole of what a reader of a dispatch still in
flight can be shown. `payload::live_transcript` fills those turns from them, into
the fields the report fills.

**Where a session has both, the report wins and the live records are not read at
all.** A merge of the two can disagree with itself about one turn — a text the
journal bounds against the whole of it — so `payload::conversation_document`
builds the live reading only where no readable report was found, which makes the
precedence a property of that function rather than a habit of its callers.

**Two records describe one turn, and one turn is one row.** Everything that lists,
counts or numbers a turn goes through one fold, `payload::Transcripts`, so the count
beside a node, the transcript opened from it and the id the timeline addresses it
under cannot disagree. That fold is also the one place a stored report is read, and
a row the report alone holds is addressed by nothing on the timeline — nothing
relayed it, and the dispatch span is what opens the transcript. The grouping join is the producer's `{turn, role}` and nothing
else: `oneagentgraph` 0.2 emits one `turn-completed` per *dispatch*, from
`settle_report`, carrying the member's whole total rather than any turn's, so
closing a turn by proximity would bill one turn for all of them.

**This vocabulary is declared, and is gated against its declaration.** The
`oneagentgraph` linked here is whichever one the pinned `onepipeline` resolves, and
0.3 publishes `TurnStarted`, `TurnMessage`, `TurnCompleted` and `TurnActivity` as
types — so every name in `payload::graph` but one is a field or a variant
`tests/contract.rs` holds the copy to. The one that is not is `TOOL_RESULT`: a
call's kind is the producing harness's own word, served through verbatim, so that
library types the field as a `String` and closes only the observation's spelling
inline. Moving the SDK pin is what retired the rest, and this is what it left.

**A fixture keeps writing the older shape on purpose.** A `turn-started` carrying
a number and nothing else is what every run recorded before that correction holds,
and those runs are still read: a record with no party on it joins nothing and its
turn is served as it always was. Both shapes are in `write_lanes`.

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
