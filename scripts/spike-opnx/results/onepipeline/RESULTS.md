# Nx task hashes under release-plz's edits: github.com/nickderobertis/onepipeline

Plan `ci-release-test-cache`, spike `spike-opnx-audit`. Every path below is relative to
`/home/whoop/ai-orchestrator/runs/ci-release-test-cache-brief-spikes/scratch/2673833-0/hashes/onepipeline/`.

- **Commit measured:** `origin/main` = `5612c253f07f2d7139b1b3188bf4b2068a4a1e5e`
  (`feat(deps)!: link the onetaskgraph release that lands section links on their headings (#1385)`),
  cloned 2026-11-03 into `clone/`.
- **Nx:** 23.1.3 (from the workspace's `node_modules`, installed with `npm ci`; this repository's
  `package.json` names no `packageManager` and commits `package-lock.json`, and `scripts/nx.sh`
  installs with `npm ci`, so npm, not bun, is this repo's installer).
- **Hasher:** `/home/whoop/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/3/worktree/scripts/spike-opnx/task-hashes.mjs`, unmodified.
  Every capture below deletes the workspace's `.nx/workspace-data` first (`tools/cap.sh`,
  `tools/states.sh`): see "Measurement hazards".

## Directory

| Path | What |
|---|---|
| `clone/` | `origin/main` clone (+ `node_modules`), the "main" state |
| `release/` | a second clone at the same commit after `release-plz update` |
| `var/` | a third clone used for single-file variants and the local test timings |
| `def/` | a fourth clone; branch `def` = the version-blind definition, branch `strict` = version-strict |
| `plan.txt` | `ci-job.sh <job> --plan` output for the four jobs |
| `tasks.txt` | the 80 distinct tasks |
| `projects/*.json` | `nx show project <p> --json` for every project in the list; `summary.txt` its targets/cache/inputs/dependsOn |
| `main.json`, `release.json` | captures on main and after release-plz's edits |
| `only-{Cargo.toml,Cargo.lock,CHANGELOG.md}.json` | captures with one of the three release edits applied alone |
| `diff-main-release.txt`, `diff-main-only-*.txt` | `task-hashes.mjs diff` output |
| `release-plz-update.diff` | the exact edits `release-plz update` made |
| `table-main-release.md` | section 2's table |
| `def-blind.diff`, `def-strict.diff` | the input definitions (diff against main, and strict against blind) |
| `tools/nx-cargo-inputs.mjs` | the runtime-input script the definitions use |
| `states-{current,blind,strict}/` | captures for base / release / own-source / dependency states under each definition |
| `matrix-{current,blind,strict}.md`, `summary-{current,blind,strict}.txt` | per-task tables and summaries of those states |
| `lintllm-{main,release}.json` | the lint job's `lint-llm-diff` task, which is outside `ci-job.sh` |
| `gh/` | GitHub reads (run list, job lists, three job logs with ANSI stripped) |
| `tests-run/` | local test runs (TAP output, wall times) |
| `tools/` | scripts written for this spike (`cap.sh`, `states.sh`, `table.mjs`, `matrix.mjs`, `summ.mjs`, `apply-def.mjs`, `tap.mjs`, `enclosing.mjs`) |

## Commands

```
S=/home/whoop/ai-orchestrator/runs/ci-release-test-cache-brief-spikes/scratch/2673833-0/hashes/onepipeline
T=/home/whoop/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/3/worktree/scripts/spike-opnx/task-hashes.mjs
git clone https://github.com/nickderobertis/onepipeline $S/clone; git -C $S/clone rev-parse origin/main
(cd $S/clone && npm ci --silent --no-audit --no-fund)
# the task list: no base => nx-affected.sh fails closed to run-many over every project (the broadest selection)
for j in lint test-linux test-windows test-macos; do (cd $S/clone && CI=1 env -u GITHUB_BASE_REF bash scripts/ci-job.sh $j --plan); done > $S/plan.txt
# main
tools/cap.sh $S/clone $S/main.json            # = rm -rf .nx/workspace-data; node $T capture <ws> $(cat tasks.txt) --out <file>
# release-plz's own edits (needs a branch with an upstream, so a plain clone, not a worktree)
git clone $S/clone $S/release; cd $S/release; git remote set-url origin https://github.com/nickderobertis/onepipeline
git fetch origin; git branch -u origin/main; ~/.cargo/bin/release-plz update     # release-plz 0.3.167
git diff > $S/release-plz-update.diff; cp -a $S/clone/node_modules $S/release/
tools/cap.sh $S/release $S/release.json; node $T diff main.json release.json > diff-main-release.txt
# each edit alone, in var/
git apply --include=<file> release-plz-update.diff; tools/cap.sh ...; git checkout -- .
# definitions
node tools/apply-def.mjs $S/def            # branch def   (version-blind)
node tools/apply-def.mjs $S/def --strict   # branch strict (on top of def)
tools/states.sh $S/var $S/states-current; tools/states.sh $S/def $S/states-blind   # (def at branch def)
git -C def checkout strict; tools/states.sh $S/def $S/states-strict
node tools/matrix.mjs states-<x> > matrix-<x>.md; node tools/summ.mjs matrix-<x>.md > summary-<x>.txt
```

`release-plz update` ran successfully (it read crates.io and ran cargo-semver-checks):
`onepipeline: 0.98.4 -> 0.99.0 (✓ API compatible changes)`. Its edits are exactly three files, the same
three files and shapes as the last release commit on main (`3526b14 chore: release v0.98.4`, `git show --stat`:
`CHANGELOG.md | 6 ++++++`, `Cargo.lock | 2 +-`, `Cargo.toml | 2 +-`):

```
CHANGELOG.md: + "## [0.99.0](…compare/v0.98.4...v0.99.0) - 2026-11-03" section (6 lines)
Cargo.lock:   [[package]] name = "onepipeline"  version = "0.98.4" -> "0.99.0"
Cargo.toml:   [package]   name = "onepipeline"  version = "0.98.4" -> "0.99.0"
```

`git grep -F 0.98.4` on main finds the version only in those three files (no fixture, no `package.json`,
no `pyproject.toml` — that file takes the version dynamically from Cargo.toml).

## 1. The task list

`scripts/ci-job.sh` maps each job to Nx targets (`lint`: `format-check,lint,syntax-check,deps-check`;
`test-linux`: `test,doc,budgets,test-ci-shape,msrv,smoke,release-compat,install-smoke,install-documented,wheel-smoke`;
`test-windows`/`test-macos`: `lint,test-quick,test-launcher,install-smoke,install-documented`) and runs them via
`scripts/nx-affected.sh`, which falls back to `run-many` over every project when no base can be derived. The
script has no tier flag; `--plan` prints the selection. With `CI=1` and no base, the plans are
(`plan.txt`): lint 42 tasks, test-linux 30, test-windows 30, test-macos 30 — **80 distinct tasks** across 20 projects,
including the `dependsOn` tasks `ci-job-tasks.mjs` reads off the graph (`onepipeline:coverage-clean`,
`test-archive`, `test-quick-archive`, `build`, `human-items-e2e:build`, `onepipeline-stop-verdict:test-build`).
63 of the 80 are `cache: true`; 17 are uncached (`cache: false`, or unset for `github-workflows:syntax-check`).

What a real release PR selected: the v0.98.4 release PR's run (`gh/jobs-41636311031.json`, run 41636311031,
head branch `release-plz-2026-11-03T12-30-29Z`) ran test-linux with 27 tasks (6,628 s job) and test-windows with
27 tasks (10,081 s job); test-macos is skipped on release-plz's own PRs by its `if:`. `release-pr-shortcut.mjs`
declined to skip that run: `release-pr-shortcut: CHANGELOG.md adds lines other than one new section above its releases`
(`gh/log-125918287670.txt` line 447).

Not in `ci-job.sh` but run by the `lint` job: `just lint-llm-diff origin/main` (task
`onepipeline-lint-llm:lint-llm-diff`, cached, inputs `{workspaceRoot}/**/*` + env + `runtime: llmlint fingerprint`).
Its hash moves on the release edits (`lintllm-*.json`: `1779011156939172531 -> 267296043405506862`, input
`workspace:[{workspaceRoot}/**/*]`). It judges the diff itself, so the release edits are a real input to it;
it is not a candidate and is not counted below. The visual-docs capture in the lint job is also outside
`ci-job.sh` and was not measured.

## 2. Hashes on main and after release-plz's edits (current definitions)

60 of 80 tasks move; **45 of the 63 cached tasks move**. "Moved by" names which of the three edits moves the
task when applied alone (`only-*.json`), then the Nx input node(s) that changed (long `workspace:[…]` keys are
truncated; full keys are in the JSON). Nx does **not** propagate a `dependsOn` task's hash into its dependent:
under CHANGELOG.md alone `onepipeline:test-archive` moves while `onepipeline-e2e:test`, which depends on it,
does not.

Summary of attribution: Cargo.toml moves 60 tasks, Cargo.lock 59 (all but `github-workflows:test`, which lists
Cargo.toml and not Cargo.lock), CHANGELOG.md 7 — all 7 uncached root-project tasks whose inputs are the root
project's `{projectRoot}/**/*` (the whole repository) plus `onepipeline-npm:test-launcher`, which reaches it
through `^default`. No cached task is moved by CHANGELOG.md.

*(Filled in by the spike worker after the helper agent stopped; figures from the files named.)*

| task | job(s) | cached | hash on main | hash after | moved by |
|---|---|---|---|---|---|
| github-workflows:budgets | test-linux | no | 12039634930678655397 | same |  |
| github-workflows:format-check | lint | yes | 3254805829226285583 | same |  |
| github-workflows:lint | lint, test-windows, test-macos | yes | 10265482886050019201 | same |  |
| github-workflows:syntax-check | lint | no | 16134224378533554714 | same |  |
| github-workflows:test | test-linux | no | 7659407474482958457 | 11792200447599940031 | Cargo.toml via workspace:[{workspaceRoot}/screencomp.to…(676 chars) |
| github-workflows:test-ci-shape | test-linux | yes | 4465815609861067364 | same |  |
| human-items-e2e:build | test-linux | yes | 11620948590520845818 | 3446056440216474559 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(500 chars) |
| human-items-e2e:format-check | lint | yes | 9302475284427338226 | 2671487568599631280 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(435 chars) |
| human-items-e2e:lint | lint, test-windows, test-macos | yes | 12813380205225354093 | 8497352974320478650 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(500 chars) |
| human-items-e2e:test | test-linux | no | 16264750709659969603 | 10878521411253697806 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(500 chars) |
| onepipeline-ci-jobs:format-check | lint | yes | 11751611219594916062 | same |  |
| onepipeline-ci-jobs:lint | lint, test-windows, test-macos | yes | 17595494961048883364 | same |  |
| onepipeline-ci-jobs:test | test-linux | yes | 4527609036938410826 | same |  |
| onepipeline-codex-server:format-check | lint | yes | 928200194573633369 | 13751625098696987749 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/tests/codex_s…(582 chars) |
| onepipeline-codex-server:lint | lint, test-windows, test-macos | yes | 7224905412381895270 | 8538730031916887779 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/tests/codex_s…(582 chars) |
| onepipeline-codex-server:test | test-linux | yes | 2557659825525663327 | 17422267670194295923 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/tests/codex_s…(582 chars) |
| onepipeline-codex-server:test-quick | test-windows, test-macos | yes | 2579590271932203824 | 18347851124544718669 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/tests/codex_s…(582 chars) |
| onepipeline-contract:format-check | lint | yes | 3855225613576896467 | 7793600701233519642 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(865 chars) |
| onepipeline-contract:lint | lint, test-windows, test-macos | yes | 11420602888624203667 | 1203419041265708399 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(865 chars) |
| onepipeline-contract:test | test-linux | yes | 18384474338480633967 | 7555870370123762928 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(865 chars) |
| onepipeline-contract:test-quick | test-windows, test-macos | yes | 6383853458452530183 | 8270842312878105297 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(865 chars) |
| onepipeline-e2e:format-check | lint | yes | 11208049783469677691 | 6446421976477292938 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(771 chars) |
| onepipeline-e2e:lint | lint, test-windows, test-macos | yes | 4131117319254488770 | 441824243082385504 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(771 chars) |
| onepipeline-e2e:test | test-linux | yes | 4212914001956249921 | 9768534474492776176 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(771 chars) |
| onepipeline-e2e:test-quick | test-windows, test-macos | yes | 3991717885311327911 | 9921352268672253315 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(771 chars) |
| onepipeline-journal-workload:format-check | lint | yes | 16010079569953480836 | 12008835172666707421 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(584 chars) |
| onepipeline-journal-workload:lint | lint, test-windows, test-macos | yes | 11202726324330170005 | 8104185552551532411 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(584 chars) |
| onepipeline-llmlint-diff:format-check | lint | yes | 6010283721761157714 | same |  |
| onepipeline-llmlint-diff:lint | lint, test-windows, test-macos | yes | 6173141264682588370 | same |  |
| onepipeline-llmlint-diff:test | test-linux | yes | 10813795474699781959 | same |  |
| onepipeline-note-journeys:format-check | lint | yes | 16602830788914139942 | 11373004162176676281 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(551 chars) |
| onepipeline-note-journeys:lint | lint, test-windows, test-macos | yes | 785127102978577204 | 511133259965848114 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(551 chars) |
| onepipeline-note-journeys:test | test-linux | yes | 2708386633785434822 | 6659876163654280164 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(551 chars) |
| onepipeline-note-journeys:test-quick | test-windows, test-macos | yes | 17182851267905053952 | 8086098094518927480 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(551 chars) |
| onepipeline-npm:format-check | lint | yes | 2060195159870174135 | same |  |
| onepipeline-npm:lint | lint, test-windows, test-macos | yes | 17038905940326288087 | same |  |
| onepipeline-npm:test | test-linux | yes | 2249812045367106217 | 3384956678298096548 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/scripts/npm-b…(1205 chars) |
| onepipeline-npm:test-launcher | test-windows, test-macos | no | 2691686366583292550 | 9572488300425998857 | Cargo.toml + Cargo.lock + CHANGELOG.md via onepipeline:**/* |
| onepipeline-pool-workload:format-check | lint | yes | 13084884625023318491 | 9351304433922104128 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(560 chars) |
| onepipeline-pool-workload:lint | lint, test-windows, test-macos | yes | 5380248219623887397 | 17986030911573744366 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(560 chars) |
| onepipeline-pooled-slot:format-check | lint | yes | 6738699867214642232 | 11639164368006322023 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(768 chars) |
| onepipeline-pooled-slot:lint | lint, test-windows, test-macos | yes | 1160018287807757543 | 1488590017329868349 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(768 chars) |
| onepipeline-pooled-slot:test | test-linux | yes | 9861835295423312630 | 1031263993042995250 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(768 chars) |
| onepipeline-pooled-slot:test-quick | test-windows, test-macos | yes | 6845176983648639873 | 6831063960737819551 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(768 chars) |
| onepipeline-real-smoke:format-check | lint | yes | 3468825923284137280 | 17086189008392795549 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(593 chars) |
| onepipeline-real-smoke:lint | lint, test-windows, test-macos | yes | 11871287750506374464 | 9438412605009255946 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(593 chars) |
| onepipeline-real-smoke:smoke | test-linux | no | 10365458063745850409 | 2843606235379257787 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(593 chars) |
| onepipeline-release-compat:format-check | lint | yes | 8588450068302773532 | 11393621159786278405 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(644 chars) |
| onepipeline-release-compat:lint | lint, test-windows, test-macos | yes | 3634277466282394304 | 14353282683481387091 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(644 chars) |
| onepipeline-release-compat:release-compat | test-linux | no | 7830533513230402931 | 7602590246255872792 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(644 chars) |
| onepipeline-release-journeys:format-check | lint | yes | 4435860469243614188 | same |  |
| onepipeline-release-journeys:lint | lint, test-windows, test-macos | yes | 2529502796551734431 | same |  |
| onepipeline-release:format-check | lint | yes | 7217800315779142710 | same |  |
| onepipeline-release:lint | lint, test-windows, test-macos | yes | 58835217871473145 | same |  |
| onepipeline-release:test | test-linux | no | 17873618261132088420 | 6258041909815160559 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/.github/workf…(723 chars) |
| onepipeline-scratch-workload:format-check | lint | yes | 15321291137720937234 | 17037915865358344274 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(584 chars) |
| onepipeline-scratch-workload:lint | lint, test-windows, test-macos | yes | 8294916612739128992 | 781415288228166668 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(584 chars) |
| onepipeline-stop-verdict:format-check | lint | yes | 1374012258523029264 | 10957275138958143818 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(543 chars) |
| onepipeline-stop-verdict:lint | lint, test-windows, test-macos | yes | 3687745416684106822 | 9276243349739409463 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(543 chars) |
| onepipeline-stop-verdict:test | test-linux | yes | 15181628818341906727 | 4512568410254602527 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(660 chars) |
| onepipeline-stop-verdict:test-build | test-linux | yes | 17596261025788417598 | 950022064057130650 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(660 chars) |
| onepipeline:budgets | test-linux | no | 14042599729120893019 | 5832117399738359200 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(1277 chars) |
| onepipeline:build | test-linux | yes | 11691563651390401890 | 12471983885619230657 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(605 chars) |
| onepipeline:coverage-clean | test-linux | no | 9649597300578094594 | 10386979482933379603 | Cargo.toml + Cargo.lock + CHANGELOG.md via onepipeline:**/* |
| onepipeline:deps-check | lint | no | 8448711846923329135 | 13603454396535885238 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(393 chars) |
| onepipeline:doc | test-linux | yes | 15204209792036385729 | 1325807421664879886 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(605 chars) |
| onepipeline:format-check | lint | yes | 15180511963917060098 | 2236898876557591579 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(605 chars) |
| onepipeline:install-documented | test-linux, test-windows, test-macos | no | 10674160099904811353 | 222283181443969329 | Cargo.toml + Cargo.lock + CHANGELOG.md via onepipeline:**/* |
| onepipeline:install-smoke | test-linux, test-windows, test-macos | no | 2378621302626873875 | 17815858423401208850 | Cargo.toml + Cargo.lock + CHANGELOG.md via onepipeline:**/* |
| onepipeline:lint | lint, test-windows, test-macos | yes | 5952525637999605049 | 2663229499920563890 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(605 chars) |
| onepipeline:msrv | test-linux | no | 8751172795986907176 | 7440858313008113624 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(605 chars) |
| onepipeline:test | test-linux | yes | 8004973741017644298 | 2243424649456621336 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(4897 chars) |
| onepipeline:test-archive | test-linux | no | 8447759258733162810 | 302607795501685125 | Cargo.toml + Cargo.lock + CHANGELOG.md via onepipeline:**/* |
| onepipeline:test-quick | test-windows, test-macos | yes | 344557774736531324 | 8353563698980414743 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(1415 chars) |
| onepipeline:test-quick-archive | test-windows, test-macos | no | 12765914685426362592 | 17896658199256416162 | Cargo.toml + Cargo.lock + CHANGELOG.md via onepipeline:**/* |
| onepipeline:test-rest | test-linux | yes | 10726109506385162373 | 67790842385914811 | Cargo.toml + Cargo.lock via workspace:[{workspaceRoot}/src/**/*,{wor…(1415 chars) |
| onepipeline:wheel-smoke | test-linux | no | 5773123789235316589 | 1199615695198970703 | Cargo.toml + Cargo.lock + CHANGELOG.md via onepipeline:**/* |
| pool-maintenance:format-check | lint | yes | 14449281146270791026 | same |  |
| pool-maintenance:lint | lint, test-windows, test-macos | yes | 8723751160372624488 | same |  |
| pool-maintenance:test | test-linux | yes | 3400706089091820993 | same |  |


## 3. A sound input definition, recomputed

### What has to change

The only release-edit lines that reach cached tasks are the `version` of `[package]` in Cargo.toml and the
`version` of the `onepipeline` `[[package]]` in Cargo.lock. They reach the tasks through:

- the named inputs `rustBuild` (used by every Rust project, directly or via `crateSource`, `crateTestSource`,
  `e2eSource`, `contractSource`, `noteJourneySource`, `smokeSource`, `poolWorkloadSource`,
  `releaseCompatSource`, `pooledSlotSource`), `visualDocsSource` and `codexServerSource`, each listing
  `{workspaceRoot}/Cargo.toml` and `{workspaceRoot}/Cargo.lock`;
- project-level inputs: `npm/project.json` (`test`, `build`), `.github/project.json` (`test`),
  `release/project.json` (`test`);
- the root project's `default` = `{projectRoot}/**/*` = the whole repository (CHANGELOG.md too) for its
  input-less targets, and through `^default` for `onepipeline-npm:test-launcher`. All of these are uncached today.

`sharedGlobals` (`nx.json`, `package.json`, `package-lock.json`, `justfile`) is untouched by the release edits.

### The definition ("version-blind", branch `def`, `def-blind.diff`)

1. `scripts/nx-cargo-inputs.mjs` (`tools/nx-cargo-inputs.mjs`): prints a SHA-256 over Cargo.toml without the
   `version` key of its `[package]` table and Cargo.lock without the `version` line of every `[[package]]`
   entry that has no `source` (path packages = the workspace members `onepipeline` and `onepipeline-testfakes`;
   a member's own manifest is already a file input via `crates/**/*`). CRLF is normalised. `--version` prints
   the `[package]` version alone. Node only, no shell features, so the same command runs under cmd.exe, pwsh,
   Git Bash and sh; **not executed on Windows or macOS in this spike** (Linux only).
   On main and on the release edits the digest is identical:
   `e7ff28d5a11ae25d09903744f0ec3f6694887c5a48c7a798cc4ce7c9f6af516b`; `--version` gives `0.98.4` / `0.99.0`.
2. Every `{workspaceRoot}/Cargo.toml` / `{workspaceRoot}/Cargo.lock` pair in `nx.json` namedInputs and in
   `npm/`, `.github/`, `release/` `project.json` inputs replaced by `{ "runtime": "node scripts/nx-cargo-inputs.mjs" }`.
3. Root `project.json`: `namedInputs.default = ["{projectRoot}/**/*", "!{projectRoot}/CHANGELOG.md",
   "!{projectRoot}/Cargo.toml", "!{projectRoot}/Cargo.lock", {runtime}, "sharedGlobals"]`, **and** every root
   target with no `inputs` given `["default", "^default"]` explicitly. Measured on Nx 23.1.3: with the override
   alone, the root's input-less targets still hashed `onepipeline:**/*` (nx.json's `default`) for their own files
   while `onepipeline-npm:test-launcher`'s `^default` already used the override (`onepipeline:**/*,!CHANGELOG.md,!Cargo.toml,!Cargo.lock`);
   naming the inputs made the override apply.

The "version-strict" variant (branch `strict`, `def-strict.diff`) adds
`{ "runtime": "node scripts/nx-cargo-inputs.mjs --version" }` to the targets that hold a version-reading test
(section 4): `onepipeline:test-rest`, `onepipeline:test-quick`, `onepipeline-contract:test`/`test-quick`,
`onepipeline-e2e:test`/`test-quick`, `onepipeline-npm:test`, `github-workflows:test`, `onepipeline-release:test`.

### The states

- **release**: `release-plz-update.diff` applied.
- **src (own project)**: `\n// spike source change\n` appended to one file of the task's own project
  (`own-files.txt`: e.g. `src/lib.rs` for the root, `tests/contract.rs` for `onepipeline-contract`, whose root
  holds only `project.json`, `npm/onepipeline-cli/bin/onepipeline.js` for `onepipeline-npm`); each project captured
  separately, only its own tasks.
- **dep Cargo.lock**: `itoa` `1.0.18 -> 1.0.19` and its checksum's first character changed in Cargo.lock.
- **dep Cargo.toml**: `windows-sys = "0.61"` -> `"0.61.2"` in `[workspace.dependencies]`.
- **dep npm**: `node_modules/yaml` `2.9.0 -> 2.9.1` in package-lock.json.

### Results

| definition | release moves | own-source moves | Cargo.lock dep moves | Cargo.toml dep moves | npm dep moves |
|---|---|---|---|---|---|
| current (main) | 60 / 80 (45 of 63 cached) | 80 / 80 | 59 / 80 | 60 / 80 | 77 / 80 |
| version-blind | **0 / 80** | 80 / 80 | 60 / 80 | 60 / 80 | 77 / 80 |
| version-strict | 9 / 80 (7 cached + 2 uncached) | 80 / 80 | 60 / 80 | 60 / 80 | 77 / 80 |

The tasks no Cargo dependency change moves are the same 20 under all three definitions (the JS/workflow
projects: `github-workflows:*` except `test`, `onepipeline-ci-jobs:*`, `onepipeline-llmlint-diff:*`,
`onepipeline-npm:format-check`/`lint`, `onepipeline-release-journeys:*`, `onepipeline-release:format-check`/`lint`,
`pool-maintenance:*`), plus `github-workflows:test` under the current definition only (it lists Cargo.toml but
not Cargo.lock; the runtime digest covers both). None of them builds Rust. The three tasks no npm change moves
(`github-workflows:budgets`, `github-workflows:syntax-check`, `github-workflows:test-ci-shape`) are moved by no
dependency change under any definition: their inputs are `.github/**/*` (+ `screencomp.toml`) only — a
pre-existing property, unaffected by release edits; `test-ci-shape` is the only cached one, and its command is
`node --test .github/ci-shape/*.test.mjs`.

Version-strict moves on release: `github-workflows:test` (uncached), `onepipeline-contract:test`,
`onepipeline-contract:test-quick`, `onepipeline-e2e:test`, `onepipeline-e2e:test-quick`, `onepipeline-npm:test`,
`onepipeline-release:test` (uncached), `onepipeline:test-quick`, `onepipeline:test-rest`.

Version-blind, every task, four states (hash on the definition's own base, then the state's hash or `same`):

*(Filled in by the spike worker after the helper agent stopped; figures from the files named.)*

| task | job(s) | cached | base hash | release | src (own project) | dep Cargo.lock | dep Cargo.toml | dep npm lock |
|---|---|---|---|---|---|---|---|---|
| github-workflows:budgets | test-linux | no | 16675430571774729234 | same | moved 8643259943865347118 | same | same | same |
| github-workflows:format-check | lint | yes | 13994209195421118901 | same | moved 2377601635572567093 | same | same | moved 5852420143625279172 |
| github-workflows:lint | lint, test-windows, test-macos | yes | 7193883326915447865 | same | moved 3512754917157019510 | same | same | moved 3213303343852578548 |
| github-workflows:syntax-check | lint | no | 3025860510575588383 | same | moved 3271805578220792254 | same | same | same |
| github-workflows:test | test-linux | no | 17740304239815832454 | same | moved 7763486853212823663 | moved 16720191313619533186 | moved 4698037631581683375 | moved 765491506621917904 |
| github-workflows:test-ci-shape | test-linux | yes | 17539101256416210584 | same | moved 1674786766042874690 | same | same | same |
| human-items-e2e:build | test-linux | yes | 9744525887342686444 | same | moved 17620601476223831559 | moved 13216498407271595821 | moved 8960885621974939558 | moved 2230037792269609861 |
| human-items-e2e:format-check | lint | yes | 3671219903836672199 | same | moved 18193475665410035461 | moved 572938638446970452 | moved 12618429780733485815 | moved 17203876354559795073 |
| human-items-e2e:lint | lint, test-windows, test-macos | yes | 13667490311048304813 | same | moved 8991491176510671019 | moved 16948512981403942805 | moved 5991896818765251410 | moved 16031377170743983624 |
| human-items-e2e:test | test-linux | no | 16803800580771009749 | same | moved 4687217618081770290 | moved 18201404122653408505 | moved 4269827331636682202 | moved 16580488346639408481 |
| onepipeline-ci-jobs:format-check | lint | yes | 2760971776154294983 | same | moved 1719386429433897573 | same | same | moved 2813713356632815809 |
| onepipeline-ci-jobs:lint | lint, test-windows, test-macos | yes | 8708183046261683126 | same | moved 18154661172059447364 | same | same | moved 9442499748109290552 |
| onepipeline-ci-jobs:test | test-linux | yes | 571453666316856660 | same | moved 7494258771016864514 | same | same | moved 9976763748439857493 |
| onepipeline-codex-server:format-check | lint | yes | 3367757992548633755 | same | moved 9908136082299160326 | moved 11376742102281325982 | moved 14858274807568828928 | moved 12692453351685689812 |
| onepipeline-codex-server:lint | lint, test-windows, test-macos | yes | 2785346057396864092 | same | moved 11908220031731424691 | moved 14023486441749807556 | moved 2394062503170381183 | moved 12812937112251779603 |
| onepipeline-codex-server:test | test-linux | yes | 2109612658235635309 | same | moved 1619542440433903446 | moved 8985714966363883687 | moved 4788801013502568 | moved 17454375921007810534 |
| onepipeline-codex-server:test-quick | test-windows, test-macos | yes | 2266402600960719666 | same | moved 13427152027408693863 | moved 13938031854215351264 | moved 3877309627127878049 | moved 15539699461275851207 |
| onepipeline-contract:format-check | lint | yes | 18385648706389348624 | same | moved 6480702422532003995 | moved 11797571248659089626 | moved 8606135088634058576 | moved 12638786477762965801 |
| onepipeline-contract:lint | lint, test-windows, test-macos | yes | 4222736043408239041 | same | moved 439918616204732690 | moved 3663827211937321923 | moved 12085361193431858770 | moved 3546054054198351590 |
| onepipeline-contract:test | test-linux | yes | 9423986630714288186 | same | moved 3958840300042438809 | moved 10883354739666245434 | moved 17399086315368531839 | moved 5310647063366220508 |
| onepipeline-contract:test-quick | test-windows, test-macos | yes | 5946499284669038864 | same | moved 15254602020390599358 | moved 2463567706463529823 | moved 14093040258835941829 | moved 18383808930955592150 |
| onepipeline-e2e:format-check | lint | yes | 6430217831296578719 | same | moved 103511461711378545 | moved 15443570352106198938 | moved 2836575267332709407 | moved 6104684965009172828 |
| onepipeline-e2e:lint | lint, test-windows, test-macos | yes | 13035215136683558478 | same | moved 14871361529157866029 | moved 879508238277694246 | moved 549841886601478337 | moved 4360416669810846817 |
| onepipeline-e2e:test | test-linux | yes | 8346663512037318500 | same | moved 8207073977388749742 | moved 10807416267428074959 | moved 11713832974990530764 | moved 12460789777960577549 |
| onepipeline-e2e:test-quick | test-windows, test-macos | yes | 1792204477493962727 | same | moved 4922314409772853334 | moved 8333005530252015460 | moved 14931459829560513572 | moved 13387424012298986409 |
| onepipeline-journal-workload:format-check | lint | yes | 12000164412256970729 | same | moved 515694763932832762 | moved 5708015154536804854 | moved 11398941712139281306 | moved 8949659871599816652 |
| onepipeline-journal-workload:lint | lint, test-windows, test-macos | yes | 1565558340631304258 | same | moved 6316180268768974718 | moved 5933930509607344049 | moved 645748442664332621 | moved 10846378235458652437 |
| onepipeline-llmlint-diff:format-check | lint | yes | 2440236132106987694 | same | moved 6896604558709811197 | same | same | moved 16208977703284608761 |
| onepipeline-llmlint-diff:lint | lint, test-windows, test-macos | yes | 8280466631396740965 | same | moved 17080459542538434260 | same | same | moved 6098860215587238202 |
| onepipeline-llmlint-diff:test | test-linux | yes | 8666271800648897912 | same | moved 4482686717967019987 | same | same | moved 1313431726089466033 |
| onepipeline-note-journeys:format-check | lint | yes | 14404050443644023610 | same | moved 4511036202654753629 | moved 7368607414328390005 | moved 16547061400832172591 | moved 2103088792110236992 |
| onepipeline-note-journeys:lint | lint, test-windows, test-macos | yes | 18399164196194805840 | same | moved 3267170290922351236 | moved 7334219113468304261 | moved 17066172058676182231 | moved 11403648845958630560 |
| onepipeline-note-journeys:test | test-linux | yes | 8631002450534725014 | same | moved 8168159772374522639 | moved 10671611217290539763 | moved 15539200162107244495 | moved 8516748070937330409 |
| onepipeline-note-journeys:test-quick | test-windows, test-macos | yes | 8721358434661691658 | same | moved 8774351580860849054 | moved 7435641895301023202 | moved 4919798829553168400 | moved 15108860291203396485 |
| onepipeline-npm:format-check | lint | yes | 15636867765899222787 | same | moved 18199336880912109346 | same | same | moved 14378232638209705374 |
| onepipeline-npm:lint | lint, test-windows, test-macos | yes | 11894958825785729130 | same | moved 13582501160328590973 | same | same | moved 9332407463686733628 |
| onepipeline-npm:test | test-linux | yes | 18349463151757401380 | same | moved 2115579287740946015 | moved 11330796518650691242 | moved 16435571959633785481 | moved 3417592335069601417 |
| onepipeline-npm:test-launcher | test-windows, test-macos | no | 13573966654766160363 | same | moved 17334600217763391780 | moved 3854566585444279593 | moved 5477416911037237625 | moved 5949232481814475308 |
| onepipeline-pool-workload:format-check | lint | yes | 4547367210802506077 | same | moved 1273508479367792943 | moved 182907583103168216 | moved 4908638664491650036 | moved 11424082233613278364 |
| onepipeline-pool-workload:lint | lint, test-windows, test-macos | yes | 7525387393042350776 | same | moved 8889236666917259637 | moved 16840684447677736298 | moved 15863779553553137064 | moved 16203971516602066074 |
| onepipeline-pooled-slot:format-check | lint | yes | 459743216592379259 | same | moved 16770272290029208186 | moved 10631674004440664516 | moved 7824832273119100155 | moved 13893801000306025305 |
| onepipeline-pooled-slot:lint | lint, test-windows, test-macos | yes | 2900606477284511639 | same | moved 17138105884901403979 | moved 1183657971442153994 | moved 11237905552091156729 | moved 3786914859875451581 |
| onepipeline-pooled-slot:test | test-linux | yes | 4959506611949502155 | same | moved 6738932436144322058 | moved 16407852806394381706 | moved 3857916367686968098 | moved 10812664963831308352 |
| onepipeline-pooled-slot:test-quick | test-windows, test-macos | yes | 17359759380446845493 | same | moved 16759660975460309865 | moved 9455936971362462567 | moved 9008112284756513386 | moved 3894709871335153084 |
| onepipeline-real-smoke:format-check | lint | yes | 13178754600765007875 | same | moved 11466219843311511358 | moved 18071267150181579746 | moved 3933741894005095522 | moved 7084611157402661493 |
| onepipeline-real-smoke:lint | lint, test-windows, test-macos | yes | 17002608724681770817 | same | moved 98287642584756517 | moved 12670193003522505078 | moved 12609442456015130886 | moved 10225009724763537580 |
| onepipeline-real-smoke:smoke | test-linux | no | 14833661974488746895 | same | moved 1851444733329367666 | moved 12856443855574156686 | moved 12194882563543665851 | moved 11236884237069855014 |
| onepipeline-release-compat:format-check | lint | yes | 2954509055996623023 | same | moved 11112788592219814964 | moved 8764729544215994901 | moved 3449028281154719384 | moved 8348283352284910644 |
| onepipeline-release-compat:lint | lint, test-windows, test-macos | yes | 6505072681019995183 | same | moved 16883701757781539897 | moved 4762072840222039891 | moved 15381090620701514193 | moved 11912944727101070061 |
| onepipeline-release-compat:release-compat | test-linux | no | 15939351302604472068 | same | moved 7829020989236908959 | moved 16278358830598350444 | moved 12388474615358101249 | moved 14850311749386085278 |
| onepipeline-release-journeys:format-check | lint | yes | 2409455427663523160 | same | moved 7462376346483244586 | same | same | moved 10291760995222147082 |
| onepipeline-release-journeys:lint | lint, test-windows, test-macos | yes | 8507652883686983227 | same | moved 4961347141525212974 | same | same | moved 16388916444872343172 |
| onepipeline-release:format-check | lint | yes | 1249332349956884347 | same | moved 15686685623475277523 | same | same | moved 5810146267308525671 |
| onepipeline-release:lint | lint, test-windows, test-macos | yes | 12170379867055799369 | same | moved 5638768270286148943 | same | same | moved 6881577944018448724 |
| onepipeline-release:test | test-linux | no | 11131288119185899318 | same | moved 17157460620402316277 | moved 8319913045051583282 | moved 5810962435665143134 | moved 7244737914202729389 |
| onepipeline-scratch-workload:format-check | lint | yes | 8789221847453024811 | same | moved 3638334885658420135 | moved 16168035023038242461 | moved 13924239017347704758 | moved 3092824401434416423 |
| onepipeline-scratch-workload:lint | lint, test-windows, test-macos | yes | 14175489724706690155 | same | moved 10916094608752848772 | moved 17248459493890568687 | moved 17480622843549159440 | moved 15059877849895149648 |
| onepipeline-stop-verdict:format-check | lint | yes | 16850828328663513163 | same | moved 2378051155803118650 | moved 5592228299683405968 | moved 5815069675616164171 | moved 1809128449433009320 |
| onepipeline-stop-verdict:lint | lint, test-windows, test-macos | yes | 16314255907579739834 | same | moved 14000545820930457500 | moved 6184912770427933647 | moved 5989411241565127317 | moved 9332161472979715696 |
| onepipeline-stop-verdict:test | test-linux | yes | 13874421218978026782 | same | moved 12095093192076770953 | moved 1934978383963181986 | moved 488951508001768452 | moved 6509482852647687626 |
| onepipeline-stop-verdict:test-build | test-linux | yes | 6006368937733190668 | same | moved 8340113020475132334 | moved 5611260256617342099 | moved 9570131133542342753 | moved 6225536740228849598 |
| onepipeline:budgets | test-linux | no | 3225000104456077699 | same | moved 9902471446764416118 | moved 1516799909026552584 | moved 7658715295897939008 | moved 2904346715483422406 |
| onepipeline:build | test-linux | yes | 5025347185531182069 | same | moved 6968738652483103647 | moved 7290882254120651738 | moved 5103769646725582860 | moved 14335735302370905235 |
| onepipeline:coverage-clean | test-linux | no | 15732966715359011338 | same | moved 17646822148270686434 | moved 17047261984613288948 | moved 14026431073852586377 | moved 294568610599196494 |
| onepipeline:deps-check | lint | no | 10443131920802301190 | same | moved 6787486971417227119 | moved 17136222357612419572 | moved 18102481698059046351 | moved 14455250069605136494 |
| onepipeline:doc | test-linux | yes | 405336412645497082 | same | moved 4442789321336624383 | moved 9740446659351282403 | moved 3938162022825919713 | moved 13929637198276681569 |
| onepipeline:format-check | lint | yes | 2905617934213064665 | same | moved 2012309355336814916 | moved 683760373349033710 | moved 13986862049251689877 | moved 5556786320621266594 |
| onepipeline:install-documented | test-linux, test-windows, test-macos | no | 5531135034285373387 | same | moved 6072971408622507746 | moved 5437769368537009190 | moved 11807909719095604099 | moved 15084667346132344789 |
| onepipeline:install-smoke | test-linux, test-windows, test-macos | no | 10148984121544157646 | same | moved 17898632507173246864 | moved 939379444864092968 | moved 8956386109422540757 | moved 3767270866669994281 |
| onepipeline:lint | lint, test-windows, test-macos | yes | 227455061163658523 | same | moved 10139486438341902317 | moved 2828337943129858942 | moved 6737692828783450260 | moved 6646992105208184297 |
| onepipeline:msrv | test-linux | no | 11279398165087363368 | same | moved 12571847732018859303 | moved 3551779555066402723 | moved 16660487372653137019 | moved 2172845693222022808 |
| onepipeline:test | test-linux | yes | 6975331938049275805 | same | moved 1998700771548506135 | moved 18004673406126295185 | moved 4624931951366102308 | moved 1421643949568080329 |
| onepipeline:test-archive | test-linux | no | 11778413774973793671 | same | moved 15113770530237696896 | moved 12068268588439569053 | moved 8178301495029286883 | moved 91050889754507027 |
| onepipeline:test-quick | test-windows, test-macos | yes | 5723395696378576672 | same | moved 6398069912232276664 | moved 10827376367249306330 | moved 9732939781344107699 | moved 3405000585113806965 |
| onepipeline:test-quick-archive | test-windows, test-macos | no | 7219380067787587886 | same | moved 15139177178760027129 | moved 6487931068446495309 | moved 17079221015687358941 | moved 9476241804725068920 |
| onepipeline:test-rest | test-linux | yes | 6579765278985701521 | same | moved 10612821193671247092 | moved 12697284745296779895 | moved 10752056880300408782 | moved 6705653831646489824 |
| onepipeline:wheel-smoke | test-linux | no | 1261388984749912277 | same | moved 505132892991046418 | moved 436974040051369913 | moved 7232317871425640130 | moved 13126985101692419010 |
| pool-maintenance:format-check | lint | yes | 10253422695771826200 | same | moved 5522965199076442982 | same | same | moved 5899813501870844251 |
| pool-maintenance:lint | lint, test-windows, test-macos | yes | 1268262286161854447 | same | moved 7989847468366217630 | same | same | moved 13013260496974843114 |
| pool-maintenance:test | test-linux | yes | 5782206006611345066 | same | moved 8578538476029105864 | same | same | moved 9264156224506523254 |


(`matrix-current.md` and `matrix-strict.md` hold the same table for the other two definitions.)

### What implementing it would break in the repository's own tests

Tests in this repo read the input definitions, so the change is not config-only:

- `scripts/stop-guard-unpublished-budget.test.mjs` › "the fingerprint and the producing tier's Nx inputs name one
  set of files": **executed** — passes on main, fails on the version-blind branch with
  `TypeError: input.replace is not a function` (it maps every input as a string; `tests-run/stop-guard-*.txt`).
  It also requires `Cargo.toml` and `Cargo.lock` to appear among `onepipeline-stop-verdict:test`'s inputs, to match
  `scripts/stop-guard-unpublished-build-inputs.json`.
- `tests/linux_wheel.rs` › `the_wheel_check_is_gated_on_inputs_carrying_what_its_build_reads`: asserts that
  `onepipeline:test-rest`'s expanded string inputs carry `Cargo.toml` and `Cargo.lock` (non-string entries are
  skipped). Not executed in this spike (read only); by reading, it would fail under the version-blind definition, because the runtime input replaces the two string entries it looks for.
- `npm/test/workspace-nx.test.mjs` › "the Rust targets' cache inputs" requires `crates/testfakes/src/lib.rs`,
  `.cargo/config.toml`, `.config/nextest.toml` only; the definition keeps those (read, not executed).

### Measurement hazards

- **Stale Nx file hashes.** One capture (the first version-strict base) returned, for
  `npm/onepipeline-cli/bin/onepipeline.js` and `tests/llmlint_diff/lint_llm_diff.test.mjs`, the hashes of the
  *edited* contents after the files had been restored with `git checkout -- .` (its `onepipeline-npm:lint` equalled
  the edited-state hash `6807669754889702457`; a direct re-check gave clean `17577114463654896337` vs edited
  `6807669754889702457`). The cause was not determined; deleting `.nx/workspace-data` before each capture removed
  it, and every figure in this file comes from captures made that way (main and release recaptured: identical to
  the first captures). Separately, an untracked file in the root project (a stray `main.json` from a relative
  `--out`, written into `clone/` because the tool `chdir`s into the workspace) moved the 7 root `**/*` tasks;
  those captures were discarded. A CI runner's checkout starts without `.nx/workspace-data` and with no untracked
  files, so neither should arise there.

## 4. Tests that read the package version

### Search

```
git grep -n 'CARGO_PKG_VERSION'
git grep -n -E 'env!\(' | grep -v CARGO_BIN_EXE | grep -v CARGO_MANIFEST_DIR
git grep -n -E 'crate_version!|\bVERSION\b|version = env|--version' -- src tests crates
git grep -n -E '(crate|onepipeline)::VERSION|\bVERSION\b' -- src tests crates
git grep -n -E 'command\(.*version|version\)\]|clap::crate_version|built::|CARGO_PKG' -- src crates
git grep -n -l -E 'Cargo\.toml|CHANGELOG|pyproject' -- tests .github npm release pool-maintenance scripts   # 52 files, each read
git grep -n -F '0.98.4'
git grep -n -E 'namedInputs|"inputs"\]|\[.inputs.\]' -- tests .github/tests npm/test release/tests pool-maintenance scripts
```

Version sources in the product: `src/lib.rs:148 pub const VERSION: &str = env!("CARGO_PKG_VERSION")` and clap's
`#[command(name = "onepipeline", version, …)]` (`src/cli.rs:153`), i.e. `onepipeline --version`. No golden or
recorded fixture holds the version string.

### Tests whose result depends on the package version

| Test (file › name) | How it reads the version | Nx target(s) |
|---|---|---|
| `tests/contract.rs` › `the_contract_names_the_retention_path_and_the_release_it_ships_in` | asserts `onepipeline::VERSION` equals Cargo.toml's `[package]` version | `onepipeline-contract:test` (test-linux), `onepipeline-contract:test-quick` (test-windows, test-macos) |
| `tests/e2e/surface.rs` › `version_reports_the_crate_version` | `onepipeline --version` stdout contains `env!("CARGO_PKG_VERSION")` | `onepipeline-e2e:test`, `onepipeline-e2e:test-quick` |
| `tests/package_bundle.rs` › `the_packaged_crate_carries_the_committed_events_bundle` | `cargo package` then opens `target/package/onepipeline-{CARGO_PKG_VERSION}.crate` | rest tier: `onepipeline:test-rest`, `onepipeline:test-quick` |
| `npm/test/launcher.test.mjs` › describe "the npm distribution" (its `before()` stamps packages via `scripts/npm-build.mjs`, which reads Cargo.toml's version); tests "stamps the crate's version into the launcher and its platform pins", "rejects an unsafe Cargo version before creating output directories", "refuses a mismatched release tag before building artifacts", and the describe's other tests that use the stamped packages | Cargo.toml `[package] version` | `onepipeline-npm:test` (test-linux; cached) |
| `npm/test/staged-zip.test.mjs` › "packages a win_amd64 wheel into the zip archive and npm package that carry its executable" (and its describe "a Windows staged record's zip archive") | module-scope `VERSION` from Cargo.toml; asserts archive names `onepipeline-v${VERSION}-…` | `onepipeline-npm:test` |
| `.github/tests/release-shape.test.mjs` › "release-targets.toml covers its npm package again and no longer retires it", "{linux,linux-arm64,macos,windows}: is what v0.74.1 published for …'s targets, at this version", "together the plans are everything v0.74.1 published but the dropped target" | module-scope `VERSION` from Cargo.toml | `github-workflows:test` (test-linux; **uncached**) |
| `release/tests/release-checks.test.mjs` — module-scope `VERSION`/`TAG` from Cargo.toml, referenced inside 18 `it()`/`test()` definitions plus module-scope helpers (list: `tests-run/version-reading-js-tests.tsv`; e.g. "refuses a build manifest it did not write, before asking GitHub anything", "treats what the earlier attempt published as published, uploading nothing again") | Cargo.toml `[package] version` | `onepipeline-release:test` (test-linux; **uncached**) — the file is the target's only test file |

Read and found **not** version-dependent: `tests/coverage.rs` (copies Cargo.toml so `just` can parse the
justfile), `tests/build_config.rs`, `tests/msrv_pin.rs` (rust-version), `tests/linked_engines.rs`,
`tests/patch_pin.rs`, `tests/oneagentgraph_liveness.rs` (dependency pins), `npm/test/metadata.test.mjs`
(description/keywords), `npm/test/release-targets.test.mjs` (names), `pool-maintenance/measure.test.mjs` and
`.github/tests/macos-policy.test.mjs` and `tests/ci_jobs/release-pr-shortcut.test.mjs` (their own fixture repos),
`tests/stop_verdict/telemetry.rs` (fingerprints Cargo.toml/Cargo.lock bytes, compared with the same computation in
`scripts/stop-guard-unpublished-build.mjs`, not with a committed value), every `--version` call on another tool
or with only an exit-code check (`tests/e2e/profiling.rs` etc.). The install proofs
(`onepipeline:install-smoke`, `install-documented`, `wheel-smoke`, via `scripts/install-proof.sh` ->
`scripts/smoke-published.sh`) run `onepipeline --version` without `--expect-version`, so they check that it runs,
not the value (and are uncached). `tests/release_journeys/release-linux.journey.mjs` and `release-plz.journey.mjs`
read the version but belong to `onepipeline-release-journeys:release-journeys`, which no CI job runs.

The Rust and JS checks above are self-consistency checks (artifact/constant == Cargo.toml's version); each
passes for any well-formed version, but its outcome is computed from the version.

### Times

*(Filled in by the spike worker after the helper agent stopped; figures from the files named.)*

Local, targeted runs against the test build in `var/` (`build-tests.log`, `Finished test profile in 6m 39s`, exit 0), nextest's own per-test time:

| Test | Local time | Target it sits in | That target / its job in CI (release PR run 41636311031) |
|---|---|---|---|
| `contract::the_contract_names_the_retention_path_and_the_release_it_ships_in` | 0.028 s (`tests-run/rust-contract.log`) | `onepipeline-contract:test`, `:test-quick` (146 tests) | test-linux job 6,628 s; test-windows job 10,081 s |
| `e2e surface::version_reports_the_crate_version` | 0.035 s (`tests-run/rust-e2e.log`) | `onepipeline-e2e:test`, `:test-quick` (1,980 tests) | e2e on Linux started 13:38:39 and the Nx run ended 14:21:01 (≤2,542 s); Windows `test-quick` of e2e started 13:23:11 in a 155 m 4 s Nx run |
| `package_bundle::the_packaged_crate_carries_the_committed_events_bundle` | 1.168 s (`tests-run/rust-package_bundle.log`) | `onepipeline:test-rest`, `:test-quick` | as above |
| `.github/tests/release-shape.test.mjs` version tests (6) | 1,883 ms of the file's 2,105 ms (`tests-run/release-shape.*.tap`) | `github-workflows:test` (uncached) | — |
| `npm/test/staged-zip.test.mjs` (6) | 3,835 ms whole file (`tests-run/staged-zip.file.tap`) | `onepipeline-npm:test` | — |

Per-target CI durations are not measurable from the logs: Nx runs the tiers in parallel and prints only each task's start. The bounds above are the job and Nx-run durations (`gh/jobs-41636311031.json`, `gh/log-*.txt`).

### Targets that still re-run on a release PR if version-reading tests keep the version as an input

Cached targets (version-strict, measured above): `onepipeline-contract:test`, `onepipeline-contract:test-quick`,
`onepipeline-e2e:test`, `onepipeline-e2e:test-quick`, `onepipeline:test-rest`, `onepipeline:test-quick`,
`onepipeline-npm:test`. Plus every uncached task runs on every PR regardless of its hash; on a release PR those
in the list are: `github-workflows:test`, `github-workflows:budgets`, `github-workflows:syntax-check`,
`human-items-e2e:test`, `onepipeline-real-smoke:smoke`, `onepipeline-release-compat:release-compat`,
`onepipeline-release:test`, `onepipeline:budgets`, `onepipeline:coverage-clean`, `onepipeline:deps-check`,
`onepipeline:install-smoke`, `onepipeline:install-documented`, `onepipeline:msrv`, `onepipeline:test-archive`,
`onepipeline:test-quick-archive`, `onepipeline:wheel-smoke`, `onepipeline-npm:test-launcher`. Note that
`onepipeline:test-archive` (Linux) and `onepipeline:test-quick-archive` (Windows/macOS) are uncached
`dependsOn` of every cached tier: Nx runs a task's dependencies before consulting the cache for it, so even
with every tier a cache hit the full test build+archive still runs (Linux: `> nx run onepipeline:test-archive`
at 12:41:40.92, the first dependent tier started at 12:50:41.21, ≈540 s, in `gh/log-125918287670.txt`).

*(Filled in by the spike worker after the helper agent stopped; figures from the files named.)*

Worth splitting: the three Rust version tests take 0.028 s, 0.035 s and 1.168 s against tiers measured in tens of minutes to hours. Moving them into one small cached target that keeps the version as an input (`node scripts/nx-cargo-inputs.mjs --version`) lets `onepipeline-contract`, `onepipeline-e2e` and `onepipeline:test-rest`/`test-quick` replay on a release PR. `onepipeline-npm:test`: the version reads are in `before()` stamping and module scope across two files, so a split is a refactor of those files; small either way. The uncached `test-archive`/`test-quick-archive` still build every test binary on a release PR (≈540 s Linux) whatever the cache holds — that is the larger cost and is outside the input definition.
