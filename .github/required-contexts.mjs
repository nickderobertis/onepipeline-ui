// The status contexts branch protection on `main` requires today, by the name
// each job reports under. Both the lifecycle test (tests/graph.test.mjs) and the
// four-jobs test (tests/ci-jobs.test.mjs) hold the workflows to this one list.
//
// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] the source is the repository's branch protection, which a person changes and only an authenticated API call reads; the offline gate cannot ask it. This is the one copy in the tree, and it changes in the same change that moves protection (the plan's `onepipeline-ui-required-checks` step), whose own check reads the live settings.
export const REQUIRED_CONTEXTS = [
  "gate",
  "deny",
  "pr-title",
  "llmlint",
  "msrv",
  "cross (windows-latest)",
  "install (ubuntu-latest)",
  "install (windows-latest)",
  "visual-docs / report (x86_64, shots/current, shots/verify, Visual docs)",
];
// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
