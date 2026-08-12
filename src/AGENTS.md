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
- **A dispatch id.** The journal stamps a dispatch with its run, round, and node
  but mints no id for it; schema 10 serves one, so `payload::dispatch_key`
  derives it from the three.
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
- **Whether an in-flight node's turn can be redirected.** `payload::node_control`
  is the read-side answer to the question `onepipeline`'s reconciler answers by
  pulling the lever. That engine keeps a `TurnAddress` per in-flight dispatch —
  read off `oneagentgraph`'s relayed envelopes, latest winning — and a `context`
  note goes into a running turn only when there is one; a read surface must not
  pull that lever, because serving a run would then interrupt it. So this reads
  the same stream the engine reads the address from, and folds each member's last
  record into one of two answers: in a turn, or not, with the reason. An interrupt
  the sibling already refused is decisive, because `turn-interrupted` is published
  for *every* attempt and carries the producing library's own words.
  Two proposals, either of which would make this a read rather than a fold. The
  smaller: `onepipeline` publishes `edits::Operation` and `edits::Delivery`, which
  `payload::edits` currently copies as wire strings for want of a type to gate
  against. The larger: a member's control record — `oneagentgraph` already writes
  one per member into its own scratch, and onejudge reports `control` on the
  finished run — reaches the merged store, so a harness with no lever says so
  before anybody tries it. Until it does, a node nobody has yet tried to interrupt
  is served as interruptible whether or not its harness has a lever, and only the
  attempt tells them apart. That is the one thing this fold cannot answer.

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
- **A provider refusal's own evidence** (`providerFailureSchema`). A member that
  died records a classified cause, but the identity, the chain and the reset time
  a planner would act on are `oneagentgraph`'s to relay and are not on the
  envelope this crate reads.
