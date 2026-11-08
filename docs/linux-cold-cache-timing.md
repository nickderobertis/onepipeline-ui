# Linux job on a cold Rust cache

Measured 2026-10-20 for `test-linux` runs cancelled at their 36-minute cap
(PR #395's job 118653295422, main's 118494578589, release-plz's 118477876803 and
118477186037). No CI run was triggered, rerun or cancelled to produce these
measurements; the CI logs below were read with GET only and served as guidance.

## What made the slow jobs slow

Each slow job's two `Swatinem/rust-cache` restores reported `No cache found`;
each fast job restored 1.2–1.5 GB. A cold `target` makes the job compile four
whole dependency graphs (debug, coverage-instrumented, `cargo doc`'s, and the
manylinux release build), each with OpenSSL from source, which a warm run reads
back. Why the caches miss is recorded as a follow-up, not changed here: rust-cache
hashes every installed toolchain, including the runner image's unused stable,
and two image versions were live (1.99.0 and 1.99.1); and the repository's
caches total 10.9 GB, over the 10 GB limit, so main's Linux caches are evicted.

A cold job will therefore keep happening, so what this change removes is what a
cold job spent beyond its compiles. A cold `just ci-test-linux`, traced by
sampling its process tree, showed these on the job's longest chains:

1. **Journeys queued behind the rehearsal.** `onepipeline-ui-release:rehearse`
   ran `publication.test.mjs`, which reads none of the rehearsal's files, after
   `journeys.test.mjs`, and inside that file the recipe's refusals of broken
   staged files and the registry journeys ran one after another behind the
   manylinux build; `release:test` ran six more independent files after it all.
2. **The baseline held `target`'s build lock through the debug graph.**
   `ensure-baseline` builds with `build.build-dir = "target"`, which cargo locks
   for the whole build. Cold, that build compiled the debug graph for 11.7
   minutes while `build-api-server`, `doc` and `install-smoke` waited in Nx
   slots.
3. **The browser tier started last.** Nx starts the ready task with the most
   dependents first, then the one whose project most projects depend on;
   `dag-ui-e2e:test` scores nothing on either, so it waited behind every crate
   task for a slot: 5.5 minutes after its server was built.
4. **`ui::a_build_without_the_bundle…` compiled the debug graph a second time,**
   into `target/no-bundle`, a target directory of its own: 7.8 minutes of the
   e2e tier against 0.9 once it shares `target`.

Main's job 118705585520 (run 39445326668) failed rather than overran, on
another cold cache: its step ended at 15:35:55 with `Failed tasks:
dag-ui-e2e:test`, the journey "falls back to the empty state once no run is
left" not seeing the empty state within its 15 s. Its `ENOENT … opendir
target/wheel-smoke/venv/…/colorama/tests/{target,trybuild}` annotations come
two seconds later from rust-cache's post-job "Cleaning … target" pass, which then
saved the cache; successful jobs (118466628123) carry the same annotations, so
they fail nothing. That journey's 15 s wait is recorded as a follow-up.

## What changed

- `tests/release/project.json`: `rehearse` runs the manylinux build and its own
  checks (`journeys.test.mjs`) and declares the staged tree as its output.
  `test-staged` then runs `rehearsal-failures.test.mjs` and
  `registries.test.mjs` at once, both reading that tree and writing only trees of
  their own (the files they share are named once in `rehearsal.mjs`).
  `test-standalone` runs `doubles`, `plan`, `release-plz`, `probe`, `staging`
  and then `publication.test.mjs` beside the rehearsal.
  `test` runs `check.test.mjs` and `npm-upload.test.mjs`, whose waits are timed
  against their budget, and `tools.test.mjs`, which rebuilds the shared venv, after all of them: run
  beside the rehearsal, `check.test.mjs` failed its `>= 14 s` assertion at
  10.5 s. `scripts/release.mjs` names the SBOM's scratch file after its `--out`
  (`sbomScratch`), because two publish builds now run at once.
- `project.json`: `ensure-baseline` depends on `dag-ui:build-api-server`, so the
  server compiles the graph and the baseline then its own crate (0.5–1.0 min).
- `apps/dag-ui-e2e/project.json`: `test-isolation` follows `test`, which gives
  the browser tier a dependent and so a slot as soon as its server is built.
- `tests/e2e/ui.rs`: the packaged build uses `target` as its `build.build-dir`,
  salts its own crate's units with a native `RUSTC_WORKSPACE_WRAPPER` as
  `scripts/ensure-baseline-api.sh` does, and drops the variables cargo sets for
  the test binary (`ring` reruns its build script on `CARGO_MANIFEST_DIR` and
  `OUT_DIR`, which otherwise made it and the server rebuild each other's units).

No assertion was removed. The SBOM assertion now also checks the scratch file
this build wrote; the journeys that moved run unchanged in their new files.

A higher CPU weight for the manylinux container (`--cpu-shares 4096`) was tried
and reverted. It shortened the job by 0–2 minutes, but it runs the container
from the job's first minute at three times a service's weight, beside
`dag-ui:test`: that tier's 5 s and 60 s test timeouts failed in 3 of the 4
weighted cold runs, all three made on 10-20 between runs #2 and #4 below, and in
none of the 7 runs below, which ran at the default weight. The tree no longer
depends on how a runner divides CPU between the job and its containers. The
weighted runs, each on CPUs 0-3 beside the same commit at the default weight
(load was not sampled during the three later ones; the default-weight runs
interleaved with them saw 4.8–18.9):

| When | Commit | Weighted | Default weight | Outcome of the weighted run |
| --- | --- | ---: | ---: | --- |
| 10-20 morning, load 3.7-6.6 | an earlier form of the change (row 1) | 20m15s | 22m21s | passed but for row 1's EXDEV case |
| 10-20 evening | a6c5efe | 21m21s | 23m23s | `dag-ui:test` timed out at 5 s |
| 10-20 evening | 24087db | 23m11s | 23m12s | `dag-ui:test` timed out at 5 s |
| 10-20 night | b8782a8 | 21m29s | 23m59s | `dag-ui:test` timed out at 5 s and 60 s; `release:test` and `test-standalone` did not run, so the duration is short of a full run |

## Measurement

`just measure-cold-linux` (`scripts/measure-cold-linux.sh`) clones one commit
into `/tmp`, applies a fixture change on top, provisions it untimed, removes
`target`, `.nx` and the baseline server, and runs `just ci-test-linux` pinned to
`--cpus` with Docker pinned to the same CPUs and every compiler cache off. The
journeys' scratch directory sits beside the clone, on the same filesystem. The
fixture is PR #395's change, which selects that job's 20 tasks (22 on the
finished tree, with `test-staged` and `test-standalone`):

```sh
git fetch origin pull/395/head:refs/remotes/origin/pr-395
just measure-cold-linux --commit 1c71ecd --fixture 1c71ecd...origin/pr-395 \
  --label before --cpus 0-3 --workdir /tmp/onepipeline-ui-cold
just measure-cold-linux --commit HEAD --fixture 1c71ecd...origin/pr-395 \
  --label final --cpus 0-3 --workdir /tmp/onepipeline-ui-cold
```

The host is shared with other work, which moved the before tree alone between
27m14s and 38m00s, so each ratio below compares a before-tree run with a
finished-tree run made under conditions as close as the host allowed. Host load
is the 1-minute load average on the host's 8 CPUs (start and end of each run,
or its mean over the run where it was sampled); the job's own work is part of it.

| # | When, layout | Before (1c71ecd) | Finished tree | Ratio |
| --- | --- | ---: | ---: | ---: |
| 1 | 10-20 morning, within the hour, CPUs 0-3, load 3.7-6.6 | 28m51s ⁷ | 22m21s ¹ ⁷ | 0.775 |
| 2 | 10-20 evening, back to back, CPUs 0-3, load 4.8-13.7 | 30m46s | 23m23s ² | 0.760 |
| 3 | 10-20 evening, 1.5 h after #2's before run, CPUs 0-3, load 6-17 | 30m46s | 23m12s ² | 0.754 |
| 4 | 10-20 night, back to back, CPUs 0-3, load 6.3-18.9 | 35m04s | 23m59s ³ | 0.684 |
| 5 | 10-20 night, back to back, finished first, CPUs 0-3, mean load 21.4 finished, 24.6 before | 38m00s | 26m19s ⁴ | 0.693 |
| 6 | 10-21, back to back, CPUs 0-3, mean load 16.0 before, 20.5 finished | 27m14s | 22m42s ⁵ | 0.834 |
| 7 | 10-21, at the same time, before on CPUs 0-3 and finished on 4-7, load 8-24 | 34m56s ⁶ | 30m56s ⁵ | 0.886 |

¹ An earlier form of the change: the rehearsal split and the baseline and
`ui.rs` fixes, without `test-staged` or the browser tier's ordering.
² Earlier commits of this branch (a6c5efe, 24087db), with their CPU weight
removed at `docker run` by an earlier revision of the measurement.
³ b8782a8 with its CPU weight removed the same way, which is e7d2622's tree.
⁴ e7d2622, the weight's revert. ⁵ 9fa9b23, the finished tree but for the lock
bump, a formatting fix and the measurement's own hardening.
⁶ A Playwright journey timed out in this run, as in main's job 118705585520;
Nx ran every other task, so its duration stands.
⁷ Made with the ad-hoc harness this script was written from, under the same
conditions; in both runs `tools.test.mjs`'s copy-from-PATH case failed with
EXDEV, its scratch directory being on another filesystem than the clone, which
the script's scratch placement fixed.

Every other test passed in every run listed. Left out: the weighted runs,
listed above, whose variant the tree no longer carries; a run on 10-20 that
stopped when `check.test.mjs` failed beside the rehearsal, which is why it runs
after it; and the second simultaneous pair (10-21, before on CPUs 0-3 and
finished on 4-7, right after #7, load not sampled), neither of which ran every
task: the finished-tree run (9fa9b23, 29m13s) stopped on the registry double's
port race (fixed in 93a5e97) with a Playwright timeout beside it, and the
before-tree run (33m53s, its `dag-ui-e2e:test-isolation` failing on a port
already in use) had its `release:test` stopped 44 s in when measuring ended.

## Estimate under the finished tree, cold

The median of the seven ratios is 0.760, and the worst is 0.886 (#7, where two
cold jobs and the host's other work saturated all 8 CPUs). A hosted cold job is a
hosted before-tree job scaled by the ratio, plus the 1.4-1.8 minutes before Nx
and the 0.3-0.5 after it. PR #395's cold job ran the fixture's 20 tasks for 34.7
minutes of Nx; the longest hosted cold job, 118494578589 (main, 29 tasks), was
cancelled with its rehearsal done 35.0 minutes in and `release:test`'s ~2.1
minutes still to run, about 37.1.

| Ratio | PR #395's job (34.7) | Longest job (37.1) |
| --- | ---: | ---: |
| median, 0.760 | **28.7 min**, 20% under the cap | 30.5 min, 15% under |
| worst, 0.886 | 33.1 min, 8% under | 35.2 min, 2% under |

The estimate is the median's 28.7 minutes for the job this change was made for,
at least 15% under the 36-minute cap; the worst measured case, 35.2 minutes,
stays under it. The cap is unchanged. A hosted cold job over 30.5 minutes is
outside every median figure above.

## Later: the tail behind the timed journey (2026-11-08)

On the action-items branch, test-linux was cancelled at its cap four times on
fab12a3d (run 42458563223) and again on c5797b8c (run 42473859179, job
128710690806) with every finished task green. Nx's own record of the last
passing run (42451639631, `nx-cache-entries-test-linux`'s `executions.json`)
gives each task's start and end. The job ends on `dag-ui-read-latency:test`,
which has `parallelism: false` and so starts only once every other task is done.
The last of those was `github-workflows-nx-cache:test`. It reads the whole
workspace, so it runs on every pull request, for about 950 s. Having no dependent,
it started 635 s into that run and about 800 s into the cancelled one. Two
changes, held to Nx 23.1.3's own `TasksSchedule` driven over the branch's task
graph with that run's task durations:

- `.github/tests/nx-cache/project.json`: a no-op `prioritize` follows `test`,
  test-linux's affected targets (`scripts/ci-job.sh`) and the project's `check`
  name it, so the suite has a dependent and a slot with the tiers
  (it starts at 302 s rather than 692 s). On its own that moves the end only
  41 s: with `dag-ui-e2e:test` uncached, the browser tier then ends last.
- `apps/dag-ui-e2e`: each action-items world is built once per run and copied
  for later journeys (`fixtures/human-items-world.mjs`). That spec's 54 world
  starts took 177 s and now take 60 s on this host.

With the edge in place and the browser tier 112–212 s shorter, the modelled end
moves from 1899 s to 1746–1714 s. The same model puts the passing run's end at
1820 s; it actually ended at 1843 s.

`dag-ui-read-latency:compile-release-server` builds through `just wheel-linux`
for the same reason. A host `cargo build --release` beside `wheel-smoke` and
the rehearsal compiled a second release dependency graph that no warm cache
held: 1420–1450 s on every recent branch, test-linux's longest task.

Run 42508499783 (a1d8ba2) was cancelled at the cap with the browser tier still
running. Three tasks in a row have no slack around them: `dag-ui:build-api-server`
(8.4 minutes into Nx there), `dag-ui-e2e:test` (24.3 minutes on one worker, run
42458563223 attempt 3) and `dag-ui-read-latency:test` (255 s, alone). With the
3.3 minutes before Nx that is about 40 minutes whatever else is reordered.
`dag-ui-e2e:test` now runs two single-worker lanes: the journeys against the shared
server in one, and `dag-ui-human-items` and `dag-ui-update-settings`, whose every
journey starts its own server, in the other. Those two were 695 of the tier's
1851 s of journey time, so the tier's wall time falls by up to that share, about
9 minutes on the runner; the same 284 journeys run.

Run 42515808360 (080242f, job 128838449483) had both lanes and was still cancelled
at the cap, with `dag-ui-e2e:test`, `:test-isolation`, `dag-ui-read-latency:test`
and `:budgets` and `onepipeline-ui-release:test` unfinished and every finished task
green. `dag-ui:build-api-server` ended 12.7 minutes into Nx, against 260 s on the
last passing run (fda7038), which predates this branch's move of the linked
`onepipeline` and replayed the browser tier. A pin move misses main's warm Rust
cache for that crate in every target directory the job compiles, and a change to
the app runs the browser tier.

That was then profiled with `cargo build --timings` at four jobs, cold, on a loaded
shared host, so the durations are a profile and not a comparison:

| Build | `onepipeline` | this crate's library | binary | Serial total |
| --- | --- | --- | --- | --- |
| debug (`build-api-server`) | 81 s | 13 s | 4 s | about 100 s |
| release (the wheel) | 473 s | 97 s | 240 s | about 810 s |

The release rows are serial because `codegen-units = 1` and thin LTO keep each on
one rustc. The debug figure is far under the 12.7 minutes `build-api-server` took
to finish, so the build's own compile does not explain that time. A cancelled run
records no task start times, so the time it waited for a slot is not measured.

The release build is not compiled three times. `compile-release-server`,
`wheel-smoke` and `rehearse` share `target/wheel-x86_64-unknown-linux-gnu` behind
the lock in `scripts/build-linux-wheel.sh`, and in that run two of the three report
cargo finishing in about a second. So two of the job's six Nx slots slept on the
lock for the compile. `wheel-smoke` and `rehearse` now depend on
`compile-release-server`, so they start once it is done and the slots go to tasks
that can run; the same three commands run. A list-scheduling model of six slots,
with durations from the fda7038 and 080242f runs and no account of CPU limits,
moves the job's end from about 2425 s to 1900 s into Nx. CI has not measured it.
Sharing `target`'s build directory with `build-api-server` was not done: it would
save about 100 s of compile and queue that build behind the tiers' compiles there.
