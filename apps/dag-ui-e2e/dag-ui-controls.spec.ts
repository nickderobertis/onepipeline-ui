import {
  apiErrorSchema,
  artifactContentSchema,
  renderedRunSchema,
  runAgentsSchema,
  runDetailSchema,
  runStatusSchema,
  runTimelineSchema,
  runTranscriptSchema,
} from "@onepipeline-ui/dag-model";
import {
  expect,
  type Locator,
  type Page,
  type Response,
  test,
} from "@playwright/test";
import { z } from "zod";
import { fixture, runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";

/**
 * Browser run controls and read panels, driven against the real read API over
 * runs the fixture harness recorded.
 *
 * These journeys write surfaces, queue replies and stop runs, so they use a
 * dedicated corpus: a run the acting session owns, one another session owns,
 * and one nothing drives. Writes move these runs to the top of the flat list;
 * journeys reading the shared live run therefore select it by id.
 *
 * This file sorts before dag-ui.spec.ts, whose final journeys remove the
 * shared corpus. Within this file, stopping the acting session's run comes
 * after the journeys that read and write its channel.
 */

/**
 * What the served API answers, read beside the browser to hold it to the same
 * bytes — and read through the contract's own parser, as the browser reads it,
 * so a journey never asserts against a shape the client would have refused.
 */
async function served<T>(
  page: Page,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  return schema.parse(await response.json());
}

/** A refusal the API answered, as `{error: {code, message}}` and nothing else. */
async function refusedBy(
  response: { status(): number; json(): Promise<unknown> },
  status: number,
): Promise<{ code: string; message: string }> {
  expect(response.status()).toBe(status);
  return apiErrorSchema.parse(await response.json()).error;
}

const receipt = (page: Page, label: string): Locator =>
  page.getByRole("alert", { name: `${label} receipt` });
const refusal = (page: Page, label: string): Locator =>
  page.getByRole("alert", { name: `${label} refused` });

test("refuses to stop a run another session owns, naming the owner, and forces it only behind a confirm that names them", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().elsewhere}&view=overall`);
  await expect(
    page.getByRole("region", { name: "Graph timeline" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText(`Stop ${runs().elsewhere}?`);
  // The first confirm offers no force: a forced stop is never the default.
  await expect(confirm.getByRole("button", { name: /Force/ })).toHaveCount(0);
  await confirm.getByRole("button", { name: "Stop run" }).click();

  const refused = refusal(page, "Stop");
  await expect(refused).toContainText("409 not_owner");
  const said = (await refused.textContent()) ?? "";
  const message =
    /run \S+ belongs to \[codex:[0-9a-f]+\], not to this session/.exec(
      said,
    )?.[0] ?? "";
  expect(message).not.toBe("");
  const owner = /\[codex:[0-9a-f]+\]/.exec(message)?.[0] ?? "";
  expect(owner).not.toBe("");
  // The run is untouched: still driven, and the second confirm names the owner
  // it would override.
  await expect(
    page
      .getByRole("region", { name: "Run header" })
      .getByRole("img", { name: "Running", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Force stop…" }).click();
  const second = page.getByRole("dialog");
  await expect(second).toContainText(
    `Force-stop ${runs().elsewhere}, overriding ${owner}?`,
  );
  await expect(second).toContainText(message);
  await second
    .getByRole("button", { name: `Force stop, overriding ${owner}` })
    .click();
  const forced = receipt(page, "Stop");
  await expect(forced).toContainText('"forced": true');
  await expect(forced).toContainText(`"owner": "${owner}"`);
  await expect(forced).toContainText('"stopped": true');
  await expect(page.getByRole("button", { name: "Force stop…" })).toHaveCount(
    0,
  );
});

test("stops a run the acting session owns on one confirm", async ({ page }) => {
  await page.goto(`/?run=${runs().supervised}&view=overall`);
  await expect(
    page.getByRole("region", { name: "Graph timeline" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop run" })
    .click();
  const stopped = receipt(page, "Stop");
  await expect(stopped).toContainText('"stopped": true');
  await expect(stopped).toContainText('"owner": "[mine]"');
  await expect(stopped).toContainText('"forced": false');
  await expect(page.getByRole("button", { name: "Force stop…" })).toHaveCount(
    0,
  );
  // The run's own record says so now: the stop is journalled, and the run's
  // state reads what the engine makes of a stopped run — once the record
  // reaches the page, which on a loaded host is seconds away.
  await expect(
    page
      .getByRole("region", { name: "Run header" })
      .getByRole("img", { name: "Stopped", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
});

/**
 * Every agent a run launched, off the run's own pointer file — the file the
 * engine has every oneharness under its launches append to — grouped by which
 * launch each session was written under, and each opening to its transcript in
 * the store oneharness itself kept it in. Held to the served API on both sides:
 * the sessions the listing serves are the ones the fixture's pointer file names,
 * and the count beside the run is the number of them.
 */
test("observer and worker harness sessions open from their timelines", async ({
  page,
}) => {
  const listing = await served(
    page,
    `/api/v2/runs/${runs().live}/agents`,
    runAgentsSchema,
  );
  expect(listing.sessions).toHaveLength(fixture().agents.live);
  const observer = listing.sessions.find(
    (session) => session.labels["onepipeline.scope"] === "observer",
  );
  expect(observer).toBeDefined();
  const timeline = await served(
    page,
    `/api/v2/runs/${runs().live}/timeline?scope=run`,
    runTimelineSchema,
  );
  const observed = timeline.spans.find(
    (span) => span.harness_scope === "observer",
  );
  if (observed?.ended_at == null)
    throw new Error("observer with its own recorded end");
  expect(Date.parse(observed.ended_at) - Date.parse(observed.started_at)).toBe(
    42_000,
  );
  const worked = timeline.spans.find((span) => span.harness_scope === "node");
  expect(worked).toBeDefined();
  expect(worked?.ended_at).toBe(worked?.started_at);
  expect(worked?.label).toContain("no recorded end");
  await page.goto(`/?run=${runs().live}&view=overall`);
  const graph = page.getByRole("region", {
    name: "Graph timeline",
    exact: true,
  });
  await graph.getByRole("button", { name: "Expand timeline" }).click();
  const runLevel = page.getByRole("region", {
    name: "Run-level timeline",
    exact: true,
  });
  await runLevel.getByRole("button", { name: "Expand timeline" }).click();
  await runLevel
    .getByRole("button", { name: /^Run-level · observer/ })
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText("Oneharness conversation");
  await expect(
    page.getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveCount(0);
  const node = fixture().agents.worker.node;
  await page.goto(`/?run=${runs().live}&node=${node}`);
  const worker = listing.sessions.find(
    (session) => session.labels["onepipeline.scope"] === "node",
  );
  if (worker === undefined) throw new Error("worker session");
  await page
    .getByRole("button", {
      name: `Open node (${worker.name} · no recorded end)`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText(fixture().agents.worker.text);
  const transcript = await served(
    page,
    `/api/v2/runs/${runs().live}/artifacts/${fixture().agents.worker.history_id}`,
    artifactContentSchema,
  );
  expect(transcript.content).toContain(fixture().agents.worker.text);
  await expect(
    page.getByRole("region", { name: "Review reply drafter", exact: true }),
  ).toContainText("replier-dashboard");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", {
      name: "Open review-reply (replier-dashboard · no recorded end)",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText("the review reply is drafted");
  await page.goto(`/?run=${runs().live}&node=foundation`);
  await expect(page.getByRole("button", { name: /^Open node \(/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveCount(0);
});

test("shows the status read's unread surfaces and the run's last progress in the run details card", async ({
  page,
}) => {
  for (const runId of [
    runs().live,
    runs().history,
    runs().outcomes,
    runs().legacy,
  ]) {
    const detail = await served(
      page,
      `/api/v2/runs/${runId}?include_conversations=false`,
      runDetailSchema,
    );
    const isStatus = (response: Response) =>
      new URL(response.url()).pathname === `/api/v2/runs/${runId}/status`;
    const statusResponse = page.waitForResponse(isStatus);
    await page.goto(`/?run=${runId}&view=overall`);
    const status = runStatusSchema.parse(await (await statusResponse).json());
    const card = page.getByRole("group", { name: "Run details", exact: true });
    // The count the status read gave, and how long the oldest has waited.
    await expect(card.getByRole("definition").nth(1)).toHaveText(
      status.unread_surfaces.oldest_seconds === null
        ? String(status.unread_surfaces.count)
        : new RegExp(`^${status.unread_surfaces.count} · oldest `, "u"),
    );
    // How long the journal has been quiet, read off the run's own last write, or
    // a dash where it recorded none.
    const lastProgress = detail.run.last_progress_at;
    const reading = card.getByRole("status", {
      name: "Last progress",
      exact: true,
    });
    if (lastProgress === undefined) await expect(reading).toHaveText("—");
    else
      await expect(reading.getByRole("time")).toHaveAttribute(
        "datetime",
        new Date(lastProgress * 1000).toISOString(),
      );
  }
});

test("says in run details when the status read fails, and shows the readings again once it answers", async ({
  page,
}) => {
  const server = await startFixtureServer("status-outage", []);
  try {
    const run = z
      .object({ runs: z.object({ history: z.string().min(1) }) })
      .parse(server.facts).runs.history;
    const read = async () =>
      runStatusSchema.parse(
        await (
          await page.request.get(`${server.origin}/api/v2/runs/${run}/status`)
        ).json(),
      );
    const before = await read();
    await page.goto(`${server.origin}/?run=${run}&view=overall`);
    const card = page.getByRole("group", { name: "Run details", exact: true });
    const unread = card.getByRole("definition").nth(1);
    const count = new RegExp(`^${before.unread_surfaces.count}\\b`, "u");
    await expect(unread).toHaveText(count);
    await expect(card.getByRole("alert")).toHaveCount(0);

    // The status is read on request, never on a timer. The API goes away under
    // an open page: the read the reader asks for with Refresh is refused, and
    // the last reading stays beside the alert that says so.
    const refresh = page.getByRole("button", { name: "Refresh" });
    await server.stopServing();
    await refresh.click();
    await expect(card.getByRole("alert")).toContainText("Status unavailable", {
      timeout: 30_000,
    });
    await expect(unread).toHaveText(count);

    await server.serveRebuilt();
    const after = await read();
    await refresh.click();
    await expect(card.getByRole("alert")).toHaveCount(0, { timeout: 30_000 });
    await expect(unread).toHaveText(
      new RegExp(`^${after.unread_surfaces.count}\\b`, "u"),
    );
  } finally {
    await server.stop();
  }
});

/**
 * The removed Results, Goals and per-node Transcript reads, line by line.
 *
 * Each read is still served — the routes are the CLI's, and only the tab that
 * printed them went — so this reads what each printed over the corpus and holds
 * every line to the place the remaining views show it. A line no rule below
 * names fails the journey rather than passing unread, which is what makes this
 * an inventory of everything those reads showed rather than a sample of it.
 *
 * Two kinds of line are deliberately not shown, by the manager's ruling, and
 * each is named where it is consumed: a merged node's landing phrase (a live
 * `onevcs` read at request time, not a recorded fact), and a transcript's
 * `report ROLE PATH` line with the note under it (the producer's scratch path).
 * A dispatch whose run recorded no transcript still says so, in the dispatch's
 * own detail.
 *
 * Each run's Results and Goals readings, and its Transcript readings, are
 * journeys of their own, the eight together being the inventory: each opens
 * every node it reads, and all of it in one journey ran past its time limit on
 * a loaded CI runner.
 */
for (const run of ["live", "history", "outcomes", "legacy"] as const) {
  test(`shows every fact the removed Results and Goals reads printed, for the ${run} run`, async ({
    page,
  }) => {
    expect(await resultsAndGoalsShown(page, runs()[run])).toEqual([]);
  });
  test(`shows every fact the removed Transcript reads printed, for the ${run} run`, async ({
    page,
  }) => {
    expect(await transcriptsShown(page, runs()[run])).toEqual([]);
  });
}

/** The run's one state, for each word `onepipeline goals` prints a run in. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  SETTLED: "Complete",
  PAUSED: "Waiting on you",
  "DRIVER DEAD": "Driver dead",
  UNDRIVEN: "Driver dead",
  PARKED: "Idle",
};

/**
 * Hold `runId`'s Results and Goals readings to the views, and answer the lines
 * no rule maps.
 */
async function resultsAndGoalsShown(
  page: Page,
  runId: string,
): Promise<string[]> {
  const unmapped: string[] = [];
  const detail = await served(
    page,
    `/api/v2/runs/${runId}?include_conversations=true`,
    runDetailSchema,
  );
  const results = (
    await served(page, `/api/v2/runs/${runId}/results`, renderedRunSchema)
  ).rendered.split("\n");
  const goals = (
    await served(page, `/api/v2/runs/${runId}/goals`, renderedRunSchema)
  ).rendered.split("\n");

  // Goals and the Results header: the run's whole-graph readings. The graph's
  // own state word is not shown: the run's one state is, in the Whole DAG card,
  // and every node's word is on its card.
  await page.goto(`/?run=${runId}&view=overall`);
  const [resultsHead, ...nodeLines] = results.filter((line) => line !== "");
  expect(resultsHead?.match(/^(\S+) {2}(\S+)$/)?.[1]).toBe(runId);
  const [goalsHead, goalLine, tally, ...goalRest] = goals.filter(
    (line) => line !== "",
  );
  const liveness = goalsHead?.match(/^(\S+) {2}(\S+)$/);
  expect(liveness?.[1]).toBe(runId);
  const statuses = Object.values(detail.graph?.node_status ?? {});
  const word = String(liveness?.[2]);
  await expect(
    page
      .getByRole("region", { name: "Whole DAG" })
      .getByRole("group", { name: "Run state" }),
  ).toHaveText(
    word === "ACTIVE"
      ? statuses.includes("waiting")
        ? "Waiting on you"
        : "Running"
      : (STATE_WORDS[word] ?? word),
  );
  // The tally's done count, beside the run's nodes, in the Nodes tile. The
  // total is every node the run served a status for: the engine's tally leaves
  // out a legacy run's `improvised` node, which the graph still draws.
  const doneOf = tally?.match(/^\s*(\d+)\/(\d+) done/u);
  expect(doneOf).not.toBeNull();
  expect(statuses.filter((status) => status === "done").length).toBe(
    Number(doneOf?.[1]),
  );
  await expect(
    page.getByRole("group", { name: "Nodes", exact: true }).getByRole("strong"),
  ).toHaveText(`${doneOf?.[1]} of ${statuses.length} done`);
  const goal = goalLine?.trim();
  // A run whose journal the engine folds to no plan states no goal; the plan
  // the API serves for it can still name one, and that is what is shown.
  if (goal !== "(no goal stated)" || detail.graph?.plan.goal?.text)
    await expect(page.getByRole("region", { name: "Whole DAG" })).toContainText(
      goal === "(no goal stated)"
        ? String(detail.graph?.plan.goal?.text)
        : String(goal),
    );
  // Dropped by the user's ruling with the section that listed them: the
  // repositories a run's nodes name are each node's own.
  for (const line of goalRest)
    if (line.match(/^ {2}identities: (.+)$/) === null)
      unmapped.push(`${runId} goals: ${line}`);
  // Every node's status word as the engine folds it, on the graph's list of
  // nodes — the one word its card and Dependencies show too.
  await page.getByRole("tab", { name: "Graph" }).click();
  const list = page.getByRole("list", { name: "DAG nodes" });
  for (const line of nodeLines) {
    const status = line.match(/^ {2}(\S+)\s+(\S+)/);
    const task = detail.graph?.plan.tasks.find(({ id }) => id === status?.[1]);
    if (status !== null && task !== undefined)
      await expect(
        list.getByRole("button", {
          name: new RegExp(
            `^${typeof task.name === "string" ? task.name : task.id}: ${status[2]}\\b`,
            "u",
          ),
        }),
      ).toHaveCount(1);
  }

  let current: string | undefined;
  // The node a line is about stays open for the lines under it, which read its
  // tabs: opening it again for each was a whole page load per line.
  let open: Locator | undefined;
  for (const line of nodeLines) {
    const nodeLine = line.match(/^ {2}(\S+)\s+(\S+)(?: \(([^)]+)\))?(.*)$/);
    if (nodeLine !== null) {
      const [, id, , outcome, rest] = nodeLine;
      current = String(id);
      const view = await openNode(page, runId, String(id));
      open = view;
      const task = await nodeTab(view, "Task");
      if (outcome !== undefined)
        await expect(task).toContainText(`Settled as${outcome}`);
      const url = rest?.match(/ — (https?:\/\/\S+)$/)?.[1];
      if (url !== undefined)
        // The corpus's change URLs are not GitHub's, so the link keeps the
        // readable name rather than a short id.
        await expect(
          view.getByRole("link", { name: "Change request" }),
        ).toHaveAttribute("href", url);
      const beside = (rest ?? "").replace(/ — https?:\/\/\S+$/, "");
      // Dropped: a landing read taken when the read was asked, not a record.
      if (
        beside !== "" &&
        !/^ — (landing UNDECIDED|NOT landed|landed on its base)/.test(beside)
      )
        unmapped.push(`${runId} results: ${line}`);
      continue;
    }
    const under = line.match(
      /^ {6}(detail|action|unblocks|never attempted; skipped by): (.+)$/,
    );
    const id = current;
    if (under === null || id === undefined) {
      unmapped.push(`${runId} results: ${line}`);
      continue;
    }
    const [, term, value] = under;
    const view = open ?? (await openNode(page, runId, id));
    if (term === "detail")
      await expect(await nodeTab(view, "Task")).toContainText(
        `Outcome${value}`,
      );
    else if (term === "action")
      await expect(await nodeTab(view, "Task")).toContainText(String(value));
    else if (term === "unblocks")
      await expect(await nodeTab(view, "Dependencies")).toContainText(
        `Unblocks${value}`,
      );
    else {
      // Skipped — never attempted — is the node's word under Node statuses
      // above; what skipped it is each dependency with the status it holds,
      // and where the recorded graph reads the node skipped too, its banner
      // names both.
      const dependencies = await nodeTab(view, "Dependencies");
      for (const cause of String(value).split(", "))
        await expect(dependencies).toContainText(cause);
      if (detail.graph?.node_status[id] === "skipped") {
        const banner = view.getByRole("alert");
        await expect(banner).toContainText(`Unmet${value}`);
        await expect(banner).toContainText("AttemptsNever attempted");
      }
    }
  }
  return unmapped;
}

/**
 * Hold `runId`'s per-node and whole-run Transcript readings to the views, and
 * answer the lines no rule maps.
 */
async function transcriptsShown(page: Page, runId: string): Promise<string[]> {
  const unmapped: string[] = [];
  const detail = await served(
    page,
    `/api/v2/runs/${runId}?include_conversations=true`,
    runDetailSchema,
  );
  const tasks = detail.graph?.plan.tasks ?? [];
  const conversations = Array.isArray(detail.conversations)
    ? detail.conversations
    : [];

  const transcriptOf = new Map<string, string | undefined>();
  for (const { id } of tasks) {
    const response = await page.request.get(
      `/api/v2/runs/${runId}/transcript?node=${encodeURIComponent(id)}`,
    );
    if (!response.ok()) {
      // The engine refuses a node it recorded nothing for, and so does the
      // view: that node's header counts no turns.
      expect((await refusedBy(response, 422)).message).toContain(
        `has recorded nothing for node '${id}'`,
      );
      transcriptOf.set(id, undefined);
      continue;
    }
    transcriptOf.set(
      id,
      runTranscriptSchema.parse(await response.json()).rendered,
    );
  }

  const perNode: string[] = [];
  for (const { id } of tasks) {
    const rendered = transcriptOf.get(id);
    if (rendered === undefined) {
      const view = await openNode(page, runId, id);
      await expect(view.getByText(/ node · 0 turns · /)).toBeVisible();
      continue;
    }
    perNode.push(rendered);
    unmapped.push(
      ...(await expectTranscriptShown(
        page,
        runId,
        id,
        rendered,
        conversations.filter((entry) => entry.attribution?.nodeId === id),
      )),
    );
  }
  // The whole-run reading is the per-node ones together, or says there are none.
  const whole = (
    await served(page, `/api/v2/runs/${runId}/transcript`, runTranscriptSchema)
  ).rendered;
  if (perNode.length === 0) {
    expect(whole).toBe("no dispatch has recorded a transcript\n");
    await page.goto(`/?run=${runId}&view=overall`);
    await expect(
      page.getByRole("group", { name: "Turns", exact: true }),
    ).toContainText("0");
  } else
    expect(
      whole
        .split(new RegExp(`(?=^${runId} {2})`, "m"))
        .filter(Boolean)
        .sort(),
    ).toEqual([...perNode].sort());
  return unmapped;
}

async function openNode(
  page: Page,
  runId: string,
  node: string,
): Promise<Locator> {
  await page.goto(`/?run=${runId}&node=${encodeURIComponent(node)}`);
  const view = page.getByRole("region", { name: /^Timeline for / });
  await expect(view).toBeVisible();
  return view;
}

async function nodeTab(view: Locator, tab: string): Promise<Locator> {
  await view.getByRole("tab", { name: tab, exact: true }).click();
  return view.getByRole("tabpanel", { name: tab, exact: true });
}

/**
 * Hold one node's transcript reading to the conversations its dispatches open:
 * every `turn N` to a dispatch showing at least N turns, every tool line and
 * message to a turn showing it, and every dispatch that recorded no transcript
 * to a detail saying so. Returns the lines no rule maps.
 */
async function expectTranscriptShown(
  page: Page,
  runId: string,
  node: string,
  rendered: string,
  conversations: readonly {
    readonly conversation: {
      readonly id: string;
      readonly turns: readonly unknown[];
    };
  }[],
): Promise<string[]> {
  const unmapped: string[] = [];
  const [head, ...lines] = rendered.split("\n").filter((line) => line !== "");
  expect(head).toBe(`${runId}  ${node}`);
  const timeline = await served(
    page,
    `/api/v2/runs/${runId}/timeline?scope=node&node=${encodeURIComponent(node)}`,
    runTimelineSchema,
  );
  const dispatches = timeline.spans.filter((span) => span.kind === "dispatch");
  const shown: string[][] = [];
  for (const { conversation } of conversations) {
    const span = dispatches.find(
      (candidate) => candidate.reference?.value === conversation.id,
    );
    expect(span, `a dispatch opens ${conversation.id}`).toBeDefined();
    await page.goto(
      `/?run=${runId}&node=${encodeURIComponent(node)}&event=${encodeURIComponent(String(span?.id))}`,
    );
    const turns = page
      .getByRole("region", { name: "Timeline item detail" })
      .getByRole("article", {
        name: new RegExp(
          `^Turn ${conversation.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+ from `,
        ),
      });
    await expect(turns).toHaveCount(conversation.turns.length);
    shown.push(await turns.allTextContents());
  }
  for (const span of dispatches.filter(
    (each) => each.reference === undefined,
  )) {
    await page.goto(
      `/?run=${runId}&node=${encodeURIComponent(node)}&event=${encodeURIComponent(span.id)}`,
    );
    await expect(
      page.getByRole("region", { name: "Timeline item detail" }),
    ).toContainText("No transcript was recorded for this dispatch.");
  }
  const needed = new Map<number, number>();
  let inReport = false;
  for (const line of lines) {
    const turn = line.match(/^ {2}turn (\d+)$/);
    if (turn !== null) {
      inReport = false;
      const n = Number(turn[1]);
      needed.set(n, (needed.get(n) ?? 0) + 1);
      continue;
    }
    // Dropped: the producer's report path, and the note on whether this run
    // kept a copy of it — the dispatch's own detail says when it has no transcript.
    if (/^ {2}report \S+ \S+$/.test(line)) {
      inReport = true;
      continue;
    }
    if (
      inReport &&
      /^ {4}(it carries no transcript|not retained by this run, )/.test(line)
    )
      continue;
    if (/^ {4}(user|assistant)$/.test(line)) continue;
    const tool = line.match(/^ {4,6}tool_(?:use|call|result) (\S*) {2}(.*)$/);
    const said = line.match(/^ {6}(.+)$/);
    const text = tool === null ? said?.[1] : undefined;
    if (tool !== null) {
      const [, name, input] = tool;
      expect(
        shown
          .flat()
          .some(
            (each) =>
              each.includes(String(name)) && each.includes(String(input)),
          ),
        `${node}: a turn shows ${line.trim()}`,
      ).toBe(true);
    } else if (text !== undefined)
      expect(
        shown.flat().some((each) => each.includes(text)),
        `${node}: a turn shows ${text}`,
      ).toBe(true);
    else unmapped.push(`${runId} transcript ${node}: ${line}`);
  }
  // Each `turn N` is a turn of one dispatch: N of them need N dispatches that
  // reached that turn.
  for (const [n, count] of needed)
    expect(
      shown.filter((turns) => turns.length >= n).length,
      `${node}: dispatches reaching turn ${n}`,
    ).toBeGreaterThanOrEqual(count);
  return unmapped;
}

/**
 * One node, one status word: the engine's. A run whose recorded result names
 * words the engine's fold has since moved past — `dag-ui-outcomes` records
 * `improvised`, `not-completed` and `blocked` for nodes the engine reads as
 * skipped or ready — used to show one word on its graph and another under Node
 * statuses. Every view now renders the word `/status` serves, and the word the
 * run recorded is the node's outcome instead of being lost.
 */
test("shows each node in the engine's one status word across the graph, its node list and Dependencies", async ({
  page,
}) => {
  for (const runId of [runs().outcomes, runs().live]) {
    const engine = (
      await served(page, `/api/v2/runs/${runId}/status`, runStatusSchema)
    ).node_status;
    const detail = await served(
      page,
      `/api/v2/runs/${runId}?include_conversations=false`,
      runDetailSchema,
    );
    expect(detail.graph?.node_status).toEqual(engine);
    expect(
      Object.fromEntries(
        detail.run.nodes.map(({ node, status }) => [node, status]),
      ),
    ).toEqual(engine);
    const tasks = detail.graph?.plan.tasks ?? [];
    expect(tasks.map(({ id }) => id).sort()).toEqual(
      Object.keys(engine).sort(),
    );

    await page.goto(`/?run=${runId}&view=graph`);
    for (const task of tasks) {
      const label = typeof task.name === "string" ? task.name : task.id;
      await expect(
        page.getByRole("article", {
          name: `${label}: ${engine[task.id]}`,
          exact: true,
        }),
      ).toBeVisible();
    }
    const list = page.getByRole("list", { name: "DAG nodes" });
    for (const task of tasks) {
      const label = typeof task.name === "string" ? task.name : task.id;
      await expect(
        list.getByRole("button", {
          name: new RegExp(`^${label}: ${engine[task.id]}\\b`, "u"),
        }),
      ).toHaveCount(1);
    }

    for (const task of tasks) {
      const view = await openNode(page, runId, task.id);
      await expect(
        view.getByText(String(engine[task.id]), { exact: true }).first(),
      ).toBeVisible();
      const outcome = detail.graph?.node_results[task.id]?.outcome;
      if (typeof outcome === "string")
        await expect(await nodeTab(view, "Task")).toContainText(
          `Settled as${outcome}`,
        );
      const dependencies = await nodeTab(view, "Dependencies");
      // A dependency on another run's node holds no status in this one.
      for (const dep of task.deps ?? [])
        await expect(dependencies).toContainText(
          engine[dep] === undefined ? dep : `${dep} (${engine[dep]})`,
        );
    }
  }
  // The recorded words the engine's reading replaced, still shown as outcomes.
  const outcomes = (
    await served(
      page,
      `/api/v2/runs/${runs().outcomes}?include_conversations=false`,
      runDetailSchema,
    )
  ).graph?.node_results;
  expect(Object.values(outcomes ?? {}).map((result) => result.outcome)).toEqual(
    expect.arrayContaining(["improvised", "not-completed"]),
  );
});
