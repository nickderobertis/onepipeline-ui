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
