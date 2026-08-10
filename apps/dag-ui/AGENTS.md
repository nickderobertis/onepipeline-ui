# apps/dag-ui/AGENTS.md

The DAG Observatory: the browser view of what the read API serves. What follows
is the bar it is held to, not a tour of it.

## The bar is journeys, not a number

There is no line-coverage floor here. `test` runs vitest and *both* Playwright
configs — `playwright.config.ts` for the journeys and `isolation.config.ts` for
what one run of that tier owes another — and a change to what a reader sees is
not done until one of them drives it, in a browser, against a real
`onepipeline-api serve` over a recorded run directory. Nothing between the browser
and the read model is doubled.

`just dag-ui-screens` photographs every surface at every viewport in the matrix.
It asserts nothing; it is how the operator sees a polish problem at a width
nobody opens by hand.

## Reading a browser tier that would not start

`Timed out waiting 120000ms from config.webServer` is the whole of what
Playwright says when one of the five servers `playwright.config.ts` starts never
becomes ready — it names neither the server nor the reason, and it starts them
one at a time. Two pull requests were spent attributing that sentence to the
wrong server. So the log is the evidence, and keeping it readable is part of the
tier: every entry carries a `name`, every entry keeps its `stdout`, and every
server states the address it took — the read API through its own `serving …`
line, Vite through its ready line, the stall server through one line per port.

**Read them in order, and read the address, not the word "ready".** The server
being waited for is the last one that printed, not the first one that did not —
the ones after it were never started. And "ready" is a server's opinion of
itself: what decides the wait is whether the address it *bound* is the address
`playwright.config.ts` *waits on*. Vite announced `ready in 253 ms` on four
GitHub runs while listening somewhere Playwright was not looking, which is the
whole of that bug and the reason `LOOPBACK` is one constant in that file.

A server that *exits* is reported differently — `Process from config.webServer
was not able to start. Exit code: N` — so a bare timeout means the process is
alive and has not bound where it was asked to. That distinction only survives if
nothing here dies on an unhandled `error`, which is why both of
`serve-fixture.mjs`'s refusals are exits under the crate's own contract: `2` for
an address this host will not give, `70` for a read API that was never built.

Whatever a server has to do before it binds, it does inside that window, so
nothing may build there. The read API is built by `dag-ui:build-api-server`,
which `test` and `bootstrap` depend on; the fixture run directory is written
here, and it costs ~70 ms for its 750 files, which is the budget it has to stay
inside.

## This app was copied, and its implementation is the spec

It came over from the repository it was written in, whole. Preserve the invested
behaviour — the three-level graph timeline, the drawn silence, the synced
transcript, the bounded rendering — and change only what this backend requires.
That is why several components hold their own effects and subscriptions beside
render rather than behind hooks: rewriting them would be rewriting the spec, and
each such site carries a suppression saying so.

## Both readings of the clock are one feature

`OverallView` and `NodeTimelineView` live together in `src/features/timeline/`
because they are the run-level and node-level ends of a single reading: they
share its model (`timeline-model`, `graph-timeline`) and the detail panel each
row opens into (`TimelineItemDetail`), and the overall view is one click from
the node view by design. Split apart, one of them has to reach into the other's
internals, which is the coupling the feature boundary exists to prevent. A
module both features need and neither owns belongs in `src/lib/` instead.

## What the backend cannot answer

Some of the client's model has no record behind it. A surface needing one of
those fields is fed nothing rather than an invented record: it states the
absence, and the journey asserts that statement. Trim a journey only against what
the producing library actually emits, never against a belief about what it does
not.
