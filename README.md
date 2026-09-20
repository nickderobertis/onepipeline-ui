# onepipeline-ui

The read API and browser view for [onepipeline](https://github.com/nickderobertis/onepipeline)
runs: an axum server wrapping the onepipeline SDK, plus the frontend that reads it.

## The contract

[`docs/contract.md`](docs/contract.md) is the source of truth, quoted verbatim
from the task that commissioned this repository. `tests/contract.rs` reconciles
the code against it, so a route that exists in one and not the other fails the
gate.

```
GET /healthz
GET /api/v2/runs                      # list w/ session attribution
GET /api/v2/runs/{run}                ?include_conversations=bool
GET /api/v2/runs/{run}/timeline       ?scope=run|node&node=ID
GET /api/v2/runs/{run}/conversations/{id}
GET /api/v2/runs/{run}/artifacts/{id}
GET /api/v2/events                    # SSE; fresh snapshot per connection
GET /api/v2/projects                  # runs grouped by project, as `onepipeline runs` groups them
GET /api/v2/projects/{project}
GET /api/v2/runs/{run}/channel        # the channel, consuming nothing
POST /api/v2/runs/{run}/channel/next  # claim the next surface
POST /api/v2/runs/{run}/channel/reply # the envelope's bytes, verbatim; ?correlation=C
POST /api/v2/runs/{run}/channel/surface
POST /api/v2/runs/{run}/attest
POST /api/v2/runs/{run}/stop          # as the session `--session` names
POST /api/v2/runs/{run}/adopt         # retains this binary as the driver
GET /api/v2/runs/{run}/watch          # SSE over `onepipeline watch`
GET /api/v2/unwatched
GET /api/v2/host
GET /api/v2/runs/{run}/status
GET /api/v2/runs/{run}/results
GET /api/v2/goals
GET /api/v2/runs/{run}/goals
GET /api/v2/runs/{run}/transcript     ?node=ID
GET /api/v2/runs/{run}/telemetry
```

The first seven are the read surface the browser view was written against;
the rest are every verb the `onepipeline` CLI has once a plan is running,
wrapped — each a thin call into `onepipeline::verbs`, never a re-implementation
and never the binary. Launching a plan and driving the planning stage are
outside this API; a reply on any run's channel is inside it. The server acts as
one launching session (`--session ID`, else `ONEPIPELINE_LAUNCHER_SESSION`),
which is what its stops and adoptions are judged by.

Every successful response carries the schema-version preamble —
`api_version`, `telemetry_schema_version` (18), `observed_at` — with the payload
flattened alongside it. Every failure carries `{"error": {"code", "message"}}`.

Payloads themselves come from the onepipeline SDK. Anything presentation-worthy
lands there first, so the agent reading the CLI sees at least what the human in
the UI sees; this crate owns the envelope, not the records.

## The view

[`apps/dag-ui`](docs/dag-ui.md) is the DAG Observatory: the browser view of the
same runs, reading nothing but the contract above. It declares no schema, event
name, or API path of its own — `packages/dag-model` holds the contract's client
half, `packages/telemetry-client` is the only thing that speaks HTTP, and
`packages/dag-layout` is the graph geometry. [`docs/dag-ui.md`](docs/dag-ui.md)
is its design record.

## Install

Two deliverables, split by what they contain.

The read API, as the same prebuilt binary on three registries:

```bash
cargo install onepipeline-ui --locked  # from crates.io
pip install onepipeline-api-cli        # prebuilt wheel, no Rust toolchain
npm install -g onepipeline-api-cli     # prebuilt binary, no Rust toolchain
```

All three install one command, `onepipeline-api`:

```bash
onepipeline-api serve --runs-root ./runs
```

The view, as a static bundle on npm alone:

```bash
npm install onepipeline-ui             # the built frontend under dist/
```

That package installs no command — it is `dist/`, to be served statically.

Prebuilt archives and their `.sha256` checksums are also attached to every
[GitHub Release](https://github.com/nickderobertis/onepipeline-ui/releases).

## Develop

```bash
just bootstrap        # from a clean clone
just check            # the deterministic gate, every project
just gate             # `check` plus the llmlint LLM-judge tier — the pre-push bar
just dag-ui-screens   # photograph the view at every viewport into a gallery
```

`just --list` is the full command surface. [`AGENTS.md`](AGENTS.md) is the
durable instruction layer for humans and agents working here.

## License

MIT. See [LICENSE](LICENSE).
