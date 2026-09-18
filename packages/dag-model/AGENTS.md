# packages/dag-model/AGENTS.md

The client half of [`docs/contract.md`](../../docs/contract.md): the Zod parsers a
browser narrows a served payload through, and nothing else. No React, no DOM, no
transport — `@onepipeline-ui/telemetry-client` owns the fetching and this owns
what may come back.

## A vocabulary here is closed on purpose

`nodeStatusSchema`, `nodeStateSchema`, `failureClassSchema`,
`transportRoleSchema` and `timelineSpanKindSchema` are enums because a consumer
switches on them exhaustively. Widening one is a contract change: it lands here,
in the server that must now serve it, and in the renderers keyed by it —
`@onepipeline-ui/dag-layout` compiles against the status set, and adding a member
without giving it a lane or a tone fails there rather than rendering untoned.

`agentRoleSchema` is the deliberate exception, and it is **open**: a role is the
member name a run's own graph declared, served under the run's word, so no
consumer may switch on it exhaustively or key a table on it. What it holds is
`oneagentgraph`'s grammar for a member's name and nothing narrower — a
consumer draws one lane per distinct word a payload serves, in the order it
serves them. Closing it again over any host's member names is the regression
timeline schema 10 and telemetry schema 17 exist to have fixed.

## Two corpora, and they are not the same thing

`e2e/corpus/` is what a *conforming* server may serve, kept as committed bytes so
these parsers cannot narrow to whatever this repository's own server happens to
emit. `tests/fixtures/` is what it does emit, pinned by `tests/contract.rs`.
`model.e2e.test.ts` reads both through the same public parsers, and that pairing
is the drift gate between the contract and the server: neither can move without
the other failing here.
