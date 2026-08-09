# packages/dag-model/AGENTS.md

The client half of [`docs/contract.md`](../../docs/contract.md): the Zod parsers a
browser narrows a served payload through, and nothing else. No React, no DOM, no
transport — `@onepipeline-ui/telemetry-client` owns the fetching and this owns
what may come back.

## A vocabulary here is closed on purpose

`nodeStatusSchema`, `nodeStateSchema`, `failureClassSchema`, `agentRoleSchema`,
`transportRoleSchema` and `timelineSpanKindSchema` are enums because a consumer
switches on them exhaustively. Widening one is a contract change: it lands here,
in the server that must now serve it, and in the renderers keyed by it —
`@onepipeline-ui/dag-layout` compiles against the status set, and adding a member
without giving it a lane or a tone fails there rather than rendering untoned.

## Two corpora, and they are not the same thing

`e2e/corpus/` is what a *conforming* server may serve, kept as committed bytes so
these parsers cannot narrow to whatever this repository's own server happens to
emit. `tests/fixtures/` is what it does emit, pinned by `tests/contract.rs`.
`model.e2e.test.ts` reads both through the same public parsers, and that pairing
is the drift gate between the contract and the server: neither can move without
the other failing here.
