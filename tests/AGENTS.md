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
writes — a launch record, a `plan.json`, a merged `events.jsonl`, and the one
`result.json` a driver rewrites as it closes out. They are deliberately not a
stub of the SDK: an SDK build that changed those files fails here rather than in
production. Execution is continuous, so there is no per-round directory in that
shape and a run being driven has no recorded result at all.

One thing some journeys need that the tree does not carry: the `onepipeline`
CLI they compare the server against. The server runs no `onepipeline` binary —
every verb is a call into the SDK it links — so the CLI is there for the
comparisons in `tests/e2e/server.rs` that hold what the server served to what
`onepipeline telemetry`, `results`, `goals`, `transcript` and `unwatched` print
over the same run. `just bootstrap` provisions the version the lock pins into
`.tools/`, and `tests/support/sibling.rs` reaches it there — through
`ONEPIPELINE_UI_ONEPIPELINE_BIN` where the justfile exports it, and at the same
clone-local path otherwise — rather than at whatever is on PATH, because a
different release prints a different document and a comparison against one
proves nothing.

The journeys that write to a run — a reply, a stop, an adoption — write to a
copy under a temporary workspace and act as the session the fixture's launch
record names, through `--session`. An adoption retains the compiled binary as
the run's driver, a real process; `tests/support/fixture_run.rs`'s
`write_awaiting_attestation` is the one run shape a driver can be retained over
on this host, and the journey that adopts it ends every driver it started.

## What a read costs is a test, not a benchmark

`tests/e2e/cost.rs` holds the bounds on what this server may do to a runs root:
what a run list may read, what a route about one named run may touch, what an
idle subscriber may do per tick. They are counted in **operations** — bytes read,
files opened, metadata looked up, processes started — rather than in elapsed
time, because a CPU measurement on a host that also runs every dispatch is a
property of the host and reproduces nowhere, while the work a read does is a
property of the finished tree.

They run behind `onepipeline-ui-cost:test-cost` rather than under `test`, and the
edge is about the tracer rather than the clock — seconds, not minutes. `check`
runs it, so the pre-push bar still holds the bounds; a bare `just test` is spared
a dependency nothing else here has.

`tests/support/cost.rs` is how they are counted: the real binary, over a real
runs root, on a real socket, with `strace` watching what it asks the kernel for.
That is what makes the bound honest — it counts every byte the linked SDK reads
without a line of this crate being involved, which is exactly where the cost
these journeys exist to hold down used to live. Linux only, and compiled away
elsewhere rather than skipped, so no leg ever reports a bound as held when
nothing measured it. One request is told from another by a **marker**: a real
request naming a run id the store cannot hold, which leaves a self-identifying
landmark in the trace and needs no clock to line two records up.

`tests/support/http.rs` is hand-rolled for the same reason. A client library
would decide what a non-2xx means and how much of a stream to buffer, and both
are what the journeys assert.

A new CLI verb, flag, or route is not done until its journey lands in
`tests/e2e/`: the happy path **and** at least one failure the user can cause.

## The tiers are projects

The suite runs as five Nx projects, so a change pays for the tiers it can reach
rather than for all of them. Each selects its tests through the nextest profile
of the same name in `.config/nextest.toml`; the projects under `tests/tiers/`
hold nothing but their `project.json`, and these rules are theirs.

| Project | Target | Profile | Runs |
| --- | --- | --- | --- |
| `onepipeline-ui` | `test` | `unit` | the library's and binary's unit tests, `tests/contract.rs` |
| `onepipeline-ui-e2e` | `test` | `e2e` | `cli`, `server`, `ui` |
| `onepipeline-ui-repo-tooling` | `test` | `repo-tooling` | `tests/packaging.rs` and the e2e modules that drive scripts, workflows and recipes |
| `onepipeline-ui-baseline` | `test-baseline` | `baseline` | `baseline` |
| `onepipeline-ui-cost` | `test-cost` | `cost` | `cost` |

- **A new module of the e2e binary lands in `e2e`** unless its name joins
  another profile's list — the `e2e` filter is the complement of the other
  three, so nothing runs nowhere. A new `tests/*.rs` binary lands in `unit`.
  `tests/e2e/ensure_baseline.rs` holds the profiles to one partition and every
  tier project to the profile it names.
- **A tier is reached only through its inputs.** No tier has a project-graph
  edge to the crate — the root project is affected by every change, so an edge
  to it would select every tier every time. Each instead names the files its
  tests read, and a module a tier starts reading has to join that list:
  `tests/e2e/ensure_baseline.rs` fails until it does. A file a journey only
  needs to *exist* is left out — `ui::` packages the crate, which lists the
  wrapper scripts, but their contents cannot change what it asserts.
- **The coverage floor is one report over three tiers.** The instrumented
  tiers (`unit`, `e2e`, `repo-tooling`) leave profiles named for themselves
  under `target/llvm-cov-target` — declared as their Nx `outputs`, so a tier
  replayed from the cache restores what the report merges — and
  `onepipeline-ui-coverage:coverage` merges them and holds the union to 95%,
  the same lines one run over the same tests measured. It lives on a project
  of its own because the root project is always affected: there it would run
  every instrumented tier on every change. Its inputs are the crate's sources
  and the suite's own files, so a change that cannot move coverage does not
  re-measure it.
- **`test-quick`** is a tier without instrumentation, for the cross-platform
  legs; the baseline and cost tiers have none, for the reasons the justfile's
  `test-quick` recipe gives.

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
