# THROWAWAY: saved budget results spike

Never merged. `ci.yml`, the `budgets` targets and `.github/tests/budget-report-job.test.mjs` (two
tests skipped, because they hold the job to two steps) carry spike-only changes.

## Repeating the measurement

1. Publish this branch as a draft against `main`. Its run is every `budgets` target from cold.
2. Cut a branch from it and open a draft pull request against this branch, so that affected
   selection and the diff see only what that branch adds.
   - Push 1, CI-only: a comment line in `.github/workflows/ci.yml`.
   - Push 2, `apps/dag-ui`: revert push 1 and add a comment line in `apps/dag-ui/src/main.tsx`.
   - Push 3, identical inputs: `git commit --allow-empty`. A hit on `dag-ui-e2e:budgets` must
     restore `target/budget-results/dag-ui-e2e.json`.
   Wait for each run to finish first: a new push cancels the running one.
3. `spike/saved-results/collect.sh <run-id>` prints one run's figures.
4. Lookup alone, anywhere with `gh`:
   `spike/saved-results/merged-run-reads.sh <commit-sha> [artifact-name] [out-dir]`.
