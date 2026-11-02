// The repository's check contract: which checks block a change and a release,
// and which report without ever blocking. This file is its one statement; the
// manager reconciles branch protection on `main` against it, and the workflow
// tests hold the workflows to it (.github/tests/graph.test.mjs,
// .github/tests/ci-jobs.test.mjs, .github/tests/advisories.test.mjs).
//
// Blocking: REQUIRED_CONTEXTS, the status contexts branch protection on `main`
// requires, by the name each job reports under — ci.yml's four jobs, with
// branches not required to be up to date (the user's decision of 2026-10-18).
// They block every change request, and a release too: a release ships the head
// of release-plz's pull request, which merges only past the same four, and
// release.yml re-runs no tests (its jobs' failures demote the Release, never
// gate a merge). A check that must block is a step of one of the four.
//
// Informational: INFORMATIONAL_CONTEXTS report and must never be required, and
// no job in any workflow may need them or wait on their result.
//   advisories  Every security advisory matching the head's Cargo.lock, whether
//               or not the change brought it in (`just advisories-report`):
//               posted as a commit status by a `continue-on-error` step of ci.yml's
//               `lint` on each pull request's head, and run as ci-cache.yml's
//               `advisories` job on each push to `main`. Red until someone fixes
//               the advisory. A pull request from a fork gets no status — its
//               token cannot post one — and reads the same report in `lint`'s
//               step summary and log instead, which every pull request also gets.
//               An advisory a change *introduces* is blocked by `lint`'s own
//               audit (`just deps-check`), so making this required would only let
//               a newly published advisory against a version `main` already
//               resolves block every unrelated change and release.
//
// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] the source is the repository's branch protection, which a person changes and only an authenticated API call reads; the offline gate cannot ask it. This is the one copy in the tree, and it changes in the same change that moves protection.
export const REQUIRED_CONTEXTS = [
  "lint",
  "test-linux",
  "test-windows",
  "test-macos",
];
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

export const INFORMATIONAL_CONTEXTS = ["advisories"];
