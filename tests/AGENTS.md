# tests/AGENTS.md

This repo runs on agents, so the suite is the only QA loop.

## Never mock the layer under test

`tests/e2e/` spawns the compiled binary as a subprocess and asserts on exit code,
stdout, and stderr, and runs the committed npm launcher under a real node through
node's own module resolution. Nothing under test is stubbed. A green mocked suite
would be worse than none here — nobody clicks through this product.

A new CLI verb, flag, or route is not done until its journey lands in
`tests/e2e/`: the happy path **and** at least one failure the user can cause.

## Which tier a test belongs to

- `tests/e2e/` — only what reaches the entry point a user typed. A test that
  inspects a build artifact without running it is not an e2e journey.
- `tests/packaging.rs` — what a released package must *contain*. Three manifests
  (Cargo.toml, `pyproject.toml`, the npm launcher) and `release.yml` describe one
  artifact; without this they would only disagree in public, mid-release.
- `tests/contract.rs` — the crate against `docs/contract.md`.

## The fixtures pin the envelope, not the records

`tests/fixtures/` holds one response body per route, and each must round-trip
**byte for byte**. What that pins is the envelope: the schema-version preamble
and its serialization. Their payload bodies carry only the facts
`docs/contract.md` itself names — session attribution on the run list,
`dispatch_id` at schema 10, an empty `conversations` for the opt-out — and are
**not** a claim about the onepipeline SDK's record shapes. Do not grow them into
one; the SDK owns those.
