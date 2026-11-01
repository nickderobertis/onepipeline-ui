// The status contexts branch protection on `main` requires, by the name each job
// reports under: ci.yml's four jobs, with branches not required to be up to date
// (the user's decision of 2026-10-18). Both the lifecycle test
// (tests/graph.test.mjs) and the four-jobs test (tests/ci-jobs.test.mjs) hold the
// workflows to this one list.
//
// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] the source is the repository's branch protection, which a person changes and only an authenticated API call reads; the offline gate cannot ask it. This is the one copy in the tree, and it changes in the same change that moves protection.
export const REQUIRED_CONTEXTS = [
  "lint",
  "test-linux",
  "test-windows",
  "test-macos",
];
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
