# onetaskgraph: Nx task hashes under release-plz's edits (spike-opnx-audit)

- Repository: github.com/nickderobertis/onetaskgraph, `origin/main` = **705faa9cc517af94977ddd10f82f5728d6d07725** (`chore: release v0.13.3 (#3870)`).
- Nx 23.1.1 (from the workspace's `node_modules`), daemon off, hashes by `task-hashes.mjs capture` (unmodified; note: `--out` is resolved *after* the script `chdir`s into the workspace, so I passed absolute paths).
- Hashes were taken with none of the CI env inputs set (`GH_PROJECTS_TOKEN`, `GITHUB_RUN_ID`, …). Absolute values will differ in CI; every comparison here holds the env constant.
- Determinism control: `main.json` vs `main-recapture.json`: 0 of 147 moved.
- Exact commands: `COMMANDS.sh`. Helper scripts: `tools/` (`diff2.py`, which prints moved keys split on ` || ` because Nx's keys contain commas and the stock `diff` splits them; `explain.py`, which maps moved keys to edited files; `apply-definition.py`; `version-free-inputs.mjs`; `make-variant.sh`; `task-times.py`).

## 1. Task list

`scripts/ci-job.sh <job> --select-only` (the repo's own selection; there is no tier flag: every job is `nx affected`). It was run with `NX_BASE` = the repo's root commit, so every project counts as affected. That is the broadest selection. The selection includes the dependency tasks Nx adds (`bootstrap`, `onetaskgraph:build`, `workspace:coverage-clear`). Raw: `sel/*.txt`, `tasks.txt` (147 unique), `task-jobs.tsv`, `task-cache.tsv`.

Caveats on what a release PR really runs:
- `test-linux`/`test-windows`/`test-macos` already have a **release shortcut** (`.github/release-shortcut.mjs`). When the PR's tree is a tree `main` passed plus only release-plz's version/changelog edits, the tests are skipped. `test-macos` is skipped outright on `release-plz-*` branches. Only `lint` runs in full on the release PR.
- `just ci-test-*` wraps `ci-job.sh` in `lane_runner.py`, which passes `--exclude=` live plugins on a version-only diff. The `--select-only` lists above are without that narrowing.

- **lint** (77 tasks): `github-workflow-policy:format-check`, `github-workflow-policy:lint`, `github-workflows:format-check`, `github-workflows:lint`, `github-workflows:typecheck`, `linear-documents-policy:format-check`, `linear-documents-policy:lint`, `linear-documents-policy:typecheck`, `onetaskgraph-core:format-check`, `onetaskgraph-core:lint`, `onetaskgraph-core:typecheck`, `onetaskgraph-e2e-support:format-check`, `onetaskgraph-e2e-support:lint`, `onetaskgraph-e2e-support:typecheck`, `onetaskgraph-e2e:format-check`, `onetaskgraph-e2e:lint`, `onetaskgraph-e2e:typecheck`, `onetaskgraph-github-live:format-check`, `onetaskgraph-github-live:lint`, `onetaskgraph-github-live:typecheck`, `onetaskgraph-github-projects-e2e:format-check`, `onetaskgraph-github-projects-e2e:lint`, `onetaskgraph-github-projects-e2e:typecheck`, `onetaskgraph-github-projects:format-check`, `onetaskgraph-github-projects:lint`, `onetaskgraph-github-projects:typecheck`, `onetaskgraph-in-memory:format-check`, `onetaskgraph-in-memory:lint`, `onetaskgraph-in-memory:typecheck`, `onetaskgraph-linear-e2e:format-check`, `onetaskgraph-linear-e2e:lint`, `onetaskgraph-linear-e2e:typecheck`, `onetaskgraph-linear:format-check`, `onetaskgraph-linear:lint`, `onetaskgraph-linear:typecheck`, `onetaskgraph-live-janitor:format-check`, `onetaskgraph-live-janitor:lint`, `onetaskgraph-live-janitor:typecheck`, `onetaskgraph-live:format-check`, `onetaskgraph-live:lint`, `onetaskgraph-live:typecheck`, `onetaskgraph-local-md:format-check`, `onetaskgraph-local-md:lint`, `onetaskgraph-local-md:typecheck`, `onetaskgraph-plugin-api:format-check`, `onetaskgraph-plugin-api:lint`, `onetaskgraph-plugin-api:typecheck`, `onetaskgraph-status-options-e2e:format-check`, `onetaskgraph-status-options-e2e:lint`, `onetaskgraph-status-options-e2e:typecheck`, `onetaskgraph-status-options:format-check`, `onetaskgraph-status-options:lint`, `onetaskgraph-status-options:typecheck`, `onetaskgraph:build`, `onetaskgraph:format-check`, `onetaskgraph:lint`, `onetaskgraph:typecheck`, `pool-maintenance:format-check`, `pool-maintenance:lint`, `pool-maintenance:typecheck`, `screenshots:format-check`, `screenshots:lint`, `screenshots:typecheck`, `scripts:format-check`, `scripts:lint`, `scripts:typecheck`, `sdk-python:format-check`, `sdk-python:generate-check`, `sdk-python:lint`, `sdk-python:typecheck`, `sdk-typescript:format-check`, `sdk-typescript:lint`, `sdk-typescript:typecheck`, `workspace:deny`, `workspace:format-check`, `workspace:lint`, `workspace:typecheck`
- **test-linux** (58 tasks): `github-workflow-policy:bootstrap`, `github-workflow-policy:budgets`, `github-workflow-policy:coverage`, `github-workflow-policy:policy-tests`, `github-workflow-policy:release-tail`, `github-workflow-policy:rust-cache-action`, `github-workflow-policy:test`, `github-workflows:bootstrap`, `github-workflows:budget-journeys`, `github-workflows:cd-journeys`, `github-workflows:ci-contexts`, `github-workflows:ci-jobs`, `github-workflows:coverage`, `github-workflows:test`, `linear-documents-policy:bootstrap`, `linear-documents-policy:coverage`, `linear-documents-policy:test`, `onetaskgraph-core:coverage`, `onetaskgraph-core:test-uncovered`, `onetaskgraph-e2e-support:coverage`, `onetaskgraph-e2e:coverage`, `onetaskgraph-github-live:coverage`, `onetaskgraph-github-projects-e2e:budgets`, `onetaskgraph-github-projects-e2e:coverage`, `onetaskgraph-github-projects-e2e:test`, `onetaskgraph-github-projects:coverage`, `onetaskgraph-github-projects:test`, `onetaskgraph-in-memory:coverage`, `onetaskgraph-linear-e2e:budgets`, `onetaskgraph-linear-e2e:coverage`, `onetaskgraph-linear-e2e:test`, `onetaskgraph-linear:test`, `onetaskgraph-live-janitor:budgets`, `onetaskgraph-live-janitor:coverage`, `onetaskgraph-live-janitor:test`, `onetaskgraph-live:coverage`, `onetaskgraph-local-md:coverage`, `onetaskgraph-plugin-api:coverage`, `onetaskgraph-status-options-e2e:coverage`, `onetaskgraph-status-options:coverage`, `onetaskgraph:build`, `onetaskgraph:coverage`, `pool-maintenance:coverage`, `pool-maintenance:test`, `screenshots:coverage`, `screenshots:test`, `scripts:coverage`, `scripts:distribution-check`, `scripts:distribution-test`, `scripts:test`, `sdk-python:coverage`, `sdk-python:test-uncovered`, `sdk-typescript:coverage`, `sdk-typescript:generate-check`, `workspace:coverage`, `workspace:coverage-clear`, `workspace:test`, `workspace:test-uncovered`
- **test-windows** (34 tasks): `github-workflow-policy:bootstrap`, `github-workflow-policy:rust-cache-action`, `github-workflows:bootstrap`, `linear-documents-policy:bootstrap`, `linear-documents-policy:test`, `onetaskgraph-core:test`, `onetaskgraph-e2e-support:test`, `onetaskgraph-e2e:test`, `onetaskgraph-github-live:test`, `onetaskgraph-github-projects-e2e:budgets`, `onetaskgraph-github-projects-e2e:test`, `onetaskgraph-github-projects:test`, `onetaskgraph-in-memory:test`, `onetaskgraph-linear-e2e:budgets`, `onetaskgraph-linear-e2e:test`, `onetaskgraph-linear:test`, `onetaskgraph-live-janitor:budgets`, `onetaskgraph-live-janitor:test`, `onetaskgraph-live:test`, `onetaskgraph-local-md:test`, `onetaskgraph-plugin-api:test`, `onetaskgraph-status-options-e2e:test`, `onetaskgraph-status-options:test`, `onetaskgraph:build`, `onetaskgraph:test`, `pool-maintenance:test`, `screenshots:test`, `scripts:distribution-check`, `scripts:distribution-test`, `scripts:test`, `sdk-python:test`, `sdk-typescript:generate-check`, `sdk-typescript:test`, `workspace:test`
- **test-macos** (34 tasks): `github-workflow-policy:bootstrap`, `github-workflow-policy:rust-cache-action`, `github-workflows:bootstrap`, `linear-documents-policy:bootstrap`, `linear-documents-policy:test`, `onetaskgraph-core:test`, `onetaskgraph-e2e-support:test`, `onetaskgraph-e2e:test`, `onetaskgraph-github-live:test`, `onetaskgraph-github-projects-e2e:budgets`, `onetaskgraph-github-projects-e2e:test`, `onetaskgraph-github-projects:test`, `onetaskgraph-in-memory:test`, `onetaskgraph-linear-e2e:budgets`, `onetaskgraph-linear-e2e:test`, `onetaskgraph-linear:test`, `onetaskgraph-live-janitor:budgets`, `onetaskgraph-live-janitor:test`, `onetaskgraph-live:test`, `onetaskgraph-local-md:test`, `onetaskgraph-plugin-api:test`, `onetaskgraph-status-options-e2e:test`, `onetaskgraph-status-options:test`, `onetaskgraph:build`, `onetaskgraph:test`, `pool-maintenance:test`, `screenshots:test`, `scripts:distribution-check`, `scripts:distribution-test`, `scripts:test`, `sdk-python:test`, `sdk-typescript:generate-check`, `sdk-typescript:test`, `workspace:test`


110 of the 147 tasks are cacheable. The 37 with `cache: false` (or unset) are listed in `task-cache.tsv`: every crate's `coverage`, `workspace:test`/`coverage`/`deny`, `scripts:test`/`distribution-*`, `github-workflows:test`/`cd-journeys`, the policy `test`/`policy-tests`/`budgets`/`rust-cache-action`, `screenshots:test`, the `generate-check`s, `onetaskgraph:build` and the bootstraps. Under the plan, those re-run on every PR whatever their hash.

## 2. Hashes on main and after release-plz's edits

**How the edits were made.** `release-plz update` ran (0.3.167, in a full copy on branch `main`), and it is a no-op: main's tip *is* the v0.13.3 release, so it logs "no commit matches the `release_commits` regex" for every package. In this repo the release PR is not release-plz's edit alone. `scripts/prepare-release-pr.sh` runs `scripts/set-version.sh <v>`, which rewrites every manifest, then release-plz writes the changelogs. I therefore reproduced the next release (0.13.3 → 0.13.4) with `scripts/set-version.sh 0.13.4` plus a changelog entry in the same 4 `crates/*/CHANGELOG.md` the v0.13.3 commit touched. The result is **27 files, +77/−53**, the same file set and line counts as the real `chore: release v0.13.3` commit. Diff: `release-edits.diff`; files: `release-edited-files.txt`.

Version-bearing files the edits touch: `Cargo.toml` (`[workspace.package]` version and 7 `=X.Y.Z` sibling pins), `Cargo.lock` (workspace members), `bun.lock`, 9× `crates/*/Cargo.toml`, 4× `crates/*/CHANGELOG.md`, `npm/cli/package.json`, 4× `npm/platforms/*/package.json`, `pyproject.toml`, `uv.lock`, `sdks/python/pyproject.toml`, **`sdks/python/src/onetaskgraph_sdk/__init__.py` (`__version__`)**, `sdks/typescript/package.json` and **`sdks/typescript/src/index.ts` (`export const VERSION`)**. No fixture holds the version literal (`git grep -F 0.13.3` hits only these files).

**Result: 123 of 147 tasks move (96 of the 110 cacheable).** Three things drive it:
- `sharedGlobals` lists `Cargo.toml`, `Cargo.lock`, `package.json` and `bun.lock`, so every task using `default` moves.
- `{projectRoot}/**/*` takes in each crate's own `Cargo.toml` and `CHANGELOG.md`, and the SDKs' version source files. `^default` carries these to every dependent.
- Explicit `{workspaceRoot}/crates/**/*`, `sdks/**/*`, `npm/**/*`, `pyproject.toml`, `uv.lock` inputs (e2e `namedInputs`, `.github` `cdJourneys`, `workspace:lint`/`typecheck`, and others).

The 24 that stay unchanged are the `.github`-only projects' tasks plus the `format-check`s of `pool-maintenance`, `screenshots` and `scripts`, and `scripts:distribution-*`.

The real release commit gives the same result: `pre-v0.13.3.json` (f8a10df) vs `main.json` (705faa9) moves exactly the same 123-task set (`diff-real-release-v0.13.3.txt`, `explain-real-release.tsv`, `real-release-v0.13.3.diff`).

Full table (raw: `main.json`, `orig-release.json`, `diff-main-release.txt`, `explain-release.tsv`):

| task | job(s) | cacheable | hash on main | hash after release edits | release-edited files inside the inputs that moved |
|---|---|---|---|---|---|
| `github-workflow-policy:bootstrap` | test-linux,test-windows,test-macos | no | 4078094187192411772 | 4078094187192411772 | **unchanged** |
| `github-workflow-policy:budgets` | test-linux | no | 6655491386980496396 | 6655491386980496396 | **unchanged** |
| `github-workflow-policy:coverage` | test-linux | yes | 13685299367342516634 | 1074522907824089008 | bun.lock |
| `github-workflow-policy:format-check` | lint | yes | 6883573273052287695 | 15872148886198918819 | bun.lock |
| `github-workflow-policy:lint` | lint | yes | 2115391463558423255 | 9349202255786064540 | bun.lock |
| `github-workflow-policy:policy-tests` | test-linux | no | 16053873700430240574 | 16053873700430240574 | **unchanged** |
| `github-workflow-policy:release-tail` | test-linux | yes | 7402055566404790573 | 7402055566404790573 | **unchanged** |
| `github-workflow-policy:rust-cache-action` | test-linux,test-windows,test-macos | no | 12595037097176118773 | 12595037097176118773 | **unchanged** |
| `github-workflow-policy:test` | test-linux | no | 6411731325481903552 | 2668550049712572209 | bun.lock |
| `github-workflows:bootstrap` | test-linux,test-windows,test-macos | no | 13138469932506071769 | 13138469932506071769 | **unchanged** |
| `github-workflows:budget-journeys` | test-linux | yes | 1109486971235097419 | 4206867262817136996 | bun.lock |
| `github-workflows:cd-journeys` | test-linux | no | 9401658849858035157 | 2669469313103751880 | Cargo.lock, Cargo.toml, bun.lock, npm/cli/package.json, npm/platforms/darwin-arm64/package.json, npm/platforms/linux-arm64/package.json, npm/platforms/linux-x64/package.json, npm/platforms/win32-x64/package.json, pyproject.toml, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, sdks/typescript/package.json, sdks/typescript/src/index.ts, uv.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `github-workflows:ci-contexts` | test-linux | yes | 12407123350008810053 | 12407123350008810053 | **unchanged** |
| `github-workflows:ci-jobs` | test-linux | yes | 9377779941666061548 | 9377779941666061548 | **unchanged** |
| `github-workflows:coverage` | test-linux | yes | 5131357683889155189 | 5131357683889155189 | **unchanged** |
| `github-workflows:format-check` | lint | yes | 10268691437650104107 | 10268691437650104107 | **unchanged** |
| `github-workflows:lint` | lint | yes | 10014123298886660966 | 10014123298886660966 | **unchanged** |
| `github-workflows:test` | test-linux | no | 18285103626365763617 | 18285103626365763617 | **unchanged** |
| `github-workflows:typecheck` | lint | yes | 1609983750395784242 | 1609983750395784242 | **unchanged** |
| `linear-documents-policy:bootstrap` | test-linux,test-windows,test-macos | no | 4033725740703155451 | 4033725740703155451 | **unchanged** |
| `linear-documents-policy:coverage` | test-linux | yes | 12750622680795353101 | 12750622680795353101 | **unchanged** |
| `linear-documents-policy:format-check` | lint | yes | 9209257943420576008 | 9209257943420576008 | **unchanged** |
| `linear-documents-policy:lint` | lint | yes | 6440407323069831332 | 6440407323069831332 | **unchanged** |
| `linear-documents-policy:test` | test-linux,test-windows,test-macos | no | 4745703393989628724 | 4745703393989628724 | **unchanged** |
| `linear-documents-policy:typecheck` | lint | yes | 9864318633680159340 | 9864318633680159340 | **unchanged** |
| `onetaskgraph-core:coverage` | test-linux | no | 14444185385642971599 | 1155479665647129688 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-core:format-check` | lint | yes | 16560806297799636176 | 7713979777826431608 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-core:lint` | lint | yes | 13125720398479637832 | 11112013108293613397 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-core:test` | test-windows,test-macos | yes | 10453618500368604110 | 16446679477814239636 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-core:test-uncovered` | test-linux | yes | 6809971652631562267 | 12257127097759155212 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-core:typecheck` | lint | yes | 7654297956646783696 | 9290680240815124568 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e-support:coverage` | test-linux | no | 3864887375392543136 | 863106659061081927 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e-support:format-check` | lint | yes | 5505968118161674009 | 4559223926121441398 | Cargo.lock, Cargo.toml, bun.lock |
| `onetaskgraph-e2e-support:lint` | lint | yes | 11876436964943166069 | 9492936935985974305 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e-support:test` | test-windows,test-macos | yes | 14384517063527398979 | 18370319625797979097 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e-support:typecheck` | lint | yes | 11966386674229635558 | 13726049716081933884 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e:coverage` | test-linux | no | 3134248049625726588 | 519243870390915577 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e:format-check` | lint | yes | 6899788628619958868 | 16389132572824076950 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-e2e:lint` | lint | yes | 2274878820450764033 | 15496272100191811253 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e:test` | test-windows,test-macos | yes | 16805970494357597279 | 10831457456388573532 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-e2e:typecheck` | lint | yes | 15084398395046226670 | 15517344564934258983 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph-github-live:coverage` | test-linux | no | 12257508604286048194 | 10510585866906206679 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-github-live:format-check` | lint | yes | 1377925531272356412 | 17470717244332169008 | Cargo.lock, Cargo.toml, bun.lock |
| `onetaskgraph-github-live:lint` | lint | yes | 15177312790378071057 | 17512933495457067954 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-github-live:test` | test-windows,test-macos | yes | 12008830219285228011 | 3016943856505566490 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-github-live:typecheck` | lint | yes | 6427426485964181338 | 14346701706929555409 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-github-projects-e2e:budgets` | test-linux,test-windows,test-macos | yes | 15138543577339990511 | 17573735231225197337 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects-e2e:coverage` | test-linux | no | 10116328410736370331 | 466030319824033231 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects-e2e:format-check` | lint | yes | 8346462471442915399 | 18426923910552005043 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects-e2e:lint` | lint | yes | 18418871334454928880 | 3994009358840120702 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects-e2e:test` | test-linux,test-windows,test-macos | yes | 850203468657140088 | 17777529049402170095 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects-e2e:typecheck` | lint | yes | 483721680732178213 | 18379362079830859580 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects:coverage` | test-linux | no | 15760249155651967967 | 6609190227628193917 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects:format-check` | lint | yes | 17505975773834079158 | 13887290417416766142 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects:lint` | lint | yes | 4688907684928261922 | 1767040247711735687 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects:test` | test-linux,test-windows,test-macos | yes | 1704234046890436204 | 12232930014383404780 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-github-projects:typecheck` | lint | yes | 6155171628943357193 | 13606050957787007678 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-in-memory:coverage` | test-linux | no | 526001026985616585 | 10986908423959372449 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-in-memory:format-check` | lint | yes | 5378567007776839041 | 4331650969538704128 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-in-memory:lint` | lint | yes | 15296141736366940294 | 1599222389539459822 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-in-memory:test` | test-windows,test-macos | yes | 11219785452402097392 | 18436429270024624639 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-in-memory:typecheck` | lint | yes | 9743808343289193263 | 16814773703145726252 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-linear-e2e:budgets` | test-linux,test-windows,test-macos | yes | 2287130100409279539 | 7029911958664123110 | Cargo.lock, Cargo.toml, bun.lock, 6× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-linear-e2e:coverage` | test-linux | no | 13662480572660006070 | 9241757119360751013 | Cargo.lock, Cargo.toml, bun.lock, 6× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-linear-e2e:format-check` | lint | yes | 15505501716330499237 | 7589187358200867266 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-linear-e2e:lint` | lint | yes | 9171276431601708983 | 4925929233006268703 | Cargo.lock, Cargo.toml, bun.lock, 6× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-linear-e2e:test` | test-linux,test-windows,test-macos | yes | 8081707327858311809 | 13257494923795158198 | Cargo.lock, Cargo.toml, bun.lock, 6× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-linear-e2e:typecheck` | lint | yes | 16718916941119440581 | 13044005185502684184 | Cargo.lock, Cargo.toml, bun.lock, 6× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-linear:format-check` | lint | yes | 16193997924427743111 | 2986751233281244446 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-linear:lint` | lint | yes | 14874297142941858468 | 10874198603898740592 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-linear:test` | test-linux,test-windows,test-macos | yes | 2139091434887920950 | 5279463929348900553 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-linear:typecheck` | lint | yes | 9818264183276532245 | 3370668264616367595 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-live-janitor:budgets` | test-linux,test-windows,test-macos | yes | 8591377468507769109 | 9650858652214371250 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-live-janitor:coverage` | test-linux | no | 5602774933144000793 | 5538256594662151457 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-live-janitor:format-check` | lint | yes | 6429091970557386996 | 11928781345098573608 | Cargo.lock, Cargo.toml, bun.lock |
| `onetaskgraph-live-janitor:lint` | lint | yes | 10614726627103710791 | 6212556908664268728 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-live-janitor:test` | test-linux,test-windows,test-macos | yes | 4353205977584486384 | 1851909202746363588 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-live-janitor:typecheck` | lint | yes | 2677739928242216209 | 7357694893540363832 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-live:coverage` | test-linux | no | 8288221673693248033 | 15268334572750329480 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-live:format-check` | lint | yes | 12784439120390428936 | 8088509836033993530 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-live:lint` | lint | yes | 7128724473859232740 | 17473238930962867859 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-live:test` | test-windows,test-macos | yes | 3972672048597613639 | 9966673786250319051 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-live:typecheck` | lint | yes | 12616915205127570252 | 11255206020100552805 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-local-md:coverage` | test-linux | no | 10163038479123629723 | 9864155924215422715 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-local-md:format-check` | lint | yes | 13970826605373782777 | 15752567259505358607 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-local-md:lint` | lint | yes | 13505567732301846548 | 12995960600909656195 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-local-md:test` | test-windows,test-macos | yes | 1929897717047692163 | 18435268907242130856 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-local-md:typecheck` | lint | yes | 17617010233572784302 | 16918367662663755646 | Cargo.lock, Cargo.toml, bun.lock, 2× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-plugin-api:coverage` | test-linux | no | 9952136535697522411 | 16259068054560602591 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-plugin-api:format-check` | lint | yes | 5460320002087499259 | 2910731466392522288 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-plugin-api:lint` | lint | yes | 1820839961124633844 | 9810904133293778688 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-plugin-api:test` | test-windows,test-macos | yes | 15325330235432419824 | 9400378793445125686 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-plugin-api:typecheck` | lint | yes | 4338165887700218399 | 5451194941601930880 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options-e2e:coverage` | test-linux | no | 3744253199359725147 | 11723994328484701966 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options-e2e:format-check` | lint | yes | 17391712793905181010 | 18297108600171651917 | Cargo.lock, Cargo.toml, bun.lock, 3× crates/*/Cargo.toml, 1× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options-e2e:lint` | lint | yes | 2727779479122520844 | 9020410771610084962 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options-e2e:test` | test-windows,test-macos | yes | 4049359876245669030 | 17345559953971610236 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options-e2e:typecheck` | lint | yes | 1705717471875995706 | 13492082186820005815 | Cargo.lock, Cargo.toml, bun.lock, 7× crates/*/Cargo.toml, 3× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options:coverage` | test-linux | no | 3375920670760070885 | 11335398422330266228 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options:format-check` | lint | yes | 15778251519014919816 | 4397388470176218902 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph-status-options:lint` | lint | yes | 16999435632656046291 | 4988083297912506488 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options:test` | test-windows,test-macos | yes | 5414667030133976103 | 17241801000116274098 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph-status-options:typecheck` | lint | yes | 8397307233556541711 | 11439753698276719256 | Cargo.lock, Cargo.toml, bun.lock, 4× crates/*/Cargo.toml, 2× crates/*/CHANGELOG.md |
| `onetaskgraph:build` | lint,test-linux,test-windows,test-macos | no | 17945756514824513063 | 18299699465715946166 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph:coverage` | test-linux | no | 2092978788183779806 | 9618819093034080889 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph:format-check` | lint | yes | 14115496247056271089 | 15638289901338211160 | Cargo.lock, Cargo.toml, bun.lock, 1× crates/*/Cargo.toml |
| `onetaskgraph:lint` | lint | yes | 15406969209130520121 | 13171827005340700810 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph:test` | test-windows,test-macos | yes | 14400393181575784724 | 16167304570711046963 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `onetaskgraph:typecheck` | lint | yes | 2716512982345682017 | 13590741734322497422 | Cargo.lock, Cargo.toml, bun.lock, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `pool-maintenance:coverage` | test-linux | yes | 5846134645557417329 | 694083886285300675 | Cargo.lock, Cargo.toml, bun.lock |
| `pool-maintenance:format-check` | lint | yes | 12627901091449851426 | 12627901091449851426 | **unchanged** |
| `pool-maintenance:lint` | lint | yes | 13744043580700184317 | 13357362213683483767 | Cargo.lock, Cargo.toml, bun.lock |
| `pool-maintenance:test` | test-linux,test-windows,test-macos | yes | 9386571358551346537 | 2246779772954836258 | Cargo.lock, Cargo.toml, bun.lock |
| `pool-maintenance:typecheck` | lint | yes | 11059580012787377568 | 17771003999956557335 | Cargo.lock, Cargo.toml, bun.lock |
| `screenshots:coverage` | test-linux | yes | 891939975978979279 | 278527744844911826 | Cargo.lock, Cargo.toml, bun.lock |
| `screenshots:format-check` | lint | yes | 17054598926214066511 | 17054598926214066511 | **unchanged** |
| `screenshots:lint` | lint | yes | 18411323995306952730 | 16605886043967113989 | Cargo.lock, Cargo.toml, bun.lock |
| `screenshots:test` | test-linux,test-windows,test-macos | no | 12699229607967107353 | 4618208901570181772 | Cargo.lock, Cargo.toml, bun.lock |
| `screenshots:typecheck` | lint | yes | 4878628667102177180 | 1965995098750580648 | Cargo.lock, Cargo.toml, bun.lock |
| `scripts:coverage` | test-linux | yes | 15867315758565549397 | 15880139712824232066 | Cargo.lock, Cargo.toml, bun.lock |
| `scripts:distribution-check` | test-linux,test-windows,test-macos | no | 17965861995768108971 | 17965861995768108971 | **unchanged** |
| `scripts:distribution-test` | test-linux,test-windows,test-macos | no | 16949719116302226301 | 16949719116302226301 | **unchanged** |
| `scripts:format-check` | lint | yes | 14959253753238984936 | 14959253753238984936 | **unchanged** |
| `scripts:lint` | lint | yes | 5838399757000897571 | 6277886391508137123 | Cargo.lock, Cargo.toml, bun.lock |
| `scripts:test` | test-linux,test-windows,test-macos | no | 14346551345898486257 | 13891199281541703770 | Cargo.lock, Cargo.toml, bun.lock |
| `scripts:typecheck` | lint | yes | 11391742275285180438 | 12315453844102889690 | Cargo.lock, Cargo.toml, bun.lock |
| `sdk-python:coverage` | test-linux | yes | 18368842337412186003 | 13989520943569513968 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-python:format-check` | lint | yes | 16117050518196455587 | 2734477018867224416 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py |
| `sdk-python:generate-check` | lint | no | 8587672109290979484 | 16394685517187038472 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-python:lint` | lint | yes | 6152526986340674479 | 14085368284840758541 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-python:test` | test-windows,test-macos | yes | 3205000915871430709 | 9846096482143114081 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-python:test-uncovered` | test-linux | no | 12543917572213439183 | 18272138167715639581 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-python:typecheck` | lint | yes | 132649104706270532 | 10832307857237981208 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-typescript:coverage` | test-linux | yes | 12539611698009021417 | 15269674073561878367 | Cargo.lock, Cargo.toml, bun.lock, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-typescript:format-check` | lint | yes | 6670596409234251135 | 18224953207096359339 | Cargo.lock, Cargo.toml, bun.lock, sdks/typescript/package.json, sdks/typescript/src/index.ts |
| `sdk-typescript:generate-check` | test-linux,test-windows,test-macos | no | 7349087188678309436 | 1713153133359486337 | Cargo.lock, Cargo.toml, bun.lock, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-typescript:lint` | lint | yes | 3749251435916125500 | 9913744852165387316 | Cargo.lock, Cargo.toml, bun.lock, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-typescript:test` | test-windows,test-macos | yes | 13051692964347955854 | 4369578478372707385 | Cargo.lock, Cargo.toml, bun.lock, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `sdk-typescript:typecheck` | lint | yes | 10496157647400741419 | 1239626057683514462 | Cargo.lock, Cargo.toml, bun.lock, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `workspace:coverage` | test-linux | no | 7664676604422676109 | 8340373035032831942 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `workspace:coverage-clear` | test-linux | no | 1460061139692764143 | 13770230425130702719 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `workspace:deny` | lint | no | 13390963464720637942 | 13806698193304460155 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `workspace:format-check` | lint | yes | 17628496566395591255 | 10573955808955699278 | sdks/typescript/package.json |
| `workspace:lint` | lint | yes | 9761400645088832703 | 11822050646661842687 | Cargo.lock, Cargo.toml, sdks/typescript/package.json, 9× crates/*/Cargo.toml |
| `workspace:test` | test-linux,test-windows,test-macos | no | 18153681841724545473 | 1988472565603178220 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `workspace:test-uncovered` | test-linux | yes | 12025546319793336386 | 4680510695404023102 | Cargo.lock, Cargo.toml, bun.lock, sdks/python/pyproject.toml, sdks/python/src/onetaskgraph_sdk/__init__.py, sdks/typescript/package.json, sdks/typescript/src/index.ts, 9× crates/*/Cargo.toml, 4× crates/*/CHANGELOG.md |
| `workspace:typecheck` | lint | yes | 14380755018232167595 | 3092726141696726099 | sdks/python/src/onetaskgraph_sdk/__init__.py, sdks/typescript/src/index.ts |


## 3. A sound input definition, recomputed

Implemented only in the scratch copy `def/` (`definition.diff`: `nx.json` + 9 `project.json` + the new `scripts/version-free-inputs.mjs`), by `tools/apply-definition.py`:

1. **`versionFree` runtime input**: `{ "runtime": "node scripts/version-free-inputs.mjs" }`, a pure-node script (no shell; runs the same from bash, Git Bash and pwsh, and CRLF is normalised although `.gitattributes` forces LF). It prints `version-shape N.N.N` and one `<path> <sha256>` line per version-bearing file: the root `Cargo.toml`, `Cargo.lock`, `package.json`, `bun.lock`, `pyproject.toml` and `uv.lock`, every `crates/*/Cargo.toml`, the npm manifests, both SDK manifests and the two SDK version source files. Each digest is taken after masking the workspace version V (read from `[workspace.package]`), but **only** in these places:
   - the manifest's own `version` line;
   - `onetaskgraph*`/`@onetaskgraph/*` sibling pins;
   - `Cargo.lock`/`uv.lock` blocks with no registry source;
   - `__version__ = "V"` and `export const VERSION = "V";`.

   Any other occurrence, and any version that disagrees with V, stays literal.
2. **`sharedGlobals`**: the raw `Cargo.toml`, `Cargo.lock`, `package.json` and `bun.lock` are replaced by `versionFree`.
3. **`default`**: `{projectRoot}/**/*`, `!{projectRoot}/Cargo.toml`, `!{projectRoot}/CHANGELOG.md`, `sharedGlobals`. The SDK projects get a project-level `default` that also excludes `package.json`/`src/index.ts` and `pyproject.toml`/`src/onetaskgraph_sdk/__init__.py`.
4. Every explicit input list whose own globs reach a version-bearing file has those files negated (`!{workspaceRoot}/...`) and gets `versionFree` added. Lists that reach none are left alone.

Four states (plus checks), the same 147 tasks:

| state | what | tasks moved vs `def-main` (of 147) | cacheable moved (of 110) |
|---|---|---|---|
| release edits | `release-edits.diff` | **3**: `onetaskgraph:build`, `sdk-python:generate-check`, `sdk-typescript:generate-check` | **0** |
| real v0.13.3 release (f8a10df→705faa9, both with the definition) | | same 3 | 0 |
| source change | one comment line in a source file of every project (`variant-def-source.diff`) | 144 | — |
| Cargo dep change | `serde_json` 1.0.151→1.0.152 in `Cargo.lock` | 124 | — |
| npm dep change | `typescript` 5.9.3→5.9.4 in `package.json` + `bun.lock` | 124 | — |
| half-applied bump | release edits except `sdks/typescript/src/index.ts` | 124, incl. `sdk-typescript:test` (via `runtime:node scripts/version-free-inputs.mjs`) | — |
| format change | 0.13.3→0.14.0-rc.1 everywhere | 124, incl. `sdk-typescript:test` | — |

**Soundness check against today's definition, on the same variants** (`orig-source/dep-cargo/dep-npm.json`): every task the change moves today still moves under the new definition. There are 0 cases of "moved today but not now" for source, Cargo dep and npm dep. The 3 tasks that a source change moves in neither definition (`pool-maintenance`, `screenshots` and `scripts:format-check`) have narrow globs that do not hold the edited files.

**Cost:** the definition is broader in a few places. A Cargo dep change now also moves 8 tasks it did not move before (`github-workflow-policy:{coverage,format-check,lint,release-tail,test}`, `github-workflows:budget-journeys`, `workspace:format-check`, `workspace:typecheck`), and an npm dep change moves 1 more (`workspace:typecheck`). The reason is that one digest covers all manifests together. Splitting it into a Rust digest and a JS/Python digest would remove that.

The 3 tasks that still move are uncached targets with **no `inputs` and no targetDefault**. For those, Nx hashes the raw `{projectRoot}/**/*` and not the named `default`, so `crates/onetaskgraph/Cargo.toml`/`CHANGELOG.md` and the SDK manifests stay in their hash. They never use the cache, so this is harmless. Giving them `"inputs": ["default", "^default"]` would settle it. **No target lacks a sound definition.**

Full four-state table (raw: `def-*.json`, `diff-def-*.txt`, `variant-*.diff`):

| task | cacheable | main | release edits | source change | Cargo dep change | npm dep change | moved by same changes under today's definition (src / cargo / npm) |
|---|---|---|---|---|---|---|---|
| `github-workflow-policy:bootstrap` | no | 2955260479879679889 | 2955260479879679889 (same) | 15716095135103319654 | 2955260479879679889 (same) | 2955260479879679889 (same) | moved / same / same |
| `github-workflow-policy:budgets` | no | 11544920100059033066 | 11544920100059033066 (same) | 8394955058604973489 | 11544920100059033066 (same) | 11544920100059033066 (same) | moved / same / same |
| `github-workflow-policy:coverage` | yes | 12517263872436587483 | 12517263872436587483 (same) | 7381634019136555096 | 15589249099398783697 | 14786517894208245164 | moved / same / moved |
| `github-workflow-policy:format-check` | yes | 12282844771427720881 | 12282844771427720881 (same) | 16542117891011274792 | 18326852443815035799 | 15893315819621230285 | moved / same / moved |
| `github-workflow-policy:lint` | yes | 9549349759706357194 | 9549349759706357194 (same) | 1438709050605789352 | 12997435198910744798 | 7100055805372721619 | moved / same / moved |
| `github-workflow-policy:policy-tests` | no | 7989845025228278414 | 7989845025228278414 (same) | 12701651435324868362 | 7989845025228278414 (same) | 7989845025228278414 (same) | moved / same / same |
| `github-workflow-policy:release-tail` | yes | 7206054512089511461 | 7206054512089511461 (same) | 14195781436152466304 | 1027503784899658536 | 8600649374764442781 | moved / same / moved |
| `github-workflow-policy:rust-cache-action` | no | 8040842282922044211 | 8040842282922044211 (same) | 18119310506047906848 | 8040842282922044211 (same) | 8040842282922044211 (same) | moved / same / same |
| `github-workflow-policy:test` | no | 17138041401741357988 | 17138041401741357988 (same) | 7884471761494017978 | 10560990022837403448 | 531149994675006607 | moved / same / moved |
| `github-workflows:bootstrap` | no | 18109241407653703797 | 18109241407653703797 (same) | 16564717922653309136 | 18109241407653703797 (same) | 18109241407653703797 (same) | moved / same / same |
| `github-workflows:budget-journeys` | yes | 8197763496727527144 | 8197763496727527144 (same) | 7662452845865413928 | 14223315114460747760 | 12012679675953776119 | moved / same / moved |
| `github-workflows:cd-journeys` | no | 5748598112799582644 | 5748598112799582644 (same) | 5457940864467283762 | 11930892094142821817 | 16765049896543924108 | moved / moved / moved |
| `github-workflows:ci-contexts` | yes | 18022559016410833754 | 18022559016410833754 (same) | 10493610820724658670 | 18022559016410833754 (same) | 18022559016410833754 (same) | moved / same / same |
| `github-workflows:ci-jobs` | yes | 14730505164769837088 | 14730505164769837088 (same) | 15724325467973429275 | 14730505164769837088 (same) | 14730505164769837088 (same) | moved / same / same |
| `github-workflows:coverage` | yes | 9085109891158018675 | 9085109891158018675 (same) | 2792382156723997719 | 9085109891158018675 (same) | 9085109891158018675 (same) | moved / same / same |
| `github-workflows:format-check` | yes | 15170128089152864298 | 15170128089152864298 (same) | 13284594550440137845 | 15170128089152864298 (same) | 15170128089152864298 (same) | moved / same / same |
| `github-workflows:lint` | yes | 6792400346653370952 | 6792400346653370952 (same) | 13344534227094846043 | 6792400346653370952 (same) | 6792400346653370952 (same) | moved / same / same |
| `github-workflows:test` | no | 11401676863541682910 | 11401676863541682910 (same) | 15395685954375723469 | 11401676863541682910 (same) | 11401676863541682910 (same) | moved / same / same |
| `github-workflows:typecheck` | yes | 2828521259004783171 | 2828521259004783171 (same) | 4366555822433587114 | 2828521259004783171 (same) | 2828521259004783171 (same) | moved / same / same |
| `linear-documents-policy:bootstrap` | no | 15855126442337270643 | 15855126442337270643 (same) | 14675084907871508533 | 15855126442337270643 (same) | 15855126442337270643 (same) | moved / same / same |
| `linear-documents-policy:coverage` | yes | 9679347985517124674 | 9679347985517124674 (same) | 17388886842631495952 | 9679347985517124674 (same) | 9679347985517124674 (same) | moved / same / same |
| `linear-documents-policy:format-check` | yes | 2899762156382628080 | 2899762156382628080 (same) | 7890544740900102213 | 2899762156382628080 (same) | 2899762156382628080 (same) | moved / same / same |
| `linear-documents-policy:lint` | yes | 11325063876282771575 | 11325063876282771575 (same) | 1988293256519062364 | 11325063876282771575 (same) | 11325063876282771575 (same) | moved / same / same |
| `linear-documents-policy:test` | no | 18396576564655499305 | 18396576564655499305 (same) | 1668183192943195655 | 18396576564655499305 (same) | 18396576564655499305 (same) | moved / same / same |
| `linear-documents-policy:typecheck` | yes | 4833778681780396410 | 4833778681780396410 (same) | 6702633568313367130 | 4833778681780396410 (same) | 4833778681780396410 (same) | moved / same / same |
| `onetaskgraph-core:coverage` | no | 9349359264885675561 | 9349359264885675561 (same) | 5145050269539044934 | 5665748846195829195 | 15682911962358519432 | moved / moved / moved |
| `onetaskgraph-core:format-check` | yes | 13900662422183462772 | 13900662422183462772 (same) | 16942908462177002852 | 15928150321887214703 | 6553204416232199932 | moved / moved / moved |
| `onetaskgraph-core:lint` | yes | 1954949467337650344 | 1954949467337650344 (same) | 12367810881781462243 | 17762326428137599487 | 6633255653665397092 | moved / moved / moved |
| `onetaskgraph-core:test` | yes | 14152260507301845412 | 14152260507301845412 (same) | 3459240625059395381 | 10431128676861961422 | 15970836615151256459 | moved / moved / moved |
| `onetaskgraph-core:test-uncovered` | yes | 17149663942032573789 | 17149663942032573789 (same) | 15305762131572128377 | 17392800273601936074 | 10707554024958176001 | moved / moved / moved |
| `onetaskgraph-core:typecheck` | yes | 9214849443914942766 | 9214849443914942766 (same) | 986783556994034613 | 12529389798319350765 | 10270982346872171965 | moved / moved / moved |
| `onetaskgraph-e2e-support:coverage` | no | 3357930473573082660 | 3357930473573082660 (same) | 7882293149792395703 | 947302955847425335 | 17276258043373311521 | moved / moved / moved |
| `onetaskgraph-e2e-support:format-check` | yes | 12903355717290086366 | 12903355717290086366 (same) | 14348353789786951188 | 13056656474921500763 | 4377181111839531518 | moved / moved / moved |
| `onetaskgraph-e2e-support:lint` | yes | 1899877477200363159 | 1899877477200363159 (same) | 5697658883544203829 | 331903071878429688 | 14501937711026081651 | moved / moved / moved |
| `onetaskgraph-e2e-support:test` | yes | 736688782955056134 | 736688782955056134 (same) | 7604381910714757970 | 2871018567534575379 | 16381005639986006786 | moved / moved / moved |
| `onetaskgraph-e2e-support:typecheck` | yes | 8445140958360347613 | 8445140958360347613 (same) | 1336939168211835545 | 14828941707350211409 | 212001682878752931 | moved / moved / moved |
| `onetaskgraph-e2e:coverage` | no | 684115797284115898 | 684115797284115898 (same) | 6306040761611142128 | 11833653766706368062 | 8434885516161054118 | moved / moved / moved |
| `onetaskgraph-e2e:format-check` | yes | 5575504739214304730 | 5575504739214304730 (same) | 1384543625070702738 | 10387278583492647242 | 18294800246769651539 | moved / moved / moved |
| `onetaskgraph-e2e:lint` | yes | 1089502891948060012 | 1089502891948060012 (same) | 12299240677263542415 | 3600343148066722223 | 1443806664052212531 | moved / moved / moved |
| `onetaskgraph-e2e:test` | yes | 2226283436828243186 | 2226283436828243186 (same) | 710127884731087948 | 2548217772375364427 | 3245590427959603636 | moved / moved / moved |
| `onetaskgraph-e2e:typecheck` | yes | 11696324842233792209 | 11696324842233792209 (same) | 2691404901648385685 | 11132653729372284714 | 450913624496463487 | moved / moved / moved |
| `onetaskgraph-github-live:coverage` | no | 13398172797709353086 | 13398172797709353086 (same) | 2478955882694536970 | 10414971011483127939 | 4754791847305531382 | moved / moved / moved |
| `onetaskgraph-github-live:format-check` | yes | 16752294125001751721 | 16752294125001751721 (same) | 8070624786649966585 | 15455786031456053245 | 9312543005741391060 | moved / moved / moved |
| `onetaskgraph-github-live:lint` | yes | 9171383891011576351 | 9171383891011576351 (same) | 2230429818045439786 | 4896219346377621542 | 4583859779275461924 | moved / moved / moved |
| `onetaskgraph-github-live:test` | yes | 12368714753760237185 | 12368714753760237185 (same) | 11731808816171593731 | 2587929541399322222 | 4452000893557450818 | moved / moved / moved |
| `onetaskgraph-github-live:typecheck` | yes | 8402663999533383178 | 8402663999533383178 (same) | 734187529063911038 | 13285957517726847448 | 9445856257282289954 | moved / moved / moved |
| `onetaskgraph-github-projects-e2e:budgets` | yes | 17475041019291130913 | 17475041019291130913 (same) | 12666452410535510383 | 2611978523712581439 | 4428441251008415448 | moved / moved / moved |
| `onetaskgraph-github-projects-e2e:coverage` | no | 8430726981824139132 | 8430726981824139132 (same) | 15147344050888847683 | 8544201529914752736 | 2619410846945417624 | moved / moved / moved |
| `onetaskgraph-github-projects-e2e:format-check` | yes | 13800912278094720826 | 13800912278094720826 (same) | 9898468997074461971 | 1637237335856407714 | 11220418827267190366 | moved / moved / moved |
| `onetaskgraph-github-projects-e2e:lint` | yes | 778842643085195782 | 778842643085195782 (same) | 7628758017744390421 | 14482924951768365674 | 13901327896707891316 | moved / moved / moved |
| `onetaskgraph-github-projects-e2e:test` | yes | 462631145729840550 | 462631145729840550 (same) | 17444761384523949727 | 6814186418979870134 | 328350181375436716 | moved / moved / moved |
| `onetaskgraph-github-projects-e2e:typecheck` | yes | 15534575298052849765 | 15534575298052849765 (same) | 11976089483927278834 | 8096602205573699931 | 13142219942129277900 | moved / moved / moved |
| `onetaskgraph-github-projects:coverage` | no | 8463149798105483668 | 8463149798105483668 (same) | 4585424957337889211 | 12548170851914565441 | 13476228589441281115 | moved / moved / moved |
| `onetaskgraph-github-projects:format-check` | yes | 16919934276505826586 | 16919934276505826586 (same) | 9529825347248478401 | 3945199883577823215 | 10521232218041620067 | moved / moved / moved |
| `onetaskgraph-github-projects:lint` | yes | 8501889950788107941 | 8501889950788107941 (same) | 14117154718939752781 | 7007270074329157868 | 7694247638841642839 | moved / moved / moved |
| `onetaskgraph-github-projects:test` | yes | 8571173043692710726 | 8571173043692710726 (same) | 3859500619539958879 | 10985121543313838420 | 11294302457793880320 | moved / moved / moved |
| `onetaskgraph-github-projects:typecheck` | yes | 912701050851268128 | 912701050851268128 (same) | 13352841097853534668 | 15430247251506507993 | 9379064213392511689 | moved / moved / moved |
| `onetaskgraph-in-memory:coverage` | no | 4537079798750434184 | 4537079798750434184 (same) | 2123287174729331313 | 8553721589036744882 | 7258958545569220745 | moved / moved / moved |
| `onetaskgraph-in-memory:format-check` | yes | 2306665257631085186 | 2306665257631085186 (same) | 319394981547549706 | 5422298432510321377 | 159660585383598440 | moved / moved / moved |
| `onetaskgraph-in-memory:lint` | yes | 13525563066324147894 | 13525563066324147894 (same) | 17274443999497103667 | 15590387266309428767 | 8738291466028558754 | moved / moved / moved |
| `onetaskgraph-in-memory:test` | yes | 4337167893281945979 | 4337167893281945979 (same) | 4483390699775513041 | 9652237705540805726 | 15867617077421299201 | moved / moved / moved |
| `onetaskgraph-in-memory:typecheck` | yes | 1769816843945871198 | 1769816843945871198 (same) | 11482038211651246315 | 3239653183494694603 | 7510096332419948652 | moved / moved / moved |
| `onetaskgraph-linear-e2e:budgets` | yes | 10650920167812782133 | 10650920167812782133 (same) | 7964891988942143925 | 7470464312418336277 | 8189249694767916412 | moved / moved / moved |
| `onetaskgraph-linear-e2e:coverage` | no | 443396577108828321 | 443396577108828321 (same) | 10591553537363473196 | 16415416687547998516 | 12802051941818966174 | moved / moved / moved |
| `onetaskgraph-linear-e2e:format-check` | yes | 5017993576019305389 | 5017993576019305389 (same) | 10211190652416702929 | 15261533709691205541 | 8255756986668713958 | moved / moved / moved |
| `onetaskgraph-linear-e2e:lint` | yes | 3894773817040191992 | 3894773817040191992 (same) | 18252415520589528549 | 4302751596151043884 | 1905198887518084446 | moved / moved / moved |
| `onetaskgraph-linear-e2e:test` | yes | 10765792917979880844 | 10765792917979880844 (same) | 12159678698832527666 | 16248766366635062492 | 13757429712954852775 | moved / moved / moved |
| `onetaskgraph-linear-e2e:typecheck` | yes | 3800649662645589332 | 3800649662645589332 (same) | 13493447937679744427 | 358789815117133766 | 4971413633928888297 | moved / moved / moved |
| `onetaskgraph-linear:format-check` | yes | 11748130535769410667 | 11748130535769410667 (same) | 9185125591845539520 | 38312077983389289 | 7071327753346265117 | moved / moved / moved |
| `onetaskgraph-linear:lint` | yes | 7590110195068592152 | 7590110195068592152 (same) | 15289613544164299012 | 6891332769594046082 | 16135494803963453807 | moved / moved / moved |
| `onetaskgraph-linear:test` | yes | 3469429274551674859 | 3469429274551674859 (same) | 1008708238644393597 | 16040038260361473092 | 4848242063750585611 | moved / moved / moved |
| `onetaskgraph-linear:typecheck` | yes | 16884156262033767900 | 16884156262033767900 (same) | 4474722069441573805 | 14312091570011118383 | 11936318781908822311 | moved / moved / moved |
| `onetaskgraph-live-janitor:budgets` | yes | 5490531064570509297 | 5490531064570509297 (same) | 7267314538183101215 | 16247109845727953042 | 15943393393714644616 | moved / moved / moved |
| `onetaskgraph-live-janitor:coverage` | no | 11779118968320652724 | 11779118968320652724 (same) | 9471442444220318785 | 4951340733993150164 | 13611947356081028019 | moved / moved / moved |
| `onetaskgraph-live-janitor:format-check` | yes | 7728319618582576491 | 7728319618582576491 (same) | 7834868101349820276 | 10284989458646419233 | 15591670565614604293 | moved / moved / moved |
| `onetaskgraph-live-janitor:lint` | yes | 16747470129873650455 | 16747470129873650455 (same) | 5300088863107938727 | 6107483930488863233 | 3470099650569892755 | moved / moved / moved |
| `onetaskgraph-live-janitor:test` | yes | 15901508448328971947 | 15901508448328971947 (same) | 13268991264038537936 | 12938597244107157010 | 10784582918198513405 | moved / moved / moved |
| `onetaskgraph-live-janitor:typecheck` | yes | 7515487286265975339 | 7515487286265975339 (same) | 5773921439870471695 | 6200344193270973233 | 12341110784443936503 | moved / moved / moved |
| `onetaskgraph-live:coverage` | no | 11920932337436831346 | 11920932337436831346 (same) | 43812779966733687 | 9645317014564502773 | 13999833702313576902 | moved / moved / moved |
| `onetaskgraph-live:format-check` | yes | 17524069120817844219 | 17524069120817844219 (same) | 1421724127590076273 | 703064154341663445 | 3514867545772798638 | moved / moved / moved |
| `onetaskgraph-live:lint` | yes | 8058644649171375750 | 8058644649171375750 (same) | 17092593156239895575 | 16307155581485765190 | 2035580494355769823 | moved / moved / moved |
| `onetaskgraph-live:test` | yes | 15811145534893710066 | 15811145534893710066 (same) | 5810762229791024254 | 1137059908052666892 | 17558692563491565495 | moved / moved / moved |
| `onetaskgraph-live:typecheck` | yes | 6704929481053500239 | 6704929481053500239 (same) | 3561872181463932005 | 11773090921324176205 | 7105786018414350186 | moved / moved / moved |
| `onetaskgraph-local-md:coverage` | no | 15441737406547278834 | 15441737406547278834 (same) | 2801334829085595072 | 5753500206380403438 | 632585736675047144 | moved / moved / moved |
| `onetaskgraph-local-md:format-check` | yes | 5770437900451966891 | 5770437900451966891 (same) | 2200860512285638258 | 15006403693486013436 | 18089514306149935193 | moved / moved / moved |
| `onetaskgraph-local-md:lint` | yes | 7945229293888739706 | 7945229293888739706 (same) | 12145298818949908902 | 8396252530294703201 | 7740451171095911871 | moved / moved / moved |
| `onetaskgraph-local-md:test` | yes | 3752106017972911860 | 3752106017972911860 (same) | 12885229002907877784 | 1680421663736029993 | 14143982492879802318 | moved / moved / moved |
| `onetaskgraph-local-md:typecheck` | yes | 10667836675281539800 | 10667836675281539800 (same) | 15307306636943484702 | 17734095770673255243 | 11827788184991567379 | moved / moved / moved |
| `onetaskgraph-plugin-api:coverage` | no | 11666703231596840956 | 11666703231596840956 (same) | 1806714788186936344 | 14353033705129682296 | 12305368370021042435 | moved / moved / moved |
| `onetaskgraph-plugin-api:format-check` | yes | 2532836552003261132 | 2532836552003261132 (same) | 16424368295443256121 | 14249260482673388286 | 3229361666233479872 | moved / moved / moved |
| `onetaskgraph-plugin-api:lint` | yes | 12938420966898807567 | 12938420966898807567 (same) | 7316325792521040317 | 11594509730394752031 | 7940546505410987768 | moved / moved / moved |
| `onetaskgraph-plugin-api:test` | yes | 5182321245434274422 | 5182321245434274422 (same) | 3863655930200639710 | 15292162666791800560 | 15978257941645484812 | moved / moved / moved |
| `onetaskgraph-plugin-api:typecheck` | yes | 17292621578651533287 | 17292621578651533287 (same) | 8197043454192865062 | 9248136810764456337 | 4882777756327026409 | moved / moved / moved |
| `onetaskgraph-status-options-e2e:coverage` | no | 5718315887367705570 | 5718315887367705570 (same) | 6314933003359930233 | 11093427648321138786 | 13015284633813407054 | moved / moved / moved |
| `onetaskgraph-status-options-e2e:format-check` | yes | 5741231915202289567 | 5741231915202289567 (same) | 4896035829472582108 | 1125728747757317803 | 2140534959179327680 | moved / moved / moved |
| `onetaskgraph-status-options-e2e:lint` | yes | 16915609911261979815 | 16915609911261979815 (same) | 8972654957129163662 | 12333237308459136992 | 15570566022851093292 | moved / moved / moved |
| `onetaskgraph-status-options-e2e:test` | yes | 13660612302088176116 | 13660612302088176116 (same) | 6508625025654144786 | 6580208842686442129 | 7325340106500622849 | moved / moved / moved |
| `onetaskgraph-status-options-e2e:typecheck` | yes | 2372191017583423659 | 2372191017583423659 (same) | 9706078271012108850 | 10344295417915638629 | 4070648837735287558 | moved / moved / moved |
| `onetaskgraph-status-options:coverage` | no | 7377874738967381412 | 7377874738967381412 (same) | 16331049901853293637 | 2725863483684962153 | 6330439484974093841 | moved / moved / moved |
| `onetaskgraph-status-options:format-check` | yes | 1097871347641934939 | 1097871347641934939 (same) | 8913014647423524015 | 8061218456382021750 | 15165601787597522191 | moved / moved / moved |
| `onetaskgraph-status-options:lint` | yes | 13922981382486282659 | 13922981382486282659 (same) | 5097892655682295214 | 11197377988683354560 | 17966623418642391928 | moved / moved / moved |
| `onetaskgraph-status-options:test` | yes | 537644912619005779 | 537644912619005779 (same) | 16012778567982149464 | 18178663820792124718 | 17876416362669197345 | moved / moved / moved |
| `onetaskgraph-status-options:typecheck` | yes | 14757169209946573772 | 14757169209946573772 (same) | 13898331455617450191 | 3688546811914950896 | 17442371268633394899 | moved / moved / moved |
| `onetaskgraph:build` | no | 17228274135916823989 | 7478879194415989574 | 10821511903488420381 | 4025229742634894145 | 3069021569745661458 | moved / moved / moved |
| `onetaskgraph:coverage` | no | 13953307954812324083 | 13953307954812324083 (same) | 16140291022767819749 | 3522054129605191074 | 17839770182537717766 | moved / moved / moved |
| `onetaskgraph:format-check` | yes | 676255341903589276 | 676255341903589276 (same) | 7172320627649313852 | 15149253553469762402 | 11929655994292213667 | moved / moved / moved |
| `onetaskgraph:lint` | yes | 7180312716710693462 | 7180312716710693462 (same) | 11552310785865723070 | 2514206184640946094 | 11503864372341514497 | moved / moved / moved |
| `onetaskgraph:test` | yes | 3654261990014732968 | 3654261990014732968 (same) | 11097432119237465544 | 13935095042804066458 | 17217358325715283909 | moved / moved / moved |
| `onetaskgraph:typecheck` | yes | 9006657588092800032 | 9006657588092800032 (same) | 16023662173611598189 | 9530401954439496441 | 5201749262187634544 | moved / moved / moved |
| `pool-maintenance:coverage` | yes | 7597193620242622159 | 7597193620242622159 (same) | 8473051432742684940 | 1540145886579883585 | 16714874325380768211 | moved / moved / moved |
| `pool-maintenance:format-check` | yes | 3282228476475954851 | 3282228476475954851 (same) | 3282228476475954851 (same) | 3282228476475954851 (same) | 3282228476475954851 (same) | same / same / same |
| `pool-maintenance:lint` | yes | 3406749269402001744 | 3406749269402001744 (same) | 8363263339269765705 | 14044015729049664531 | 14306952939860399829 | moved / moved / moved |
| `pool-maintenance:test` | yes | 961106183633022969 | 961106183633022969 (same) | 8540586097797915725 | 12727954596770520781 | 11305744520507301768 | moved / moved / moved |
| `pool-maintenance:typecheck` | yes | 438827424490187034 | 438827424490187034 (same) | 9972828611670434736 | 10272954734975041857 | 2726430912514892612 | moved / moved / moved |
| `screenshots:coverage` | yes | 4868238179666524269 | 4868238179666524269 (same) | 255181998487166794 | 10437417662209934519 | 16496530990897620252 | moved / moved / moved |
| `screenshots:format-check` | yes | 7900268095302931831 | 7900268095302931831 (same) | 7900268095302931831 (same) | 7900268095302931831 (same) | 7900268095302931831 (same) | same / same / same |
| `screenshots:lint` | yes | 5658740296983314119 | 5658740296983314119 (same) | 7075523210775040998 | 7865677560214653476 | 7965351962694848318 | moved / moved / moved |
| `screenshots:test` | no | 13037691158155979525 | 13037691158155979525 (same) | 6578880096696007022 | 5926611201712944977 | 6621752595816751935 | moved / moved / moved |
| `screenshots:typecheck` | yes | 6935143223224538655 | 6935143223224538655 (same) | 9687879302767142157 | 11601138609322646292 | 11073229841091672068 | moved / moved / moved |
| `scripts:coverage` | yes | 12549568551382870847 | 12549568551382870847 (same) | 4405132792709083086 | 12367074525512115669 | 12814185902228030233 | moved / moved / moved |
| `scripts:distribution-check` | no | 16356366628152823635 | 16356366628152823635 (same) | 14652324860939562285 | 16356366628152823635 (same) | 16356366628152823635 (same) | moved / same / same |
| `scripts:distribution-test` | no | 10554708388007676393 | 10554708388007676393 (same) | 1743245750289269649 | 10554708388007676393 (same) | 10554708388007676393 (same) | moved / same / same |
| `scripts:format-check` | yes | 416002441604950320 | 416002441604950320 (same) | 416002441604950320 (same) | 416002441604950320 (same) | 416002441604950320 (same) | same / same / same |
| `scripts:lint` | yes | 12333400007265284750 | 12333400007265284750 (same) | 16425998614405906304 | 10276798347359738437 | 8052016079205305319 | moved / moved / moved |
| `scripts:test` | no | 5469990390936483498 | 5469990390936483498 (same) | 1272117423468214716 | 17119067340793136926 | 14153755572656684920 | moved / moved / moved |
| `scripts:typecheck` | yes | 15461131652757214435 | 15461131652757214435 (same) | 2845490172423098378 | 5223920835716104491 | 16757127221652132217 | moved / moved / moved |
| `sdk-python:coverage` | yes | 9715473863898956940 | 9715473863898956940 (same) | 17556016676827750705 | 4671192297476051936 | 5148487768801661030 | moved / moved / moved |
| `sdk-python:format-check` | yes | 1633174406420002474 | 1633174406420002474 (same) | 15249241861593165994 | 8039579131183854200 | 815091292437585910 | moved / moved / moved |
| `sdk-python:generate-check` | no | 9936209453268254390 | 6780660259937096048 | 3163761646174414248 | 14682663139050668616 | 5554878643144338552 | moved / moved / moved |
| `sdk-python:lint` | yes | 2138845961899854256 | 2138845961899854256 (same) | 3439638950652269408 | 16051986756371873066 | 6523290207553972793 | moved / moved / moved |
| `sdk-python:test` | yes | 11550169655499904281 | 11550169655499904281 (same) | 14529859867044733970 | 5041772049193995431 | 14461233075518088457 | moved / moved / moved |
| `sdk-python:test-uncovered` | no | 10954376324373254103 | 10954376324373254103 (same) | 15064277754190232179 | 4618720900539476411 | 7567900293078525088 | moved / moved / moved |
| `sdk-python:typecheck` | yes | 6076923958588935577 | 6076923958588935577 (same) | 16273334287369406274 | 16107069428691763081 | 15362192676669067188 | moved / moved / moved |
| `sdk-typescript:coverage` | yes | 9538243504383899695 | 9538243504383899695 (same) | 13367421977102666319 | 2169180347787733881 | 16595370315463295429 | moved / moved / moved |
| `sdk-typescript:format-check` | yes | 16651711344936195928 | 16651711344936195928 (same) | 1981699800376713240 | 15983652612929917597 | 8934768680464461958 | moved / moved / moved |
| `sdk-typescript:generate-check` | no | 5947438926679235059 | 15362563210903699808 | 16352961437005286032 | 18117982046842037693 | 18410463532099135884 | moved / moved / moved |
| `sdk-typescript:lint` | yes | 16190295833108277603 | 16190295833108277603 (same) | 18098921635321270077 | 16480425615976719032 | 116153766804353586 | moved / moved / moved |
| `sdk-typescript:test` | yes | 11829324425032315136 | 11829324425032315136 (same) | 17918105978706803296 | 16482285770479468836 | 6102057119159236894 | moved / moved / moved |
| `sdk-typescript:typecheck` | yes | 5092253254158670043 | 5092253254158670043 (same) | 4478022539471408769 | 9190201030817854609 | 1136397647695386407 | moved / moved / moved |
| `workspace:coverage` | no | 17775929920145583447 | 17775929920145583447 (same) | 5953612190671962302 | 441936720084146093 | 12712305397935767332 | moved / moved / moved |
| `workspace:coverage-clear` | no | 6358099278577324873 | 6358099278577324873 (same) | 1861677554055094728 | 8291135512143074187 | 6410115666675325724 | moved / moved / moved |
| `workspace:deny` | no | 17752347619715721454 | 17752347619715721454 (same) | 9635080448190576768 | 4111572824329165202 | 11837625672257001716 | moved / moved / moved |
| `workspace:format-check` | yes | 6293631054785169364 | 6293631054785169364 (same) | 15763360512395023239 | 17887396146748837624 | 14185708351606372361 | moved / same / moved |
| `workspace:lint` | yes | 15290557135474026805 | 15290557135474026805 (same) | 536300251176273272 | 16828222708907608622 | 18000208641985352886 | moved / moved / moved |
| `workspace:test` | no | 4782478976376105524 | 4782478976376105524 (same) | 1609457773503211829 | 14587910144768953150 | 5987856074627770628 | moved / moved / moved |
| `workspace:test-uncovered` | yes | 6399610153157622842 | 6399610153157622842 (same) | 15332207304123823256 | 13183714947613980288 | 6246334725201996975 | moved / moved / moved |
| `workspace:typecheck` | yes | 9008904970286128041 | 9008904970286128041 (same) | 2616702358135295247 | 12647412914557425832 | 3033977251560027660 | moved / same / same |


## 4. Tests that read the package version

Searches run in `clone/`:
- `git grep -n -F '0.13.3' -- ':!*CHANGELOG.md' ':!Cargo.lock'`
- `git grep -n CARGO_PKG_VERSION`, `git grep -n WORKSPACE_VERSION`
- `git grep -nE '__version__|\bVERSION\b' -- sdks`
- `git grep -nE '\-\-version' -- crates sdks screenshots pool-maintenance .github/policy .github/tests scripts/*.py scripts/test-*.sh`
- `git grep -nE '(Cargo\.toml|package\.json|pyproject\.toml|Cargo\.lock|uv\.lock|bun\.lock)' -- crates/*/tests/** crates/*/src/** sdks/*/tests/** screenshots/** pool-maintenance/**`
- `git grep -lE 'CHANGELOG' -- ':!*.md'`
- `git grep -lnE "product_versions|set-version|workspace\.package|readFileSync\(...(Cargo\.toml|package\.json|pyproject)|CARGO_PKG_VERSION|__version__|\bVERSION\b"` over `.github`, `scripts`, `crates` and others

**In cacheable targets:**

| test (file :: name) | Nx target(s) | how it depends on the version | sound under `versionFree`? |
|---|---|---|---|
| `sdks/typescript/tests/version.test.ts` :: "the exported version matches the published package version" | `sdk-typescript:test` (win, mac), `sdk-typescript:coverage` (linux) | agreement `VERSION == package.json.version` | yes: a disagreement is left unmasked (half-bump variant moves it) |
| `sdks/typescript/tests/version.test.ts` :: "the version is a plain semantic version" | same | format of V | yes: `version-shape` line (pre-release variant moves it) |
| `sdks/python/tests/test_client.py::test_distribution_version` | `sdk-python:test` (win, mac), `sdk-python:coverage` (linux) | agreement `__version__ == pyproject version` | yes |
| `sdks/python/tests/test_version.py::test_the_version_is_a_plain_semantic_version` | same | format of V | yes |
| `crates/onetaskgraph-e2e/tests/e2e/surface.rs::version_reports_the_crate_version_on_stdout_and_exits_zero` | `onetaskgraph-e2e:test` (win, mac); `onetaskgraph-e2e:coverage` (linux, uncached) | `--version` output == `env!("CARGO_PKG_VERSION")`, both compiled from one manifest | yes: holds for any V |

Read the version, but the result does not depend on its value:
- `crates/onetaskgraph-linear-e2e/tests/e2e/health.rs::every_health_read_through_the_plugin_host_reaches_linear_with_the_cache_on_or_off` sends `env!("CARGO_PKG_VERSION")` in a handshake.
- `crates/onetaskgraph-github-projects/tests/journey/quota.rs` (`onetaskgraph-github-projects:test`) and the `onetaskgraph-github-projects-e2e` live/budget runners (`live.rs`, `live_pair.rs`, `e2e/budget_runner.rs`) record `WORKSPACE_VERSION` into a live session and compare it with the same build's value.
- `crates/onetaskgraph-core/tests/plugin_features.rs` (`onetaskgraph-core:test`/`test-uncovered`) copies the workspace `Cargo.lock` next to a path dependency, so it relies on the lock agreeing with the path crates' versions.
- `crates/onetaskgraph-linear-e2e/tests/e2e/budget_commands.rs::the_reporter_is_the_release_of_the_onebudgetspec_that_judges_it` reads the raw root `Cargo.toml`/`package.json`, but for the onebudgetspec pin, not V. Those lines are kept by the digest.

In uncached targets (they always re-run, so cache keys do not matter for them): `scripts:distribution-check` (`set-version.sh --check`), `scripts:test` (`check-workspace-config-enforced.sh`, `check-release-pr-sync.sh` and others), `github-workflows:cd-journeys` (`.github/tests/release-cd.test.mjs` reads `npm/cli/package.json` version; `release-plz.test.mjs`), and `github-workflow-policy:policy-tests` (`policy.test.mjs` over `product_versions`).

**Timings** (targeted local runs, this host; CI from run 41606565192, the last non-release PR run, all four jobs green. Per-task CI time is approximated from the stream log's line timestamps, from `> nx run <task>` to that project's last output line (`tools/task-times.py`, `ci/task-times-*.tsv`); it includes compile time):

| project | version tests' run time (local) | whole target in CI |
|---|---|---|
| sdk-typescript | `bun test tests/version.test.ts`: 2 tests, 177 / 204 / 174 ms across the file (3 runs) | `sdk-typescript:test` win 130.7 s, mac 83.6 s; `sdk-typescript:coverage` linux 131.3 s |
| sdk-python | 2 tests: each call < 0.005 s (pytest `--durations`); session 13.94 / 4.98 / 0.55 s including import and collection | `sdk-python:test` win 224.9 s, mac 109.6 s; `sdk-python:coverage` linux 316.4 s |
| onetaskgraph-e2e | 1 test: `finished in 0.01s` (cargo test 0.49 s wall after a 273.5 s cold build of `onetaskgraph-e2e` tests + the binary) | `onetaskgraph-e2e:test` win 580.0 s, mac 94.0 s; linux coverage: not measurable from the log (its output is silent, so the parser reads 0) |

Job step "Test the affected projects" in that run: test-linux 1,541 s, test-windows 1,771 s, test-macos 766 s.

**What still re-runs on a release PR if the version-reading tests keep the version as a raw input:**
- `sdk-typescript:test`/`coverage`, `sdk-python:test`/`coverage` and `onetaskgraph-e2e:test` (its `coverage` is uncached anyway).
- Every task that depends on them: `workspace:*`, through `^default`. The `workspace` tasks are mostly uncached, but `workspace:test-uncovered`, `lint`, `typecheck` and `format-check` are cacheable.

The `CARGO_PKG_VERSION` case is different: it is compiled in, so keeping the crate's version would mean keeping `Cargo.toml` raw for `onetaskgraph-e2e` and everything above it.

**Is a separate cached target worth it? No.** The version tests take under 0.5 s against 84–580 s per target. They are agreement and format checks, which the masked digest already keeps sound: the half-bump and format variants move them. Splitting them out would save nothing that the definition does not already save.

## Other findings relevant to the plan

- **These tasks can never hit across CI runs:** `onetaskgraph-github-projects:test` takes `env:GITHUB_RUN_ID` and `env:GITHUB_RUN_ATTEMPT`, and it plus `onetaskgraph-github-projects-e2e:test`/`budgets` take `env:GITHUB_LIVE_SESSION_ID` and `GITHUB_LIVE_SOURCE_REVISION`. These values differ every run wherever they are set. Credential env inputs (`GH_PROJECTS_TOKEN`, `LINEAR_API_KEY`) also split linux from win/mac.
- 37 of the 147 tasks are uncached by design, including all Rust `coverage` (Linux runs the crates' tests only as coverage). The cache therefore cannot shorten test-linux's crate tests at all unless that changes.
- GitHub API use by this agent: about 10 REST reads (run list, jobs, 3 job logs, rate_limit). Core remaining at the last check: 4,628.

## Raw records in this directory

`main.json`, `main-recapture.json`, `orig-release.json`, `pre-v0.13.3.json`, `orig-{source,dep-cargo,dep-npm}.json`, `def-{main,release,source,dep-cargo,dep-npm,halfbump,prerelease}.json`, `def-pre-v0.13.3.json`; diffs `diff-*.txt`; `explain-*.tsv`; edit diffs `release-edits.diff`, `real-release-v0.13.3.diff`, `definition.diff`, `variant-*.diff`; `digest-main.txt` (the runtime input's output on main); `sel/`, `projects/`, `ci/` (job logs, job JSON, task times), `timing/`.
