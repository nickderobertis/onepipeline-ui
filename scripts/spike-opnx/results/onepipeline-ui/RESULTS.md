# Nx task-hash audit: github.com/nickderobertis/onepipeline-ui

Plan `ci-release-test-cache`, spike `spike-opnx-audit`. Every figure below comes from a
record saved beside this file. Nothing was pushed or written to GitHub. The GitHub API
was used for reads only: about 8 requests, with `rate_limit` showing 4651 and then
4582 core requests remaining.

## What was measured

- **Commit:** `origin/main` = `6c669bd74bd9afcc5a1385e8b8abb4c25dad97b3` (`chore: release v0.65.3 (#595)`), cloned to `clone/`.
- **Tools:** Nx 23.1.3 (from the workspace's `node_modules`), node v26.8.2, bun 1.3.14 (`bash scripts/workspace-install.sh`), release-plz 0.3.167, cargo-nextest 0.9.137.
- **Hasher:** `node /home/whoop/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/3/worktree/scripts/spike-opnx/task-hashes.mjs` was used **unmodified**. Its one quirk: it `chdir`s into the workspace, so `--out` must be an absolute path. The first capture failed with ENOENT on a relative `--out`.
- **Determinism:** the main capture from `clone/` (`records/main.json`) and from a second worktree of the same commit (`records/old-base.json`) give identical hashes for all 105 tasks.

## Exact commands

```bash
S=/home/whoop/ai-orchestrator/runs/ci-release-test-cache-brief-spikes/scratch/2673833-0/hashes/onepipeline-ui
T=/home/whoop/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/3/worktree/scripts/spike-opnx/task-hashes.mjs
git clone https://github.com/nickderobertis/onepipeline-ui $S/clone && cd $S/clone && bash scripts/workspace-install.sh
# 1. task lists (plans/)
NX_DAEMON=false bash scripts/ci-job.sh test-linux --tier broader --plan            # plans/test-linux-broader.txt (98 tasks)
# in the release-edit worktree rel/ (main + release-plz's edits, committed), affected against main:
NX_DAEMON=false ONEPIPELINE_UI_NX_BASE_SHA=6c669bd7... bash scripts/ci-job.sh <job> --plan   # plans/<job>-affected-release.txt
# every project (superset) for the jobs that have no broader tier:
bash scripts/nx.sh run-many -t <the job's targets from ci-job.sh> --graph=stdout | node scripts/ci-job-tasks.mjs   # plans/<job>-all-projects.txt
node tools/joblist.mjs plans        # plans/tasks.json, plans/all-tasks.txt (105-task union)
# 2. release-plz's own edits (release/)
git clone clone rplz && cd rplz && git fetch --tags   # a standalone clone: release-plz cannot run in a git worktree ('main' is already used by worktree)
echo "// spike probe" >> src/lib.rs && git commit -am "fix: spike probe commit for release-plz update"
git clone clone tag-v0.65.3 && git -C tag-v0.65.3 checkout v0.65.3
release-plz update --config ../release/release-plz.nosemver.toml --registry-manifest-path ../tag-v0.65.3/Cargo.toml \
  --repo-url https://github.com/nickderobertis/onepipeline-ui
git diff > ../release/release-plz-update.diff
# 3. hashes
node $T capture $S/clone $(cat plans/all-tasks.txt) --out $S/records/main.json
node $T capture $S/rel   $(cat plans/all-tasks.txt) --out $S/records/release.json
node $T diff records/main.json records/release.json > records/diff-main-release.txt
bash tools/variants.sh $S/wt-old old   # current definition: base, release, 24 source variants, 3 dependency variants
bash tools/variants.sh $S/wt-new new   # same variants on top of the proposed definition (branch spike-newdef)
node tools/analyze.mjs $S > records/matrix.txt; node tools/cacheable.mjs ...; node tools/tables.mjs $S
# 4. version-reading tests, timed
(cd apps/dag-ui && npx vite build --config vite.config.ts)
cargo nextest run --locked --no-run --test e2e --test packaging                       # timing/build-tests.log (6m26.753s, cold)
cargo nextest run --locked --test e2e --test packaging --status-level all --final-status-level all --no-fail-fast -E '<5 tests>'   # timing/version-tests.log
gh run list -R nickderobertis/onepipeline-ui --workflow ci.yml ...; gh api .../actions/runs/41664459663/jobs; gh run view --job <id> --log   # ci/
```

### Why release-plz needed three adjustments (`release/`)

`main` is itself the v0.65.3 release commit, so there is nothing for release-plz to release. A local probe commit (`fix: ...` appending one comment line to `src/lib.rs`) gives it something; the probe commit is not part of the saved edit diff.

- With no other arguments, release-plz compares against crates.io. crates.io served 0.65.2, not 0.65.3, at measurement time, so it only rewrote the changelog for 0.65.3 ("local version (0.65.3) > registry version (0.65.2)"). Fix: `--registry-manifest-path` pointed at a checkout of tag v0.65.3.
- Its semver check then failed: `failed to build rustdoc for crate onepipeline-ui v0.65.3` with `--features bundled-ui`, because there is no `apps/dag-ui/dist` in its temporary copy. Fix: `release/release-plz.nosemver.toml`, which is the repo's `release-plz.toml` with only `semver_check = true` changed to `false`. That changes how the bump is decided, not the files release-plz writes for a `fix:` (patch) release.
- `--repo-url` was given so the changelog heading carries the compare link, as on GitHub.

The result is `release/release-plz-update.diff`: Cargo.toml `version` 0.65.3 to 0.65.4, the Cargo.lock `onepipeline-ui` entry's `version` 0.65.3 to 0.65.4, and a new 6-line CHANGELOG.md section. The real v0.65.3 commit (`git show 6c669bd`) touches the same three files with the same shape: `CHANGELOG.md | 6 ++++++`, `Cargo.lock | 2 +-`, `Cargo.toml | 2 +-`.

## 1. The task list

`scripts/ci-job.sh` maps each job to its Nx targets:

| job | targets |
|---|---|
| lint | format-check, lint, typecheck, msrv, deps-check |
| test-linux | broader: format-check, lint, typecheck, build, test, test-baseline, test-cost, doc, check, budgets, budgets-host, install-smoke. affected: build, test, test-baseline, test-cost, test-isolation, doc, coverage, budgets, test-ci-jobs, install-smoke, wheel-smoke |
| test-windows | format-check, lint, test-quick, build, install-smoke |
| test-macos | format-check, lint, test-quick, install-smoke |

What a release PR (branch `release-plz-*`) actually runs:

- **test-linux:** `scripts/ci-tier.sh` answers `broader`, so it runs `run-many` over every project: **98 tasks** (`plans/test-linux-broader.txt`, identical in the release-edit worktree).
- **lint and test-windows:** these have only the affected tier. Against the release edit, lint selects **14** tasks and test-windows **17** (`plans/*-affected-release.txt`). So that a future non-release PR is covered too, the table also includes each job's every-project superset: lint 27, test-windows 31, test-macos 27.
- **test-macos:** skipped outright on release-plz branches (`ci.yml`, `if: ... !startsWith(github.head_ref, 'release-plz-')`). Run 41664459663 confirms it: test-macos `skipped`.

The union is **105 tasks**: 58 cacheable, 22 `cache: false`, 25 `nx:noop`. The full task-to-job map is in `records/table-tasks.md` and `plans/tasks.json`. Job labels used below: † = what the release PR's affected selection picks, * = every project (superset), ‡ = test-macos superset (not run on a release PR).

`onepipeline-ui:wheel-smoke` (cache: false) is in test-linux's *affected* tier only, not in the release-PR sweep. It is not in the 105, but it was captured separately: it moves under the release edit (`records/wheel-smoke-*.json`).

## 2. Hashes on main and after release-plz's edits (current definition)

`records/diff-main-release.txt` shows **36 of 105 tasks move**: 20 cacheable, 13 uncached, 3 noop. The other 69 keep their hash.

The inputs that move them come down to three files, reached three ways:

1. **The root project `onepipeline-ui` (root `.`) owns `CHANGELOG.md`, `Cargo.toml` and `Cargo.lock`.** Its `default` = `{projectRoot}/**/*` therefore moves every root target. `dag-ui` implicitly depends on `onepipeline-ui`, and `dag-ui:build` has inputs `["default", "^default"]`, so it moves too. `dag-ui:build-api-server`, `dag-ui:check` and `dag-ui-e2e:check` move through the same node `onepipeline-ui:**/*`.
2. **The `apiServerSurface` named input** (nx.json) lists `{workspaceRoot}/Cargo.toml` and `{workspaceRoot}/Cargo.lock`. Every Rust tier that uses it moves: e2e, npm-launcher, repo-tooling, baseline, cost, linked-report, coverage, dag-ui-e2e:test/test-isolation and the release tier.
3. **Explicit file inputs:**
   - `{workspaceRoot}/CHANGELOG.md` in `onepipeline-ui-release`'s `releaseMachinery`
   - `{workspaceRoot}/Cargo.toml` in `.github/project.json` (github-workflows:lint and :test)
   - `Cargo.toml` and `Cargo.lock` in `github-workflows-judge-install:test`

No fixture holds the crate version. `tests/fixtures/healthz.json` holds the SDK's version, which the release edit does not change. Nothing in `sharedGlobals` is touched.

### Table: every task, main vs release-plz edits (current definition)

| task | job(s) | cacheable | hash on main | hash after release-plz edits | inputs that moved it |
|---|---|---|---|---|---|
| dag-layout:build | test-linux, test-windows* | yes | 7436930124762215168 | 7436930124762215168 | — (same) |
| dag-layout:check | test-linux | noop | 545586582040556923 | 545586582040556923 | — (same) |
| dag-layout:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 11795289264666988629 | 11795289264666988629 | — (same) |
| dag-layout:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 5023590172649886053 | 5023590172649886053 | — (same) |
| dag-layout:test | test-linux | yes | 15740782497861190560 | 15740782497861190560 | — (same) |
| dag-layout:typecheck | lint*, test-linux | yes | 3824118245153910873 | 3824118245153910873 | — (same) |
| dag-model:build | test-linux, test-windows* | yes | 10290769848978150390 | 10290769848978150390 | — (same) |
| dag-model:check | test-linux | noop | 10021952518056988955 | 10021952518056988955 | — (same) |
| dag-model:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 11579224825641191256 | 11579224825641191256 | — (same) |
| dag-model:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 11920314250766873386 | 11920314250766873386 | — (same) |
| dag-model:test | test-linux | yes | 14448500774875392184 | 14448500774875392184 | — (same) |
| dag-model:typecheck | lint*, test-linux | yes | 8998043963212926075 | 8998043963212926075 | — (same) |
| dag-ui-build-cache:check | test-linux | noop | 8183299172947175126 | 8183299172947175126 | — (same) |
| dag-ui-build-cache:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 13414991736004705075 | 13414991736004705075 | — (same) |
| dag-ui-build-cache:test | test-linux | yes | 11455598988270269715 | 11455598988270269715 | — (same) |
| dag-ui-e2e:budgets | test-linux | yes | 10177069996800203106 | 10177069996800203106 | — (same) |
| dag-ui-e2e:check | test-linux | noop | 7899377426627721431 | 1293490607864794127 | `onepipeline-ui:**/*` |
| dag-ui-e2e:format-check | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 2265250298008412286 | 2265250298008412286 | — (same) |
| dag-ui-e2e:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 893763465194598058 | 893763465194598058 | — (same) |
| dag-ui-e2e:test | test-linux | yes | 14020005236606440495 | 17035847752101980664 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| dag-ui-e2e:test-isolation | test-linux | yes | 3202826487270328093 | 16173223174952985417 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| dag-ui-e2e:typecheck | lint†, lint*, test-linux | yes | 1858606452491184033 | 1858606452491184033 | — (same) |
| dag-ui:build | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 1019628406791014360 | 2733025598418686181 | `onepipeline-ui:**/*` |
| dag-ui:build-api-server | test-linux | no | 5125665785380810965 | 7369112527531021208 | `onepipeline-ui:**/*` |
| dag-ui:check | test-linux | noop | 17276465347261994392 | 12320083286244377116 | `onepipeline-ui:**/*` |
| dag-ui:format-check | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 349025515724083304 | 349025515724083304 | — (same) |
| dag-ui:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 5501223171192335905 | 5501223171192335905 | — (same) |
| dag-ui:test | test-linux | yes | 7256076885477157775 | 7256076885477157775 | — (same) |
| dag-ui:typecheck | lint†, lint*, test-linux | yes | 5826401207004319391 | 5826401207004319391 | — (same) |
| docs:check | test-linux | noop | 3724972041303611679 | 3724972041303611679 | — (same) |
| docs:test | test-linux | yes | 13528724522413564082 | 13528724522413564082 | — (same) |
| github-workflows-installs:bootstrap | test-linux | no | 13742409158141067760 | 13742409158141067760 | — (same) |
| github-workflows-installs:check | test-linux | noop | 12462683125658282809 | 12462683125658282809 | — (same) |
| github-workflows-installs:test | test-linux | no | 6496840706015887559 | 6496840706015887559 | — (same) |
| github-workflows-judge-install:bootstrap | test-linux | no | 7778204571837513220 | 7778204571837513220 | — (same) |
| github-workflows-judge-install:check | test-linux | noop | 6064962675551975448 | 6064962675551975448 | — (same) |
| github-workflows-judge-install:test | test-linux | no | 17318972914332539489 | 16838636302518082337 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| github-workflows:bootstrap | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | no | 7344896508971545020 | 7344896508971545020 | — (same) |
| github-workflows:budgets | test-linux | no | 4331763743507738944 | 4331763743507738944 | — (same) |
| github-workflows:check | test-linux | noop | 7370006069187857172 | 7370006069187857172 | — (same) |
| github-workflows:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 15974782157907725349 | 2541035269046236696 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml)` |
| github-workflows:test | test-linux | no | 1080839191794788035 | 2268433856523259826 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml)` |
| github-workflows:test-ci-jobs | test-linux | no | 5517819802463559780 | 5517819802463559780 | — (same) |
| onepipeline-ui-baseline-reuse:check | test-linux | noop | 15396579214611856928 | 15396579214611856928 | — (same) |
| onepipeline-ui-baseline-reuse:test | test-linux | yes | 12702701209399234564 | 12702701209399234564 | — (same) |
| onepipeline-ui-baseline-reuse:test-quick | test-windows*, test-macos‡ | yes | 7865778722086250372 | 7865778722086250372 | — (same) |
| onepipeline-ui-baseline:check | test-linux | noop | 9822515578771856560 | 9822515578771856560 | — (same) |
| onepipeline-ui-baseline:test-baseline | test-linux | yes | 8719356502459912636 | 1784827794337760912 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-ci-jobs:check | test-linux | noop | 5436583673338610728 | 5436583673338610728 | — (same) |
| onepipeline-ui-ci-jobs:test | test-linux | yes | 15011250092720782601 | 15011250092720782601 | — (same) |
| onepipeline-ui-cost:check | test-linux | noop | 3231091825700247039 | 3231091825700247039 | — (same) |
| onepipeline-ui-cost:test-cost | test-linux | yes | 13735046094335569224 | 16194094604732890305 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-coverage:check | test-linux | noop | 13305061854993632759 | 13305061854993632759 | — (same) |
| onepipeline-ui-coverage:coverage | test-linux | no | 2927974484049308487 | 374858285045545743 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-deps-audit-toolchain:check | test-linux | noop | 687344240220703988 | 687344240220703988 | — (same) |
| onepipeline-ui-deps-audit-toolchain:test | test-linux | yes | 9891810768325011161 | 9891810768325011161 | — (same) |
| onepipeline-ui-e2e:check | test-linux | noop | 2814644846060145563 | 2814644846060145563 | — (same) |
| onepipeline-ui-e2e:test | test-linux | yes | 6602071420801223177 | 455599340453473890 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-e2e:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 9847470736865079021 | 7599538253712363882 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-judged-tier:check | test-linux | noop | 8326465605392900964 | 8326465605392900964 | — (same) |
| onepipeline-ui-judged-tier:test | test-linux | yes | 11446108853003875362 | 11446108853003875362 | — (same) |
| onepipeline-ui-linked-report:check | test-linux | noop | 7649018143932709478 | 7649018143932709478 | — (same) |
| onepipeline-ui-linked-report:test | test-linux | yes | 3012223613868532463 | 18110498681776868622 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-npm-launcher:check | test-linux | noop | 6734915839946889967 | 6734915839946889967 | — (same) |
| onepipeline-ui-npm-launcher:test | test-linux | yes | 13497469496617808121 | 9387443880766819124 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-npm-launcher:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 4221989025528876387 | 15247174656984534426 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-release:check | test-linux | noop | 7305003424633497354 | 7305003424633497354 | — (same) |
| onepipeline-ui-release:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 1383363957332679740 | 1383363957332679740 | — (same) |
| onepipeline-ui-release:rehearse | test-linux | yes | 5313669799663871607 | 8393135825279339934 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:test | test-linux | yes | 17426652758645175860 | 15473217720780808333 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:test-staged | test-linux | no | 12384214337353164562 | 10348239031764971248 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:test-standalone | test-linux | no | 15561576450010121211 | 1724925679370564596 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:tools | test-linux | no | 3387442018034029607 | 3387442018034029607 | — (same) |
| onepipeline-ui-repo-tooling:check | test-linux | noop | 3304037748991227285 | 3304037748991227285 | — (same) |
| onepipeline-ui-repo-tooling:test | test-linux | yes | 6300560468403571933 | 11928865251108210732 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-repo-tooling:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 11499616191202248048 | 17072232485453879518 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui:bootstrap | test-linux | no | 18280344006287992565 | 12351366521281636197 | `onepipeline-ui:**/*` |
| onepipeline-ui:check | test-linux | noop | 11040617973428890467 | 2604697008521424999 | `onepipeline-ui:**/*` |
| onepipeline-ui:deps-check | lint†, lint* | no | 4999156657967361049 | 18364654384698860092 | `onepipeline-ui:**/*` |
| onepipeline-ui:doc | test-linux | yes | 15166543465045373884 | 17232020039570498727 | `onepipeline-ui:**/*` |
| onepipeline-ui:ensure-baseline | test-linux | no | 7435748378674697233 | 11191956766764682619 | `onepipeline-ui:**/*` |
| onepipeline-ui:ensure-node-without-execve | test-linux, test-windows†, test-windows*, test-macos‡ | no | 12205443019170251996 | 13521853480128009176 | `onepipeline-ui:**/*` |
| onepipeline-ui:ensure-sibling | test-linux, test-windows†, test-windows*, test-macos‡ | no | 13305295182881897995 | 1049444355992127142 | `onepipeline-ui:**/*` |
| onepipeline-ui:format-check | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 14992594228093443956 | 14529168408210921041 | `onepipeline-ui:**/*` |
| onepipeline-ui:install-smoke | test-linux, test-windows†, test-windows*, test-macos‡ | no | 3458371429410282975 | 16361365969628724033 | `onepipeline-ui:**/*` |
| onepipeline-ui:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 5822675924035497984 | 14475635898233813615 | `onepipeline-ui:**/*` |
| onepipeline-ui:msrv | lint†, lint* | no | 11301935902787033177 | 1561096259047201009 | `onepipeline-ui:**/*` |
| onepipeline-ui:test | test-linux | yes | 796949154427448715 | 67758780338587368 | `onepipeline-ui:**/*` |
| onepipeline-ui:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 7565424268957279482 | 7390571916899287388 | `onepipeline-ui:**/*` |
| pool-maintenance:bootstrap | test-linux | no | 13075375632265625935 | 13075375632265625935 | — (same) |
| pool-maintenance:budgets-host | test-linux | no | 17324687526252100896 | 17324687526252100896 | — (same) |
| pool-maintenance:check | test-linux | noop | 5853565625899650221 | 5853565625899650221 | — (same) |
| pool-maintenance:test | test-linux | yes | 8874381836791811700 | 8874381836791811700 | — (same) |
| telemetry-client:build | test-linux, test-windows* | yes | 4382076967311548102 | 4382076967311548102 | — (same) |
| telemetry-client:check | test-linux | noop | 5796199167934558439 | 5796199167934558439 | — (same) |
| telemetry-client:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 13746964645187185391 | 13746964645187185391 | — (same) |
| telemetry-client:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 1032262003115952501 | 1032262003115952501 | — (same) |
| telemetry-client:test | test-linux | yes | 1341131232330129225 | 1341131232330129225 | — (same) |
| telemetry-client:typecheck | lint*, test-linux | yes | 6790541202175861920 | 6790541202175861920 | — (same) |
| timeline-categories:build | test-linux, test-windows* | yes | 12606743297271791292 | 12606743297271791292 | — (same) |
| timeline-categories:check | test-linux | noop | 14962893359406924818 | 14962893359406924818 | — (same) |
| timeline-categories:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 16777138724215102004 | 16777138724215102004 | — (same) |
| timeline-categories:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 18200265506027560630 | 18200265506027560630 | — (same) |
| timeline-categories:test | test-linux | yes | 7371721558486388342 | 7371721558486388342 | — (same) |
| timeline-categories:typecheck | lint*, test-linux | yes | 14742582606743025417 | 14742582606743025417 | — (same) |

## 3. A sound input definition, recomputed

### The definition

Implemented only on scratch branch `spike-newdef` (worktrees `nd/` and `wt-new/`); full diff in `records/newdef.diff`.

- **`scripts/cargo-manifest-digest.mjs`** (new, node-only). It prints the sha256 of Cargo.toml and Cargo.lock with exactly two lines blanked: `version = "…"` in Cargo.toml's `[package]` table, and the `version` line of Cargo.lock's `[[package]] name = "<that package>"` entry. Every other byte still counts: dependency requirements, features, `rust-version`, `include`, and every third-party lock entry. Further behaviour:
  - It normalises CRLF to LF.
  - `manifest` as the argument digests Cargo.toml alone.
  - If the version line is not where expected (for example `version.workspace = true`), it prints `raw:<sha256 of the unnormalised bytes>` instead. This matters because, as measured, **Nx does not fail a hash when a runtime command exits non-zero**: with a broken version line the capture still exited 0 and produced a hash (`records/probe-broken-manifest.*`). A constant failure output would therefore replay every later edit. The raw-bytes fallback can only over-invalidate.
  - An unreadable file exits 1 with a message. Nx would still hash that output, but a missing Cargo.toml or Cargo.lock fails the build anyway.
- **nx.json:**
  - `"cargoManifests": [{ "runtime": "node scripts/cargo-manifest-digest.mjs" }]`
  - `"cargoManifest": [{ "runtime": "node scripts/cargo-manifest-digest.mjs manifest" }]`
  - `apiServerSurface` lists `cargoManifests` in place of the two Cargo files.
- **project.json (root):** a project-level `default` = `{projectRoot}/**/*`, `!{projectRoot}/CHANGELOG.md`, `!{projectRoot}/Cargo.toml`, `!{projectRoot}/Cargo.lock`, `cargoManifests`, `sharedGlobals`. This also fixes `dag-ui:build`, whose `^default` resolves the root's override.
- **`.github/project.json`:** `{workspaceRoot}/Cargo.toml` becomes `cargoManifest`. It is Cargo.toml-only so that a Cargo.lock bump does not move github-workflows:lint and :test, matching the current definition.
- **`.github/tests/judge-install/project.json`:** Cargo.toml and Cargo.lock become `cargoManifests`.
- **`tests/release/project.json`:** drops `{workspaceRoot}/CHANGELOG.md` from `releaseMachinery`.

**Why dropping CHANGELOG.md is sound.** No test reads its content. The searches in `records/search-1.txt` find:

- the release scripts copying it into archives;
- tests asserting archive *member names* (`.github/tests/release.test.mjs:619,735,798`);
- fixtures writing their own changelog (`tests/release/release-plz.test.mjs`, `.github/tests/histories.mjs`);
- a string in a served payload fixture (`tests/e2e/server.rs:6182`);
- the macOS path classifier treating it as a path (`.github/macos-policy.mjs:129`).

No `include_str!` of it exists (`records/search-3.txt`).

**Cross-platform.** The runtime command is `node scripts/…mjs` with no shell syntax, so it runs the same under cmd, pwsh, Git Bash and sh. It is only measured on Linux here; it was not run on a Windows or macOS runner.

### Results

The variants (`tools/variants.sh`, edit diffs in `records/edits/`) are:

- **release:** release-plz's edit.
- **24 source variants:** one appended line in a file each project's tasks run. Examples: `src/lib.rs` for the crate; the tier's own module (`tests/e2e/cost.rs`, ...) for each Rust tier; `packages/*/src/index.ts`; `apps/dag-ui/src/...`; `.github/workflows/ci.yml`; `tests/release/support.mjs`; and so on.
- **dep-cargo:** Cargo.lock third-party bump, `itoa` 1.0.18 to 1.0.19.
- **dep-cargo-req:** a Cargo.toml dependency requirement, `axum = "0.8"` to `"0.8.1"`.
- **dep-npm:** vite 8.1.5 to 8.1.6 in `apps/dag-ui/package.json` and `bun.lock`.

**Under the proposed definition, all 58 cacheable tasks keep their hash under the release edit.**

The 8 tasks that still move are all uncached (`cache: false`) or `nx:noop`:

- `onepipeline-ui:bootstrap`
- `onepipeline-ui:check` (noop)
- `onepipeline-ui:deps-check`
- `onepipeline-ui:ensure-baseline`
- `onepipeline-ui:ensure-node-without-execve`
- `onepipeline-ui:ensure-sibling`
- `onepipeline-ui:install-smoke`
- `onepipeline-ui:msrv`

They declare no `inputs`, so Nx falls back to the raw `onepipeline-ui:**/*` plus every external npm node. Their hash is never looked up, so this does not matter for the cache. If any of them is made cacheable, it needs explicit inputs. Measured: giving `msrv` and `deps-check` `"inputs": ["default"]` makes both keep their hash under the release edit (`records/probe-uncached-*.json`, `records/edits/uncached-inputs-probe.diff`).

**The new definition loses none of the movement the current one had.** For every task, its own source variant, the Cargo.lock bump, the Cargo.toml requirement change and the npm bump move it under the new definition exactly when they move it under the current one (`records/matrix.txt`, columns new vs old). Specifically:

- **Every Rust task that uses `apiServerSurface` or the root's `default`** (root targets, e2e, npm-launcher, repo-tooling, baseline, cost, linked-report, coverage, release rehearse/test, dag-ui:build, dag-ui-e2e:test/test-isolation, judge-install:test) moves on its own source, on `src/lib.rs`, on the Cargo.lock bump and on the Cargo.toml requirement change. All of them except coverage also move on the npm bump.
- **The JS-only tasks** (packages, dag-ui lint/test/typecheck, docs:test, …) move on their own source and on the npm bump. They do not read Cargo files, before or after.
- **github-workflows:lint and :test** move on Cargo.toml changes and not on Cargo.lock, both before and after.

### Gaps that exist on main today

These are unchanged by this definition and unrelated to the release edit, but they matter for a remote cache. These cacheable tasks compile this crate's test binaries, yet **do not move on a crate-source change (`src/lib.rs`) or a Cargo.lock/Cargo.toml dependency change**:

| task | moves on | does not move on |
|---|---|---|
| `dag-ui-build-cache:test` (`cargo nextest run --test build-cache`) | dag-ui source, npm | src/lib.rs, Cargo.lock, Cargo.toml |
| `dag-ui-build-cache:lint` (`cargo clippy --test build-cache`) | only `tests/build_cache.rs` and its project.json | dag-ui source, src/lib.rs, Cargo.lock, Cargo.toml, npm |
| `onepipeline-ui-baseline-reuse:test`, `:test-quick` | `tests/e2e/baseline_reuse.rs`, npm | src/lib.rs, Cargo.lock, Cargo.toml |
| `onepipeline-ui-ci-jobs:test` | `tests/e2e/ci_jobs.rs`, npm | src/lib.rs, Cargo.lock, Cargo.toml |
| `onepipeline-ui-judged-tier:test` | `tests/e2e/judged_tier.rs`, npm | src/lib.rs, Cargo.lock, Cargo.toml |
| `onepipeline-ui-deps-audit-toolchain:test` | `tests/e2e/deps_audit_toolchain.rs` | src/lib.rs, Cargo.lock, Cargo.toml, npm |

Three of these (baseline-reuse, ci-jobs, judged-tier) drive scripts in scratch workspaces, so their verdict may not depend on the crate's code. But a third-party crate bump such as `assert_cmd` or `tempfile` reaches their test harness. With a remote cache they would replay across such a bump.

Also, `dag-ui-e2e:budgets` did not move on the `apps/dag-ui-e2e/capture-clock.ts` edit. Its inputs are its telemetry outputs, which the hasher cannot see before a run.

The four-state table for the proposed definition follows. Each hash cell is marked `(SAME)` when it equals that task's main hash under the new definition. The source column names the variant used.

| task | cacheable | main | release edits | source change (variant: hash) | Cargo.lock dep bump (itoa 1.0.18→1.0.19) | Cargo.toml dep req (axum 0.8→0.8.1) | npm dep bump (vite 8.1.5→8.1.6) |
|---|---|---|---|---|---|---|---|
| dag-layout:build | yes | 9348647494516668168 | 9348647494516668168 (SAME) | dag-layout: 6696545546083710443 | 9348647494516668168 (SAME) | 9348647494516668168 (SAME) | 1050058491586733583 |
| dag-layout:check | noop | 11400740987570370262 | 11400740987570370262 (SAME) | dag-layout: 13696236643899602168 | 11400740987570370262 (SAME) | 11400740987570370262 (SAME) | 11400740987570370262 (SAME) |
| dag-layout:format-check | yes | 12441223274893376815 | 12441223274893376815 (SAME) | dag-layout: 469318136717972081 | 12441223274893376815 (SAME) | 12441223274893376815 (SAME) | 15673160092214485000 |
| dag-layout:lint | yes | 13491499288857977844 | 13491499288857977844 (SAME) | dag-layout: 6774211607862037658 | 13491499288857977844 (SAME) | 13491499288857977844 (SAME) | 3777794529731024617 |
| dag-layout:test | yes | 10058802463844257440 | 10058802463844257440 (SAME) | dag-layout: 13858942277205476858 | 10058802463844257440 (SAME) | 10058802463844257440 (SAME) | 5758938397092696484 |
| dag-layout:typecheck | yes | 12009325178037663698 | 12009325178037663698 (SAME) | dag-layout: 6836661309206694160 | 12009325178037663698 (SAME) | 12009325178037663698 (SAME) | 18442086447779569820 |
| dag-model:build | yes | 16104351065853275948 | 16104351065853275948 (SAME) | dag-model: 3928148957381948565 | 16104351065853275948 (SAME) | 16104351065853275948 (SAME) | 13359503838005925281 |
| dag-model:check | noop | 9641860565189298451 | 9641860565189298451 (SAME) | dag-model: 8763423067850432964 | 9641860565189298451 (SAME) | 9641860565189298451 (SAME) | 9641860565189298451 (SAME) |
| dag-model:format-check | yes | 10254016275445741489 | 10254016275445741489 (SAME) | dag-model: 10644080037241400381 | 10254016275445741489 (SAME) | 10254016275445741489 (SAME) | 4801315627634012621 |
| dag-model:lint | yes | 15283811125848303098 | 15283811125848303098 (SAME) | dag-model: 7997305486543524402 | 15283811125848303098 (SAME) | 15283811125848303098 (SAME) | 8778938972253066698 |
| dag-model:test | yes | 12386212595458057308 | 12386212595458057308 (SAME) | dag-model: 4921662365920613290 | 12386212595458057308 (SAME) | 12386212595458057308 (SAME) | 6646491917560239152 |
| dag-model:typecheck | yes | 325087497716265352 | 325087497716265352 (SAME) | dag-model: 2519549536438518058 | 325087497716265352 (SAME) | 325087497716265352 (SAME) | 12132666267573254577 |
| dag-ui-build-cache:check | noop | 2581725037935813882 | 2581725037935813882 (SAME) | dag-ui: 2581725037935813882 (SAME)<br>crate: 2581725037935813882 (SAME) | 2581725037935813882 (SAME) | 2581725037935813882 (SAME) | 2581725037935813882 (SAME) |
| dag-ui-build-cache:lint | yes | 12092707093287356535 | 12092707093287356535 (SAME) | dag-ui: 12092707093287356535 (SAME)<br>crate: 12092707093287356535 (SAME) | 12092707093287356535 (SAME) | 12092707093287356535 (SAME) | 12092707093287356535 (SAME) |
| dag-ui-build-cache:test | yes | 5239871128451400928 | 5239871128451400928 (SAME) | dag-ui: 2622746585034893189<br>crate: 5239871128451400928 (SAME) | 5239871128451400928 (SAME) | 5239871128451400928 (SAME) | 15198680272724939466 |
| dag-ui-e2e:budgets | yes | 2446669707329122309 | 2446669707329122309 (SAME) | dag-ui-e2e: 2446669707329122309 (SAME) | 2446669707329122309 (SAME) | 2446669707329122309 (SAME) | 2446669707329122309 (SAME) |
| dag-ui-e2e:check | noop | 7381212745303005973 | 7381212745303005973 (SAME) | dag-ui-e2e: 10696418880234437159 | 14092013789805891471 | 287087901746296091 | 18029459343677842180 |
| dag-ui-e2e:format-check | yes | 3356896798253214689 | 3356896798253214689 (SAME) | dag-ui-e2e: 11864476819879520134 | 3356896798253214689 (SAME) | 3356896798253214689 (SAME) | 4430106029950212188 |
| dag-ui-e2e:lint | yes | 16295887872539460494 | 16295887872539460494 (SAME) | dag-ui-e2e: 327770368767042920 | 16295887872539460494 (SAME) | 16295887872539460494 (SAME) | 16640576422945192247 |
| dag-ui-e2e:test | yes | 18412468364441049088 | 18412468364441049088 (SAME) | dag-ui-e2e: 14087678674558252970 | 9217057496754760573 | 6302994714315144326 | 2506599276890841489 |
| dag-ui-e2e:test-isolation | yes | 356866969742003882 | 356866969742003882 (SAME) | dag-ui-e2e: 12643033184503355697 | 10464702605223112668 | 13170505940173808182 | 1347967239619450853 |
| dag-ui-e2e:typecheck | yes | 13282972190012846638 | 13282972190012846638 (SAME) | dag-ui-e2e: 12630575803367130513 | 13282972190012846638 (SAME) | 13282972190012846638 (SAME) | 2634964655016008837 |
| dag-ui:build | yes | 8201725071074710095 | 8201725071074710095 (SAME) | dag-ui: 14051759953119433757 | 16003036422264302001 | 1456018727354280630 | 17025056481238953383 |
| dag-ui:build-api-server | no | 2578258908166782891 | 2578258908166782891 (SAME) | dag-ui: 1758530826296382518 | 15288099439293726933 | 859693560636319961 | 5762528518367717045 |
| dag-ui:check | noop | 5193184703716624552 | 5193184703716624552 (SAME) | dag-ui: 464938650139437840 | 3140973830358063834 | 2649693565840180338 | 6805033539779044800 |
| dag-ui:format-check | yes | 10009200402067374938 | 10009200402067374938 (SAME) | dag-ui: 7095473758099309983 | 10009200402067374938 (SAME) | 10009200402067374938 (SAME) | 15808643167960776215 |
| dag-ui:lint | yes | 10729317756030744759 | 10729317756030744759 (SAME) | dag-ui: 11040939661405920835 | 10729317756030744759 (SAME) | 10729317756030744759 (SAME) | 1365533449901298482 |
| dag-ui:test | yes | 4494510760669759948 | 4494510760669759948 (SAME) | dag-ui: 860678564083106354 | 4494510760669759948 (SAME) | 4494510760669759948 (SAME) | 16089720269776597672 |
| dag-ui:typecheck | yes | 12147499375762886438 | 12147499375762886438 (SAME) | dag-ui: 12179956947778468464 | 12147499375762886438 (SAME) | 12147499375762886438 (SAME) | 5955390019955952862 |
| docs:check | noop | 12666848539954874171 | 12666848539954874171 (SAME) | docs: 6573296359166556348 | 12666848539954874171 (SAME) | 12666848539954874171 (SAME) | 12666848539954874171 (SAME) |
| docs:test | yes | 5003433762638576203 | 5003433762638576203 (SAME) | docs: 12404018623067535860 | 5003433762638576203 (SAME) | 5003433762638576203 (SAME) | 5246331075887774391 |
| github-workflows-installs:bootstrap | no | 172226400880187404 | 172226400880187404 (SAME) | github-workflows-installs: 5589003404346436865 | 172226400880187404 (SAME) | 172226400880187404 (SAME) | 172226400880187404 (SAME) |
| github-workflows-installs:check | noop | 5586997870931416187 | 5586997870931416187 (SAME) | github-workflows-installs: 9352774229996193754 | 5586997870931416187 (SAME) | 5586997870931416187 (SAME) | 5586997870931416187 (SAME) |
| github-workflows-installs:test | no | 4741261631422376786 | 4741261631422376786 (SAME) | github-workflows-installs: 16078840843265015405 | 4741261631422376786 (SAME) | 4741261631422376786 (SAME) | 13898483972793675481 |
| github-workflows-judge-install:bootstrap | no | 4338579251053061841 | 4338579251053061841 (SAME) | github-workflows-judge-install: 8545942709617997601 | 4338579251053061841 (SAME) | 4338579251053061841 (SAME) | 4338579251053061841 (SAME) |
| github-workflows-judge-install:check | noop | 12168217606558251824 | 12168217606558251824 (SAME) | github-workflows-judge-install: 14537239981701890027 | 12168217606558251824 (SAME) | 12168217606558251824 (SAME) | 12168217606558251824 (SAME) |
| github-workflows-judge-install:test | no | 3633307747683041976 | 3633307747683041976 (SAME) | github-workflows-judge-install: 18046935626451581482 | 8499278854138761325 | 1024706784395345427 | 11002387642716452964 |
| github-workflows:bootstrap | no | 11641778564537201156 | 11641778564537201156 (SAME) | github-workflows: 15054942592847222826 | 11641778564537201156 (SAME) | 11641778564537201156 (SAME) | 11641778564537201156 (SAME) |
| github-workflows:budgets | no | 9042396010063669028 | 9042396010063669028 (SAME) | github-workflows: 12256196681899747465 | 9042396010063669028 (SAME) | 9042396010063669028 (SAME) | 9042396010063669028 (SAME) |
| github-workflows:check | noop | 13986496002994504265 | 13986496002994504265 (SAME) | github-workflows: 17691218140022948589 | 13986496002994504265 (SAME) | 13986496002994504265 (SAME) | 13986496002994504265 (SAME) |
| github-workflows:lint | yes | 18307138877262838443 | 18307138877262838443 (SAME) | github-workflows: 13452414519349523168 | 18307138877262838443 (SAME) | 778965609146146973 | 15127834987968855457 |
| github-workflows:test | no | 17878666440442104780 | 17878666440442104780 (SAME) | github-workflows: 18346227081410508441 | 17878666440442104780 (SAME) | 10217918824113929130 | 3137473981864970725 |
| github-workflows:test-ci-jobs | no | 3135761782384485209 | 3135761782384485209 (SAME) | github-workflows: 12699954303794511588 | 3135761782384485209 (SAME) | 3135761782384485209 (SAME) | 3135761782384485209 (SAME) |
| onepipeline-ui-baseline-reuse:check | noop | 13744528833133650174 | 13744528833133650174 (SAME) | tier-baseline-reuse: 13744528833133650174 (SAME)<br>crate: 13744528833133650174 (SAME) | 13744528833133650174 (SAME) | 13744528833133650174 (SAME) | 13744528833133650174 (SAME) |
| onepipeline-ui-baseline-reuse:test | yes | 14373954091132805072 | 14373954091132805072 (SAME) | tier-baseline-reuse: 1899686180860661350<br>crate: 14373954091132805072 (SAME) | 14373954091132805072 (SAME) | 14373954091132805072 (SAME) | 14549385787561199431 |
| onepipeline-ui-baseline-reuse:test-quick | yes | 9119725294850199246 | 9119725294850199246 (SAME) | tier-baseline-reuse: 5541761822040087107<br>crate: 9119725294850199246 (SAME) | 9119725294850199246 (SAME) | 9119725294850199246 (SAME) | 3998111466435237772 |
| onepipeline-ui-baseline:check | noop | 8819373131174075349 | 8819373131174075349 (SAME) | tier-baseline: 8819373131174075349 (SAME)<br>crate: 8819373131174075349 (SAME) | 8819373131174075349 (SAME) | 8819373131174075349 (SAME) | 8819373131174075349 (SAME) |
| onepipeline-ui-baseline:test-baseline | yes | 11067840359772322645 | 11067840359772322645 (SAME) | tier-baseline: 13768833508613555204<br>crate: 7236389048809338927 | 6175150035721679573 | 9223342258147023967 | 11402374536100826329 |
| onepipeline-ui-ci-jobs:check | noop | 13822082527360650058 | 13822082527360650058 (SAME) | tier-ci-jobs: 13822082527360650058 (SAME)<br>crate: 13822082527360650058 (SAME) | 13822082527360650058 (SAME) | 13822082527360650058 (SAME) | 13822082527360650058 (SAME) |
| onepipeline-ui-ci-jobs:test | yes | 1209382658539446786 | 1209382658539446786 (SAME) | tier-ci-jobs: 3622604605071048520<br>crate: 1209382658539446786 (SAME) | 1209382658539446786 (SAME) | 1209382658539446786 (SAME) | 6056878898882028703 |
| onepipeline-ui-cost:check | noop | 18161316182890670017 | 18161316182890670017 (SAME) | tier-cost: 18161316182890670017 (SAME)<br>crate: 18161316182890670017 (SAME) | 18161316182890670017 (SAME) | 18161316182890670017 (SAME) | 18161316182890670017 (SAME) |
| onepipeline-ui-cost:test-cost | yes | 6467767571916617392 | 6467767571916617392 (SAME) | tier-cost: 12116293471512885371<br>crate: 9732646398473375426 | 16198547599344376069 | 11385507650195143362 | 8495556549110550952 |
| onepipeline-ui-coverage:check | noop | 6701945965479801824 | 6701945965479801824 (SAME) | crate: 6701945965479801824 (SAME) | 6701945965479801824 (SAME) | 6701945965479801824 (SAME) | 6701945965479801824 (SAME) |
| onepipeline-ui-coverage:coverage | no | 7528212486747151075 | 7528212486747151075 (SAME) | crate: 3978118513750733546 | 13375881147420758120 | 6614963365213127872 | 7528212486747151075 (SAME) |
| onepipeline-ui-deps-audit-toolchain:check | noop | 11484908186358759346 | 11484908186358759346 (SAME) | tier-deps-audit-toolchain: 11484908186358759346 (SAME)<br>crate: 11484908186358759346 (SAME) | 11484908186358759346 (SAME) | 11484908186358759346 (SAME) | 11484908186358759346 (SAME) |
| onepipeline-ui-deps-audit-toolchain:test | yes | 5227058285139875202 | 5227058285139875202 (SAME) | tier-deps-audit-toolchain: 7635809104605829774<br>crate: 5227058285139875202 (SAME) | 5227058285139875202 (SAME) | 5227058285139875202 (SAME) | 5227058285139875202 (SAME) |
| onepipeline-ui-e2e:check | noop | 827308762100590338 | 827308762100590338 (SAME) | tier-e2e: 827308762100590338 (SAME)<br>crate: 827308762100590338 (SAME) | 827308762100590338 (SAME) | 827308762100590338 (SAME) | 827308762100590338 (SAME) |
| onepipeline-ui-e2e:test | yes | 2665103021118980575 | 2665103021118980575 (SAME) | tier-e2e: 15977819653716653820<br>crate: 10745644696194587551 | 15282007277229623778 | 929952345374673762 | 16041275523902961994 |
| onepipeline-ui-e2e:test-quick | yes | 11241568102229844745 | 11241568102229844745 (SAME) | tier-e2e: 8077202675747921658<br>crate: 8103956922257941992 | 1069498119044748243 | 14873096842350069412 | 7456181311339350416 |
| onepipeline-ui-judged-tier:check | noop | 15052449802299145297 | 15052449802299145297 (SAME) | tier-judged-tier: 15052449802299145297 (SAME)<br>crate: 15052449802299145297 (SAME) | 15052449802299145297 (SAME) | 15052449802299145297 (SAME) | 15052449802299145297 (SAME) |
| onepipeline-ui-judged-tier:test | yes | 14277430299854444138 | 14277430299854444138 (SAME) | tier-judged-tier: 5782920627660898556<br>crate: 14277430299854444138 (SAME) | 14277430299854444138 (SAME) | 14277430299854444138 (SAME) | 13553785240881910529 |
| onepipeline-ui-linked-report:check | noop | 13042261674208485935 | 13042261674208485935 (SAME) | tier-linked-report: 13042261674208485935 (SAME)<br>crate: 13042261674208485935 (SAME) | 13042261674208485935 (SAME) | 13042261674208485935 (SAME) | 13042261674208485935 (SAME) |
| onepipeline-ui-linked-report:test | yes | 1478552384134195940 | 1478552384134195940 (SAME) | tier-linked-report: 8515717203921212287<br>crate: 17987958846762938002 | 5076089949076045013 | 366657536758401604 | 17860327922142690562 |
| onepipeline-ui-npm-launcher:check | noop | 11175533689428960758 | 11175533689428960758 (SAME) | tier-npm-launcher: 11175533689428960758 (SAME)<br>crate: 11175533689428960758 (SAME) | 11175533689428960758 (SAME) | 11175533689428960758 (SAME) | 11175533689428960758 (SAME) |
| onepipeline-ui-npm-launcher:test | yes | 3128847391232629391 | 3128847391232629391 (SAME) | tier-npm-launcher: 14379812536381973914<br>crate: 592190940771655921 | 11783328323225924990 | 13675350241921123721 | 17769191251698771295 |
| onepipeline-ui-npm-launcher:test-quick | yes | 13959010153748307568 | 13959010153748307568 (SAME) | tier-npm-launcher: 997003530014289257<br>crate: 7436834218024240085 | 12626375333945969754 | 15008894318852498221 | 10148576755911899470 |
| onepipeline-ui-release:check | noop | 3557085866496236919 | 3557085866496236919 (SAME) | release: 8691158547448551567<br>crate: 3557085866496236919 (SAME) | 3557085866496236919 (SAME) | 3557085866496236919 (SAME) | 862990873733198566 |
| onepipeline-ui-release:lint | yes | 11972466615289296572 | 11972466615289296572 (SAME) | release: 7902247991234671906<br>crate: 11972466615289296572 (SAME) | 11972466615289296572 (SAME) | 11972466615289296572 (SAME) | 14788568326978824998 |
| onepipeline-ui-release:rehearse | yes | 4272109762225229169 | 4272109762225229169 (SAME) | release: 11604554672389576055<br>crate: 7023403426435123080 | 15938456310539775616 | 5127971625828814628 | 1821610387652276625 |
| onepipeline-ui-release:test | yes | 16287439453622853361 | 16287439453622853361 (SAME) | release: 4970339642532171040<br>crate: 10470258624596430168 | 7800415175128981152 | 16429199307885063557 | 11300930772058727198 |
| onepipeline-ui-release:test-staged | no | 15265566372198682592 | 15265566372198682592 (SAME) | release: 6804158731891973114<br>crate: 7722036088508141882 | 17502881395198644980 | 17948303861676768447 | 11274832219820020224 |
| onepipeline-ui-release:test-standalone | no | 2458889731113163387 | 2458889731113163387 (SAME) | release: 3752308173853828744<br>crate: 8747274974130525225 | 9052898698797200702 | 18203780511323705210 | 16818441497477203165 |
| onepipeline-ui-release:tools | no | 16647493030854059101 | 16647493030854059101 (SAME) | release: 597951881752156122<br>crate: 16647493030854059101 (SAME) | 16647493030854059101 (SAME) | 16647493030854059101 (SAME) | 3867209615837368531 |
| onepipeline-ui-repo-tooling:check | noop | 8063171327652552096 | 8063171327652552096 (SAME) | tier-repo-tooling: 8063171327652552096 (SAME)<br>crate: 8063171327652552096 (SAME) | 8063171327652552096 (SAME) | 8063171327652552096 (SAME) | 8063171327652552096 (SAME) |
| onepipeline-ui-repo-tooling:test | yes | 11216751219890493717 | 11216751219890493717 (SAME) | tier-repo-tooling: 14701703538763769353<br>crate: 6602365522191711629 | 3738589832281383811 | 6703733263212142356 | 5791135220666359100 |
| onepipeline-ui-repo-tooling:test-quick | yes | 427934683856606811 | 427934683856606811 (SAME) | tier-repo-tooling: 14340406370882213732<br>crate: 15787727880459353945 | 2777193454472552213 | 8320062209202618064 | 3165665479062693684 |
| onepipeline-ui:bootstrap | no | 16331571958516243460 | 11604730974886342477 | crate: 8020362759907746451 | 13414747927702408826 | 13261194329772897378 | 8563114293979009807 |
| onepipeline-ui:check | noop | 12898654535091318846 | 13034109638236109485 | crate: 586040958461535727 | 453657815777658310 | 9081755129248475878 | 11379555609220116237 |
| onepipeline-ui:deps-check | no | 13180949393946986141 | 6521862190771314100 | crate: 16944282935026669301 | 3736168512087016465 | 6426361999679646142 | 15136511476234442267 |
| onepipeline-ui:doc | yes | 13033971105540837159 | 13033971105540837159 (SAME) | crate: 5649032082103654566 | 5013586688578670280 | 13300572452270012891 | 10486576808276721714 |
| onepipeline-ui:ensure-baseline | no | 2874805259343014477 | 3254280205894412295 | crate: 11603773275039400562 | 7254390809256342321 | 17886236125690437216 | 13705299265159225853 |
| onepipeline-ui:ensure-node-without-execve | no | 9411776061805321434 | 13489210810662947204 | crate: 867950065103732052 | 6169700656533903928 | 14822261016174698738 | 8580185787965305902 |
| onepipeline-ui:ensure-sibling | no | 10225773775691186052 | 360387599805980207 | crate: 716234407044320509 | 6766300495684907768 | 16472887810880137933 | 15043185714479238458 |
| onepipeline-ui:format-check | yes | 17177841401397326637 | 17177841401397326637 (SAME) | crate: 11055518764993714416 | 14905109525832388601 | 13105055074654551935 | 8285718268268335813 |
| onepipeline-ui:install-smoke | no | 12970972168333736022 | 6543543233301235239 | crate: 15387904822217813792 | 4032111517401253523 | 12577793851739191937 | 15651049226796154015 |
| onepipeline-ui:lint | yes | 8119669928875169677 | 8119669928875169677 (SAME) | crate: 12150564340715133801 | 7879512318952274067 | 1152859766125332997 | 10917080798367396613 |
| onepipeline-ui:msrv | no | 11105640063702396906 | 11108852284170463557 | crate: 8408994313933461632 | 6007977750007321493 | 13058547637792247264 | 17047678577956185139 |
| onepipeline-ui:test | yes | 17104477225402576587 | 17104477225402576587 (SAME) | crate: 14335544212292156960 | 6880708898145569634 | 15012939954058286952 | 8367697568451728019 |
| onepipeline-ui:test-quick | yes | 16973649587516376771 | 16973649587516376771 (SAME) | crate: 3402124257345202493 | 17772104553220687737 | 14555685458579926009 | 18134420796691140362 |
| pool-maintenance:bootstrap | no | 14268913210643943814 | 14268913210643943814 (SAME) | pool-maintenance: 3579953258570732580 | 14268913210643943814 (SAME) | 14268913210643943814 (SAME) | 14268913210643943814 (SAME) |
| pool-maintenance:budgets-host | no | 11422172484247164876 | 11422172484247164876 (SAME) | pool-maintenance: 3710638299099841602 | 11422172484247164876 (SAME) | 11422172484247164876 (SAME) | 11422172484247164876 (SAME) |
| pool-maintenance:check | noop | 7179141918635180394 | 7179141918635180394 (SAME) | pool-maintenance: 1371326754719844219 | 7179141918635180394 (SAME) | 7179141918635180394 (SAME) | 7179141918635180394 (SAME) |
| pool-maintenance:test | yes | 7973653103099999099 | 7973653103099999099 (SAME) | pool-maintenance: 15504809517965862833 | 7973653103099999099 (SAME) | 7973653103099999099 (SAME) | 7973653103099999099 (SAME) |
| telemetry-client:build | yes | 18092967244732802642 | 18092967244732802642 (SAME) | telemetry-client: 1223642794795877877 | 18092967244732802642 (SAME) | 18092967244732802642 (SAME) | 6175874399016935155 |
| telemetry-client:check | noop | 11750885736784260376 | 11750885736784260376 (SAME) | telemetry-client: 6729258236605726817 | 11750885736784260376 (SAME) | 11750885736784260376 (SAME) | 3138039579441788 |
| telemetry-client:format-check | yes | 1255343614732159662 | 1255343614732159662 (SAME) | telemetry-client: 1164180877961873844 | 1255343614732159662 (SAME) | 1255343614732159662 (SAME) | 3298834356103127684 |
| telemetry-client:lint | yes | 11173319451729024798 | 11173319451729024798 (SAME) | telemetry-client: 4812975801221255045 | 11173319451729024798 (SAME) | 11173319451729024798 (SAME) | 7296649277004243515 |
| telemetry-client:test | yes | 18334590074079792706 | 18334590074079792706 (SAME) | telemetry-client: 4109419306705591061 | 18334590074079792706 (SAME) | 18334590074079792706 (SAME) | 14176069312846280400 |
| telemetry-client:typecheck | yes | 12109705714926631987 | 12109705714926631987 (SAME) | telemetry-client: 7294646635777914858 | 12109705714926631987 (SAME) | 12109705714926631987 (SAME) | 18021235991291403675 |
| timeline-categories:build | yes | 14874194170455358128 | 14874194170455358128 (SAME) | timeline-categories: 17457642495907578560 | 14874194170455358128 (SAME) | 14874194170455358128 (SAME) | 11504315649545967130 |
| timeline-categories:check | noop | 12371247024442461862 | 12371247024442461862 (SAME) | timeline-categories: 2536245288455916068 | 12371247024442461862 (SAME) | 12371247024442461862 (SAME) | 12371247024442461862 (SAME) |
| timeline-categories:format-check | yes | 16180507433517094926 | 16180507433517094926 (SAME) | timeline-categories: 9495385223077735506 | 16180507433517094926 (SAME) | 16180507433517094926 (SAME) | 13801149049007459720 |
| timeline-categories:lint | yes | 11385253144199786404 | 11385253144199786404 (SAME) | timeline-categories: 15904664185607697040 | 11385253144199786404 (SAME) | 11385253144199786404 (SAME) | 8647289330357746252 |
| timeline-categories:test | yes | 14511304227588298296 | 14511304227588298296 (SAME) | timeline-categories: 4103298556068632493 | 14511304227588298296 (SAME) | 14511304227588298296 (SAME) | 14553132748321841396 |
| timeline-categories:typecheck | yes | 3225729321477192135 | 3225729321477192135 (SAME) | timeline-categories: 17751053495934355941 | 3225729321477192135 (SAME) | 3225729321477192135 (SAME) | 14678214638445927122 |

## 4. Tests that read the package version

### Searches run (outputs in `records/search-*.txt`)

```bash
git grep -n -E 'CARGO_PKG_VERSION|env!\("CARGO_PKG'
git grep -n -E 'CHANGELOG' -- tests src scripts .github apps packages npm
git grep -n "a_build_without_the_bundle" -- tests
git grep -n -E '"Cargo\.toml"|Cargo\.toml'"'" -- tests .github/tests pool-maintenance judged-diff docs apps packages
git grep -n -E 'include_str!|include_bytes!' -- src build.rs tests | grep -i -E 'changelog|cargo\.toml'      # none
git grep -n -E 'CARGO_PKG_VERSION|PKG_VERSION|\[package\]' -- build.rs scripts .github/tests npm apps packages pool-maintenance docs ':!*.md'
git grep -n -E -- '--version' -- tests .github/tests | grep -i -E 'onepipeline-api|COMMAND|binary'
git grep -n -E 'pyproject' -- tests .github/tests
git grep -n -E 'RELEASE_TAG|npm-build|readFileSync\(.*Cargo' -- '.github/tests/*.mjs' '.github/tests/**/*.mjs'
git grep -n -E 'npm-build|release\.mjs' -- 'tests/*.rs' 'tests/e2e/*.rs'
grep -o -E 'version\(\)|\bVERSION\b|\bTAG\b|rehearsal\.mjs|RELEASE_TAG' tests/release/*.test.mjs
```

Two scripts read this crate's version from Cargo.toml `[package]`: `scripts/release.mjs` (`cargoVersion()`, line 190) and `scripts/npm-build.mjs` (line 111). `src/error.rs:29` compiles `env!("CARGO_PKG_VERSION")` into an error message the binary serves. No test asserts a literal version of this crate. The fixtures that carry versions (`1.0.0` in `.github/tests/*`, `healthz.json`'s SDK version) are not this crate's version.

### Every test whose result reads the version

The tests below read the version and use it consistently with itself. The compile-time `CARGO_PKG_VERSION` or the runtime Cargo.toml `[package]` version is compared against, or used to locate, artefacts built from the same tree. So for any valid `X.Y.Z` the verdict is the same, and a patch bump does not change what they prove. The release tier is different: what it does is rehearse building and publishing *this version*.

| test (file :: name) | Nx target(s) | how it uses the version | local targeted run |
|---|---|---|---|
| `tests/e2e/cli.rs :: cli::version_reports_the_crate_version` | `onepipeline-ui-e2e:test` (Linux), `:test-quick` (Windows, macOS) | `--version` output contains `env!("CARGO_PKG_VERSION")` | 0.090 s |
| `tests/e2e/server.rs :: server::browser_supervision_is_removed_and_shutdown_is_host_only` | same | the served error message (from `src/error.rs:29`) contains `CARGO_PKG_VERSION` | 0.939 s |
| `tests/e2e/ui.rs :: ui::a_build_without_the_bundle_refuses_ui_naming_what_is_missing` | same | locates `target/.../package/onepipeline-ui-<CARGO_PKG_VERSION>` after a `cargo package`, then builds and runs it | 140.681 s (the no-bundle build compiled from cold) |
| `tests/e2e/packaging.rs :: packaging::the_launcher_runs_the_binary_its_platform_package_carries` | `onepipeline-ui-npm-launcher:test`, `:test-quick` | the launcher's output contains `CARGO_PKG_VERSION`. Every journey in this module packs through `npm-build.mjs`, which stamps the Cargo.toml version, but only this one asserts it | 1.222 s |
| `tests/packaging.rs :: the_assembled_launcher_pins_every_platform_package_to_the_crate_version` | `onepipeline-ui-repo-tooling:test`, `:test-quick` | `npm-build.mjs`'s manifest `version` equals `CARGO_PKG_VERSION` | 0.233 s |
| `.github/tests/release.test.mjs :: "a release tag that is not Cargo.toml's version is refused before anything builds"` | `github-workflows:test` (cache: false) | `release.mjs` compares `RELEASE_TAG=v0.0.1-not-this` against Cargo.toml's version and must refuse. Invariant for any `X.Y.Z` | 0.290 s (CI, run 41664459663) |
| `tests/release/journeys.test.mjs` (all 6 tests) | `onepipeline-ui-release:rehearse` (cacheable) | `VERSION`/`TAG` from `rehearsal.mjs` = Cargo.toml version. Builds and stamps the archive, wheel, npm and SBOM for it | CI only, see below |
| `tests/release/rehearsal-failures.test.mjs`, `registries.test.mjs` (13 tests) | `onepipeline-ui-release:test-staged` (cache: false) | `TAG`/`VERSION` of the staged rehearsal | CI only |
| `tests/release/probe.test.mjs`, `staging.test.mjs`, `publication.test.mjs`, `sbom.test.mjs` | `onepipeline-ui-release:test-standalone` (cache: false) | `version()` / `VERSION` / `RELEASE_TAG: v${version()}` (`support.mjs:287`) | CI only |
| `tests/release/check.test.mjs`, `npm-upload.test.mjs` | `onepipeline-ui-release:test` (cacheable) | `version()` / `VERSION` | CI only |

Not version-reading in the release tier: `doubles.test.mjs`, `plan.test.mjs`, `release-plz.test.mjs`, `tools.test.mjs`. `release-plz.test.mjs` reads the real Cargo.toml only to build a scratch repo of its own.

**Local timing.** The five Rust tests were run together as one targeted nextest run in `clone/` (`timing/version-tests.log`): Summary 140.693 s, 5 passed, after a 6m26.753s cold compile of the two test binaries. They do not need the sibling CLI. **CI per-test times for Rust tiers are not observable**: the nextest profiles print failures only, so the local figure is the only per-test one. The `ui::` figure is host-local and includes a cold compile of the separate no-bundle target. Its CI share of the e2e tier was not measured.

### Whole-target times from CI

These come from the release PR's CI run **41664459663** (branch `release-plz-2026-11-03T04-56-55Z`, head `f121c77`, conclusion success). Logs are in `ci/`. The figures are the test runners' own totals, which exclude compilation; Nx prints no per-task wall time.

| target | runner total | tests |
|---|---|---|
| `onepipeline-ui-e2e:test` (Linux) | nextest Summary 203.104 s | 331 |
| `onepipeline-ui-e2e:test-quick` (Windows) | 277.491 s | 263 |
| `onepipeline-ui-npm-launcher:test` (Linux) | 31.188 s | 25 |
| `onepipeline-ui-npm-launcher:test-quick` (Windows) | 11.094 s | 12 |
| `onepipeline-ui-repo-tooling:test` (Linux) | 477.893 s | 232 |
| `onepipeline-ui-repo-tooling:test-quick` (Windows) | 374.889 s | 130 |
| `onepipeline-ui:test` (Linux) | 6.044 s | 81 |
| `github-workflows:test` | node `duration_ms` 115079.818876 | — |
| `onepipeline-ui-release:rehearse` | `duration_ms` 511173.23482 | 6, all version-reading |
| `onepipeline-ui-release:test-staged` | 178435.17734 | 13, all version-reading |
| `onepipeline-ui-release:test-standalone` | 415862.202581 | 38 |
| `onepipeline-ui-release:test` | 118431.597287 | 27 |

The split of the last two by test file uses node's per-test `✔ … (ms)` lines (`ci/release-*.toplevel.tsv`, `ci/release-*.split.txt`, `tools/release-split.mjs`):

- **test-standalone:** top-level tests sum to 327.022 s. Of that, 12.024 s is the files that do not read the version (doubles 4.471, plan 5.323, release-plz 2.230), leaving **314.998 s** for the version-reading ones.
- **test:** top-level 118.256 s, of which tools.test.mjs is 6.777 s, leaving **111.479 s** version-reading.

Job wall times in that run:

| job | job wall time | its gate step |
|---|---|---|
| test-linux | 15:29:47–15:49:49 | 15:32:41–15:49:46 |
| test-windows | 15:29:47–15:43:38 | 15:33:44–15:43:34 |
| lint | 15:29:46–15:43:45 | — |

test-macos was skipped.

### What would still re-run on a release PR if version-reading tests keep the version as an input

Assume the proposed definition, plus the version added back as an input of every target holding a test above. Then:

- **test-linux (sweep):** `onepipeline-ui-e2e:test`, `onepipeline-ui-npm-launcher:test`, `onepipeline-ui-repo-tooling:test`, `onepipeline-ui-release:rehearse`, `onepipeline-ui-release:test`.
- **Uncached today, so they re-run whatever the key:** `onepipeline-ui-release:test-staged`, `onepipeline-ui-release:test-standalone`, `github-workflows:test`.
- **test-windows (affected):** `onepipeline-ui-e2e:test-quick`, `onepipeline-ui-npm-launcher:test-quick`, `onepipeline-ui-repo-tooling:test-quick`.
- **test-macos:** nothing, because it is skipped on release-plz branches.
- **Always, independent of any key:** every `cache: false` task in the jobs, 22 of the 105:
  - `dag-ui:build-api-server`
  - `github-workflows{,-installs,-judge-install}:{bootstrap,test}`
  - `github-workflows:{budgets,test-ci-jobs}`
  - `onepipeline-ui-coverage:coverage`
  - `onepipeline-ui-release:{test-staged,test-standalone,tools}`
  - `onepipeline-ui:{bootstrap,deps-check,ensure-baseline,ensure-node-without-execve,ensure-sibling,install-smoke,msrv}`
  - `pool-maintenance:{bootstrap,budgets-host}`

  Plus `onepipeline-ui:wheel-smoke` on the affected tier.

**Separate compile cost.** `CARGO_PKG_VERSION` is compiled into the crate (`src/error.rs:29`), so a version bump makes cargo rebuild the crate and every test binary whatever Nx's key says. A cache hit skips that rebuild only because the task does not run at all.

### Is moving them into a separate cached target worth it?

- **repo-tooling: yes.** One 0.233 s test holds a target whose runner total is 477.893 s on Linux and 374.889 s on Windows. That is the largest Rust tier and the one on test-linux's critical path in earlier measurements.
- **e2e: yes for `cli::` and `server::`** (0.090 s and 0.939 s against 203.104 s on Linux and 277.491 s on Windows). For `ui::a_build_without_the_bundle…`, the version is only a directory name. Globbing `target/.../package/onepipeline-ui-*` instead would stop it reading the version at all. It is the expensive one locally (140.681 s), so it should not be kept on a version-keyed target.
- **npm-launcher: marginal.** 1.222 s out of 31.188 s on Linux and 11.094 s on Windows. Every launcher journey packs a version-stamped package, but only one asserts the version.
- **release tier: no split possible.** Of its 1223.902 s of CI runner time (the four `duration_ms` totals), 1116.085 s is in version-reading tests:
  - rehearse 511.173 s
  - test-standalone version files 314.998 s
  - test-staged 178.435 s
  - test version files 111.479 s

  Only 18.801 s is in test files that do not read the version. The remaining 89.016 s is runner time no top-level test accounts for. The tier *is* the version's release rehearsal, and `release.yml` re-runs no tests, so the release PR is the last place that rehearsal runs for the shipping version. Keeping the version in its key costs that one tier on each release PR. Dropping it would replay a rehearsal made for the previous version.
- **The self-referential tests are version-invariant**, comparing `CARGO_PKG_VERSION` with what the same tree builds. The alternative to splitting is to accept the version-blind key for them as sound. Only the release tier then needs the version, and that can be done by adding `{ "runtime": "node -e …print the [package] version…" }` or the raw `{workspaceRoot}/Cargo.toml` back to `releaseMachinery` alone.

## Files

- `plans/`: the job plans, `tasks.json` (task to jobs) and `all-tasks.txt`.
- `release/`: `release-plz-update.diff` (release-plz's edit) and `release-plz.nosemver.toml`.
- `records/main.json`, `records/release.json`, `records/diff-main-release.txt`: part 2.
- `records/old-*.json`, `records/new-*.json`: every variant under the current and proposed definitions. `records/edits/*.diff` holds each variant's exact edit. `records/matrix.{json,txt}` and `records/table-*.md` hold the tables.
- `records/newdef.diff`: the proposed definition, including the digest script.
- `records/probe-*`: the failing-runtime and uncached-inputs probes.
- `records/cacheable.json`: each task's resolved cache flag.
- `records/search-*.txt`: the search commands and their outputs.
- `timing/`: local build and targeted test logs.
- `ci/`: the run's jobs JSON, the cleaned test-linux and test-windows logs, and the release-tier splits.
- `tools/`: the scripts used (joblist, variants, analyze, cacheable, tables, release-split).
- Worktrees: `clone/` (main), `rel/` (release edit), `nd/` (proposed definition), `wt-old/` and `wt-new/` (variant scratch), `rplz/` and `tag-v0.65.3/` (release-plz run).
