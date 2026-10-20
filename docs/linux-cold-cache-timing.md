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
cold job spent beyond its compiles. A cold `just ci-test-linux` was traced
locally, sampling the process tree every 3 s and the CPUs every 5 s, on 4 pinned
CPUs with Docker pinned to the same 4 and no compiler cache. It showed three
causes, each on the job's longest chain:

1. **The rehearsal's tail ran behind the compile.** `onepipeline-ui-release:rehearse`
   ran `publication.test.mjs`, which reads none of the rehearsal's files, after
   `journeys.test.mjs`, and `release:test` ran six more such files after both.
   With the manylinux compile ending about 18 minutes in, the release chain
   ended at 28.9 minutes.
2. **The baseline held `target`'s build lock through the debug graph.**
   `ensure-baseline` builds with `build.build-dir = "target"`, which cargo locks
   for the whole build. Cold, that build compiled the debug graph for 11.7
   minutes while `build-api-server`, `doc` and `install-smoke` waited on the lock
   in Nx slots, so the browser tiers could not start until about 19 minutes in.
3. **`ui::a_build_without_the_bundle…` compiled the debug graph a second time.**
   It builds the packaged crate into `target/no-bundle`, a target directory of
   its own, so cold it compiled every dependency again: 7.8 minutes of the e2e
   tier (13.4 → 21.2 min) against 0.9 minutes once it shares `target`.

Beside these, the manylinux compile (the head of the release chain) took
15.8–17.0 minutes inside the job against 9.8 alone (618 s for
`just wheel-linux x86_64-unknown-linux-gnu target/wheel-alone`, cold): Docker's
default weight makes its container one equal cgroup against everything the job
runs, where the job runs in a systemd service, as on the measuring host.

## What changed

- `tests/release/project.json`: `rehearse` runs `journeys.test.mjs` alone.
  `test-standalone` runs `publication.test.mjs`, `doubles`, `plan`,
  `release-plz`, `probe` and `staging` beside it. `test` runs `check.test.mjs`,
  whose waits are timed against their budget, and `tools.test.mjs`, which
  rebuilds the shared venv, after both. Running `check.test.mjs` beside the
  rehearsal failed its `>= 14 s` assertion at 10.5 s under the cold compiles, so
  it stays where it always ran. `scripts/release.mjs` names the SBOM's scratch
  file after its `--out` (`sbomScratch`), because two publish builds now run at
  once and both used to write and delete one `bom.json`.
- `project.json`: `ensure-baseline` depends on `dag-ui:build-api-server`, so the
  server compiles the graph and the baseline then compiles its own crate over
  those units (0.4 minutes cold, against 11.7).
- `tests/e2e/ui.rs`: the packaged build uses `target` as its `build.build-dir`,
  salts its own crate's units with a native `RUSTC_WORKSPACE_WRAPPER` as
  `scripts/ensure-baseline-api.sh` does, and drops the variables cargo sets for
  the test binary (`ring` reruns its build script on `CARGO_MANIFEST_DIR` and
  `OUT_DIR`, which otherwise made it and the server rebuild each other's units).
- `scripts/build-linux-wheel.sh`: the container runs at `--cpu-shares 4096`
  (cpu.weight 303), and its cold compile took 11.2–12.1 minutes in the job.

No assertion was removed. The SBOM assertion now also checks the scratch file
this build wrote. The tests that moved run unchanged in their new targets.

## Regression measurement

Both trees carry PR #395's `Cargo.toml` change on top, which selects that PR's
20 tasks (21 after, with `test-standalone`). Each run started from an empty
`target`, `.nx/cache` and no provisioned baseline, with tools provisioned
beforehand as CI's earlier steps do:

```sh
rm -rf target .tools/bin/onepipeline-api-baseline* .nx/cache .nx/workspace-data
PATH=<shim adding --cpuset-cpus=0-3 to docker run>:$PATH \
  RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= CARGO_INCREMENTAL=0 \
  ONEPIPELINE_UI_NX_BASE_SHA=<the tree's base> \
  taskset -c 0-3 just ci-test-linux
```

| Tree | Nx run | Release chain ends | Last task |
| --- | ---: | ---: | --- |
| Before (1c71ecd), two runs | 28m46s, 28m51s | 28.9 min | `onepipeline-ui-release:test` |
| Finished tree without the container weight | 22m21s | 22.3 min | `onepipeline-ui-release:test` |
| Finished tree | 20m15s | 20.2 min | `dag-ui-e2e:test` (20.3 min) |

Each run's one failing test was `tools.test.mjs`'s copy-from-PATH case, failing
with `EXDEV` because the measuring clones sat on `/tmp` and the scratch directory
on `/home`. It runs in the job's checkout and is not a timing.

## Estimate under the finished tree, cold

PR #395's cold job ran the same 20 tasks for 34.7 minutes of Nx against the
before tree's 28.85 locally: 1.20×. Other cold jobs give 0.88× (job 118486067053,
25.5 minutes, complete) and at least 1.22× and 1.23× (118477186037, 118494578589,
cancelled with `release:test`'s ~2 minutes still to run, so about 1.30×). Outside
Nx the job spends 1.4–1.8 minutes before it and 0.3–0.5 after it.

With 0.88–1.30× for runner variance and a further 5% for a single local run (the
two before runs differed by 0.3%, the three unweighted compiles by ±4%):

- low: 20.25 × 0.88 + 1.7 = **19.5 min**
- high: 20.25 × 1.05 × 1.30 + 2.3 = **29.9 min**, 16.8% under the 36-minute cap

If a hosted runner does not place the job's processes beside Docker's cgroups as
the measuring host does, the weight changes nothing there and the tree without
it applies: 22.35 × 1.05 × 1.30 + 2.3 = 32.8 minutes, 8.9% under the cap. The
runner's cgroup layout was not observable from the logs. The cap is unchanged.
A cold PR job over 29.9 minutes falsifies the first figure; compare its
manylinux compile against the 11.2–12.1 minutes above first.
