# apps/dag-ui-e2e/AGENTS.md

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

`test` is the journeys, and `test-isolation` is the one check that *runs* the
tier rather than being run by it: it launches two whole tiers at once to prove
they stay out of each other's way, which costs more than everything else here
together and answers one question nothing else asks. Each edge is what a reader
can ask for without paying for the rest; `check` pays for all of it.

## Reaching the app

Sibling dependencies here are `"*"`, as every one in this workspace is: the
`workspace:*` protocol does not install under the npm this repository provisions
with. `tests/packaging.rs` fails the build on it and carries the measurement.

Not at all, and that is the point: what a journey needs of the app's vocabulary
comes from `@onepipeline-ui/timeline-categories`, the shared package both this
project and the app depend on. A journey importing `../src/...` reaches into
another project's files, which `@nx/enforce-module-boundaries` refuses and which
would make every internal move of the app a change to the journeys — and reaching
for the app's own package instead is the same coupling with a nicer spelling. The
vocabulary is what a journey must not restate: a journey holding its own copy of
`EVENT_CATEGORIES` passes while the app grows a category nobody draws.

## Reading a tier that would not start

`Timed out waiting 120000ms from config.webServer` is the whole of what Playwright
says when one of the five servers never becomes ready — it names neither the
server nor the reason, and it starts them one at a time. So every entry carries a
`name`, keeps its `stdout`, and states the address it took. **Read them in order:
the first server that printed nothing is the one being waited for.**

Every server runs from the app directory (`cwd`), because that is where its
`vite.config.ts`, its built bundle and `fixtures/serve-fixture.mjs` are.
Nothing in that readiness window may build: the bundle and the API binary are
this project's `test` dependencies, and a compile there is reported only as a server
that would not start.
