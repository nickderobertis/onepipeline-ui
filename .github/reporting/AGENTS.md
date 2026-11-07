This project's own budget and the journeys behind it. `test` drives ci.yml's `budgets` job: its pinned action's steps, the
released tools, real `gh`, onevcs and upload code, with only GitHub's services, the release host and the package index doubled
by the harness the action ships at that tag. `budgets` reads back what `test` recorded and reruns nothing. Budget-only data
stays here. Assert behaviour, never a threshold. A pin bump changes ci.yml and `fixtures/onebudgetspec-github-action/` together.

A row shows what a `budgets` target saved in `test-linux` (`target/budget-results/`, uploaded as
`budget-check-results-test-linux`) or a figure this job measures, and `<name>-ci-check-time` and `-ci-job-count` read this
pull request's own run. A `not-measured-on-pr` budget has no row and one line counts it. A saved target names its results
with `--save-results` and its Nx `outputs`. A budget with neither reads `no saved result was found on this run`, which on a
pull request a target the change did not select also reads; name a budget's saved telemetry or required file in its
`command`, or its absence reads as a broken measurement. A base push takes the merged pull request's figures for its rolling
history, so a pull request's value and its baseline are one measurement; it runs no test job and none of those budgets'
commands.
