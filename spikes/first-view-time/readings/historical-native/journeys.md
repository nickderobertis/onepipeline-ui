# HISTORICAL (2026-11-10, before the release-route rebuild): runs against the native cargo build of the prototype, superseded by ../journeys.md.
# spikes/first-view-time/journeys.sh runs: switches, ONEPIPELINE_UI_SPIKE_STUB_KINDS, result (Playwright's summary lines)

## j01-all  switches=[snapshot-move,node-latest,overall-stubs]  stub_kinds=default
25 passed (19.3m)

## j02-node-latest  switches=[node-latest]  stub_kinds=default
25 passed (24.0m)

## j03-overall-stubs  switches=[overall-stubs]  stub_kinds=default
25 passed (23.9m)

## j04-overall-edge-stubs  switches=[overall-stubs]  stub_kinds=turn-message,turn-started,turn-completed,turn-activity,member-heartbeat
25 passed (23.9m)

## j05-snapshot-move  switches=[snapshot-move]  stub_kinds=default
✘  24 apps/dag-ui-e2e/read-latency/reach-everything.spec.ts:287:1 › the busiest node's whole transcript is reached back to its first row, in order (10.3m)
TimeoutError: locator.click: Timeout 300000ms exceeded.
1 failed
24 passed (28.7m)

## j06-trim-spans  switches=[trim-spans]  stub_kinds=default
✘   1 apps/dag-ui-e2e/read-latency/first-screen-marks.spec.ts:127:1 › every first-screen value on a settled run equals its documents, on each view (2.4s)
✘   2 apps/dag-ui-e2e/read-latency/first-screen-marks.spec.ts:141:1 › a small settled run's first screens equal its documents (1.3s)
✘   3 apps/dag-ui-e2e/read-latency/first-screen-marks.spec.ts:155:1 › real reasons and awaits are drawn on the first screen, and Turns only as loading (2.3s)
✘  16 apps/dag-ui-e2e/read-latency/first-screen-marks.spec.ts:435:1 › the settled large run's first screens equal its complete documents (2.2m)
✘  18 apps/dag-ui-e2e/read-latency/reach-everything.spec.ts:66:1 › Overall reaches its line, tiles, run records and disclosures (6.1m)
✘  19 apps/dag-ui-e2e/read-latency/reach-everything.spec.ts:109:1 › every session link is served as the complete document names it, once the rest arrives (6.1m)
✘  20 apps/dag-ui-e2e/read-latency/reach-everything.spec.ts:146:1 › zooming a node's category lanes asks for that stretch, and only then (5.0m)
- Expected  -   1
+   "span run.load-live-open.label: answer undefined is not the complete document's \"load-live-open\"",
+   "span node.step-0.label: answer undefined is not the complete document's \"step-0\"",
+   "span node.step-0.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span verification.step-0.verify-1.label: answer undefined is not the complete document's \"verify-1\"",
+   "span verification.step-0.verify-1.parent_id: answer undefined is not the complete document's \"node.step-0\"",
+   "span verification.step-0.verify-2.label: answer undefined is not the complete document's \"verify-2\"",

## j07-three-edge  switches=[snapshot-move,node-latest,overall-stubs]  stub_kinds=turn-message,turn-started,turn-completed,turn-activity,member-heartbeat
25 passed (23.8m)

## j08-snapshot-move-rerun  switches=[snapshot-move (-g "busiest node's whole transcript")]  stub_kinds=default
1 passed (6.5m)
