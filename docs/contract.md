### onepipeline-ui contract

Rust (axum) server wrapping the onepipeline SDK. Endpoints preserved so the copied frontend re-points with minimal change:

```
GET /healthz
GET /api/v2/runs                      # list w/ session attribution
GET /api/v2/runs/{run}                ?include_conversations=bool
GET /api/v2/runs/{run}/timeline       ?scope=run|node&node=ID
GET /api/v2/runs/{run}/conversations/{id}
GET /api/v2/runs/{run}/artifacts/{id}
GET /api/v2/events                    # SSE; fresh snapshot per connection
```

Payloads keep the telemetry schema-version discipline and serve schema 12 including `dispatch_id` — schema 10 was where `dispatch_id` landed, and 11 is that discipline exercised: an unmeasured timing is served `null` rather than `0`, so a lane nothing measured can no longer read as a measured zero. Anything the API computes that is presentation-worthy lands in the onepipeline SDK/CLI first: the agent reading the CLI must have the same or better visibility than the human in the UI.

Schema 12 answers, per node in flight, whether the run has a turn it can address for it — the precondition a planner needs before choosing between correcting a node and cancelling it. A round carries `node_control` — one entry for every node it records as `running` and for no other — and each entry is `{addressable, member?, reason?}`, with `reason` present exactly when `addressable` is false. A node whose turn this run cannot address reads as `addressable: false` carrying the reason — never as an error and never as an absent value — and where an interrupt has already been attempted the reason is the producing library's own words for what it found.

`addressable` means **this run has a turn it can address for that node** — the engine's own precondition for delivering a note into a running turn — read from whether a member is in a turn and from the outcome of every interrupt already attempted, which is published for every attempt whether or not it landed. It is not a claim that the harness will accept a redirection. No published component exposes an authoritative *current-turn* control state outside the process running the turn: onejudge reports `control` only on the finished run, the live provider accessor is in-process only, `oneagentgraph`'s spawn-time record is provisional for every member whatever its harness, and the control protocol's only verb is `interrupt`, which costs the turn. A previous dispatch's report is not a substitute and is never read as one — `provider.control` is asked for per run and reset for the next. `src/AGENTS.md` records each closed route and the upstream change that opens one.

Timeline schema 4 carries the redirection itself. An event produced by a `turn-interrupted` or by an `edit-committed` that added context to a node carries `redirection` — `{delivered, member?, input_bytes?, reason?, delivery?, node_id?}` — so a turn whose behaviour changed mid-flight shows the moment the planner changed it, and whether the note went into the running turn (`live`) or onto the node's next dispatch (`deferred`).
