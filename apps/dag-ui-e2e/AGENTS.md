# apps/dag-ui-e2e/AGENTS.md

The journeys that drive the DAG Observatory, and the tier that runs them. The app
itself is `apps/dag-ui`; this is a project of its own because these drive the
built app rather than being part of it.

## What a journey is held to

A change to what a reader sees is not done until a journey drives it, in a real
browser, against the **built bundle** — `vite preview` over what `dag-ui:build`
produced, which is the artifact the `onepipeline-ui` npm package ships — and a
real `onepipeline-api serve` over a recorded run directory. Nothing between the
browser and the read model is doubled. A dev server is not what any reader loads,
and a bundle can differ from what Vite serves unbuilt.

One journey, `dag-ui-served.spec.ts`, opens the view the other way a reader
gets it: from the read API's own origin, which `serve-fixture.mjs` starts with
`--ui` so the binary serves the bundle it embedded beside the data. Every other
journey reaches that same server through the Vite preview, which is what holds
the API to answering the same with the view beside it as without.

`test` is the journeys, and `test-isolation` is the one check that *runs* the
tier rather than being run by it: it launches two whole tiers at once to prove
they stay out of each other's way, which costs more than everything else here
together and answers one question nothing else asks. Each edge is what a reader
can ask for without paying for the rest; `check` pays for all of it.

## Reaching the app

Sibling dependencies here are `workspace:*`, as every one in this workspace is:
the spelling only the sibling can satisfy, never a registry package of the same
name. `tests/packaging.rs` fails the build on any other.

Not at all, and that is the point: what a journey needs of the app's vocabulary
comes from `@onepipeline-ui/timeline-categories`, the shared package both this
project and the app depend on. A journey importing `../src/...` reaches into
another project's files, which `@nx/enforce-module-boundaries` refuses and which
would make every internal move of the app a change to the journeys — and reaching
for the app's own package instead is the same coupling with a nicer spelling. The
vocabulary is what a journey must not restate: a journey holding its own copy of
`EVENT_CATEGORIES` passes while the app grows a category nobody draws.

## Reading a tier that would not start

`Timed out waiting 120000ms from config.webServer` is the whole of what Playwright
says when one of the five servers never becomes ready — it names neither the
server nor the reason, and it starts them one at a time. So every entry carries a
`name`, keeps its `stdout`, and states the address it took. **Read them in order:
the first server that printed nothing is the one being waited for.**

Every server runs from the app directory (`cwd`), because that is where its
`vite.config.ts`, its built bundle and `fixtures/serve-fixture.mjs` are.
Nothing in that readiness window may build: the bundle and the API binary are
this project's `test` dependencies, and a compile there is reported only as a server
that would not start.

## The screens: what they are, and why they cannot quietly change

The Graph capture deliberately holds native node resize observations with
`delayGraphMeasurements`, as does `dag-ui-graph.spec.ts`. React Flow otherwise
needs those observations to initialize dimensions and handle bounds before it
will mount an edge, even when the routed layout already knows its path. Keep
the graph independent of that delivery: a quiet page with visible cards does
not prove its dependencies were drawn. The capture checks every in-run edge
from the served plan; the journey also checks nonzero SVG geometry before and
after resize and navigation. Horizontal edges have zero bounding-box height,
so Playwright's visibility assertion cannot establish that they are drawn.

`gallery.screens.spec.ts` drives the same surfaces against the same stack as the
journeys beside it, but it asserts nothing and writes images. Those images are two
things at once. They are the operator's eyes — a column that crowds its neighbour or
a panel clipped at one width is invisible to an assertion nobody wrote — and they are
the pictures `README.md` carries, which is the only way somebody deciding whether to
install this can see the product.

Every surface at every viewport, one shot each. The surface list is
`SURFACES`, the matrix is `viewports.ts`, and `docs/dag-ui.md` tabulates both with
what each one shows; `apps/dag-ui/src/test/dag-ui-doc.test.ts` reconciles the tables
with the declarations, so a surface or a width can reach neither list without
reaching the other. Each surface is photographed only once its real reads have landed
— never mid-skeleton — which is what makes a capture worth looking at.

The README carries a handful of them rather than all of them: the overall view as
the hero, the graph, a node's detail, a conversation, the project list and a project
page, the channel, and one phone-width shot. A screen that would say less than the
prose beside it is left to the gallery.

### Why it is byte-reproducible, and what it is pinned to

screencomp gates on the content hash of every image, so two captures of one build
have to be byte-identical or the gate is noise. Four things otherwise put the host in
the pixels, and each is answered here rather than by a flag added to a tool for a
screenshot's convenience:

- **The renderer.** Chromium comes from `mcr.microsoft.com/playwright:v<version>-noble`,
  pinned to the `@playwright/test` in this project's own `package.json` — glyph
  rasterisation, the font stack and the browser build all decide bytes.
  `scripts/visual-capture.sh` derives that tag from the manifest and
  `.github/workflows/visual-docs.yml` names the same one, so CI and the local guard
  render in the same image; `apps/dag-ui/src/test/visual-docs.test.ts` fails when the
  two part, which matters because the guard is what regenerates the baseline CI gates
  against. `screenshots.config.ts` carries Chromium's determinism flags — the GPU out
  of the render path, a pinned colour profile, no hinting or subpixel anti-aliasing.
- **The clock.** `capture-clock.ts` names one instant; `fixtures/runs.mjs` stamps the
  whole corpus relative to it through `DAG_UI_FIXTURE_NOW`, and the spec pins the
  browser's `Date` to the same one. That file explains why the instant is in the
  future: the read API stamps `observed_at` from its own clock and nothing may change
  that, so a corpus ahead of any host's clock is what makes the plotted range the
  corpus's own.
- **Reads still landing.** `settleReads` waits until the markup and every scroll
  offset have held still for four samples. A transcript that grows by one row after
  the wait and before the shot moves the whole panel, because the panel follows its
  own bottom.
- **Transitions.** Playwright's `animations: "disabled"` freezes CSS animations at the
  shot; a style set from JavaScript can still be caught part way, so every transition
  and animation is cut outright first.

Nothing in the capture reaches a network beyond loopback, and nothing in it costs
anything: the corpus is generated on disk, the API is the real binary over it, and
the bundle is the real built one.

### The commands, and the loop when the view legitimately changes

```sh
just dag-ui-screens                        # capture into a directory of this invocation's own
just dag-ui-screens --grep "at 390x844"    # one width; extra arguments reach Playwright
```

CI compares captures against `shots/baseline/x86_64.json`; local pushes run no
visual guard. When the view changes, capture and review it explicitly:

```sh
SHOTS_OUT=shots/current/x86_64 just dag-ui-screens
screencomp classify --baseline-manifest shots/baseline/x86_64.json --current shots/current --exit-code
screencomp gallery --input shots/current --output shots/review --title "Screenshot review"
```

Review `shots/review/index.html`. If the changes are intended, update the baseline:

```sh
screencomp manifest --input shots/current --output shots/baseline/x86_64.json
```

Commit the baseline with the view change. If a changed image appears in `README.md`,
copy it over the committed image under `docs/screens/` in the same commit. Investigate
unexpected changes before updating the baseline. `just gate` remains the manual
check command; CI verifies the deterministic checks and visual comparison.
