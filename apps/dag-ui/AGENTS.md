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

## What the backend cannot answer

The client's model has fields no onepipeline journal records, so parts of this
vocabulary are permanently empty here: observed checks, merge commits, turn
bodies and tool calls, the lint transport, lock waits, mid-turn activity. A
journey that would assert one of them was trimmed rather than fed an invented
record, and the reason for each is recorded beside the crate that would have to
serve it.
