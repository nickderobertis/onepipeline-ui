# Journeys against the release-built prototype (target/spike-release/onepipeline-api, sha256 9958590a…, built by spikes/first-view-time/build.sh through dag-ui-read-latency:compile-release-server): spikes/first-view-time/journeys.sh <switches> --output <dir>, ONEPIPELINE_UI_SPIKE_STUB_KINDS as named. Playwright's summary lines.

## k01-node-latest  switches=[node-latest]  stub_kinds=unset
25 passed (21.9m)

## k02-stubs-turn  switches=[overall-stubs]  stub_kinds=unset (turn-message,turn-started,turn-completed)
25 passed (21.9m)

## k03-stubs-five  switches=[overall-stubs]  stub_kinds=turn-message,turn-started,turn-completed,turn-activity,member-heartbeat
25 passed (22.3m)

## k04-move  switches=[snapshot-move]  stub_kinds=unset
25 passed (22.0m)

## k05-trim  switches=[trim-spans]  stub_kinds=unset
+   "span node.cross-run-consumer.label: answer undefined is not the complete document's \"cross-run-consumer\"",
+   "span node.cross-run-consumer.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.dashboard.label: answer undefined is not the complete document's \"dashboard\"",
+   "span node.dashboard.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.failed-with-reason.label: answer undefined is not the complete document's \"failed-with-reason\"",
+   "span node.failed-with-reason.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.held-for-release.label: answer undefined is not the complete document's \"held-for-release\"",
+   "span node.held-for-release.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.only.label: answer undefined is not the complete document's \"only\"",
+   "span node.only.parent_id: answer undefined is not the complete document's \"run.load-small-settled\"",
+   "span node.retired-off-graph.label: answer undefined is not the complete document's \"retired-off-graph\"",
+   "span node.retired-off-graph.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.step-0.label: answer undefined is not the complete document's \"step-0\"",
+   "span node.step-0.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",

## k06-favoured  switches=[snapshot-move,node-latest,overall-stubs]  stub_kinds=turn-message,turn-started,turn-completed,turn-activity,member-heartbeat
25 passed (19.1m)

## k07-favoured-trim  switches=[snapshot-move,node-latest,overall-stubs,trim-spans]  stub_kinds=turn-message,turn-started,turn-completed,turn-activity,member-heartbeat
+   "span node.cross-run-consumer.label: answer undefined is not the complete document's \"cross-run-consumer\"",
+   "span node.cross-run-consumer.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.dashboard.label: answer undefined is not the complete document's \"dashboard\"",
+   "span node.dashboard.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.failed-with-reason.label: answer undefined is not the complete document's \"failed-with-reason\"",
+   "span node.failed-with-reason.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.held-for-release.label: answer undefined is not the complete document's \"held-for-release\"",
+   "span node.held-for-release.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.only.label: answer undefined is not the complete document's \"only\"",
+   "span node.only.parent_id: answer undefined is not the complete document's \"run.load-small-settled\"",
+   "span node.retired-off-graph.label: answer undefined is not the complete document's \"retired-off-graph\"",
+   "span node.retired-off-graph.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",
+   "span node.step-0.label: answer undefined is not the complete document's \"step-0\"",
+   "span node.step-0.parent_id: answer undefined is not the complete document's \"run.load-live-open\"",

# Journeys added by a later dispatch (2026-11-10, 09:16–09:59, two at a time, load 4.2–6.5) for the configurations the report presented without them; no binary rebuilt, no measurement repeated. Same command, with READ_LATENCY_SERVER naming the binary: prototype sha256 9958590a…, default (this branch, no overlay) dbfc2405…, landed 59eaa15 5d776adf…

## k08-engine-cuts  server=prototype  switches=[node-latest,overall-stubs]  stub_kinds=turn-message,turn-started,turn-completed,turn-activity,member-heartbeat  (reading r09)
25 passed (20.7m) 

## k09-proto-off  server=prototype  switches=[]  stub_kinds=unset  (readings r02, r12)
25 passed (21.0m) 

## k10-default  server=default  switches=[]  stub_kinds=unset  (readings r03, r15)
25 passed (20.8m) 

## k11-landed  server=landed 59eaa15  switches=[]  stub_kinds=unset  (readings r01, r13, r16, r17, r19)
25 passed (21.1m) 
