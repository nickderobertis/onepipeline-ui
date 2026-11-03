| task | cacheable | job(s) that run it |
|---|---|---|
| dag-layout:build | yes | test-linux (broader); test-windows (all projects) |
| dag-layout:check | noop | test-linux (broader) |
| dag-layout:format-check | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-layout:lint | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-layout:test | yes | test-linux (broader) |
| dag-layout:typecheck | yes | lint (all projects); test-linux (broader) |
| dag-model:build | yes | test-linux (broader); test-windows (all projects) |
| dag-model:check | noop | test-linux (broader) |
| dag-model:format-check | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-model:lint | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-model:test | yes | test-linux (broader) |
| dag-model:typecheck | yes | lint (all projects); test-linux (broader) |
| dag-ui-build-cache:check | noop | test-linux (broader) |
| dag-ui-build-cache:lint | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-ui-build-cache:test | yes | test-linux (broader) |
| dag-ui-e2e:budgets | yes | test-linux (broader) |
| dag-ui-e2e:check | noop | test-linux (broader) |
| dag-ui-e2e:format-check | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-ui-e2e:lint | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-ui-e2e:test | yes | test-linux (broader) |
| dag-ui-e2e:test-isolation | yes | test-linux (broader) |
| dag-ui-e2e:typecheck | yes | lint (release-PR affected); lint (all projects); test-linux (broader) |
| dag-ui:build | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-ui:build-api-server | no | test-linux (broader) |
| dag-ui:check | noop | test-linux (broader) |
| dag-ui:format-check | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-ui:lint | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| dag-ui:test | yes | test-linux (broader) |
| dag-ui:typecheck | yes | lint (release-PR affected); lint (all projects); test-linux (broader) |
| docs:check | noop | test-linux (broader) |
| docs:test | yes | test-linux (broader) |
| github-workflows-installs:bootstrap | no | test-linux (broader) |
| github-workflows-installs:check | noop | test-linux (broader) |
| github-workflows-installs:test | no | test-linux (broader) |
| github-workflows-judge-install:bootstrap | no | test-linux (broader) |
| github-workflows-judge-install:check | noop | test-linux (broader) |
| github-workflows-judge-install:test | no | test-linux (broader) |
| github-workflows:bootstrap | no | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| github-workflows:budgets | no | test-linux (broader) |
| github-workflows:check | noop | test-linux (broader) |
| github-workflows:lint | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| github-workflows:test | no | test-linux (broader) |
| github-workflows:test-ci-jobs | no | test-linux (broader) |
| onepipeline-ui-baseline-reuse:check | noop | test-linux (broader) |
| onepipeline-ui-baseline-reuse:test | yes | test-linux (broader) |
| onepipeline-ui-baseline-reuse:test-quick | yes | test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui-baseline:check | noop | test-linux (broader) |
| onepipeline-ui-baseline:test-baseline | yes | test-linux (broader) |
| onepipeline-ui-ci-jobs:check | noop | test-linux (broader) |
| onepipeline-ui-ci-jobs:test | yes | test-linux (broader) |
| onepipeline-ui-cost:check | noop | test-linux (broader) |
| onepipeline-ui-cost:test-cost | yes | test-linux (broader) |
| onepipeline-ui-coverage:check | noop | test-linux (broader) |
| onepipeline-ui-coverage:coverage | no | test-linux (broader) |
| onepipeline-ui-deps-audit-toolchain:check | noop | test-linux (broader) |
| onepipeline-ui-deps-audit-toolchain:test | yes | test-linux (broader) |
| onepipeline-ui-e2e:check | noop | test-linux (broader) |
| onepipeline-ui-e2e:test | yes | test-linux (broader) |
| onepipeline-ui-e2e:test-quick | yes | test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui-judged-tier:check | noop | test-linux (broader) |
| onepipeline-ui-judged-tier:test | yes | test-linux (broader) |
| onepipeline-ui-linked-report:check | noop | test-linux (broader) |
| onepipeline-ui-linked-report:test | yes | test-linux (broader) |
| onepipeline-ui-npm-launcher:check | noop | test-linux (broader) |
| onepipeline-ui-npm-launcher:test | yes | test-linux (broader) |
| onepipeline-ui-npm-launcher:test-quick | yes | test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui-release:check | noop | test-linux (broader) |
| onepipeline-ui-release:lint | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui-release:rehearse | yes | test-linux (broader) |
| onepipeline-ui-release:test | yes | test-linux (broader) |
| onepipeline-ui-release:test-staged | no | test-linux (broader) |
| onepipeline-ui-release:test-standalone | no | test-linux (broader) |
| onepipeline-ui-release:tools | no | test-linux (broader) |
| onepipeline-ui-repo-tooling:check | noop | test-linux (broader) |
| onepipeline-ui-repo-tooling:test | yes | test-linux (broader) |
| onepipeline-ui-repo-tooling:test-quick | yes | test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui:bootstrap | no | test-linux (broader) |
| onepipeline-ui:check | noop | test-linux (broader) |
| onepipeline-ui:deps-check | no | lint (release-PR affected); lint (all projects) |
| onepipeline-ui:doc | yes | test-linux (broader) |
| onepipeline-ui:ensure-baseline | no | test-linux (broader) |
| onepipeline-ui:ensure-node-without-execve | no | test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui:ensure-sibling | no | test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui:format-check | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui:install-smoke | no | test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui:lint | yes | lint (release-PR affected); lint (all projects); test-linux (broader); test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| onepipeline-ui:msrv | no | lint (release-PR affected); lint (all projects) |
| onepipeline-ui:test | yes | test-linux (broader) |
| onepipeline-ui:test-quick | yes | test-windows (release-PR affected); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| pool-maintenance:bootstrap | no | test-linux (broader) |
| pool-maintenance:budgets-host | no | test-linux (broader) |
| pool-maintenance:check | noop | test-linux (broader) |
| pool-maintenance:test | yes | test-linux (broader) |
| telemetry-client:build | yes | test-linux (broader); test-windows (all projects) |
| telemetry-client:check | noop | test-linux (broader) |
| telemetry-client:format-check | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| telemetry-client:lint | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| telemetry-client:test | yes | test-linux (broader) |
| telemetry-client:typecheck | yes | lint (all projects); test-linux (broader) |
| timeline-categories:build | yes | test-linux (broader); test-windows (all projects) |
| timeline-categories:check | noop | test-linux (broader) |
| timeline-categories:format-check | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| timeline-categories:lint | yes | lint (all projects); test-linux (broader); test-windows (all projects); test-macos (all projects; skipped on release-plz branches) |
| timeline-categories:test | yes | test-linux (broader) |
| timeline-categories:typecheck | yes | lint (all projects); test-linux (broader) |
