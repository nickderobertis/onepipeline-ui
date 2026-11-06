This project's own budget and the journeys behind it. `test` drives ci.yml's `budgets` job: its pinned action's steps, the
released tools, real `gh`, onevcs and upload code, with only GitHub's services, the release host and the package index doubled
by the harness the action ships at that tag. `budgets` reads back what `test` recorded and reruns nothing. Budget-only data
stays here. Assert behaviour, never a threshold. A pin bump changes ci.yml and `fixtures/onebudgetspec-github-action/` together.
