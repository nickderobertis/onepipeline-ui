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
  and then `publication.test.mjs` beside the rehearsal, after `dag-ui:test`.
  `test` runs `check.test.mjs`, whose waits are timed against their budget, and
  `tools.test.mjs`, which rebuilds the shared venv, after all of them: run
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
and reverted. It shortened the rehearsal by 3.5–3.9 minutes and the job by 0–2,
but it runs the container from the job's first minute at three times a
service's weight, beside `dag-ui:test`: that tier's 5 s and 60 s test timeouts
failed in 3 of the 5 weighted cold runs (every one measured the evening the 7
runs below were), and in none of those 7, which ran at the default weight. The
tree no longer depends on how a runner divides CPU between the job and its
containers.

## Measurement

`just measure-cold-linux` (`scripts/measure-cold-linux.sh`) clones one commit
into `/tmp`, applies a fixture change on top, provisions it untimed, removes
`target`, `.nx` and the baseline server, and runs `just ci-test-linux` pinned to
4 CPUs with Docker pinned to the same 4 and every compiler cache off. The
journeys' scratch directory sits beside the clone, on the same filesystem. The
fixture is PR #395's change, which selects that job's 20 tasks (22 on the
finished tree, with `test-staged` and `test-standalone`):

```sh
git fetch origin pull/395/head:refs/remotes/origin/pr-395
just measure-cold-linux --commit 1c71ecd --fixture 1c71ecd...origin/pr-395 \
  --label pair-before --workdir /tmp/onepipeline-ui-cold
just measure-cold-linux --commit HEAD --fixture 1c71ecd...origin/pr-395 \
  --label pair-final --workdir /tmp/onepipeline-ui-cold
```

The host is shared, and other work on it moved every run's duration by more
than the change did (the before tree took 30m46s–38m00s), so each comparison is
a pair run back to back, the second order reversed:

| Pair | Before (1c71ecd) | Finished tree | Ratio |
| --- | ---: | ---: | ---: |
| 1, before first, host load 6–18 | 35m04s | 23m59s | 0.684 |
| 2, finished first, host load 21–25 | 38m00s | 26m19s | 0.693 |

Every test passed in all four runs, as in the three other default-weight runs
that evening (one before-tree run, 30m46s, and two of earlier finished-tree
commits, 23m23s and 23m12s). Pair 1's finished-tree run is the commit
before the weight's revert with the measurement's `--default-cpu-weight`, which
removes that weight at `docker run`; pair 2's is the revert itself.

## Estimate under the finished tree, cold

A hosted cold job is a before-tree job scaled by the measured ratio. The longest
hosted cold job of these: 118494578589 (main, 29 tasks), cancelled with its
rehearsal done 35.0 minutes into Nx and `release:test`'s ~2.1 minutes still to
run, about 37.1 minutes; PR #395's 20-task job ran 34.7. Taking 37.6 minutes for
a hosted cold before-tree Nx run, the larger pair ratio, 5% for a ratio from two
pairs, and the 1.4–1.8 minutes before Nx and 0.3–0.5 after it:

- high: 37.6 × 0.693 × 1.05 + 2.3 = **29.7 min**, 17.5% under the 36-minute cap
  and within its 30.6-minute 85%
- low: 25.5 (the fastest hosted cold job, 118486067053) × 0.684 + 1.7 =
  **19.1 min**

Runner variance enters through the hosted durations, which span 25.5–37.1
minutes of Nx for cold jobs; the cap is unchanged. A hosted cold job over 29.7
minutes falsifies the high figure.
