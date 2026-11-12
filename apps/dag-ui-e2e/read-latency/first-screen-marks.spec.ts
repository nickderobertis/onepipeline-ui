/**
 * Each view's first screen, checked at its mark on the real release server: every
 * drawn value equals the received answer and that answer equals the complete
 * document, or the value is drawn as loading. Fed one wrong or missing value, the
 * same checks refuse it by name, so they cannot pass blind.
 */
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import {
  addressOf,
  buildWorld,
  completeDocuments,
  LARGE_WORKLOAD,
  NEVER,
  observe,
  removeWorld,
  type Served,
  screenStates,
  serve,
  settledDocuments,
  stop,
  visibleOf,
  type World,
} from "./journey-world";
import {
  checkAnswer,
  checkScreen,
  type FirstView,
  type ScreenState,
  type Visible,
} from "./mark";

interface Marked {
  readonly state: ScreenState | undefined;
  readonly visible: Visible;
  readonly nearest: readonly string[];
}

type Body = {
  initial: { snapshot: { visible: Visible & Record<string, unknown> } };
};

/** Open `view`, optionally feeding the first answer through `feed`, to its mark. */
async function reachMark(
  page: Page,
  served: Served,
  view: FirstView,
  run: string,
  node: string | undefined,
  feed?: (visible: Body["initial"]["snapshot"]["visible"]) => void,
): Promise<Marked> {
  await observe(page);
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the acceptance criteria require that answers fed with one value wrong or missing are each refused by the same check that passes the real ones, so it cannot pass while blind to a wrong value; the real server's answer is fetched and only the one value under test is changed, and with no `feed` the answer passes through untouched.
  await page.route("**/api/v2/subscriptions", async (route) => {
    if (route.request().method() !== "POST" || feed === undefined)
      return route.continue();
    const answer = await route.fetch();
    const raw: unknown = await answer.json();
    // The contract's own parser refuses an answer it does not name before one
    // value of the raw body is changed in place, so the wire carries the
    // server's answer with that one value different.
    visibleOf(raw);
    const body = raw as Body;
    feed(body.initial.snapshot.visible);
    return route.fulfill({ response: answer, json: body });
  });
  // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
  await page.goto(`${served.origin}${addressOf(run, view, node)}`);
  await expect
    .poll(() => page.evaluate("window.__firstAnswer !== undefined"), {
      timeout: NEVER,
    })
    .toBe(true);
  const visible = visibleOf(
    JSON.parse(z.string().parse(await page.evaluate("window.__firstAnswer"))),
  );
  const deadline = Date.now() + NEVER / 5;
  let last: readonly string[] = ["no state recorded"];
  for (;;) {
    const states = await screenStates(page);
    for (const state of states) {
      if (!state.first) continue;
      const failures = checkScreen(view, visible, state, node);
      last = failures;
      if (failures.length === 0) return { state, visible, nearest: [] };
    }
    if (Date.now() > deadline)
      return { state: undefined, visible, nearest: last };
    await page.waitForTimeout(100);
  }
}

const scopeOf = (view: FirstView) =>
  view === "overall" ? "run" : view === "node" ? "node" : undefined;

/** The whole check of one view: screen against answer, answer against document. */
async function checkView(
  page: Page,
  served: Served,
  view: FirstView,
  run: string,
  node: string | undefined,
  documents: typeof completeDocuments = completeDocuments,
) {
  const complete = await documents(served, run, node);
  const marked = await reachMark(
    page,
    served,
    view,
    run,
    view === "node" ? node : undefined,
  );
  expect(marked.nearest, `${view} screen against its answer`).toStrictEqual([]);
  expect(marked.state, `${view} mark`).toBeDefined();
  expect(
    checkAnswer(marked.visible, complete, scopeOf(view)),
    `${view} answer against the complete document`,
  ).toStrictEqual([]);
  return marked;
}

let world: World;
test.beforeAll(() => {
  world = buildWorld(undefined, "settled");
});
test.afterAll(() => removeWorld(world));

const openView = (page: Page, served: Served, view: FirstView) =>
  checkView(
    page,
    served,
    view,
    world.facts.openLiveRun,
    view === "node" ? world.facts.large.busiestNode : undefined,
  );

test("every first-screen value on a settled run equals its documents, on each view", async ({
  page,
}) => {
  for (const view of ["graph", "overall", "node"] as const) {
    const served = await serve(world);
    try {
      await page.goto("about:blank");
      await openView(page, served, view);
    } finally {
      await stop(served);
    }
  }
});

test("a small settled run's first screens equal its documents", async ({
  page,
}) => {
  for (const view of ["graph", "overall"] as const) {
    const served = await serve(world);
    try {
      await page.goto("about:blank");
      await checkView(page, served, view, world.facts.smallRun, undefined);
    } finally {
      await stop(served);
    }
  }
});

test("real reasons and awaits are drawn on the first screen, and Turns only as loading", async ({
  page,
}) => {
  let served = await serve(world);
  try {
    const marked = await openView(page, served, "graph");
    const cards = marked.state?.cards ?? [];
    const failed = cards.find((card) =>
      card.name?.startsWith(`${world.facts.large.failedNode}:`),
    );
    expect(failed?.reason).toContain("real reason");
    const held = cards.find((card) =>
      card.name?.startsWith(`${world.facts.large.heldNode}:`),
    );
    expect(held?.awaits).toContain("awaits");
    await stop(served);
    served = await serve(world);
    await page.goto("about:blank");
    const overall = await openView(page, served, "overall");
    expect(overall.state?.turns?.value).toBe("Loading…");
  } finally {
    await stop(served);
  }
});

/** One wrong or missing value a first answer can carry, and the name it is refused by. */
const WRONG_ANSWERS: {
  name: string;
  view: FirstView;
  feed: (visible: Body["initial"]["snapshot"]["visible"], w: World) => void;
  refusedAs: RegExp;
}[] = [
  {
    name: "a card's state",
    view: "graph",
    feed: (v, w) => {
      (v.detail.graph as { node_status: Record<string, string> }).node_status[
        w.facts.large.busiestNode
      ] = "failed";
    },
    refusedAs: /graph\.node_status/u,
  },
  {
    name: "a card's reason",
    view: "graph",
    feed: (v, w) => {
      delete (
        v.detail.graph as { node_results: Record<string, { detail?: string }> }
      ).node_results[w.facts.large.failedNode]?.detail;
    },
    refusedAs: /node_results\..*detail/u,
  },
  {
    name: "a card's awaits",
    view: "graph",
    feed: (v, w) => {
      delete (
        v.detail.graph as {
          node_results: Record<string, { awaiting?: unknown }>;
        }
      ).node_results[w.facts.large.heldNode]?.awaiting;
    },
    refusedAs: /awaiting/u,
  },
  {
    name: "Status",
    view: "overall",
    feed: (v) => {
      (v.detail.run as { state: string }).state = "complete-wrongly";
    },
    refusedAs: /run\.state/u,
  },
  {
    name: "Nodes",
    view: "overall",
    feed: (v) => {
      (v.detail.run as { nodes: unknown[] }).nodes.pop();
    },
    refusedAs: /run\.nodes/u,
  },
  {
    name: "Wall time",
    view: "overall",
    feed: (v) => {
      (
        v.detail.run as { timing: { wall_seconds: number } }
      ).timing.wall_seconds = 1;
    },
    refusedAs: /wall_seconds/u,
  },
  {
    name: "Turns, as a default zero",
    view: "overall",
    feed: (v) => {
      (v.detail.run as { turns: unknown }).turns = 0;
    },
    refusedAs: /run\.turns/u,
  },
  {
    name: "a short span",
    view: "overall",
    feed: (v) => {
      const span = (
        (v.timeline as unknown as { spans: never[] }).spans as unknown as {
          kind: string;
          ended_at: string;
          started_at: string;
        }[]
      ).find((held) => held.kind === "verification");
      if (span !== undefined)
        span.ended_at = new Date(
          Date.parse(span.started_at) + 86_400_000,
        ).toISOString();
    },
    refusedAs: /span .*ended_at/u,
  },
  {
    name: "a missing span",
    view: "overall",
    feed: (v) => {
      (v.timeline as unknown as { spans: unknown[] }).spans.pop();
    },
    refusedAs: /spans: the answer holds/u,
  },
  {
    name: "a row",
    view: "node",
    feed: (v) => {
      const span = (
        v.timeline as unknown as { spans: { events: unknown[] }[] }
      ).spans.find((held) => held.events.length > 1);
      span?.events.pop();
    },
    refusedAs: /events/u,
  },
];

for (const wrong of WRONG_ANSWERS)
  test(`a first answer with ${wrong.name} wrong is refused by name`, async ({
    page,
  }) => {
    const served = await serve(world);
    try {
      const run = world.facts.openLiveRun;
      const node =
        wrong.view === "node" ? world.facts.large.busiestNode : undefined;
      const complete = await completeDocuments(served, run, node);
      const marked = await reachMark(
        page,
        served,
        wrong.view,
        run,
        node,
        (visible) => wrong.feed(visible, world),
      );
      const refused = [
        ...checkAnswer(marked.visible, complete, scopeOf(wrong.view)),
        ...marked.nearest,
      ];
      expect(
        refused.some((failure) => wrong.refusedAs.test(failure)),
        `refused as ${wrong.refusedAs}, got ${JSON.stringify(refused)}`,
      ).toBe(true);
    } finally {
      await stop(served);
    }
  });

/** The state a view's mark was reached at; a view that reached none fails here. */
function marked(
  reached: { readonly state: ScreenState | undefined },
  view: string,
): ScreenState {
  if (reached.state === undefined)
    throw new Error(`the ${view} view reached no first useful screen`);
  return reached.state;
}

test("a screen drawing a value unlike its answer is refused by name", async ({
  page,
}) => {
  const served = await serve(world);
  try {
    const run = world.facts.openLiveRun;
    const graph = await reachMark(page, served, "graph", run, undefined);
    const graphState = marked(graph, "graph");
    const held = (changed: (state: ScreenState) => void) => {
      const copy = structuredClone(graphState);
      changed(copy);
      return checkScreen("graph", graph.visible, copy);
    };
    const cardOf = (s: ScreenState, node: string) =>
      s.cards.find((c) => c.name?.startsWith(`${node}:`));
    expect(
      held((s) => {
        const card = cardOf(s, world.facts.large.busiestNode);
        if (card) card.name = `${world.facts.large.busiestNode}: failed`;
      }).join(" "),
    ).toMatch(/card .* state/u);
    expect(
      held((s) => {
        const card = cardOf(s, world.facts.large.failedNode);
        if (card) card.reason = null;
      }).join(" "),
    ).toMatch(/card .* reason/u);
    expect(
      held((s) => {
        const card = cardOf(s, world.facts.large.heldNode);
        if (card) card.awaits = null;
      }).join(" "),
    ).toMatch(/card .* awaits/u);
    await page.goto("about:blank");
    const overall = await reachMark(page, served, "overall", run, undefined);
    const base = marked(overall, "overall");
    const of = (changed: (state: ScreenState) => void) => {
      const copy = structuredClone(base);
      changed(copy);
      return checkScreen("overall", overall.visible, copy).join(" ");
    };
    expect(of((s) => (s.status = { value: "wrong" }))).toMatch(
      /metric Status/u,
    );
    expect(of((s) => (s.nodes = { value: "0" }))).toMatch(/metric Nodes/u);
    expect(of((s) => (s.wall = { value: "0s" }))).toMatch(/metric Wall time/u);
    expect(of((s) => (s.turns = { value: "0" }))).toMatch(/metric Turns/u);
    expect(of((s) => (s.bars = s.bars.slice(1)))).toMatch(/span .*missing/u);
    expect(
      of((s) => {
        const bar = s.bars[0];
        if (bar) s.bars[0] = { ...bar, width: 90 };
      }),
    ).toMatch(/span .*width/u);
    await page.goto("about:blank");
    const node = await reachMark(
      page,
      served,
      "node",
      run,
      world.facts.large.busiestNode,
    );
    const nodeBase = marked(node, "node");
    const row = structuredClone(nodeBase);
    row.rows = row.rows.slice(1);
    expect(
      checkScreen(
        "node",
        node.visible,
        row,
        world.facts.large.busiestNode,
      ).join(" "),
    ).toMatch(/row/u);
  } finally {
    await stop(served);
  }
});

test("each view's first screen renders while the status read and the sidebar are held", async ({
  page,
}) => {
  const served = await serve(world);
  try {
    const held: unknown[] = [];
    const hold = async (route: { abort(): Promise<void> }) => {
      held.push(route);
      await new Promise(() => undefined);
    };
    // llmlint: ignore-block[e2e_not_mocked] the acceptance criteria ask for each view's first screen while the status read and the sidebar are held: holding those two requests at the network boundary is what states it, and the first answer comes from the real server unchanged.
    await page.route("**/api/v2/runs/*/status", hold);
    await page.route("**/api/v2/events**", hold);
    // llmlint: ignore-end[e2e_not_mocked]
    for (const view of ["graph", "overall", "node"] as const) {
      await page.goto("about:blank");
      const node = view === "node" ? world.facts.large.busiestNode : undefined;
      const marked = await reachMark(
        page,
        served,
        view,
        world.facts.openLiveRun,
        node,
      );
      expect(
        marked.nearest,
        `${view} under held status and sidebar`,
      ).toStrictEqual([]);
      expect(marked.state).toBeDefined();
    }
  } finally {
    await stop(served);
  }
});

test("the settled large run's first screens equal its complete documents", async ({
  page,
}) => {
  const large = buildWorld(LARGE_WORKLOAD, "settled");
  try {
    for (const view of ["graph", "overall", "node"] as const) {
      const served = await serve(large);
      try {
        await page.goto("about:blank");
        await checkView(
          page,
          served,
          view,
          large.facts.openLiveRun,
          view === "node" ? large.facts.large.busiestNode : undefined,
          // A fresh server per view, as each first screen is a cold one; the
          // settled run's documents are one reading, compared by all three.
          (on, run, node) => settledDocuments(large, on, run, node),
        );
      } finally {
        await stop(served);
      }
    }
  } finally {
    removeWorld(large);
  }
});
