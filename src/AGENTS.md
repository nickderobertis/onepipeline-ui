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

- **The eight-way timing breakdown.** The SDK attributes a run's wall clock four
  ways behind its contract surface; the wire's breakdown is finer, and
  `payload::buckets` recomputes the fold to map onto it.
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
  counts a node's dispatched sessions per role so the graph reading is a reading
  rather than a download: a node that dispatched two hundred of them is two
  hundred spans at `scope=node` and one per category at `scope=run`. The SDK
  counts neither.

## What the wire asks for and no onepipeline journal records

Not derivations but gaps: a client's model has fields this API cannot fill from
any run, and the copied browser journeys were trimmed to stop asserting them.
Each needs a producing library to record it before anything here can serve it.

- **Observed checks on a publication** (`node_details[…].verification.checks`,
  `pre_push_hook`, `required_checks`). `onevcs` relays a branch and a change url
  and nothing about what ran against them.
- **A merge commit and its url, and a branch url.** The publish event carries the
  change's own url only.
- **Turn bodies and tool calls.** The journal records that a session reported,
  not what it said, so every served turn carries no tools and no reasoning.
- **A lint transport.** `transportRoleSchema` has an `llmlint` member; a
  onepipeline journal has three producers and none of them is one, so the client's
  lint lane is always empty.
- **Lock waits.** Nothing counts contention, so no `rollup` span is ever served.
- **Mid-turn activity.** The client knows an `activity.changed` stream event and a
  live-activity summary; a session's turn is relayed once, when it is done, so
  there is nothing in flight to report and that event is never sent.
