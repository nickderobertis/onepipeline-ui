# Exact commands of this measurement (run from SCRATCH/hashes/onetaskgraph). T = task-hashes.mjs.
T=/home/whoop/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/3/worktree/scripts/spike-opnx/task-hashes.mjs
git clone -q https://github.com/nickderobertis/onetaskgraph clone          # origin/main 705faa9cc517af94977ddd10f82f5728d6d07725
(cd clone && bun install --frozen-lockfile)
# 1. Task list: the four jobs' selection, with every project affected (base = repo root commit)
for j in lint test-linux test-windows test-macos; do (cd clone && NX_DAEMON=false NX_BASE=143002fe022eca174b58ccac06497800aedc9092 NX_HEAD=HEAD bash scripts/ci-job.sh $j --select-only) > sel/$j.txt; done
# -> tasks.txt (147 tasks), task-jobs.tsv; projects/*.json from `nx show project <p> --json`
# 2. main and release edits
node $T capture clone $(cat tasks.txt) --out $PWD/main.json          # (also main-recapture.json: 0 moved, deterministic)
cp -a clone rel && (cd rel && ~/.cargo/bin/release-plz update)      # no-op: main's tip IS the v0.13.3 release, no eligible commit
(cd rel && scripts/set-version.sh 0.13.4)                           # the script prepare-release-pr.sh runs; + 4 CHANGELOG entries
git -C rel diff > release-edits.diff
node $T capture rel $(cat tasks.txt) --out $PWD/orig-release.json
python3 tools/diff2.py main.json orig-release.json > diff-main-release.txt
python3 tools/explain.py main.json orig-release.json release-edited-files.txt projects task-jobs.tsv > explain-release.tsv
# real release commit (f8a10df -> 705faa9, release v0.13.3):
cp -a clone pre && git -C pre checkout f8a10df && node $T capture pre $(cat tasks.txt) --out $PWD/pre-v0.13.3.json
python3 tools/diff2.py pre-v0.13.3.json main.json > diff-real-release-v0.13.3.txt
# 3. new definition
cp -a clone def && python3 tools/apply-definition.py def && node $T capture def $(cat tasks.txt) --out $PWD/def-main.json
for k in release source dep-cargo dep-npm; do tools/make-variant.sh def v/def-$k $k; node $T capture v/def-$k $(cat tasks.txt) --out $PWD/def-$k.json; done
for k in source dep-cargo dep-npm; do tools/make-variant.sh clone v/orig-$k $k; node $T capture v/orig-$k $(cat tasks.txt) --out $PWD/orig-$k.json; done
# + def-halfbump (release edits minus sdks/typescript/src/index.ts), def-prerelease (0.13.3 -> 0.14.0-rc.1), def-pre-v0.13.3
# 4. timings
(cd clone/sdks/typescript && bun test tests/version.test.ts)
(cd clone/sdks/python && ONETASKGRAPH_SDK_WITHOUT_CLI=1 UV_NO_SYNC=1 uv run --frozen pytest -q --no-cov tests/test_version.py::test_the_version_is_a_plain_semantic_version tests/test_client.py::test_distribution_version)
(cd clone && cargo build --locked -p onetaskgraph-e2e --tests -p onetaskgraph && cargo test --locked -p onetaskgraph-e2e --test e2e -- surface::version_reports_the_crate_version_on_stdout_and_exits_zero --exact)
gh run view 41606565192 -R nickderobertis/onetaskgraph --log --job <id> > ci/job-<id>.log; python3 tools/task-times.py ci/job-<id>.log
