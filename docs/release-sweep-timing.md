# Release pull request sweep timing

Measured 2026-10-19, against release PR #368. These are estimates of complete
jobs, including provisioning and cache saves, not a promise about arbitrary
registry outages. The next release-PR CI run is the validation; no CI run was
triggered, rerun or cancelled to produce these measurements.

## Evidence and work removed

The source logs can be fetched with GET only:

```sh
gh api repos/nickderobertis/onepipeline-ui/actions/jobs/118043738773/logs
gh api repos/nickderobertis/onepipeline-ui/actions/jobs/117862781028/logs
gh api repos/nickderobertis/onepipeline-ui/actions/jobs/118043738531/logs
gh api repos/nickderobertis/onepipeline-ui/actions/jobs/117862781006/logs
```

The first two are Linux in runs 39247750671 and 39190752893; the last two
are Windows in those runs. Nx static-output groups are emitted at task completion,
not task start. Start times below were recovered using the pinned Nx scheduler's
six slots, dependency edges, reverse-dependency priority and project priority;
adding the listed task durations reproduces the completion order. A cancelled
job's elapsed time is a lower bound, not its completed sweep duration.

| Observation | Earlier release PR | Later release PR |
| --- | ---: | ---: |
| Linux instrumented unit tier | 546 s | 129 s |
| Linux instrumented repo-tooling tier | 648 s | 257 s |
| Linux instrumented e2e tier | 612 s | 541 s |
| Linux baseline provisioning | 536 s | 722 s |
| Linux linked-report tier | 615 s | 407 s |
| Linux browser e2e | 555 s | 527 s |
| Linux release tests | at least 974 s (cancelled) | 1093 s |
| Windows test tiers all finished, from Nx start | 438 s | 690 s |
| Windows install-smoke | 1146 s | unfinished at cancellation |

In the later Linux log, the release target started about 534 s after Nx started.
Its dry-run build suite took 852.062 s, publication suite 165.583 s, and all
release tests 1092.894 s. The command inside the first suite took 794 s. These
are nested intervals: they must not be added to each other. The remaining
release tests account for about 75 s. The release rehearsal now has its own
target, with two dependents, so its tools run at the head of the queue and the
rehearsal follows them rather than trailing the test tiers. Tools tests follow
the rehearsal because they recreate its Python environment. (Since split
further: the journeys over the rehearsal's files run after it in `test-staged`,
those that read none of them beside it in `test-standalone`, and the check and
tools tests after all three;
[linux-cold-cache-timing.md](linux-cold-cache-timing.md).)

Changes preserve all assertions in the release journeys:

- Install-smoke uses `cargo install --debug`, sharing the dev build used by the
  browser server. It still tests the installed executable through
  `smoke-published.sh`. Its former release-profile compile is covered by the
  rehearsal's manylinux build on Linux and the actual release builds on every
  platform. This is a profile change, not a claim to test a release-profile
  local install on Windows anymore.
- The broader Linux selection drops wheel-smoke: the rehearsal calls the same
  `wheel-linux` recipe and installs and runs its wheel through the staged-release
  verifier. The removed invocation's version, help, health and exit-code smoke
  assertions remain in that verifier's call to `smoke-published.sh`. The affected
  selection still runs wheel-smoke. Two containers previously built into one
  wheel target directory, contending on Cargo's lock.
- Bootstrap no longer compiles the browser's API server. Its browser test
  dependency still builds that server; compilation overlaps the tiers instead
  of delaying every tier. No browser journey or assertion was removed.
- Baseline provisioning shares intermediate debug units with the current tree,
  while keeping the base binary in its separate scratch target. A fresh native
  compiler forwarder gives each archived workspace a distinct Cargo artifact
  namespace without changing dependency units or compiler options. It still
  builds the base manifest under its own lock and verifies the stamped commit.
  This uses Cargo's documented [workspace-wrapper filename hashing](https://doc.rust-lang.org/cargo/reference/environment-variables.html#environment-variables-cargo-reads).
- The auditable build likewise shares intermediate dependency units, keeps its
  own executable, and clears Cargo's test-process package environment. The same
  linked-report requests and dependency-report assertions still run.

Local four-job cold compiles into `/tmp` measured release 527.37 s versus debug
144.07 s (`RUSTC_WRAPPER=`); with the host's compiler cache, 685.24 s versus
174.81 s. A release-profile experiment took 434.50 s without the wrapper but
was not adopted. These are compile comparisons, not full sweep measurements.
The former attempt's local sweeps exited nonzero and are not successful timing
proofs. Shared-host load and build locks make their wall times unsuitable for
scaling hosted runner times directly.

## Finished-tree forecast and cap

The Linux schedule uses both observed tier envelopes, retaining the full
407–615 s linked-report duration even though its duplicate compile was cut.
It budgets 120–180 s for baseline provisioning, 47–240 s for the browser server
now inside the sweep, 60 s for dev install, and 1018 s for the unchanged rehearsal
plus 75 s for its other release tests. Six workers overlap these intervals;
adding every tier would double-count most of the job. Budget another 30 s in
repo-tooling for native-forwarder setup in its guard journeys, plus 60 s for
the separate baseline-reuse target (its measured test times were 34.9–58.7 s).
The resulting Nx critical path is 1146 s for the warmer envelope and 1234 s
for the colder one.
Conservatively add 5 s to both critical paths for a cold frontend build, without
crediting its overlap: 1151 s and 1239 s.

For the complete Linux job, the warm case adds 90 s provisioning and 60 s
post steps: 1301 s, or 21.7 min. The cold case reserves 180 s provisioning and
120 s post steps: 1539 s, or 25.7 min. Provisioning was 125 s in the later log;
the earlier log included a serial 178 s API compile now moved into Nx. Reserve
another 16% over the cold envelope for runner speed, earlier rehearsal CPU
contention, Docker setup and overlap uncertainty: 1785.3 s, rounded up to
**29.8 min**. The resulting forecast is **21.7–29.8 min**. The large observed instrumented-tier
variance is included by using both envelopes before this residual margin.

Windows keeps the affected cross-platform selection even on a release PR.
With the duplicate release install compile removed, the observed non-install
critical path is 438–690 s. The later run had already completed every other tier
at 12:12:04, 19.8 min after job setup began, despite its old serial bootstrap
compile. Budgeting a dev install without credit for bootstrap overlap, another
120 s for cache saves, and 14% residual runner/build-lock variance gives
(19.8 + 2) × 1.14 = **24.9 min**. The forecast is **16–25 min**; it conservatively
credits no saving from moving bootstrap's compile and assumes no Nx test-cache
hits. Reserve 30 s of extra native-forwarder work in repo-tooling. Its observed
106–200 s lead over the last Windows test tier also accommodates the separate
60 s reuse journey when baseline-specific inputs select it; the 14% residual
covers overlap and CPU-contention uncertainty. That new edge is not selected
for a version-only release diff (Cargo.toml, Cargo.lock and CHANGELOG.md), as
`/tmp/sweepcap/scoped-release-version-graph.json` verifies through real Nx.
Local debug/release measurements support eliminating the release install tail,
but do not measure Windows compilation speed.

Linux's upper end exceeds 25.5 min (85% of 30), so only its cap changes:
`ceil(29.8 / 0.85) = 36` minutes. Its upper estimate leaves 17.2% of that cap.
Windows stays at 30 minutes; 25 min leaves 16.7%. Lint and macOS stay at 30.
The workflow, cancelled-cache verdict, CI job tests and AGENTS.md agree on these
caps. This is a timeout allowance for the measured remaining work, not a new
performance threshold or permission to skip checks.

A later complete Linux job over 29.8 min or Windows job over 25 min falsifies
this forecast. Inspect per-target durations and queue delay first; include setup
and cache-save time, and distinguish cache hits from compilation. Registry
unavailability has no finite completion-time estimate.

## Local verification on the finished tree

| Real interface | Result |
| --- | --- |
| `onepipeline-ui-release:test`, including its dependencies | All 15 rehearsal and 30 smaller tests passed; 13m36s, zero Nx cache hits |
| `dag-ui-e2e:test` | All 139 passed; 8m52s including prerequisites |
| `dag-ui-e2e:test-isolation` | Both passed; 51.6 s of tests |
| `dag-ui-e2e:bootstrap` and `dag-ui:build-api-server` | Passed |
| `onepipeline-ui-repo-tooling:test` | All 184 guard, graph and packaging tests passed |
| `onepipeline-ui-baseline-reuse:test` and `test-quick` | The real Cargo reuse/source-identity/failure/recovery journey passed through both targets |
| `onepipeline-ui-linked-report:test` and `onepipeline-ui-baseline:test-baseline` | Real server journeys and base/head API comparisons passed after the cache correction |
| `onepipeline-ui-ci-jobs:test` | All ten recipe-selection journeys passed |
| `github-workflows:test`, `test-ci-jobs` and `budgets` | Passed; full workflow suite has 56 tests |
| `onepipeline-ui:ensure-baseline` | Forced real SDK-backed rebuild, stamp removed first: passed in 68.3 s including Nx startup |
| `onepipeline-ui:install-smoke` | Passed in 50.4 s including its smoke journey |
| `just lint`, `just fmt-check`, static and judged diff lint | Passed |

The final release run used warm Cargo artifacts, not replayed Nx results.
Its dry-run command took 470 s, build/install suite 563.270 s, and rehearsal
about 12m53s. A preceding build/install suite passed in 799.736 s (dry-run
712 s); that entire invocation failed later and is not a passing full-target
proof. These measurements retain the CI-based forecast above rather than
scaling hosted-runner times from the warm local run. Raising the dev install
model allowance from 30 to 60 s leaves both predicted critical paths unchanged.

The first browser attempt passed 137 tests and timed out in two. The separate
full-target rerun passed all 139, including both previously failing journeys.
No browser implementation or assertion was changed to obtain that pass. That
rerun overlapped some release compilation, so it is not an isolated host timing.
The initial repo-tooling run failed on Node's conflicting `NO_COLOR` and
`FORCE_COLOR` warning; unsetting the worker's `NO_COLOR` returned all 185 tests
to green. Judged lint ran with `LLMLINT_ONEHARNESS_BIN` unset against the installed
oneharness: the inherited value named an absent orchestrator wrapper. Neither
worker environment override changed repository enforcement.

The baseline test now compiles a real local dependency and this crate's
library-plus-binary shape, runs both executables, and breaks and repairs the
dependency. This replaces the internal Cargo-argument assertion with observed
reuse, source identity and recovery. It lives behind its own narrowly keyed
`onepipeline-ui-baseline-reuse:test` / `test-quick` edge, not in repo-tooling's
broad input set. The nextest partition moved this one journey into its own
profile; every existing assertion and the default test collection remain.
Linux `check` and the cross-platform `test-quick` selection reach that edge.
Actual Nx graphs select it for the provisioning script but not for Cargo.toml
(`/tmp/sweepcap/scoped-provisioning-graph.json` and `scoped-version-graph.json`).
Removing the shared build directory made
its dependency compile twice (`/tmp/sweepcap/real-baseline-dependency-reuse-mutation.log`).
Reverting the namespace correction installed the branch executable as the base
(`/tmp/sweepcap/real-reuse-original.log`). Restoring both returned the suite
to green, including the subsequent tier extraction: 184 repo-tooling tests and
ten CI-selection journeys in `/tmp/sweepcap/scoped-partition.log`, and the new
tier's real journey through both targets in `/tmp/sweepcap/scoped-reuse2.log`.
Real SDK-backed baseline and linked-report journeys also passed
(`/tmp/sweepcap/final-baseline-api.log`).
The corrected real baseline rebuilds measured 45.2–68.3 s, within the forecast's
120–180 s allowance. The earlier 20.1 s measurement is not used as proof of
correct cache isolation.
No hosted Windows execution is claimed; the next release-PR CI run validates
that platform's forecast.

### Temporary mirror setup for the real release run

CentOS vault returned HTTP 403 for yum metadata on this host. The manager
approved an untracked helper, `/tmp/sweepcap/mirror-forwarder/docker`, for this
run only. It executed `/usr/bin/docker` with every original argument intact
except inserting the following setup immediately before the existing
`yum install -y -q perl-IPC-Cmd perl-Time-Piece` in the manylinux shell command:

```sh
sed -i \
  -e 's|https://vault.centos.org/centos/\$releasever/|https://archive.kernel.org/centos-vault/7.9.2009/|g' \
  -e 's|https://vault.centos.org/centos/7/|https://archive.kernel.org/centos-vault/7.9.2009/|g' \
  /etc/yum.repos.d/*.repo
```

Both the base repositories and SCLo therefore fetched the same signed CentOS
packages through kernel.org. The helper forwarded both real Linux builds;
it synthesized no output or exit status. The repository stayed clean for
Cargo packaging, and no `--allow-dirty` flag or test assertion was changed.
The helper and its duplicate were removed after success. The committed
`scripts/build-linux-wheel.sh` remains identical to the merge base; another
dispatch owns the permanent fetch repair.

The first real Docker client's exact PATH was captured from its process
environment (the Nx invocation itself began with the helper directory):

```text
PATH=/home/nick/projects/ai-orchestrator/runs/Share-one-Codex-app-server-across-dispatches-and-budget-network-data-per-launch/scratch/739294-34/release-journey-rehearsal-xIYp1S/gh-bin:/home/nick/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/1/worktree/.tools/release-venv/bin:/home/nick/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/1/worktree/.tools/bin:/home/nick/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/1/worktree/node_modules/.bin:/home/nick/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/1/node_modules/.bin:/home/nick/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/pool/node_modules/.bin:/home/nick/.onevcs/workspaces/github.com-nickderobertis-onepipeline-ui-95f7516c419c/node_modules/.bin:/home/nick/.onevcs/workspaces/node_modules/.bin:/home/nick/.onevcs/node_modules/.bin:/home/nick/node_modules/.bin:/home/node_modules/.bin:/node_modules/.bin:/home/nick/.asdf/installs/nodejs/26.5.0/bin:/tmp/sweepcap/mirror-forwarder:/home/nick/.asdf/installs/nodejs/26.5.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-path:/home/nick/.local/bin:/home/nick/.codex/tmp/arg0/codex-arg0AP4B4T:/home/nick/.asdf/installs/nodejs/26.5.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-path:.venv/bin:/home/nick/projects/ai-orchestrator/.venv/bin:/home/nick/projects/ai-orchestrator/.venv/bin:/home/nick/.local/bin:/home/nick/.cargo/bin:/home/nick/.local/node/bin:/home/nick/.asdf/plugins/nodejs/shims:/home/nick/.asdf/installs/nodejs/26.5.0/bin:/home/nick/.asdf/shims:/home/nick/.asdf/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
```

The negative install journey additionally prepended `/home/nick/projects/ai-orchestrator/runs/Share-one-Codex-app-server-across-dispatches-and-budget-network-data-per-launch/scratch/739294-34/release-journey-rehearsal-xIYp1S/broken-venv`, as its
unchanged fixture specifies. The forwarding audit records two builds in
`/tmp/sweepcap/mirror-forwarder-used.log`. The successful full-target log is
`/tmp/sweepcap/release-forwarded.log`; the successful browser rerun is
`/tmp/sweepcap/browser-alone.log`. These are local verification records, not
claims that a complete local sweep or a hosted CI job was run successfully.
