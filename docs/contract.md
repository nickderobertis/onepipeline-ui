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

Schema 12 answers, per node, whether an in-flight turn can be redirected rather than only cancelled. A round carries `node_control` — one entry for every node it records as `running` and for no other — and each entry is `{interruptible, member?, reason?}`, with `reason` present exactly when `interruptible` is false. A node on a harness with no out-of-band turn control reads as `interruptible: false` carrying that harness's own words, never as an error and never as an absent value.

The answer is onejudge's `control` wherever onejudge has given one: a member whose report carries `control: null` had no controllable turn, and reads as not interruptible with `control_unavailable`'s own reason — **before any interruption has been attempted**, and whatever its turn records show. The report is read from the copy the run itself retains, never from the `report_path` a settlement names. Where onejudge has not answered, a recorded `turn-interrupted` does, and the member's turn records last. onejudge reports `control` only on the finished run, so a member that has never settled on this run has no `control` value to reflect; `src/AGENTS.md` records that gap and the upstream change that closes it.

Timeline schema 4 carries the redirection itself. An event produced by a `turn-interrupted` or by an `edit-committed` that added context to a node carries `redirection` — `{delivered, member?, input_bytes?, reason?, delivery?, node_id?}` — so a turn whose behaviour changed mid-flight shows the moment the planner changed it, and whether the note went into the running turn (`live`) or onto the node's next dispatch (`deferred`).
