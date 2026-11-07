`jobs.json` is GitHub's job listing of CI run 42255859378, a real five-job pull-request run, recorded read-only with
`gh api 'repos/nickderobertis/onepipeline-ui/actions/runs/42255859378/jobs?per_page=100&filter=latest'` and kept to the
fields the figures script reads. The one change: `budgets` is served in progress, as that job sees itself when it reads
its own run. Its longest finished job is `test-windows` at 981 s.
