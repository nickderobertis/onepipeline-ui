# tests/AGENTS.md

This repo runs on agents, so the suite is the only QA loop.

## Never mock the layer under test

`tests/e2e/` spawns the compiled binary as a subprocess and asserts on exit code,
stdout, and stderr; starts that binary on a real port and reads the bytes it
serves over a socket; and runs the committed npm launcher under a real node
through node's own module resolution. Nothing under test is stubbed. A green
mocked suite would be worse than none here — nobody clicks through this product.

The run directories the server journeys read are built by
`tests/support/fixture_run.rs`, and they are the files the onepipeline SDK itself
writes — a launch record, a merged `events.jsonl`, `round-NN/plan.json`,
`round-NN/result.json`. They are deliberately not a stub of the SDK: an SDK build
that changed those files fails here rather than in production.

One thing those journeys need that the tree does not carry: the `onepipeline`
build whose telemetry document this server serves. `just bootstrap` provisions
the version the lock pins into `.tools/`, and every tier is pointed at it by
`ONEPIPELINE_UI_ONEPIPELINE_BIN` rather than at whatever is on PATH — a stray
build speaks a different document version and is refused, which would leave every
run served with no clock at all. `every_route_serves_the_payload_its_golden_pins`
fails with that instruction rather than quietly pinning goldens full of nulls.

`tests/support/http.rs` is hand-rolled for the same reason. A client library
would decide what a non-2xx means and how much of a stream to buffer, and both
are what the journeys assert.

A new CLI verb, flag, or route is not done until its journey lands in
`tests/e2e/`: the happy path **and** at least one failure the user can cause.

## Which tier a test belongs to

- `tests/e2e/` — only what reaches the entry point a user typed. A test that
  inspects a build artifact without running it is not an e2e journey.
- `tests/packaging.rs` — what a released package must *contain*. Three manifests
  (Cargo.toml, `pyproject.toml`, the npm launcher) and `release.yml` describe one
  artifact; without this they would only disagree in public, mid-release.
- `tests/contract.rs` — the crate against `docs/contract.md`.

## The fixtures are goldens, not hand-written claims

`tests/fixtures/` holds one response body per route, and every one of them is
what this server actually made of the recorded run in
`tests/support/fixture_run.rs`. They are not written by hand and must not be
edited by hand: `every_route_serves_the_payload_its_golden_pins` regenerates
them from a real read when you run it with `UPDATE_CONTRACT_FIXTURES=1`.

That is the schema-version discipline in practice. A payload change shows up as
a golden diff in the same commit, which is where the decision to make it is
either obvious or obviously wrong. The one field a golden cannot pin is
`observed_at` — the instant of the read — so the comparison normalizes it and
holds everything else byte for byte.
