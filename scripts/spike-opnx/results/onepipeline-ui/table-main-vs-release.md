| task | job(s) | cacheable | hash on main | hash after release-plz edits | inputs that moved it |
|---|---|---|---|---|---|
| dag-layout:build | test-linux, test-windows* | yes | 7436930124762215168 | 7436930124762215168 | — (same) |
| dag-layout:check | test-linux | noop | 545586582040556923 | 545586582040556923 | — (same) |
| dag-layout:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 11795289264666988629 | 11795289264666988629 | — (same) |
| dag-layout:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 5023590172649886053 | 5023590172649886053 | — (same) |
| dag-layout:test | test-linux | yes | 15740782497861190560 | 15740782497861190560 | — (same) |
| dag-layout:typecheck | lint*, test-linux | yes | 3824118245153910873 | 3824118245153910873 | — (same) |
| dag-model:build | test-linux, test-windows* | yes | 10290769848978150390 | 10290769848978150390 | — (same) |
| dag-model:check | test-linux | noop | 10021952518056988955 | 10021952518056988955 | — (same) |
| dag-model:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 11579224825641191256 | 11579224825641191256 | — (same) |
| dag-model:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 11920314250766873386 | 11920314250766873386 | — (same) |
| dag-model:test | test-linux | yes | 14448500774875392184 | 14448500774875392184 | — (same) |
| dag-model:typecheck | lint*, test-linux | yes | 8998043963212926075 | 8998043963212926075 | — (same) |
| dag-ui-build-cache:check | test-linux | noop | 8183299172947175126 | 8183299172947175126 | — (same) |
| dag-ui-build-cache:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 13414991736004705075 | 13414991736004705075 | — (same) |
| dag-ui-build-cache:test | test-linux | yes | 11455598988270269715 | 11455598988270269715 | — (same) |
| dag-ui-e2e:budgets | test-linux | yes | 10177069996800203106 | 10177069996800203106 | — (same) |
| dag-ui-e2e:check | test-linux | noop | 7899377426627721431 | 1293490607864794127 | `onepipeline-ui:**/*` |
| dag-ui-e2e:format-check | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 2265250298008412286 | 2265250298008412286 | — (same) |
| dag-ui-e2e:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 893763465194598058 | 893763465194598058 | — (same) |
| dag-ui-e2e:test | test-linux | yes | 14020005236606440495 | 17035847752101980664 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| dag-ui-e2e:test-isolation | test-linux | yes | 3202826487270328093 | 16173223174952985417 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| dag-ui-e2e:typecheck | lint†, lint*, test-linux | yes | 1858606452491184033 | 1858606452491184033 | — (same) |
| dag-ui:build | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 1019628406791014360 | 2733025598418686181 | `onepipeline-ui:**/*` |
| dag-ui:build-api-server | test-linux | no | 5125665785380810965 | 7369112527531021208 | `onepipeline-ui:**/*` |
| dag-ui:check | test-linux | noop | 17276465347261994392 | 12320083286244377116 | `onepipeline-ui:**/*` |
| dag-ui:format-check | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 349025515724083304 | 349025515724083304 | — (same) |
| dag-ui:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 5501223171192335905 | 5501223171192335905 | — (same) |
| dag-ui:test | test-linux | yes | 7256076885477157775 | 7256076885477157775 | — (same) |
| dag-ui:typecheck | lint†, lint*, test-linux | yes | 5826401207004319391 | 5826401207004319391 | — (same) |
| docs:check | test-linux | noop | 3724972041303611679 | 3724972041303611679 | — (same) |
| docs:test | test-linux | yes | 13528724522413564082 | 13528724522413564082 | — (same) |
| github-workflows-installs:bootstrap | test-linux | no | 13742409158141067760 | 13742409158141067760 | — (same) |
| github-workflows-installs:check | test-linux | noop | 12462683125658282809 | 12462683125658282809 | — (same) |
| github-workflows-installs:test | test-linux | no | 6496840706015887559 | 6496840706015887559 | — (same) |
| github-workflows-judge-install:bootstrap | test-linux | no | 7778204571837513220 | 7778204571837513220 | — (same) |
| github-workflows-judge-install:check | test-linux | noop | 6064962675551975448 | 6064962675551975448 | — (same) |
| github-workflows-judge-install:test | test-linux | no | 17318972914332539489 | 16838636302518082337 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| github-workflows:bootstrap | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | no | 7344896508971545020 | 7344896508971545020 | — (same) |
| github-workflows:budgets | test-linux | no | 4331763743507738944 | 4331763743507738944 | — (same) |
| github-workflows:check | test-linux | noop | 7370006069187857172 | 7370006069187857172 | — (same) |
| github-workflows:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 15974782157907725349 | 2541035269046236696 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml)` |
| github-workflows:test | test-linux | no | 1080839191794788035 | 2268433856523259826 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml)` |
| github-workflows:test-ci-jobs | test-linux | no | 5517819802463559780 | 5517819802463559780 | — (same) |
| onepipeline-ui-baseline-reuse:check | test-linux | noop | 15396579214611856928 | 15396579214611856928 | — (same) |
| onepipeline-ui-baseline-reuse:test | test-linux | yes | 12702701209399234564 | 12702701209399234564 | — (same) |
| onepipeline-ui-baseline-reuse:test-quick | test-windows*, test-macos‡ | yes | 7865778722086250372 | 7865778722086250372 | — (same) |
| onepipeline-ui-baseline:check | test-linux | noop | 9822515578771856560 | 9822515578771856560 | — (same) |
| onepipeline-ui-baseline:test-baseline | test-linux | yes | 8719356502459912636 | 1784827794337760912 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-ci-jobs:check | test-linux | noop | 5436583673338610728 | 5436583673338610728 | — (same) |
| onepipeline-ui-ci-jobs:test | test-linux | yes | 15011250092720782601 | 15011250092720782601 | — (same) |
| onepipeline-ui-cost:check | test-linux | noop | 3231091825700247039 | 3231091825700247039 | — (same) |
| onepipeline-ui-cost:test-cost | test-linux | yes | 13735046094335569224 | 16194094604732890305 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-coverage:check | test-linux | noop | 13305061854993632759 | 13305061854993632759 | — (same) |
| onepipeline-ui-coverage:coverage | test-linux | no | 2927974484049308487 | 374858285045545743 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-deps-audit-toolchain:check | test-linux | noop | 687344240220703988 | 687344240220703988 | — (same) |
| onepipeline-ui-deps-audit-toolchain:test | test-linux | yes | 9891810768325011161 | 9891810768325011161 | — (same) |
| onepipeline-ui-e2e:check | test-linux | noop | 2814644846060145563 | 2814644846060145563 | — (same) |
| onepipeline-ui-e2e:test | test-linux | yes | 6602071420801223177 | 455599340453473890 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-e2e:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 9847470736865079021 | 7599538253712363882 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-judged-tier:check | test-linux | noop | 8326465605392900964 | 8326465605392900964 | — (same) |
| onepipeline-ui-judged-tier:test | test-linux | yes | 11446108853003875362 | 11446108853003875362 | — (same) |
| onepipeline-ui-linked-report:check | test-linux | noop | 7649018143932709478 | 7649018143932709478 | — (same) |
| onepipeline-ui-linked-report:test | test-linux | yes | 3012223613868532463 | 18110498681776868622 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-npm-launcher:check | test-linux | noop | 6734915839946889967 | 6734915839946889967 | — (same) |
| onepipeline-ui-npm-launcher:test | test-linux | yes | 13497469496617808121 | 9387443880766819124 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-npm-launcher:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 4221989025528876387 | 15247174656984534426 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-release:check | test-linux | noop | 7305003424633497354 | 7305003424633497354 | — (same) |
| onepipeline-ui-release:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 1383363957332679740 | 1383363957332679740 | — (same) |
| onepipeline-ui-release:rehearse | test-linux | yes | 5313669799663871607 | 8393135825279339934 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:test | test-linux | yes | 17426652758645175860 | 15473217720780808333 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:test-staged | test-linux | no | 12384214337353164562 | 10348239031764971248 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:test-standalone | test-linux | no | 15561576450010121211 | 1724925679370564596 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock, {workspaceRoot}/CHANGELOG.md)` |
| onepipeline-ui-release:tools | test-linux | no | 3387442018034029607 | 3387442018034029607 | — (same) |
| onepipeline-ui-repo-tooling:check | test-linux | noop | 3304037748991227285 | 3304037748991227285 | — (same) |
| onepipeline-ui-repo-tooling:test | test-linux | yes | 6300560468403571933 | 11928865251108210732 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui-repo-tooling:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 11499616191202248048 | 17072232485453879518 | `workspace file-set input (its members that release-plz edits: {workspaceRoot}/Cargo.toml, {workspaceRoot}/Cargo.lock)` |
| onepipeline-ui:bootstrap | test-linux | no | 18280344006287992565 | 12351366521281636197 | `onepipeline-ui:**/*` |
| onepipeline-ui:check | test-linux | noop | 11040617973428890467 | 2604697008521424999 | `onepipeline-ui:**/*` |
| onepipeline-ui:deps-check | lint†, lint* | no | 4999156657967361049 | 18364654384698860092 | `onepipeline-ui:**/*` |
| onepipeline-ui:doc | test-linux | yes | 15166543465045373884 | 17232020039570498727 | `onepipeline-ui:**/*` |
| onepipeline-ui:ensure-baseline | test-linux | no | 7435748378674697233 | 11191956766764682619 | `onepipeline-ui:**/*` |
| onepipeline-ui:ensure-node-without-execve | test-linux, test-windows†, test-windows*, test-macos‡ | no | 12205443019170251996 | 13521853480128009176 | `onepipeline-ui:**/*` |
| onepipeline-ui:ensure-sibling | test-linux, test-windows†, test-windows*, test-macos‡ | no | 13305295182881897995 | 1049444355992127142 | `onepipeline-ui:**/*` |
| onepipeline-ui:format-check | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 14992594228093443956 | 14529168408210921041 | `onepipeline-ui:**/*` |
| onepipeline-ui:install-smoke | test-linux, test-windows†, test-windows*, test-macos‡ | no | 3458371429410282975 | 16361365969628724033 | `onepipeline-ui:**/*` |
| onepipeline-ui:lint | lint†, lint*, test-linux, test-windows†, test-windows*, test-macos‡ | yes | 5822675924035497984 | 14475635898233813615 | `onepipeline-ui:**/*` |
| onepipeline-ui:msrv | lint†, lint* | no | 11301935902787033177 | 1561096259047201009 | `onepipeline-ui:**/*` |
| onepipeline-ui:test | test-linux | yes | 796949154427448715 | 67758780338587368 | `onepipeline-ui:**/*` |
| onepipeline-ui:test-quick | test-windows†, test-windows*, test-macos‡ | yes | 7565424268957279482 | 7390571916899287388 | `onepipeline-ui:**/*` |
| pool-maintenance:bootstrap | test-linux | no | 13075375632265625935 | 13075375632265625935 | — (same) |
| pool-maintenance:budgets-host | test-linux | no | 17324687526252100896 | 17324687526252100896 | — (same) |
| pool-maintenance:check | test-linux | noop | 5853565625899650221 | 5853565625899650221 | — (same) |
| pool-maintenance:test | test-linux | yes | 8874381836791811700 | 8874381836791811700 | — (same) |
| telemetry-client:build | test-linux, test-windows* | yes | 4382076967311548102 | 4382076967311548102 | — (same) |
| telemetry-client:check | test-linux | noop | 5796199167934558439 | 5796199167934558439 | — (same) |
| telemetry-client:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 13746964645187185391 | 13746964645187185391 | — (same) |
| telemetry-client:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 1032262003115952501 | 1032262003115952501 | — (same) |
| telemetry-client:test | test-linux | yes | 1341131232330129225 | 1341131232330129225 | — (same) |
| telemetry-client:typecheck | lint*, test-linux | yes | 6790541202175861920 | 6790541202175861920 | — (same) |
| timeline-categories:build | test-linux, test-windows* | yes | 12606743297271791292 | 12606743297271791292 | — (same) |
| timeline-categories:check | test-linux | noop | 14962893359406924818 | 14962893359406924818 | — (same) |
| timeline-categories:format-check | lint*, test-linux, test-windows*, test-macos‡ | yes | 16777138724215102004 | 16777138724215102004 | — (same) |
| timeline-categories:lint | lint*, test-linux, test-windows*, test-macos‡ | yes | 18200265506027560630 | 18200265506027560630 | — (same) |
| timeline-categories:test | test-linux | yes | 7371721558486388342 | 7371721558486388342 | — (same) |
| timeline-categories:typecheck | lint*, test-linux | yes | 14742582606743025417 | 14742582606743025417 | — (same) |
