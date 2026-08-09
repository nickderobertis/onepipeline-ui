# packages/telemetry-client/AGENTS.md

The one way a browser reaches the read API: the six `/api/v2` routes and the SSE
stream, each response handed straight to `@onepipeline-ui/dag-model` to narrow.
It parses nothing itself and renders nothing.

## Ask for the scope the contract names

A route's query string is part of the contract, not a convenience: the timeline
is `?scope=run` or `?scope=node&node=<id>`, and a request that names a node
without the scope is refused by a conforming server rather than guessed at. Every
identifier this package interpolates is encoded, because a run or conversation id
arrives from a served payload and a URL is a trust boundary like any other.

## The stream invalidates; it does not carry state

Every connection opens with a fresh snapshot, and everything after it names the
run that moved. A consumer refetches; it never reconciles a second copy of the
state model out of the frames. `e2e/` drives both halves over a real
`node:http` loopback server rather than a stubbed `fetch`.
