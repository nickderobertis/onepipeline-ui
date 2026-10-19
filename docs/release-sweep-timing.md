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
the rehearsal because they recreate its Python environment.

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
  while keeping the base binary in its separate scratch target. It still builds
  the base manifest under its own lock and verifies the stamped commit.
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
adding every tier would double-count most of the job. The resulting Nx critical
path is 1146 s for the warmer envelope and 1220 s for the colder envelope.

For the complete Linux job, the warm case adds 90 s provisioning and 60 s
post steps: 1296 s, or 21.6 min. The cold case reserves 180 s provisioning and
120 s post steps: 1520 s, or 25.3 min. Provisioning was 125 s in the later log;
the earlier log included a serial 178 s API compile now moved into Nx. Reserve
another 16% over the cold envelope for runner speed, earlier rehearsal CPU
contention, Docker setup and overlap uncertainty: 1763 s, rounded to **29.5 min**.
The resulting forecast is **21.6–29.5 min**. The large observed instrumented-tier
variance is included by using both envelopes before this residual margin.

Windows keeps the affected cross-platform selection even on a release PR.
With the duplicate release install compile removed, the observed non-install
critical path is 438–690 s. The later run had already completed every other tier
at 12:12:04, 19.8 min after job setup began, despite its old serial bootstrap
compile. Budgeting a dev install without credit for bootstrap overlap, another
120 s for cache saves, and 14% residual runner/build-lock variance gives
(19.8 + 2) × 1.14 = **24.9 min**. The forecast is **16–25 min**; it conservatively
credits no saving from moving bootstrap's compile and assumes no Nx test-cache
hits. Local debug/release measurements support eliminating the long release
install tail, but do not measure Windows compilation speed.

Linux's upper end exceeds 25.5 min (85% of 30), so only its cap changes:
`ceil(29.5 / 0.85) = 35` minutes. Its upper estimate leaves 15.7% of that cap.
Windows stays at 30 minutes; 25 min leaves 16.7%. Lint and macOS stay at 30.
The workflow, cancelled-cache verdict, CI job tests and AGENTS.md agree on these
caps. This is a timeout allowance for the measured remaining work, not a new
performance threshold or permission to skip checks.

A later complete Linux job over 29.5 min or Windows job over 25 min falsifies
this forecast. Inspect per-target durations and queue delay first; include setup
and cache-save time, and distinguish cache hits from compilation. Registry
unavailability has no finite completion-time estimate.

## Local verification on this branch

The forced real `onepipeline-ui:ensure-baseline` rebuild (stamp removed first)
passed in 20.1 s. `onepipeline-ui:install-smoke` passed in 50.4 s including the
smoke journey; raising its model allowance from 30 to 60 s leaves both critical
paths unchanged. The linked-report target passed both real server journeys
(58.887 s of tests). These warm measurements support sharing intermediates;
the forecast retains much larger hosted-runner allowances.

The repo-tooling target passed all 185 tests, the CI-jobs target all ten, and
the smaller release target all 30. The smaller release target was run with
`--excludeTaskDependencies` after provisioning its tools, because the full
`onepipeline-ui-release:test` invocation failed in its rehearsal dependency:
CentOS vault returned HTTP 403 for yum metadata before compilation. This is
an unresolved environment blocker, not a passing end-to-end rehearsal. The two
manager questions about that blocker received no reply within their windows.

To verify the added baseline test, the shared-build config argument was removed
temporarily: the repo-tooling target failed specifically at
`the_base_is_built_from_the_units_this_clone_already_compiled`, reporting the
missing shared build directory. The script was restored immediately afterward.
The local scratch logs are `/tmp/sweepcap/baseline-mutation.log` and
`/tmp/sweepcap/baseline-restored.log`. All new local measurements used the real
Nx targets, without Nx result-cache reuse; no hosted Windows execution is
claimed here.
