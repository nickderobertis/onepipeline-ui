# apps/dag-ui/e2e/AGENTS.md

The journeys that drive the DAG Observatory, and the tier that runs them. The app
itself is `apps/dag-ui`; this is a project of its own because these drive the
built app rather than being part of it.

## What a journey is held to

A change to what a reader sees is not done until a journey drives it, in a real
browser, against the **built bundle** — `vite preview` over what `dag-ui:build`
produced, which is the artifact the `onepipeline-ui` npm package ships — and a
real `onepipeline-api serve` over a recorded run directory. Nothing between the
browser and the read model is doubled. A dev server is not what any reader loads,
and a bundle can differ from what Vite serves unbuilt.

`test-browser` is the only tier here, and it is the only one in this repository
that starts five servers: that is why it is an edge of its own rather than part of
the app's `test`, which runs components in seconds. `check` depends on both, so
the gate rules on the journeys and only somebody asking for one tier by name is
spared the other.

## Reaching the app

Through `@onepipeline-ui/dag-ui/testing` and nothing else. A journey importing
`../src/...` reaches into another project's files, which
`@nx/enforce-module-boundaries` refuses and which would make every internal move
of the app a change to the journeys. What that export carries is the category
vocabulary, because it is the one thing a journey must not restate: a journey
holding its own copy passes while the app grows a category nobody draws.

## Reading a tier that would not start

`Timed out waiting 120000ms from config.webServer` is the whole of what Playwright
says when one of the five servers never becomes ready — it names neither the
server nor the reason, and it starts them one at a time. So every entry carries a
`name`, keeps its `stdout`, and states the address it took. **Read them in order:
the first server that printed nothing is the one being waited for.**

Every server runs from the app directory (`cwd`), because that is where its
`vite.config.ts`, its built bundle and `e2e/fixtures/serve-fixture.mjs` are.
Nothing in that readiness window may build: the bundle and the API binary are
`test-browser`'s dependencies, and a compile there is reported only as a server
that would not start.
