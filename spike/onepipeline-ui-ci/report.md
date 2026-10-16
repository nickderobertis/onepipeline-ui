# Spike `spike-onepipeline-ui-ci`

- **Branch:** `nick/ci-time-budgets-wave1/spike-onepipeline-ui-ci`

## Harness

On branch `nick/ci-time-budgets-wave1/spike-onepipeline-ui-ci`, directory `spike/onepipeline-ui-ci/` (throwaway; nothing there lands).

- **The one command** — `measure.py`. Given a repository and a start date it reads the repository's Actions runs (in 3-day `created` slices, under the 1,000-result cap a filtered list has), the jobs of every run's latest attempt, and its closed pull requests, all through `gh api --method GET`, and writes the per-job, per-run and per-PR cycle-time figures as one JSON document. The fetch was: `python3 -I spike/onepipeline-ui-ci/measure.py --repo nickderobertis/onepipeline-ui --since 2026-09-15 --raw spike/onepipeline-ui-ci/raw --out spike/onepipeline-ui-ci/figures.json --job-run-budget 1200`. It ran three times, resuming from its cache: the first run stopped at the quota floor, the second on a transient `rate_limit` read failure. **The report's figures are the output of** `python3 -I spike/onepipeline-ui-ci/measure.py --repo nickderobertis/onepipeline-ui --since 2026-09-15 --raw spike/onepipeline-ui-ci/raw --out spike/onepipeline-ui-ci/figures.json --offline --shape-since 2026-10-13T22:56:32Z`, which is the same command reading the cache offline. Its output is `spike/onepipeline-ui-ci/figures.json`, and `current_shape` inside it holds the same figures for runs created on or after 2026-10-13T22:56:32Z.
- **Request log and quota guard** — `ghread.py`. Before every REST request it asks `gh api rate_limit` (which does not count against the core quota) for the core requests remaining, writes that figure into `request-log.jsonl`, and refuses the request if the figure is below 2,500 or 3,000 requests have already been made.
- **Raw responses** — `raw.tar.xz` holds every response the harness read, verbatim: 1,149 runs, the jobs of all 1,149, 2 pages of pull requests, 12 job logs, plus `git-tags.json`. That last file is the only input that is not a REST response; it records, from the local clone, which tag first contains each merge commit. To reproduce: `tar xJf spike/onepipeline-ui-ci/raw.tar.xz -C spike/onepipeline-ui-ci`, then run the command above. That reproduces `figures.json` exactly; this was checked by diffing a re-run in a scratch directory. `sample/raw/` is a smaller verbatim subset for PR #339 and release v0.36.1: running `python3 -I spike/onepipeline-ui-ci/measure.py --repo nickderobertis/onepipeline-ui --since 2026-09-15 --raw spike/onepipeline-ui-ci/sample/raw --out /tmp/sample.json --offline` reproduces PR #339's two phases (checks 2577 s, merge→release 6671 s), and v0.36.1's CD job count (43) and longest job (Release / test, 2,320 s), identical to the full figures. It also gives every job duration of Release run 38706388926.
- **Helpers** (not the budget command): `ci_logs.py`, which reads per-Nx-invocation and per-test-runner timings out of 12 CI job logs into `ci-logs.json`; `local_profile.py`, which times one of the repository's own recipes and reads Nx's own task history into `local/*.json`; `tables.py`; `report_answers.py`, which renders this report's answers from those outputs.
- **Required-checks snapshot** — `required-status-checks.json`: GitHub's response to `GET repos/nickderobertis/onepipeline-ui/branches/main/protection/required_status_checks`, with `taken_at` added.

How the budget node can grow it: `measure.py`'s `analyse()` already computes the measures for `ci-check-time` (`per_pr_head_commit.ci_longest_job_s`), `cd-job-time` (`per_release_cd.longest_job_s`), `release-cycle-time` (`cycle_time.per_release_max_total_s`), `ci-job-count` (`per_pr_head_commit.jobs_executed`) and `cd-job-count` (`per_release_cd.job_count`), each for one unit. A onebudgetspec command can call it on the runs for one head commit or one release. `gate-time` is `local_profile.py --label gate -- just check`, plus the judge tier.

## Method

**Systems and window.** GitHub's REST API, read through this host's `gh` authentication, with `gh api --method GET` only. Repository `nickderobertis/onepipeline-ui`, every run of `CI`, `Release-plz`, `Release`, `Published smoke`, `Visual docs` and `notignored` created from 2026-09-15 to 2026-10-16 00:04 UTC. That is 1149 runs, by workflow and event: CI / pull_request 219, CI / push 140, Published smoke / workflow_run 66, Release / release 54, Release-plz / push 140, Visual docs / pull_request 319, Visual docs / push 121, Visual docs / schedule 1, notignored / pull_request 89. `pages-build-deployment` is excluded. **No sampling:** jobs were read for all 1149 runs, along with 199 closed pull requests. REST requests made: 1186, including 1 made by hand before the logger existed, which is recorded in the log with the quota read immediately before it. The lowest core quota reported before any request was 2504; 1 further request was refused at the floor (2,499 < 2,500) and made after the hourly reset. The quota is shared with the other spikes on this host: between the first request and the floor, core quota fell 2320 while this spike made 551 requests.

**Definitions.** All of these are in `measure.py`.
- A job's duration is `started_at` → `completed_at`.
- Queue wait is the run's `created_at` → the job's `started_at`, or `run_started_at` for a re-run attempt. It therefore includes time held behind a `needs` edge.
- Duration distributions are taken over successful jobs. Failed and cancelled jobs are counted separately.
- An executed job is one that is not skipped and was given a runner. Jobs cancelled while still queued are excluded.
- p90 is the nearest-rank p90.
- A PR head commit's runs are the pull_request-event runs on the PR's final head SHA created before `merged_at`. This drops the visual-docs `closed` run. The latest run per workflow is used.
- A release's CD is: the push runs on the tag's commit (CI, Release-plz, Visual docs on the release-PR merge), the `release`-event Release run for that tag, and the first Published smoke `workflow_run` run created within 30 minutes after that Release run completed.
- Cycle time covers every non-release PR merged in the window. The first tag containing the merge commit comes from the local clone's history.

**Two shapes.** The workflows changed shape during the window: #244 split the test tiers and added `sweep` (10-07), and #315 consolidated macOS (10-13). So every figure is given twice. *Window* covers every run since 2026-09-15. *Current shape* covers runs created since 2026-10-13T22:56:32Z (#315), which is only 4 releases (v0.34.1–v0.36.1) and 6 PR head commits. Current-shape distributions are therefore thin: they describe today's workflows, and the window describes their history.

**CI's own per-target timings** come from 12 job logs read on 2026-10-16: the newest 3 successful `quality`, `sweep`, `cross (windows-latest)` and Release `test` jobs since #315. From each log the harness took what Nx and the runners print themselves: each Nx invocation's `Run duration`, the critical-path tasks Nx names, nextest `Summary [ Ns ]` lines, the Playwright `passed (…)` total and the Vitest `Duration`. CI's nextest profiles print failures only, so **CI per-test durations are not observable; this report has none.**

**Local profile — the limits matter.** This host is Linux aarch64 with 14 cores and 29 GB. Load average was 9 when the profile started and **27–55 for most of it**, because other repositories' gates were running on the same host. Local figures are therefore inflated well past CI's: repo-tooling `test` took 15,778 s locally against CI's 944–1,287 s critical path. They are useful for ordering and for cold/warm ratios, not as absolute CI predictions.
- The spike's own files under `spike/` were kept out of Nx's file hashing during the profile by an untracked `.nxignore` (`spike/`), so the profiled tree hashed as ecb96f6. That file was removed afterwards and never committed.
- *Cold* means no Nx cache (the session clone's cache held only what bootstrap built) and a cargo `target/` holding only bootstrap's debug build. The cold `just check` stopped at its `test` recipe. `dag-ui:test` and `dag-ui-e2e:test` failed on timeouts under load and passed on re-run, which Nx reports as flaky. `github-workflows:test` failed, and that failure was caused by this profile: the profiler's log was growing inside the checkout, and `.github/workflow-graph.mjs`'s `digest()` hashes every untracked file. Its later runs, with the log kept outside the tree, passed. `test-baseline`, `test-cost` and `doc` were therefore timed cold as separate invocations of their own recipes.
- *Warm* means the same tree again, with the Nx cache those runs left. The first warm `just check` (`check-warm-1`) also failed on `github-workflows:budgets`, for the same digest reason; `check-warm-2` passed with exit 0.
- `check-affected` was profiled on PR #339's diff (5a2daca..cd4be04, a deps bump that affects 8 of the 15 projects, which is the commonest PR shape here). It used the command `just check-affected` execs, with the base and head named explicitly so the spike's own commits did not enter the diff: once with Nx's `--skip-nx-cache` (Nx cold, cargo warm, which is the state CI's rust-cache leaves) and once warm.
- The judged tier `lint-llm-diff` was **not run locally**, by manager ruling. `gate-time` is `just check`'s local wall clock plus the judge's wall clock **as CI measured it** (the `llmlint` job).

**Per job and matrix leg — window (every run since 2026-09-15).** Durations are over successful jobs.

| Workflow | Event | Job / matrix leg | OS | n ok | median s | p90 s | max s | queue median s | queue p90 s | queue max s | failed | cancelled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CI | pull_request | browser-windows | windows | 86 | 107 | 126 | 195 | 3 | 75 | 263 | 1 | 0 |
| CI | pull_request | changes | linux | 219 | 20 | 24 | 39 | 3 | 54 | 863 | 0 | 0 |
| CI | pull_request | cross (macos-latest) | linux,macos | 175 | 877 | 1202 | 1654 | 40 | 3229 | 13937 | 28 | 16 |
| CI | pull_request | cross (windows-latest) | windows | 183 | 1283 | 1714 | 2260 | 27 | 74 | 888 | 22 | 14 |
| CI | pull_request | deny | linux | 213 | 30 | 38 | 72 | 27 | 92 | 812 | 6 | 0 |
| CI | pull_request | gate | linux | 175 | 5 | 729 | 1378 | 1133 | 1653 | 2196 | 43 | 1 |
| CI | pull_request | install | – | 0 | – | – | – | – | – | – | 0 | 16 |
| CI | pull_request | install (macos-latest) | linux,macos | 158 | 270 | 705 | 891 | 1354 | 7391 | 22844 | 17 | 9 |
| CI | pull_request | install (ubuntu-latest) | linux | 173 | 192 | 475 | 600 | 1140 | 1652 | 2327 | 0 | 2 |
| CI | pull_request | install (windows-latest) | windows | 172 | 407 | 823 | 1156 | 1138 | 1625 | 2221 | 0 | 3 |
| CI | pull_request | llmlint | linux | 212 | 182 | 304 | 643 | 3 | 57 | 613 | 5 | 2 |
| CI | pull_request | macos | macos | 1 | 1928 | 1928 | 1928 | 5498 | 5498 | 5498 | 0 | 15 |
| CI | pull_request | msrv | linux | 217 | 51 | 86 | 237 | 27 | 94 | 982 | 2 | 0 |
| CI | pull_request | pr-title | linux | 219 | 4 | 5 | 40 | 3 | 69 | 895 | 0 | 0 |
| CI | pull_request | quality | linux | 137 | 1195 | 1665 | 2191 | 3 | 58 | 474 | 21 | 15 |
| CI | pull_request | sweep | linux | 23 | 1800 | 2073 | 2537 | 18 | 184 | 775 | 0 | 0 |
| CI | pull_request | wheel (aarch64-unknown-linux-gnu) | linux-arm64 | 167 | 441 | 501 | 578 | 30 | 95 | 897 | 1 | 5 |
| CI | pull_request | wheel (x86_64-unknown-linux-gnu) | linux | 166 | 526 | 607 | 675 | 27 | 109 | 1421 | 1 | 6 |
| CI | push | browser-windows | windows | 38 | 102 | 138 | 162 | 3 | 2959 | 6880 | 0 | 0 |
| CI | push | changes | linux | 133 | 10 | 17 | 43 | 3 | 101 | 6878 | 0 | 0 |
| CI | push | cross (macos-latest) | linux,macos | 130 | 820 | 1146 | 1661 | 40 | 3262 | 11456 | 1 | 2 |
| CI | push | cross (windows-latest) | windows | 132 | 1198 | 1662 | 2177 | 16 | 139 | 6893 | 0 | 1 |
| CI | push | deny | linux | 132 | 29 | 37 | 61 | 17 | 225 | 6894 | 1 | 0 |
| CI | push | gate | linux | 122 | 5 | 759 | 1429 | 1196 | 1755 | 7982 | 11 | 0 |
| CI | push | install | – | 0 | – | – | – | – | – | – | 0 | 1 |
| CI | push | install (macos-latest) | linux,macos | 114 | 258 | 690 | 847 | 1332 | 6076 | 13850 | 1 | 8 |
| CI | push | install (ubuntu-latest) | linux | 122 | 170 | 486 | 609 | 1198 | 1755 | 7982 | 0 | 0 |
| CI | push | install (windows-latest) | windows | 118 | 368 | 790 | 1089 | 1196 | 1899 | 7982 | 0 | 4 |
| CI | push | msrv | linux | 132 | 57 | 178 | 226 | 16 | 157 | 6893 | 1 | 0 |
| CI | push | quality | linux | 92 | 1202 | 1619 | 1949 | 3 | 559 | 6878 | 7 | 1 |
| CI | push | wheel (aarch64-unknown-linux-gnu) | linux-arm64 | 99 | 438 | 501 | 765 | 20 | 811 | 6896 | 0 | 1 |
| CI | push | wheel (x86_64-unknown-linux-gnu) | linux | 99 | 526 | 574 | 677 | 19 | 915 | 6894 | 0 | 1 |
| Published smoke | workflow_run | npm (macos-15-intel) | macos | 53 | 17 | 25 | 40 | 21 | 1749 | 5080 | 6 | 0 |
| Published smoke | workflow_run | npm (macos-latest) | macos | 56 | 11 | 14 | 80 | 26 | 2426 | 4840 | 3 | 0 |
| Published smoke | workflow_run | npm (ubuntu-latest) | linux | 60 | 8 | 12 | 15 | 3 | 4 | 1309 | 5 | 0 |
| Published smoke | workflow_run | npm (windows-latest) | windows | 58 | 26 | 39 | 64 | 3 | 5 | 1309 | 7 | 0 |
| Published smoke | workflow_run | probe | linux | 64 | 8 | 11 | 17 | 3 | 4 | 1310 | 1 | 0 |
| Published smoke | workflow_run | pypi (macos-15-intel) | macos | 59 | 17 | 27 | 49 | 25 | 1489 | 3443 | 0 | 0 |
| Published smoke | workflow_run | pypi (macos-latest) | macos | 59 | 11 | 14 | 18 | 23 | 2479 | 10419 | 0 | 0 |
| Published smoke | workflow_run | pypi (ubuntu-latest) | linux | 65 | 8 | 11 | 15 | 3 | 5 | 1309 | 0 | 0 |
| Published smoke | workflow_run | pypi (windows-latest) | windows | 65 | 19 | 26 | 30 | 3 | 6 | 1310 | 0 | 0 |
| Published smoke | workflow_run | report a failure | linux | 15 | 7 | 8 | 8 | 53 | 259 | 353 | 0 | 0 |
| Release | release | build-npm (aarch64-apple-darwin) | macos | 47 | 636 | 758 | 1035 | 1859 | 12872 | 21832 | 0 | 0 |
| Release | release | build-npm (aarch64-unknown-linux-gnu) | linux-arm64 | 51 | 408 | 469 | 494 | 1516 | 1809 | 2520 | 0 | 0 |
| Release | release | build-npm (x86_64-apple-darwin) | macos | 47 | 607 | 800 | 972 | 1897 | 12876 | 22318 | 0 | 0 |
| Release | release | build-npm (x86_64-pc-windows-msvc) | windows | 49 | 844 | 1170 | 1231 | 1501 | 1820 | 2518 | 2 | 0 |
| Release | release | build-npm (x86_64-unknown-linux-gnu) | linux | 51 | 486 | 581 | 618 | 1515 | 1807 | 2518 | 0 | 0 |
| Release | release | build-wheels (aarch64-apple-darwin) | macos | 47 | 599 | 749 | 947 | 1770 | 10157 | 25033 | 0 | 0 |
| Release | release | build-wheels (aarch64-unknown-linux-gnu) | linux-arm64 | 50 | 431 | 498 | 545 | 1514 | 1809 | 2520 | 1 | 0 |
| Release | release | build-wheels (x86_64-apple-darwin) | macos | 47 | 633 | 763 | 1060 | 1680 | 17078 | 28871 | 0 | 0 |
| Release | release | build-wheels (x86_64-pc-windows-msvc) | windows | 49 | 835 | 1111 | 1214 | 1501 | 1820 | 2728 | 2 | 0 |
| Release | release | build-wheels (x86_64-unknown-linux-gnu) | linux | 50 | 510 | 586 | 640 | 1534 | 1807 | 2781 | 1 | 0 |
| Release | release | darwin | macos | 3 | 594 | 842 | 842 | 4443 | 7524 | 7524 | 1 | 0 |
| Release | release | guard | linux | 54 | 3 | 4 | 8 | 3 | 7 | 97 | 0 | 0 |
| Release | release | publish-crate | linux | 51 | 207 | 225 | 263 | 1514 | 1806 | 2741 | 0 | 0 |
| Release | release | publish-npm | linux | 48 | 58 | 68 | 80 | 2843 | 19675 | 23029 | 0 | 0 |
| Release | release | publish-pypi | linux | 47 | 26 | 35 | 134 | 2656 | 18020 | 29626 | 0 | 0 |
| Release | release | release-status | linux | 14 | 6 | 7 | 13 | 2425 | 33361 | 35188 | 40 | 0 |
| Release | release | test | linux | 51 | 1561 | 1801 | 2431 | 3 | 5 | 85 | 3 | 0 |
| Release | release | upload (aarch64-apple-darwin) | macos | 47 | 578 | 753 | 963 | 1775 | 14964 | 21120 | 0 | 0 |
| Release | release | upload (aarch64-unknown-linux-gnu) | linux-arm64 | 51 | 396 | 458 | 489 | 1503 | 1809 | 2601 | 0 | 0 |
| Release | release | upload (x86_64-apple-darwin) | macos | 47 | 597 | 712 | 908 | 1770 | 17005 | 23048 | 0 | 0 |
| Release | release | upload (x86_64-pc-windows-msvc) | windows | 49 | 828 | 1058 | 1164 | 1501 | 1820 | 2778 | 2 | 0 |
| Release | release | upload (x86_64-unknown-linux-gnu) | linux | 51 | 485 | 554 | 621 | 1514 | 1808 | 2518 | 0 | 0 |
| Release | release | upload-darwin | linux | 3 | 7 | 10 | 10 | 5287 | 8120 | 8120 | 0 | 0 |
| Release | release | verify-assets (aarch64-apple-darwin) | macos | 45 | 9 | 11 | 13 | 2874 | 29118 | 37259 | 0 | 0 |
| Release | release | verify-assets (aarch64-unknown-linux-gnu) | linux-arm64 | 48 | 6 | 7 | 57 | 2760 | 20133 | 23772 | 1 | 0 |
| Release | release | verify-assets (x86_64-unknown-linux-gnu) | linux | 49 | 7 | 8 | 10 | 2824 | 20130 | 23770 | 0 | 0 |
| Release | release | verify-npm (macos-15-intel) | macos | 35 | 19 | 92 | 399 | 3351 | 20231 | 24730 | 10 | 0 |
| Release | release | verify-npm (macos-latest) | macos | 37 | 12 | 150 | 395 | 3444 | 32263 | 34044 | 8 | 0 |
| Release | release | verify-npm (ubuntu-latest) | linux | 21 | 84 | 265 | 450 | 2462 | 11336 | 22743 | 27 | 0 |
| Release | release | verify-npm (windows-latest) | windows | 17 | 156 | 410 | 412 | 2437 | 19735 | 22745 | 31 | 0 |
| Release | release | verify-pypi (macos-15-intel) | macos | 43 | 17 | 26 | 69 | 2926 | 19340 | 32710 | 1 | 0 |
| Release | release | verify-pypi (macos-latest) | macos | 42 | 11 | 16 | 31 | 2846 | 24549 | 35175 | 1 | 1 |
| Release | release | verify-pypi (ubuntu-latest) | linux | 46 | 13 | 18 | 29 | 2731 | 18053 | 29654 | 1 | 0 |
| Release | release | verify-pypi (windows-latest) | windows | 46 | 24 | 33 | 51 | 2731 | 18053 | 29654 | 1 | 0 |
| Release-plz | push | guard | linux | 140 | 3 | 4 | 10 | 3 | 4 | 385 | 0 | 0 |
| Release-plz | push | release-plz | linux | 123 | 54 | 200 | 249 | 8 | 11 | 1349 | 17 | 0 |
| Visual docs | pull_request | visual-docs / aggregate-comment | – | 0 | – | – | – | – | – | – | 0 | 10 |
| Visual docs | pull_request | visual-docs / arches | linux | 193 | 6 | 8 | 16 | 9 | 44 | 637 | 0 | 2 |
| Visual docs | pull_request | visual-docs / capture | – | 0 | – | – | – | – | – | – | 0 | 2 |
| Visual docs | pull_request | visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs) | linux | 180 | 833 | 863 | 1639 | 18 | 56 | 867 | 4 | 8 |
| Visual docs | pull_request | visual-docs / cleanup-preview | linux | 123 | 8 | 10 | 42 | 9 | 13 | 1009 | 1 | 2 |
| Visual docs | pull_request | visual-docs / deploy-pages | linux | 177 | 51 | 82 | 559 | 883 | 1136 | 2158 | 1 | 12 |
| Visual docs | pull_request | visual-docs / pages-preflight | linux | 317 | 3 | 4 | 5 | 3 | 11 | 1137 | 0 | 2 |
| Visual docs | pull_request | visual-docs / prune-history | – | 0 | – | – | – | – | – | – | 0 | 2 |
| Visual docs | pull_request | visual-docs / report | – | 0 | – | – | – | – | – | – | 0 | 10 |
| Visual docs | pull_request | visual-docs / report (x86_64, shots/current, shots/verify, Visual docs) | linux | 176 | 18 | 22 | 197 | 861 | 1087 | 1989 | 3 | 0 |
| Visual docs | push | visual-docs / aggregate-comment | – | 0 | – | – | – | – | – | – | 0 | 81 |
| Visual docs | push | visual-docs / arches | linux | 40 | 6 | 8 | 11 | 25 | 56 | 219 | 0 | 81 |
| Visual docs | push | visual-docs / capture | – | 0 | – | – | – | – | – | – | 0 | 81 |
| Visual docs | push | visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs) | linux | 40 | 827 | 865 | 2015 | 33 | 66 | 333 | 0 | 0 |
| Visual docs | push | visual-docs / cleanup-preview | – | 0 | – | – | – | – | – | – | 0 | 79 |
| Visual docs | push | visual-docs / deploy-pages | linux | 40 | 11 | 15 | 145 | 884 | 1147 | 2148 | 0 | 81 |
| Visual docs | push | visual-docs / pages-preflight | linux | 42 | 3 | 4 | 5 | 18 | 22 | 144 | 0 | 79 |
| Visual docs | push | visual-docs / prune-history | – | 0 | – | – | – | – | – | – | 0 | 79 |
| Visual docs | push | visual-docs / report | – | 0 | – | – | – | – | – | – | 0 | 81 |
| Visual docs | push | visual-docs / report (x86_64, shots/current, shots/verify, Visual docs) | linux | 40 | 12 | 15 | 23 | 868 | 1137 | 2126 | 0 | 0 |
| Visual docs | schedule | visual-docs / pages-preflight | linux | 1 | 2 | 2 | 2 | 3 | 3 | 3 | 0 | 0 |
| Visual docs | schedule | visual-docs / prune-history | linux | 1 | 11 | 11 | 11 | 7 | 7 | 7 | 0 | 0 |
| notignored | pull_request | suppressions | linux | 87 | 9 | 11 | 19 | 3 | 27 | 377 | 2 | 0 |

**Per job and matrix leg — current shape (since #315).**

| Workflow | Event | Job / matrix leg | OS | n ok | median s | p90 s | max s | queue median s | queue p90 s | queue max s | failed | cancelled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CI | pull_request | browser-windows | windows | 12 | 106 | 117 | 129 | 3 | 75 | 87 | 0 | 0 |
| CI | pull_request | changes | linux | 12 | 14 | 16 | 22 | 3 | 75 | 450 | 0 | 0 |
| CI | pull_request | cross (macos-latest) | linux | 5 | 7 | 7 | 7 | 1595 | 7428 | 7428 | 7 | 0 |
| CI | pull_request | cross (windows-latest) | windows | 10 | 1764 | 2238 | 2260 | 20 | 120 | 707 | 1 | 1 |
| CI | pull_request | deny | linux | 10 | 34 | 37 | 38 | 24 | 231 | 771 | 2 | 0 |
| CI | pull_request | gate | linux | 11 | 4 | 6 | 7 | 1512 | 1735 | 2152 | 1 | 0 |
| CI | pull_request | install | – | 0 | – | – | – | – | – | – | 0 | 1 |
| CI | pull_request | install (macos-latest) | linux | 5 | 6 | 9 | 9 | 1604 | 7428 | 7428 | 7 | 0 |
| CI | pull_request | install (ubuntu-latest) | linux | 11 | 334 | 569 | 600 | 1512 | 1735 | 2327 | 0 | 0 |
| CI | pull_request | install (windows-latest) | windows | 10 | 674 | 1110 | 1156 | 1494 | 1625 | 2221 | 0 | 1 |
| CI | pull_request | llmlint | linux | 12 | 210 | 321 | 323 | 3 | 75 | 613 | 0 | 0 |
| CI | pull_request | macos | macos | 1 | 1928 | 1928 | 1928 | 5498 | 5498 | 5498 | 0 | 7 |
| CI | pull_request | msrv | linux | 12 | 54 | 85 | 86 | 24 | 271 | 740 | 0 | 0 |
| CI | pull_request | pr-title | linux | 12 | 4 | 5 | 5 | 3 | 78 | 369 | 0 | 0 |
| CI | pull_request | quality | linux | 11 | 1506 | 1663 | 1665 | 3 | 75 | 474 | 0 | 1 |
| CI | pull_request | sweep | linux | 4 | 2233 | 2537 | 2537 | 101 | 775 | 775 | 0 | 0 |
| CI | pull_request | wheel (aarch64-unknown-linux-gnu) | linux-arm64 | 12 | 521 | 526 | 535 | 31 | 95 | 498 | 0 | 0 |
| CI | pull_request | wheel (x86_64-unknown-linux-gnu) | linux | 12 | 626 | 657 | 675 | 20 | 219 | 769 | 0 | 0 |
| CI | push | browser-windows | windows | 10 | 104 | 142 | 157 | 4 | 290 | 406 | 0 | 0 |
| CI | push | changes | linux | 10 | 15 | 17 | 20 | 6 | 452 | 1142 | 0 | 0 |
| CI | push | cross (macos-latest) | linux | 9 | 7 | 10 | 10 | 1575 | 3262 | 3262 | 1 | 0 |
| CI | push | cross (windows-latest) | windows | 10 | 1554 | 1908 | 2177 | 24 | 483 | 1405 | 0 | 0 |
| CI | push | deny | linux | 10 | 32 | 40 | 41 | 32 | 481 | 1874 | 0 | 0 |
| CI | push | gate | linux | 9 | 4 | 6 | 6 | 1568 | 3259 | 3259 | 1 | 0 |
| CI | push | install (macos-latest) | linux | 9 | 6 | 9 | 9 | 1569 | 3260 | 3260 | 1 | 0 |
| CI | push | install (ubuntu-latest) | linux | 9 | 199 | 609 | 609 | 1572 | 3105 | 3105 | 0 | 0 |
| CI | push | install (windows-latest) | windows | 8 | 454 | 1089 | 1089 | 1526 | 3104 | 3104 | 0 | 1 |
| CI | push | msrv | linux | 10 | 57 | 78 | 152 | 24 | 490 | 1836 | 0 | 0 |
| CI | push | quality | linux | 9 | 1469 | 1668 | 1668 | 3 | 1355 | 1355 | 1 | 0 |
| CI | push | wheel (aarch64-unknown-linux-gnu) | linux-arm64 | 10 | 522 | 574 | 765 | 26 | 471 | 1361 | 0 | 0 |
| CI | push | wheel (x86_64-unknown-linux-gnu) | linux | 10 | 532 | 671 | 677 | 34 | 469 | 1845 | 0 | 0 |
| Published smoke | workflow_run | npm (ubuntu-latest) | linux | 4 | 10 | 15 | 15 | 3 | 4 | 4 | 2 | 0 |
| Published smoke | workflow_run | npm (windows-latest) | windows | 6 | 26 | 48 | 48 | 2 | 3 | 3 | 0 | 0 |
| Published smoke | workflow_run | probe | linux | 6 | 8 | 11 | 11 | 3 | 4 | 4 | 0 | 0 |
| Published smoke | workflow_run | pypi (ubuntu-latest) | linux | 6 | 9 | 10 | 10 | 3 | 3 | 3 | 0 | 0 |
| Published smoke | workflow_run | pypi (windows-latest) | windows | 6 | 18 | 26 | 26 | 2 | 4 | 4 | 0 | 0 |
| Published smoke | workflow_run | report a failure | linux | 2 | 8 | 8 | 8 | 42 | 53 | 53 | 0 | 0 |
| Release | release | build-npm (aarch64-unknown-linux-gnu) | linux-arm64 | 4 | 482 | 494 | 494 | 2412 | 2520 | 2520 | 0 | 0 |
| Release | release | build-npm (x86_64-pc-windows-msvc) | windows | 4 | 1180 | 1221 | 1221 | 2459 | 2518 | 2518 | 0 | 0 |
| Release | release | build-npm (x86_64-unknown-linux-gnu) | linux | 4 | 556 | 593 | 593 | 2392 | 2518 | 2518 | 0 | 0 |
| Release | release | build-wheels (aarch64-unknown-linux-gnu) | linux-arm64 | 4 | 523 | 545 | 545 | 2410 | 2520 | 2520 | 0 | 0 |
| Release | release | build-wheels (x86_64-pc-windows-msvc) | windows | 4 | 1106 | 1214 | 1214 | 2464 | 2728 | 2728 | 0 | 0 |
| Release | release | build-wheels (x86_64-unknown-linux-gnu) | linux | 4 | 628 | 640 | 640 | 2464 | 2781 | 2781 | 0 | 0 |
| Release | release | darwin | macos | 3 | 594 | 842 | 842 | 4443 | 7524 | 7524 | 1 | 0 |
| Release | release | guard | linux | 4 | 3 | 3 | 3 | 17 | 97 | 97 | 0 | 0 |
| Release | release | publish-crate | linux | 4 | 223 | 225 | 225 | 2464 | 2741 | 2741 | 0 | 0 |
| Release | release | publish-npm | linux | 3 | 56 | 58 | 58 | 5287 | 8120 | 8120 | 0 | 0 |
| Release | release | publish-pypi | linux | 3 | 31 | 33 | 33 | 5287 | 8120 | 8120 | 0 | 0 |
| Release | release | release-status | – | 0 | – | – | – | – | – | – | 4 | 0 |
| Release | release | test | linux | 4 | 2374 | 2431 | 2431 | 3 | 85 | 85 | 0 | 0 |
| Release | release | upload (aarch64-unknown-linux-gnu) | linux-arm64 | 4 | 485 | 489 | 489 | 2466 | 2601 | 2601 | 0 | 0 |
| Release | release | upload (x86_64-pc-windows-msvc) | windows | 4 | 1092 | 1164 | 1164 | 2464 | 2778 | 2778 | 0 | 0 |
| Release | release | upload (x86_64-unknown-linux-gnu) | linux | 4 | 550 | 602 | 602 | 2386 | 2518 | 2518 | 0 | 0 |
| Release | release | upload-darwin | linux | 3 | 7 | 10 | 10 | 5287 | 8120 | 8120 | 0 | 0 |
| Release | release | verify-assets (aarch64-unknown-linux-gnu) | linux-arm64 | 4 | 6 | 6 | 6 | 3476 | 3946 | 3946 | 0 | 0 |
| Release | release | verify-assets (x86_64-unknown-linux-gnu) | linux | 4 | 8 | 8 | 8 | 3474 | 3944 | 3944 | 0 | 0 |
| Release | release | verify-npm (ubuntu-latest) | – | 0 | – | – | – | – | – | – | 3 | 0 |
| Release | release | verify-npm (windows-latest) | – | 0 | – | – | – | – | – | – | 3 | 0 |
| Release | release | verify-pypi (ubuntu-latest) | linux | 3 | 10 | 14 | 14 | 5323 | 8146 | 8146 | 0 | 0 |
| Release | release | verify-pypi (windows-latest) | windows | 3 | 19 | 23 | 23 | 5323 | 8146 | 8146 | 0 | 0 |
| Release-plz | push | guard | linux | 10 | 3 | 4 | 4 | 3 | 174 | 385 | 0 | 0 |
| Release-plz | push | release-plz | linux | 10 | 60 | 163 | 216 | 8 | 412 | 1349 | 0 | 0 |
| Visual docs | pull_request | visual-docs / aggregate-comment | – | 0 | – | – | – | – | – | – | 0 | 1 |
| Visual docs | pull_request | visual-docs / arches | linux | 12 | 6 | 8 | 8 | 9 | 49 | 247 | 0 | 1 |
| Visual docs | pull_request | visual-docs / capture | – | 0 | – | – | – | – | – | – | 0 | 1 |
| Visual docs | pull_request | visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs) | linux | 12 | 831 | 860 | 869 | 18 | 119 | 422 | 0 | 0 |
| Visual docs | pull_request | visual-docs / cleanup-preview | linux | 8 | 8 | 10 | 10 | 9 | 48 | 48 | 1 | 1 |
| Visual docs | pull_request | visual-docs / deploy-pages | linux | 11 | 58 | 110 | 559 | 882 | 1103 | 1164 | 0 | 2 |
| Visual docs | pull_request | visual-docs / pages-preflight | linux | 21 | 3 | 4 | 4 | 3 | 42 | 1137 | 0 | 1 |
| Visual docs | pull_request | visual-docs / prune-history | – | 0 | – | – | – | – | – | – | 0 | 1 |
| Visual docs | pull_request | visual-docs / report | – | 0 | – | – | – | – | – | – | 0 | 1 |
| Visual docs | pull_request | visual-docs / report (x86_64, shots/current, shots/verify, Visual docs) | linux | 12 | 18 | 20 | 21 | 860 | 1087 | 1146 | 0 | 0 |
| Visual docs | push | visual-docs / aggregate-comment | – | 0 | – | – | – | – | – | – | 0 | 8 |
| Visual docs | push | visual-docs / arches | linux | 2 | 6 | 7 | 7 | 91 | 156 | 156 | 0 | 8 |
| Visual docs | push | visual-docs / capture | – | 0 | – | – | – | – | – | – | 0 | 8 |
| Visual docs | push | visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs) | linux | 2 | 832 | 833 | 833 | 106 | 172 | 172 | 0 | 0 |
| Visual docs | push | visual-docs / cleanup-preview | – | 0 | – | – | – | – | – | – | 0 | 8 |
| Visual docs | push | visual-docs / deploy-pages | linux | 2 | 10 | 11 | 11 | 956 | 1018 | 1018 | 0 | 8 |
| Visual docs | push | visual-docs / pages-preflight | linux | 2 | 2 | 3 | 3 | 82 | 144 | 144 | 0 | 8 |
| Visual docs | push | visual-docs / prune-history | – | 0 | – | – | – | – | – | – | 0 | 8 |
| Visual docs | push | visual-docs / report | – | 0 | – | – | – | – | – | – | 0 | 8 |
| Visual docs | push | visual-docs / report (x86_64, shots/current, shots/verify, Visual docs) | linux | 2 | 13 | 15 | 15 | 942 | 1005 | 1005 | 0 | 0 |
| notignored | pull_request | suppressions | linux | 12 | 8 | 10 | 13 | 3 | 3 | 63 | 0 | 0 |

**Jobs per PR head commit and per release's CD** (executed jobs; matrix legs counted; skipped excluded):

| Unit | Split | Window (since 2026-09-15) | Current shape (since #315) |
| --- | --- | --- | --- |
| PR head commit, all workflows | total | median 16 jobs, p90 19 jobs, max 22 jobs (n=173) | median 19 jobs, p90 22 jobs, max 22 jobs (n=6) |
| PR head commit | workflow CI | median 14 jobs, p90 16 jobs, max 16 jobs (n=173) | median 16 jobs, p90 16 jobs, max 16 jobs (n=6) |
| PR head commit | workflow Visual docs | median 2 jobs, p90 5 jobs, max 5 jobs (n=173) | median 2 jobs, p90 5 jobs, max 5 jobs (n=6) |
| PR head commit | workflow notignored | median 0 jobs, p90 1 jobs, max 1 jobs (n=173) | median 1 jobs, p90 1 jobs, max 1 jobs (n=6) |
| PR head commit | runner linux | median 11 jobs, p90 14 jobs, max 17 jobs (n=173) | median 15 jobs, p90 17 jobs, max 17 jobs (n=6) |
| PR head commit | runner linux-arm64 | median 1 jobs, p90 1 jobs, max 1 jobs (n=173) | median 1 jobs, p90 1 jobs, max 1 jobs (n=6) |
| PR head commit | runner macos | median 2 jobs, p90 2 jobs, max 2 jobs (n=173) | median 0 jobs, p90 1 jobs, max 1 jobs (n=6) |
| PR head commit | runner windows | median 2 jobs, p90 3 jobs, max 3 jobs (n=173) | median 3 jobs, p90 3 jobs, max 3 jobs (n=6) |
| Release CD (all its runs) | total | median 55 jobs, p90 60 jobs, max 61 jobs (n=54) | median 42.5 jobs, p90 49 jobs, max 49 jobs (n=4) |
| Release CD | workflow CI (push) | median 12 jobs, p90 13 jobs, max 13 jobs (n=54) | median 13 jobs, p90 13 jobs, max 13 jobs (n=4) |
| Release CD | workflow Published smoke (workflow_run) | median 9 jobs, p90 10 jobs, max 10 jobs (n=54) | median 5.5 jobs, p90 6 jobs, max 6 jobs (n=4) |
| Release CD | workflow Release (release) | median 32 jobs, p90 32 jobs, max 32 jobs (n=54) | median 23 jobs, p90 23 jobs, max 23 jobs (n=4) |
| Release CD | workflow Release-plz (push) | median 2 jobs, p90 2 jobs, max 2 jobs (n=54) | median 2 jobs, p90 2 jobs, max 2 jobs (n=4) |
| Release CD | workflow Visual docs (push) | median 0 jobs, p90 5 jobs, max 5 jobs (n=54) | median 2.5 jobs, p90 5 jobs, max 5 jobs (n=4) |
| Release CD | runner linux | median 24 jobs, p90 29 jobs, max 33 jobs (n=54) | median 27 jobs, p90 33 jobs, max 33 jobs (n=4) |
| Release CD | runner linux-arm64 | median 5 jobs, p90 5 jobs, max 5 jobs (n=54) | median 5 jobs, p90 5 jobs, max 5 jobs (n=4) |
| Release CD | runner macos | median 17 jobs, p90 17 jobs, max 17 jobs (n=54) | median 1 jobs, p90 1 jobs, max 1 jobs (n=4) |
| Release CD | runner windows | median 9 jobs, p90 10 jobs, max 10 jobs (n=54) | median 9.5 jobs, p90 10 jobs, max 10 jobs (n=4) |

**Cycle time** (85 merged PRs eligible in the window, out of 140 merged. Ineligible: 1 no completed release containing the merge yet, 54 release PR (its merge is the release itself). Current shape: 4 eligible):

| Phase | Window | Current shape |
| --- | --- | --- |
| checks phase (first head-commit run created → last head job completed) | median 2202 s, p90 7630 s, max 18935 s (n=85) | median 2740.5 s, p90 3101 s, max 3101 s (n=4) |
| merge → release (merged_at → last CD job completed, first release containing the merge) | median 9931 s, p90 39917 s, max 173661 s (n=85) | median 9457 s, p90 15255 s, max 15255 s (n=4) |
|   of which merge → release commit's first CD run | median 3297 s, p90 17850 s, max 171925 s (n=85) | median 2671 s, p90 9730 s, max 9730 s (n=4) |
| total (sum of the two phases) | median 13365 s, p90 50285 s, max 174734 s (n=85) | median 12230.5 s, p90 18159 s, max 18159 s (n=4) |
| per release: max total over the PRs it carries | median 15456 s, p90 54233 s, max 174734 s (n=54) | median 13549 s, p90 18159 s, max 18159 s (n=3) |

**Local profile, per Nx task of `just check`.** Cold seconds come from `check-cold` and the three cold tier runs; a task those never reached is taken from its first run, in `check-warm-1`. The Nx-cold, cargo-warm column is the `--skip-nx-cache` run over PR #339's 8 affected projects, which is closest to a CI `quality` job. Warm seconds come from `check-warm-2`, where `local-cache*` means replayed. The CI figure comes from the 12 logs (sweep and Release `test` jobs).

| Nx task | cold local s (status) | Nx-cold, cargo-warm s (PR #339 affected run) | warm local s (status) | CI figure |
| --- | --- | --- | --- | --- |
| onepipeline-ui-repo-tooling:test | 15778.1 (success) | 484.3 (success) | 3.8 (local-cache) | nextest run 1060, 784, 1018, 977, 1027, 1015 s |
| dag-ui-e2e:test | 12193.6 (failure) | 424.2 (success) | 0.0 (local-cache-kept-existing) | Playwright 492, 402, 486, 450, 474, 480 s |
| onepipeline-ui-e2e:test | 1828.0 (success) | 154.4 (success) | 5.2 (local-cache) | nextest run 584, 431, 522, 569 s |
| dag-ui-build-cache:test | 995.9 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| dag-ui:test | 566.8 (failure) | 105.4 (success) | 0.1 (local-cache-kept-existing) | Vitest 105, 60, 103, 92, 106, 108 s |
| onepipeline-ui:ensure-baseline | 541.1 (success) | 0.1 (success) | 0.4 (success) | critical path 193, 146, 184, 177, 191, 190 s |
| onepipeline-ui:test | 274.7 (success) | 118.2 (success) | 3.8 (local-cache) | nextest run 2.5, 1.9, 2.8, 2.4, 2.5, 2.5 s |
| onepipeline-ui-baseline:test-baseline | 202.4 (success) | 133.4 (success) | 0.0 (local-cache-kept-existing) | nextest run 18, 13, 17, 16, 18, 18 s |
| onepipeline-ui:doc | 71.8 (success) | 5.1 (failure) | 0.1 (local-cache-kept-existing) | – |
| dag-ui:build-api-server | 69.1 (success) | 122.8 (success) | 138.7 (success) | – |
| onepipeline-ui:lint | 52.4 (success) | 28.6 (success) | 0.1 (local-cache-kept-existing) | critical path 68, 51, 63, 60, 65, 65 s |
| dag-ui-build-cache:lint | 49.4 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| onepipeline-ui-cost:test-cost | 45.2 (success) | 6.7 (success) | 4.1 (local-cache-kept-existing) | nextest run 5.9, 5.6, 5.9, 5.5, 5.9, 5.6 s |
| dag-ui-e2e:test-isolation | 42.7 (success, first run in check-warm-1) | 47.3 (success) | 0.0 (local-cache-kept-existing) | – |
| telemetry-client:test | 29.0 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| github-workflows:test | 24.1 (failure) | – (not affected) | 39.5 (success) | – |
| dag-model:test | 23.3 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| github-workflows:budgets | 17.4 (failure, first run in check-warm-1) | – (not affected) | 3.6 (success) | – |
| timeline-categories:test | 12.8 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| dag-layout:test | 11.7 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| pool-maintenance:test | 6.2 (success) | – (not affected) | 0.0 (local-cache-kept-existing) | – |
| dag-ui:lint | 5.4 (success) | 21.3 (success) | 0.1 (local-cache-kept-existing) | – |
| dag-ui-e2e:lint | 4.0 (success) | 7.7 (success) | 0.1 (local-cache-kept-existing) | – |
| dag-ui:typecheck | 4.0 (success) | 17.5 (success) | 0.1 (local-cache-kept-existing) | – |
| dag-model:lint | 3.9 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| telemetry-client:lint | 3.8 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| timeline-categories:lint | 3.6 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| telemetry-client:typecheck | 3.5 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| dag-layout:lint | 3.3 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| telemetry-client:build | 3.2 (success) | – (not affected) | 0.2 (local-cache) | – |
| onepipeline-ui-coverage:coverage | 3.0 (success) | 2.2 (success) | 13.0 (success) | – |
| dag-model:typecheck | 2.8 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| dag-model:build | 2.6 (success) | – (not affected) | 0.2 (local-cache) | – |
| dag-layout:build | 2.3 (success) | – (not affected) | 0.2 (local-cache) | – |
| timeline-categories:typecheck | 2.2 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| dag-ui:build | 2.0 (success) | 4.9 (success) | 0.2 (local-cache) | – |
| timeline-categories:build | 1.7 (success) | – (not affected) | 0.2 (local-cache) | – |
| dag-ui-e2e:typecheck | 1.5 (success) | 5.5 (success) | 0.1 (local-cache-kept-existing) | – |
| dag-layout:typecheck | 1.4 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| dag-model:format-check | 1.1 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| timeline-categories:format-check | 1.1 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| telemetry-client:format-check | 1.0 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| onepipeline-ui:format-check | 0.8 (success) | 0.7 (success) | 0.1 (local-cache-kept-existing) | – |
| github-workflows:lint | 0.6 (success) | – (not affected) | 0.0 (local-cache-kept-existing) | – |
| dag-ui:format-check | 0.5 (success) | 0.8 (success) | 0.1 (local-cache-kept-existing) | – |
| pool-maintenance:bootstrap | 0.5 (success) | – (not affected) | 0.2 (success) | – |
| dag-layout:format-check | 0.4 (success) | – (not affected) | 0.1 (local-cache-kept-existing) | – |
| dag-ui-e2e:format-check | 0.4 (success) | 0.6 (success) | 0.1 (local-cache-kept-existing) | – |
| onepipeline-ui:ensure-sibling | 0.1 (success) | 0.1 (success) | 0.7 (success) | – |
| github-workflows:bootstrap | 0.0 (success) | – (not affected) | 5.8 (success) | – |
| dag-model:check | 0.0 (success, first run in check-warm-1) | – (not affected) | 0.0 (success) | – |
| timeline-categories:check | 0.0 (success, first run in check-warm-1) | – (not affected) | 0.0 (success) | – |
| telemetry-client:check | 0.0 (success, first run in check-warm-1) | – (not affected) | 0.0 (success) | – |
| dag-layout:check | 0.0 (success, first run in check-warm-1) | – (not affected) | 0.0 (success) | – |
| onepipeline-ui:check | 0.0 (success, first run in check-warm-1) | – (not affected) | 0.0 (success) | – |
| dag-ui:check | 0.0 (success, first run in check-warm-1) | 0.0 (success) | 0.0 (success) | – |
| dag-ui-build-cache:check | 0.0 (success, first run in check-warm-1) | – (not affected) | 0.0 (success) | – |
| onepipeline-ui-repo-tooling:check | 0.0 (success, first run in check-warm-1) | 0.0 (success) | 0.0 (success) | – |
| onepipeline-ui-cost:check | 0.0 (success, first run in check-warm-1) | 0.0 (success) | 0.0 (success) | – |
| onepipeline-ui-e2e:check | 0.0 (success, first run in check-warm-1) | 0.0 (success) | 0.0 (success) | – |
| onepipeline-ui-baseline:check | 0.0 (success, first run in check-warm-1) | 0.0 (success) | 0.0 (success) | – |
| onepipeline-ui-coverage:check | 0.0 (success, first run in check-warm-1) | 0.0 (success) | 0.0 (success) | – |
| pool-maintenance:check | 0.0 (success, first run in check-warm-1) | – (not affected) | 0.0 (success) | – |
| dag-ui-e2e:check | 0.0 (success, first run in check-warm-1) | 0.0 (success) | 0.0 (success) | – |

Wall clock: cold `just check` 15862 s (stopped at `test`), plus the cold `test-baseline` 747 s, `test-cost` 47 s and `doc` 74 s runs, which totals **16729 s**. Warm `just check`: **160.7 s**, exit 0: 86 tasks replayed, and 33 executed because they are uncacheable (bootstrap, ensure-*, coverage, `github-workflows:test`/`budgets`, `dag-ui:build-api-server`). `check-affected` (PR #339 diff): Nx-cold 700 s (exit 130), warm 2.4 s (exit 0). The Nx-cold run's one failure was `onepipeline-ui:doc`: rustdoc read `apps/dag-ui/dist` while `dag-ui:build` was rewriting it, because `doc` declares no `dependsOn` on that build (a follow-up is drafted). Every other task passed. Its 700 s is close to CI `quality`'s 822 s `check-affected` step, so at this load the host's Nx-cold, cargo-warm figures are roughly CI-scale, while its fully cold ones are not.

**Slowest tier and its 20 slowest tests.** `onepipeline-ui-repo-tooling:test` is the slowest tier both locally (15778 s cold) and in CI (critical path 1287, 944, 1223, 1168, 1233, 1220 s in the sweep and Release `test` logs). These are its 20 slowest of 223 tests, from nextest's own `PASS [ Ns ]` lines in the cold local run. This is host-contended, local timing only, since CI does not print per-test times.

| # | test (binary::name) | local cold s |
| --- | --- | --- |
| 1 | `onepipeline-ui::packaging` `the_release_staging_path_builds_installs_and_serves_the_native_artifact` | 5649.2 |
| 2 | `onepipeline-ui::e2e` `nx_affected::a_change_to_a_shared_package_checks_it_and_its_dependents_and_no_unrelated_package` | 135.0 |
| 3 | `onepipeline-ui::e2e` `nx_affected::a_fixture_change_re_runs_a_cached_reader_rather_than_replaying_it` | 107.7 |
| 4 | `onepipeline-ui::e2e` `nx_affected::a_change_to_the_repository_machinery_selects_its_tier_and_not_the_journeys` | 83.8 |
| 5 | `onepipeline-ui::e2e` `workspace_install::a_fresh_checkout_installs_from_the_lockfile_and_runs_a_target` | 80.1 |
| 6 | `onepipeline-ui::e2e` `nx_affected::a_base_commit_that_does_not_resolve_runs_everything_and_says_which_variable` | 62.6 |
| 7 | `onepipeline-ui::e2e` `nx_affected::a_fixture_belongs_to_its_readers_and_to_no_project_of_its_own` | 57.8 |
| 8 | `onepipeline-ui::e2e` `nx_affected::a_test_only_change_still_reaches_the_rust_matrices` | 57.6 |
| 9 | `onepipeline-ui::e2e` `nx_affected::a_change_to_a_journey_selects_its_tier_and_not_the_repository_machinery` | 52.1 |
| 10 | `onepipeline-ui::e2e` `nx_affected::a_ci_build_with_no_base_runs_everything` | 51.3 |
| 11 | `onepipeline-ui::e2e` `nx_affected::a_push_build_is_scoped_to_the_commit_before_the_push` | 50.2 |
| 12 | `onepipeline-ui::e2e` `nx_affected::the_base_commit_outranks_the_base_branch` | 48.2 |
| 13 | `onepipeline-ui::e2e` `semver_check::a_release_moving_the_engine_without_announcing_it_is_refused` | 37.3 |
| 14 | `onepipeline-ui::e2e` `packaging::the_launcher_propagates_the_binarys_exit_code_and_stderr` | 33.4 |
| 15 | `onepipeline-ui::e2e` `packaging::the_launcher_runs_the_binary_its_platform_package_carries` | 30.5 |
| 16 | `onepipeline-ui::e2e` `semver_check::an_engine_requirement_that_cannot_be_read_fails_a_release_claiming_compatibility` | 30.3 |
| 17 | `onepipeline-ui::e2e` `packaging::the_launcher_stops_the_server_on_a_terminals_interrupt` | 28.0 |
| 18 | `onepipeline-ui::e2e` `packaging::the_launcher_stops_the_server_when_a_supervisor_asks` | 27.5 |
| 19 | `onepipeline-ui::e2e` `llmlint_cache::the_per_invocation_option_re_judges_without_reading_or_writing_the_cache` | 27.0 |
| 20 | `onepipeline-ui::e2e` `llmlint_cache::a_changed_shard_budget_is_judged_again` | 26.8 |


## Candidate budgets

| Budget | Measure | Workload | Achievable | Limits allow | Consumed |
| --- | --- | --- | --- | --- | --- |
| onepipeline-ui-ci-check-time | Seconds of the longest executed job (any conclusion) of one PR head commit's latest `ci.yml` run. `figures.json` `per_pr_head_commit.ci_longest_job_s`. | Every PR head commit in the window: n=172 runs (117 ordinary, 55 release PRs); current shape n=5. | Today: window median 1294 s, p90 1800 s, max 2537 s (n=172); ordinary PRs median 1285 s, p90 1613 s, max 2260 s (n=117), longest job `cross (windows-latest)` in 81 of 117; release PRs median 1362 s, p90 1925 s, max 2537 s (n=55); current shape median 2260 s, p90 2537 s, max 2537 s (n=5) (1× ordinary PR: cross (windows-latest); 4× release PR: sweep). Achievable (PROJECTION from the job table: cached sibling CLI): ordinary PR ≈995 s (`quality`), release PR ≈1598 s median / 1820 s at the slowest measured sweep. | Target 1,800 s/job. Ordinary PRs clear it with ~805 s headroom (projection). The release PR's `sweep` sits at the limit, with `onepipeline-ui-repo-tooling:test`'s critical path (1287, 944, 1223 s) inside it. | 1186 REST GETs in total for the whole spike (lowest quota before a request: 2504; 1 refused at the floor and retried after the reset), 12 of them job logs; 5.4 h of local wall clock for the profile runs |
| onepipeline-ui-cd-job-time | Seconds of the longest executed job across one release's CD runs (push runs on the tag commit, the Release run, the Published smoke follow-up). `per_release_cd.longest_job_s`. | All 54 releases in the window (v0.8.0–v0.36.1); current shape 4 (v0.34.1–v0.36.1). | Today: window median 1597.5 s, p90 1815 s, max 2431 s (n=54); current median 2374 s, p90 2431 s, max 2431 s (n=4), always Release `test`. Achievable (PROJECTION): Release `test` ≈1698 s with the sibling CLI cached; if the re-sweep is dropped for already-swept trees (release-model decision), the longest becomes the Windows builds at ≈1180 s (measured medians of the Windows builds; push `cross` at its projected figure). | Target 1,800 s/job: reachable without sharding either way (projection). The CD *wall clock* is a different quantity: measured current median 6,041 s, set by `test`'s hold plus Mac queueing, not by any one job. | 1186 REST GETs in total for the whole spike (lowest quota before a request: 2504; 1 refused at the floor and retried after the reset), 12 of them job logs; 5.4 h of local wall clock for the profile runs |
| onepipeline-ui-release-cycle-time | Per release: the maximum, over the non-release PRs it carries, of (PR checks phase + merge→last CD job completed for the first release containing the merge). `cycle_time.per_release_max_total_s`. | 85 merged PRs carried by 54 releases (window); current shape 4 PRs in 3 releases. 1 PR merged after v0.36.1 had no release yet (ineligible). | Today: window median 15456 s, p90 54233 s, max 174734 s (n=54); current median 13549 s, p90 18159 s, max 18159 s (n=3). Components (current medians): checks 2740 s, merge→release commit 2671 s (release PR cut, swept, auto-merged), CD wall 6041 s. Achievable (PROJECTION): checks ≈1009 s (longest projected PR job + `changes`, edges removed); merge→release commit ≈2036 s (sweep −635 s); CD ≈1787 s (39 s from the release commit's first CD run to `test` starting + max(projected `test` 1698 s, slowest build-or-darwin queue+duration 1619 s [upload (x86_64-pc-windows-msvc)]) + last build→release-status 18 s + smoke 32 s, all measured on v0.36.1). So a release whose PRs merged just before its release PR would be ≈4832 s. PRs merged while an earlier release was in flight add that release's whole path, which no CI cut removes. | Bounded below by two full `check`s in series (sweep, then Release `test`) unless the re-sweep is dropped, and by Mac queueing on the account-wide limit (measured up to 7,524 s for `darwin`). | 1186 REST GETs in total for the whole spike (lowest quota before a request: 2504; 1 refused at the floor and retried after the reset), 12 of them job logs; 5.4 h of local wall clock for the profile runs |
| onepipeline-ui-ci-job-count | Executed jobs (matrix legs counted, skipped and never-started excluded) across one PR head commit's latest CI, Visual docs and notignored runs. `per_pr_head_commit.jobs_executed`. | 173 PR head commits in the window; current shape 6. | Today: window median 16 jobs, p90 19 jobs, max 22 jobs (n=173); current median 19 jobs, p90 22 jobs, max 22 jobs (n=6); by OS in the window: linux 11, arm64 1, windows 2, macos 2 (medians). Achievable (PROJECTION, arithmetic): +1 for `verdict`. Moving visual docs into ci.yml moves its 5 jobs without changing the count. −2 if the unrequired `cross (macos-latest)`/`install (macos-latest)` reporters fold into `verdict`. So ≈ current 19 −1 = 18. | Every executed job takes a slot of the account-wide concurrent-job limit the other repositories share, which is why job count is budgeted separately from time. | 1186 REST GETs in total for the whole spike (lowest quota before a request: 2504; 1 refused at the floor and retried after the reset), 12 of them job logs; 5.4 h of local wall clock for the profile runs |
| onepipeline-ui-cd-job-count | Executed jobs across one release's CD runs (definition above). `per_release_cd.job_count`. | 54 releases (window); 4 (current shape). | Today: window median 55 jobs, p90 60 jobs, max 61 jobs (n=54); current median 42.5 jobs, p90 49 jobs, max 49 jobs (n=4): CI push 13, Release 23, Published smoke 5.5, Release-plz 2, Visual docs push 2.5 (medians). Achievable (PROJECTION, arithmetic; both are release-model or artifact decisions): −13 skipping push CI on the release commit, −6 building each Linux/Windows target once, so ≈23.5 jobs (from the current median 42.5). | Same shared concurrent-job limit; Mac jobs are additionally bounded by the existing macOS budgets (1 per run), which hold today (1 Mac job per release in the current shape). | 1186 REST GETs in total for the whole spike (lowest quota before a request: 2504; 1 refused at the floor and retried after the reset), 12 of them job logs; 5.4 h of local wall clock for the profile runs |
| onepipeline-ui-gate-time | `just gate`'s wall clock on this host = local `just check` wall clock + the judge tier's wall clock **as measured in CI** (`llmlint` job; the judge was not run locally, by manager ruling). | The tree of ecb96f6 (this branch adds only `spike/`, which an untracked `.nxignore` kept out of Nx's hashing for the profile); this host, Linux aarch64 14 cores, at load average 27–55 from other repositories' gates. | Today (cold, no Nx cache): 16729 s `check` (one invocation of 15862 s that stopped at `test`, plus the three tiers it did not reach) + judge 210 s (CI median; p90 321) ≈ 16940 s. Warm (Nx cache restored): 160.7 s + 210 s ≈ 371 s. Uncontended reference: CI's full `check` step 1457–1568 s + judge ≈ 1668–1778 s. | Dominated by host contention, which no change in this repository controls. A threshold set on this host's cold figure would measure the host rather than the gate. | 5.4 h of local wall clock across the 11 profile runs in local/ (cold check 15862 s, three cold tiers 868 s, warm runs, check-affected runs); no REST requests; no judge calls |

## Design findings

- **Checks run more than once per change (measured, window medians; current shape in brackets).** (1) *A PR's whole CI runs again on its merge commit.* A push to `main` re-runs every CI job the PR head ran, on a tree that matches the head whenever the PR was up to date. Branch protection has `strict: false`, so that is not guaranteed. Cost: 5440 runner-s per merged PR (5684), p90 7407. Of that, `just bootstrap` is 1831 s, `check-affected` 587 s, `check-cross` 423 s and release-profile compiles 1498 s. (2) *The full `just check` runs three times per release, on the same tree.* It runs in `sweep` on the release PR (median 1800 s, 2233 current); in push CI's `quality` on the release commit (1469 s current); and in Release `test` (1538 s, 2374 current). All three use the same tree when the release PR was up to date. (3) *`just bootstrap`* costs 1904 s per PR head commit (1720), 1831 s again on its merge commit, and 2408 s per release's CD (2452). Per job: `quality` 594, `sweep` 718, `cross (windows)` 1162, `macos` 906, Release `test` 759 s. Most of it is the sibling CLI's `cargo install onepipeline`: Nx's critical path names `onepipeline-ui:bootstrap` at 406, 579, 586 s in `quality` and 983, 1183, 1071 s on Windows. Everything else in bootstrap measured 37, 53, 54 s and 114, 289, 113 s. Locally, `onepipeline-ui:bootstrap` took 388.6 s with no `.tools/` and 0.9 s with the sibling already provisioned, and the whole `just bootstrap` took 489 s against 6.6 s. (4) *`just build` (the browser view)* runs 457 s per release's CD, across 11 jobs, and 41 s per PR head commit (`wheel` ×2, `browser-windows` 80 s). It is cheap per job; the cost is that it repeats. (5) *Release-profile compiles of the same binary* total 9068 s per release (7624 current), because `upload`, `build-wheels` and `build-npm` each compile every Linux and Windows target. For Windows that is 982+993+996 s; for x86_64 Linux 524+602+507 s. `darwin` already builds once. On top of that comes `1637` s per PR head (`install` ×2, `wheel` ×2, `macos`). `ci.yml`'s `wheel` and Release's Linux `build-wheels` run the same `just wheel-linux` (≈548/499 s); this repeat is deliberate (v0.16.0). (6) *Screenshot capture* runs on the PR head (796 s) and again on the push to `main` whenever that run is not superseded. Each capture includes its own reproducibility re-capture (287 s).
- **`needs` edges that wait without using the needed job's output (measured hold = the needed job's completion minus when the dependent could otherwise start; current shape, window in brackets).** `ci.yml` `install` ← `quality` (ci.yml:376; install reads no output or artifact of quality): held median 1470.5 s, p90 1650 s, max 1861 s (n=20) [median 1199 s, p90 1714 s, max 7308 s (n=229)]. `ci.yml` `macos` ← `quality` (ci.yml:213): held median 1290 s, p90 1457 s, max 1457 s (n=2). `release.yml` `upload`/`build-wheels`/`build-npm` ← `test` (release.yml:243, 403, 561): held median 2376.5 s, p90 2516 s, max 2516 s (n=4) [median 1499 s, p90 1804 s, max 2516 s (n=51)]. `darwin` ← `test` (release.yml:165): held median 2376.5 s, p90 2516 s, max 2516 s (n=4), after which the Mac runner still queued (darwin's queue wait is median 4443 s, p90 7524 s, max 7524 s (n=3)). `publish-crate` ← `test` (release.yml:369): held median 2360 s, p90 2416 s, max 2416 s (n=4). That edge is a publication gate, so it stays. Only the *build* half of the release edges is free to move: `upload` publishes assets, so it would split into build (no wait) and attach (`needs: test`). Edges that consume output and stay: `gate`, `cross-macos` and `install-macos` read their needs' results; `sweep`, `cross`, `msrv`, `deny`, `wheel` and `install` read `changes` outputs; Visual docs `report` downloads `capture`'s artifact; the `publish-*` and `verify-*` jobs need what they publish. Removing `install`←`quality` cuts a PR's checks-phase wall time by up to the hold (1470 s median), at the price of ~1008 runner-s spent on PRs whose `quality` fails. Removing the build half of `needs: test` cuts CD wall time by up to 2376 s, at the price of ~7196 runner-s wasted when `test` fails.
- **Projected duration of every CI and CD job after the recommended coverage-preserving cuts. PROJECTION**, not measurement: each row names the measurements it rests on. The cuts are: cache the sibling CLI `.tools/bin/onepipeline` across runs, keyed on the `onepipeline` version in Cargo.lock and the OS; remove the wait-only `needs` edges above; and use Nx affected-only selection as `quality` already does. The `+30 s` cache restore is assumed, not measured.
  
  | Job | today median s (current shape) | projected s | projection basis |
  | --- | --- | --- | --- |
  | CI quality | 1506 | 995 | 1506 − bootstrap step 594 + cached bootstrap 83 (non-sibling bootstrap 53 s measured in 3 logs, + 30 s assumed restore) |
  | CI sweep | 2233 | 1598 | 2233 − bootstrap step 718 + cached bootstrap 83; its slowest run: 2537 − 800 + 83 = 1820 |
  | CI cross (windows-latest) | 1764 | 746 | 1764 − bootstrap step 1162 + cached bootstrap 144 (non-sibling bootstrap 114 s in 3 logs + 30 s assumed) |
  | CI macos | 1928 | 1166 | 1928 − bootstrap 906 + 144 (n=1; Windows' non-sibling remainder used, unmeasured on macOS) |
  | Release test | 2374 | 1698 | 2374 − bootstrap 759 + 83; replaced by ~0 if the re-sweep of an already-swept tree is dropped (release-model decision below) |
  | CI install (ubuntu-latest) | 334 | 334 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI install (windows-latest) | 674 | 674 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI wheel (x86_64-unknown-linux-gnu) | 626 | 626 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI wheel (aarch64-unknown-linux-gnu) | 521 | 521 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI browser-windows | 106 | 106 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI msrv | 54 | 54 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI deny | 34 | 34 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI llmlint | 210 | 210 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI pr-title | 4 | 4 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI changes | 14 | 14 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | CI gate | 4 | 4 | no cut named; queue waits move (see needs edges) but the job's own duration does not |
  | Visual docs capture (PR) | 831 | 831 | unchanged by the coverage-preserving cuts; −287 s only with the reproducibility re-capture dropped (coverage-reducing, below) |
  | Release upload (x86_64-pc-windows-msvc) | 1092 | 1092 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release build-wheels (x86_64-pc-windows-msvc) | 1106 | 1106 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release build-npm (x86_64-pc-windows-msvc) | 1180 | 1180 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release upload (x86_64-unknown-linux-gnu) | 550 | 550 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release build-wheels (x86_64-unknown-linux-gnu) | 628 | 628 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release build-npm (x86_64-unknown-linux-gnu) | 556 | 556 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release upload (aarch64-unknown-linux-gnu) | 485 | 485 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release build-wheels (aarch64-unknown-linux-gnu) | 523 | 523 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release build-npm (aarch64-unknown-linux-gnu) | 482 | 482 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release darwin | 594 | 594 | own duration unchanged; with the `needs: test` hold removed it starts ~2376 s earlier |
  | Release publish-crate | 223 | 223 | unchanged; its `needs: test` is a publication gate and stays |
  | Release publish-npm | 56 | 56 | unchanged |
  | Release publish-pypi | 31 | 31 | unchanged |
  | Release upload-darwin | 7 | 7 | unchanged |
  | Release guard | 3 | 3 | unchanged |
  | Release verify-assets (x86_64-unknown-linux-gnu) | 8 | 8 | unchanged |
  | Release verify-assets (aarch64-unknown-linux-gnu) | 6 | 6 | unchanged |
  | Release verify-pypi (ubuntu-latest) | 10 | 10 | unchanged |
  | Release verify-pypi (windows-latest) | 19 | 19 | unchanged |
  | Published smoke probe | 8 | 8 | unchanged |
  | Published smoke npm (ubuntu-latest) | 10 | 10 | unchanged |
  | Published smoke npm (windows-latest) | 26 | 26 | unchanged |
  | Published smoke pypi (ubuntu-latest) | 9 | 9 | unchanged |
  | Published smoke pypi (windows-latest) | 18 | 18 | unchanged |
  | Release-plz guard | 3 | 3 | unchanged |
  | Release-plz release-plz | 60 | 60 | unchanged |
  | CI pull_request cross (macos-latest) | 7 | 7 | unchanged by the recommended cuts |
  | CI pull_request install (macos-latest) | 6 | 6 | unchanged by the recommended cuts |
  | CI push browser-windows | 104 | 104 | unchanged by the recommended cuts |
  | CI push changes | 15 | 15 | unchanged by the recommended cuts |
  | CI push cross (macos-latest) | 7 | 7 | unchanged by the recommended cuts |
  | CI push cross (windows-latest) | 1554 | 536 | push-to-main twin of the PR job: same cached-bootstrap cut (−1018 s) |
  | CI push deny | 32 | 32 | unchanged by the recommended cuts |
  | CI push gate | 4 | 4 | unchanged by the recommended cuts |
  | CI push install (macos-latest) | 6 | 6 | unchanged by the recommended cuts |
  | CI push install (ubuntu-latest) | 199 | 199 | unchanged by the recommended cuts |
  | CI push install (windows-latest) | 454 | 454 | unchanged by the recommended cuts |
  | CI push msrv | 57 | 57 | unchanged by the recommended cuts |
  | CI push quality | 1469 | 958 | push-to-main twin of the PR job: same cached-bootstrap cut (−511 s) |
  | CI push wheel (aarch64-unknown-linux-gnu) | 522 | 522 | unchanged by the recommended cuts |
  | CI push wheel (x86_64-unknown-linux-gnu) | 532 | 532 | unchanged by the recommended cuts |
  | Published smoke workflow_run report a failure | 8 | 8 | unchanged by the recommended cuts |
  | Visual docs pull_request visual-docs / arches | 6 | 6 | unchanged by the recommended cuts |
  | Visual docs pull_request visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs) | 831 | 831 | unchanged (see the PR capture row) |
  | Visual docs pull_request visual-docs / cleanup-preview | 8 | 8 | unchanged by the recommended cuts |
  | Visual docs pull_request visual-docs / deploy-pages | 58 | 58 | unchanged by the recommended cuts |
  | Visual docs pull_request visual-docs / pages-preflight | 3 | 3 | unchanged by the recommended cuts |
  | Visual docs pull_request visual-docs / report (x86_64, shots/current, shots/verify, Visual docs) | 18 | 18 | unchanged by the recommended cuts |
  | Visual docs push visual-docs / arches | 6 | 6 | unchanged by the recommended cuts |
  | Visual docs push visual-docs / capture (x86_64, shots/current, shots/verify, Visual docs) | 832 | 832 | unchanged (see the PR capture row) |
  | Visual docs push visual-docs / deploy-pages | 10 | 10 | unchanged by the recommended cuts |
  | Visual docs push visual-docs / pages-preflight | 2 | 2 | unchanged by the recommended cuts |
  | Visual docs push visual-docs / report (x86_64, shots/current, shots/verify, Visual docs) | 13 | 13 | unchanged by the recommended cuts |
  | notignored pull_request suppressions | 8 | 8 | unchanged by the recommended cuts |
  | CI push (every job on the merge commit) | 5806 | 0 | runner-seconds per merged PR; 0 if push-to-main stops re-running a tree its PR head already passed (decision below) |
- **Local gate wall clock (the `onepipeline-ui-gate-time` figure).** `just gate` = `just check` + `just lint-llm-diff`. Cold (no Nx cache): `just check` 15862 s in one invocation, which stopped at `test` after two load-induced timeouts and one profile-induced failure, plus 868 s for the three tiers it never reached: **16729 s cold** on a host at load 27–55. Warm (Nx cache restored, same tree): **160.7 s**. Adding the judge tier **as CI measured it, not run locally** (`llmlint` job, current shape median 210.5 s, p90 321 s, max 323 s (n=12); window median 182.5 s, p90 304 s, max 643 s (n=212)) gives a gate time of **≈16940 s cold, ≈371 s warm** (sums, judge at its CI median). For an uncontended host, CI's own full-`check` step is the better reference: `sweep` 1457 s, Release `test` 1568 s.
- **What restoring the Nx cache in CI would save — little on the paths that matter, because of cache scoping.** A full replay costs 161 s locally for all of `check` (uncacheable tasks included), and 2.4 s for PR #339's affected set. That is the floor a hit replaces CI's 822 s `check-affected`, 1457 s sweep `check` or 1568 s Release `check` with. But GitHub's cache rules decide which runs can hit. A run restores caches from its own ref and the default branch; a PR additionally restores from its base, PR caches are scoped to the merge ref, and a tag's run sees only default-branch caches (docs: *Dependency caching reference → Restrictions for accessing a cache*). So: (a) a PR's first run hits nothing it does not already skip, because `check-affected` runs only projects whose inputs differ from `main`. (b) Re-runs and later pushes of the same PR replay the projects that push did not touch. (c) `cross`'s `check-cross` is `run-many` over all 15 projects, so it would replay the 7 unaffected small projects' `format-check`/`lint`. Those are ≤55+129 s on Windows across *all* projects, so ≤ ~100 s per run (projection). (d) Release `test` cannot replay the release PR's `sweep`: that cache is merge-ref scoped. It could replay only a `main`-scoped cache written by push CI on the release commit, and that run starts in the same second as the Release run (v0.36.1: both at +0–36 s), so it finishes too late. The Release version bump also changes `Cargo.toml`, an input of every Rust target. Restoring the cache is therefore worth ≲100 s per PR run and nothing on the release path, unless the release model changes (finding below). **Caveat measured here:** `github-workflows:budgets` checks a telemetry digest over every tracked *and untracked* file (`.github/workflow-graph.mjs:117`), while Nx hashes `github-workflows:test` from `workflowPolicy` alone. Any file appearing between the two fails the budget, as it did twice in this profile. A restored cache needs that test to stay uncached, which it is today (`cache: false`).
- **Checks that cannot reach 1,800 s without sharding: none is projected to need sharding, but two sit at the edge.** Measured today: `sweep` median 2233 s, p90 2537 s, max 2537 s (n=4) and Release `test` median 2374 s, p90 2431 s, max 2431 s (n=4). Both are over 1,800 s on every current-shape run. `cross (windows-latest)` measures median 1764 s, p90 2238 s, max 2260 s (n=10), and `macos` 1,928 s (n=1). After caching the sibling CLI (projection, table above): `sweep` ≈1598 s median, but its slowest measured run projects to 1820 s. Release `test` ≈1698 s, and Windows `cross` ≈746 s. What keeps the full sweep near 30 minutes is `onepipeline-ui-repo-tooling:test`: critical path 1287, 944, 1223, 1168, 1233, 1220 s inside a 1457–1672 s `check`. Its slowest test, `packaging::the_release_staging_path_builds_installs_and_serves_the_native_artifact`, compiles a release, LTO, instrumented binary; it took 5,649 s locally under contention, and its CI duration is MISSING because nextest prints failures only. **Decision for the user:** accept a sweep/Release `test` that may run ~1,830 s at its slowest, or fund the test-speed work on that test below.
- **Expensive test strategies and their alternatives (time saved vs coverage lost; savings are projections from the measured figures named).** (1) *The release-staging journey in the repo-tooling tier* (above). Keeps coverage: build that release artifact once per run as a cached Nx target the test consumes, rather than inside the test. Saving unmeasured (CI per-test time missing); its share of the tier's 1287, 944, 1223, 1168, 1233, 1220 s critical path is the upper bound. Reduces coverage: run it only in release.yml, where native artifacts are built anyway. That saves its PR/sweep time and loses PR-time detection of a broken staging path, plus whatever lines only it covers toward the 95% floor (unmeasured). (2) *Windows `cross` leg* (1764 s median, of which bootstrap 1162 s and `check-cross` 331 s). Keeps coverage: cache the sibling CLI (−1018 s, projection). Reduces coverage: run it only when the diff touches platform-sensitive code, or only on the release PR. That saves 1764 s of runner time per other PR and loses Windows proof of every other change before merge. `cross (windows-latest)` is a required context, so this is also a protection change. (3) *`macos` leg* (1928 s, n=1; queued median 5498 s, p90 5498 s, max 5498 s (n=1), cancelled 7 times in the current shape). Already policy-limited by the two macOS budgets, which this plan leaves unchanged; no further cut is proposed. (4) *Playwright tiers* (`dag-ui-e2e:test` 139 tests: 492, 402, 486, 450, 474, 480 s in CI; `test-isolation` 2 tests ~15–22 s). Keeps coverage: none needed for 30 minutes, since neither is on the critical path (repo-tooling is). Reduces coverage: run the 139-test suite only in the sweep, saving ~330 s of `quality` per affecting PR, but this suite is the only proof the served UI works (ci.yml:118–124). (5) *Baseline tier* (builds the base commit's server: `ensure-baseline` critical path 193, 146, 184, 177, 191, 190 s in sweep/Release logs; 747 s locally cold). Keeps coverage: cache `.tools/bin/onepipeline-api-baseline` keyed on the base commit, which it is already stamped with. That saves ≈ the figure above on a hit, since sweep and Release `test` share a base only when no merge landed in between (hit rate unmeasured). (6) *Reproducibility re-capture in visual docs* (287 s per capture). Reduces coverage: `verify: false` saves that much per PR and per push, and loses the byte-identical reproducibility gate. (7) *Coverage instrumentation* (`test` vs `test-quick`): every Linux tier compiles instrumented. No measured split is available, so no figure is given (MISSING).
- **Cuts that change a published artifact, a release target or the release model (decision for the user; savings are projections from measured medians, current shape).** (1) *Drop release.yml's re-sweep (`test`) when the tagged tree is one `sweep` already passed.* Compare the release PR head's tree SHA to the tag commit's and check `sweep`'s conclusion; keep the full sweep for a hand-cut Release (AGENTS.md's reason). Saves 2374 s of CD wall clock per release and 2327 s of runner time (bootstrap + `check`). Coverage is unchanged when the trees match, but the release's gate becomes "a sweep of this tree passed" rather than "this run swept it". (2) *Skip push-to-main CI on the release commit.* It re-runs the release PR's tree, which is identical when up to date: saves 4798 runner-s per release (measured on the 4 current-shape release commits: 4590, 3765, 5007, 5777; `quality` 1469 s and `cross` 1554 s of it, medians) and 13 CD jobs. It is off the critical path, so no wall clock is saved. (3) *Build each Linux/Windows target once, as `darwin` already does,* and derive the archive, wheel and npm package from one binary. That saves ≈3916 runner-s per release (the two compiles per target beyond the wheel's) and 6 jobs. The archives' and npm packages' Linux binaries would then be the manylinux-built ones: different bytes and a different glibc floor, which **changes published artifacts**. Wall clock barely moves, since the longest build (Windows ≈1180 s) remains. (4) *Split `upload` into build and attach, and let builds start without `needs: test`.* No artifact changes, but assets are attached only after `test`, as today. Saves up to 2376 s of CD wall clock. (5) *Batch fewer releases* (release-model): each release's CD costs 14963 runner-s (16030 window) and 42 jobs, and there were 54 releases in 31 days. That is a product decision, not a CI one.
- **Required-check plan.** Snapshot: `spike/onepipeline-ui-ci/required-status-checks.json` (taken 2026-10-16T00:01:43+00:00, `strict: false`, 9 contexts). Every context maps to a job of `ci.yml`, and a `verdict` job must `needs:` each of these with `if: always()`, then rule on the results:
  - `gate` → job `gate` (ci.yml:463). It aggregates `changes`, `quality`, `wheel` and `browser-windows` through `scripts/gate-verdict.sh`, so `verdict` can need `gate` or absorb those four.
  - `deny` → `deny` (ci.yml:352).
  - `pr-title` → `pr-title` (ci.yml:481).
  - `llmlint` → `llmlint` (ci.yml:495).
  - `msrv` → `msrv` (ci.yml:321).
  - `cross (windows-latest)` → `cross`'s windows-latest leg (ci.yml:175–208).
  - `install (ubuntu-latest)` and `install (windows-latest)` → `install`'s two legs (ci.yml:375–404).
  - `visual-docs / report (x86_64, shots/current, shots/verify, Visual docs)` → today `visual-docs.yml`'s job `visual-docs` (visual-docs.yml:44); after the move, a `ci.yml` job `visual-docs`.
  `verdict` must accept `skipped` exactly where protection does today:
  - `deny`, `msrv`, `cross` and `install` skip when `changes.outputs.crate == 'false'` (ci.yml:177, 323, 354, 377);
  - `pr-title` and `llmlint` skip on push (ci.yml:482, 496);
  - `gate`'s own `--may-skip wheel` rule holds.
  `cross (macos-latest)` and `install (macos-latest)` are not required and need not be in it.
- **Moving the visual-docs PR run into `ci.yml` reproduces the required context byte for byte, if the caller job is id `visual-docs` with no `name:` and passes none of `gallery-title`, `projects` or `arches`.** The evidence:
  - **Observed names.** Today's job records name the check `visual-docs / report (x86_64, shots/current, shots/verify, Visual docs)`, the exact required context (this spike's raw jobs, e.g. run 38696669809). It is the caller's job id `visual-docs` (visual-docs.yml:44, no `name:`), then ` / `, then the called job's name.
  - **The called job's name comes only from its matrix.** `report` (screencomp `visual-docs-reusable.yml@v0.4.8` :387) has no `name:`, so GitHub names it `report (<matrix values>)`. Those values come from the `arches` job (:246–317): `arch` from `screencomp.toml`, `current`/`verify` defaulting to `shots/current`/`shots/verify`, the empty `project`/`manifest` omitted, and `gallery_title` from the input `gallery-title`, whose default is `Visual docs` (:112–114). That default is fixed and independent of the calling workflow's `name:`, so calling it from the workflow named `CI` does not change it. The reusable workflow never reads `github.workflow`, which becomes the caller's name in a called workflow (docs: *Reusing workflow configurations*).
  - **Permissions.** A job-level `uses:` may set `permissions:` (docs: *Supported keywords for jobs that call a reusable workflow*), and "The `GITHUB_TOKEN` permissions passed from the caller workflow can be only downgraded (not elevated) by the called workflow" (same section). `ci.yml`'s top level is `contents: read` (ci.yml:13–14), so the job must declare `contents: write`, `pull-requests: write` and `pages: read` (visual-docs.yml:38–41).
  - **Concurrency.** The called workflow's own group is `visual-docs-${{ github.ref }}` (:213–215), distinct from ci.yml's `ci-${{ github.ref }}`. The docs warn against sharing a group value between caller and called workflow.
  **What `visual-docs.yml` keeps once the PR run moves:**
  - `push: main`, which deploys the canonical gallery;
  - `workflow_dispatch`;
  - `schedule`, because `prune-history` runs only on schedule (:546–548);
  - `pull_request: types: [closed]` alone, because `cleanup-preview` runs only on `closed` (:521–523).
  On `closed`, `arches` and `capture` skip (:248, :324). This spike's data shows it: 129 closed-PR runs executed `pages-preflight` and `cleanup-preview` only, apart from 4 that coincided with a push. The PR types it drops (opened, synchronize, reopened) are exactly ci.yml's (ci.yml:10), so the context reports on the same events as today.
- **Token permissions for a CD-tail measurement job** (documentation-based; not exercised, since no workflow could be changed). Reading runs, jobs and pull requests needs **`actions: read`** (`GET /repos/{o}/{r}/actions/runs`, `…/runs/{id}`, `…/runs/{id}/jobs`) and **`pull-requests: read`** (`GET /repos/{o}/{r}/pulls`) (docs: *Permissions required for GitHub Apps*, the Actions and Pull requests tables). Add `contents: read` for tags and commits. Both workflows that would host the job set `permissions: {}` at the top: release.yml:97 and published-smoke.yml:83. "If you specify the access for any of these permissions, all of those that are not specified are set to `none`" (docs: *Workflow syntax → permissions*), so the job must declare all three at job level.
  - *`release`-triggered* (release.yml): `GITHUB_SHA` is the tagged commit and `GITHUB_REF` the tag (docs: *Events that trigger workflows → release*). The job can read its own run's sibling jobs and the push runs on that commit. It cannot see Published smoke, which starts only after the Release run completes, so the CD job time and count it reports would be incomplete.
  - *`workflow_run`-triggered* (published-smoke.yml): it "is able to access secrets and write tokens, even if the previous workflow was not" (docs: *Events that trigger workflows → workflow_run*). `GITHUB_SHA`/`GITHUB_REF` are the default branch's, so the release must be found through `github.event.workflow_run` (its id and `head_sha`), not through `GITHUB_SHA`. This is the only host that sees the whole CD tail; it should `needs:` the smoke jobs so its own run is complete when it reads.
  Per release, the reads are ≈1 runs-list call for the commit, 5–6 jobs calls, and 1–2 PR-list calls: ~10 requests, against GITHUB_TOKEN's primary limit of 1,000 requests per hour per repository (docs: *Rate limits for the REST API → Primary rate limit for GITHUB_TOKEN*).
- **Other design facts the finalize needs.** (a) Releases do not complete green. 39 of 54 Release runs concluded `failure`. Since #315, `verify-npm (ubuntu-latest)` failed 3 of 3 runs and `release-status` 4 of 4, which demotes every Release; a follow-up is drafted. Cycle time therefore measures *to the last CD job's completion*, not to a successful publish. (b) Mac capacity dominates the CD tail. `darwin` queued median 4443 s, p90 7524 s, max 7524 s (n=3), against `test`'s 2376 s hold, and the window's CD wall clock reached 47750 s (v0.30.1, 13.3 h). In v0.30.0, v0.30.1 and v0.31.1 the last CD jobs were the Mac legs of Published smoke, which started 9–13 h after the release commit and ran for seconds. (c) CI `macos` was cancelled 7 of the 8 current-shape PR runs where it was not skipped, and its reporters `cross (macos-latest)` and `install (macos-latest)` then fail (7 and 7). That reddens ordinary PR CI runs without any required context failing. (d) The current-shape sample is thin: 4 releases and 6 head commits. Thresholds set from it alone would be fitted to two days.
