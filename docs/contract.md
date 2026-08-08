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

Payloads keep the telemetry schema-version discipline and serve schema 10 including `dispatch_id`. Anything the API computes that is presentation-worthy lands in the onepipeline SDK/CLI first: the agent reading the CLI must have the same or better visibility than the human in the UI.
