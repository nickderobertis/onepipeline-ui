# A run launched with bus validators

`nx-heal-removal-revise/` is the run of that name an operator's host launched
on 2026-10-14 under an engine linking an `onemessagebus` that still had
validators: its launch record's `bus_config` declares one under `validators:`,
on `replies`. `launch.json`, `plan.json` and `events.jsonl` are byte for byte
the files that engine wrote — the same bytes onepipeline publishes in its own
`tests/recorded/run-root/run-labels/ended/`. Nothing was edited; the run's other
files (its summary, checkpoint, channel and dispatch records) were not kept.

`tests/e2e/server.rs`'s
`a_run_launched_with_validators_is_read_as_its_engine_recorded_it` serves it
through the real server and holds its plan, node settlements and state to these
files.
