# onepipeline-ui

The read API and browser view for [onepipeline](https://github.com/nickderobertis/onepipeline)
runs: an axum server wrapping the onepipeline SDK, plus the frontend that reads it.

> **Status: interface only.** The wire contract in [`docs/contract.md`](docs/contract.md)
> is landed as compiling, tested Rust — the route table, the response envelope,
> the identifiers, the query surface, the error contract, and the CLI. **No
> request is served yet**: `onepipeline-ui serve` parses its arguments and exits
> `70` with a message saying so. The implementation lands with the onepipeline
> SDK dependency.

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
```

Every successful response carries the schema-version preamble —
`api_version`, `telemetry_schema_version` (10), `observed_at` — with the payload
flattened alongside it. Every failure carries `{"error": {"code", "message"}}`.

Payloads themselves come from the onepipeline SDK. Anything presentation-worthy
lands there first, so the agent reading the CLI sees at least what the human in
the UI sees; this crate owns the envelope, not the records.

## Install

Three surfaces, all carrying the same prebuilt binary:

```bash
cargo install onepipeline-ui --locked  # from crates.io
pip install onepipeline-api-cli        # prebuilt wheel, no Rust toolchain
npm install -g onepipeline-api-cli     # prebuilt binary, no Rust toolchain
```

Prebuilt archives and their `.sha256` checksums are also attached to every
[GitHub Release](https://github.com/nickderobertis/onepipeline-ui/releases).

## Develop

```bash
just bootstrap   # from a clean clone
just check       # the deterministic gate: format, clippy, tests + coverage, docs
just gate        # `check` plus the llmlint LLM-judge tier — the pre-push bar
```

`just --list` is the full command surface. [`AGENTS.md`](AGENTS.md) is the
durable instruction layer for humans and agents working here.

## License

MIT. See [LICENSE](LICENSE).
