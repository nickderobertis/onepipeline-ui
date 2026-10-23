# Graph edges before native measurements

React Flow checks dimensions and handle bounds before it mounts an edge.
`@xyflow/system`'s `getEdgePosition` returns `null` when `isNodeInitialized`
is false; dimensions alone do not satisfy its handle-bounds check. Our routed
edge already has its geometry from `layoutDag`, but that renderer is never
called while React Flow considers either endpoint uninitialized. Visible cards
and a settled DOM therefore do not establish that dependencies were drawn.

The graph now supplies measured dimensions and initial source/target handles
from that same layout. Native resize observations can arrive later without
preventing the routed edge from mounting. These initial handles only satisfy
React Flow's initialization: `DagRoutedEdge` continues to draw `edge.points`.

The controlled reproduction holds real native resize observations for graph
nodes until a window resize, leaving container measurements and real API reads
alone (`delayGraphMeasurements`). This establishes a failure mechanism; it does
not establish which scheduling condition occurred on the two CI runners.

## Reproduction and validation

On 2026-10-23, the continuation dispatch built `DagGraph.tsx` from `06037fa`
(the implementation before this branch's fix) with the current regression tests.
The old source was restored immediately after building; its bundle lived under
`/tmp/graph-regression-4E2QOWpr/dist`. Temporary Playwright configs imported the
repository configs, used absolute test/teardown paths, and appended
`--outDir /tmp/graph-regression-4E2QOWpr/dist` to Vite preview commands.
The capture config used a unique fixture directory name.

Both commands failed at the foundation-to-dashboard attachment assertion after
15 seconds, with data loaded and the dashboard card's running state established:

```sh
npx playwright test --config /tmp/graph-regression-4E2QOWpr/journey.config.ts dag-ui-graph.spec.ts
SHOTS_OUT=/tmp/graph-regression-4E2QOWpr/shots npx playwright test --config /tmp/graph-regression-4E2QOWpr/capture.config.ts --grep '1440.*Graph.view'
```

The capture wrote zero shots. This also verifies that the strengthened capture
continues to reject missing dependencies rather than accepting quiet cards.
The temporary configs and bundle are disposable reproduction artifacts.

On the fixed bundle:

```sh
npx playwright test --config apps/dag-ui-e2e/playwright.config.ts dag-ui-graph.spec.ts --repeat-each=5
SHOTS_OUT=shots/local/graph-verification just dag-ui-screens --grep Graph --repeat-each=3
bash scripts/nx.sh run-many -t format-check lint typecheck --projects=dag-ui,dag-ui-e2e
```

The journey passed 5/5, including nonzero edge geometry before measurement,
resize, and navigation away and back. The capture passed 30/30: all five Graph
viewports three times, plus the five composer viewports three times selected by
the same grep. The Graph capture checks every in-run dependency derived from the
served plan. All ten resulting image hashes match their existing baseline entries.
No screenshot baseline change is required for those images.

Formatting and type checks passed. Direct Biome and ESLint checks of the four
modified TypeScript/TSX files also passed without findings. The broader app lint
replayed an existing specificity warning in unrelated `styles.css:1769`; it was
recorded as an out-of-scope orchestration follow-up.
