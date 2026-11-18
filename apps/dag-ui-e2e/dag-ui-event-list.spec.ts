import {
  parseRunTimeline,
  type TimelineEvent,
} from "@onepipeline-ui/dag-model";
import {
  EVENT_TYPES,
  eventTypeLabel,
} from "@onepipeline-ui/timeline-categories";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import corpus from "./fixtures/event-list.json" with { type: "json" };
import {
  loadAllEarlierRows,
  loadRunRecords,
  openRepeatedLoops,
} from "./observatory-locators";

/**
 * A run's event list, read in the browser over the real read API and a run
 * written in the engine's own record shapes (`fixtures/event-list.json`, held to
 * the linked engine's payload registry by `tests/contract.rs`): loops collapsed
 * into one block each, one row per surface with where it stands, commands read as
 * command lines, the run's own records listed on Overall, and the event-type
 * filter that narrows each list.
 *
 * Its corpus is its own, served by a server this file starts, because a run added
 * to the shared one is counted by every listing journey and photographed by the
 * gallery.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  every: z.string().min(1),
  every_node: z.string().min(1),
});

let server: FixtureServer | undefined;
let facts: z.infer<typeof factsSchema>;

test.beforeAll(async () => {
  server = await startFixtureServer("event-list", ["--event-list-corpus"]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server?.stop();
  server = undefined;
});

function origin(): string {
  if (server === undefined) throw new Error("the fixture server is not up");
  return server.origin;
}

/** The node's own events, as the read API serves its timeline. */
async function nodeEvents(page: Page, node: string): Promise<TimelineEvent[]> {
  const response = await page.request.get(
    `${origin()}/api/v2/runs/${facts.run}/timeline?scope=node&node=${node}`,
  );
  expect(response.ok()).toBe(true);
  const served = parseRunTimeline(await response.json());
  return served.spans
    .filter((span) => span.node_id === node)
    .flatMap((span) => span.events)
    .sort(
      (left, right) => (left.journal_order ?? 0) - (right.journal_order ?? 0),
    );
}

async function openNode(
  page: Page,
  node: string,
  extra = "",
): Promise<Locator> {
  await page.goto(
    `${origin()}/?run=${facts.run}&node=${node}&view=graph${extra}`,
  );
  const transcript = page.getByRole("region", { name: "Node transcript" });
  await expect(
    transcript.getByRole("heading", { name: "Events" }),
  ).toBeVisible();
  return transcript;
}

/** A row of a list, by the name it is opened under. */
const row = (list: Locator, name: string | RegExp): Locator =>
  list.getByRole("article", { name });

/** The repeated-loop blocks of a list. */
const blocks = (list: Locator): Locator =>
  list.getByRole("region", { name: /repeated \d+ times/u });

test.describe("repeated loops", () => {
  test("a hold toggled twelve times is one block of one pass, ×12 and its span, and opens into all 36 rows in order", async ({
    page,
  }) => {
    const events = await nodeEvents(page, "held");
    const held = events.filter(({ kind }) => kind === "node-held");
    const unheld = events.filter(({ kind }) => kind === "node-unheld");
    expect(held).toHaveLength(12);
    const transcript = await openNode(page, "held");
    await expect(blocks(transcript)).toHaveCount(1);
    const block = blocks(transcript).first();
    await expect(block).toHaveAccessibleName(/^3 events repeated 12 times: /u);
    await expect(block.getByText("×12", { exact: true })).toBeVisible();
    const pass = block.getByRole("article");
    await expect(pass).toHaveCount(3);
    await expect(pass.nth(0)).toHaveAccessibleName("Queued waiting on schema");
    await expect(pass.nth(1)).toHaveAccessibleName("Held waiting on schema");
    await expect(pass.nth(2)).toHaveAccessibleName(
      "Released from dependencies",
    );
    // The span the loop covered: the first record's time to the last's.
    // The block's own two stamps come first, before its rows'.
    const stamps = block.getByRole("time");
    expect(
      Date.parse((await stamps.nth(0).getAttribute("datetime")) ?? ""),
    ).toBe(Date.parse(held[0]?.at ?? ""));
    expect(
      Date.parse((await stamps.nth(1).getAttribute("datetime")) ?? ""),
    ).toBe(Date.parse(unheld.at(-1)?.at ?? ""));
    await block.getByRole("button", { name: "Show all 36" }).click();
    await expect(pass).toHaveCount(36);
    // Every original row, in the order the run recorded them: each hold's queue,
    // the hold, and its release.
    const expected = held.flatMap((hold, index) => [
      `queued.held.${hold.journal_order}`,
      hold.record_id,
      unheld[index]?.record_id,
    ]);
    expect(
      await pass.evaluateAll((articles) =>
        articles.map((article) => article.getAttribute("data-row-id")),
      ),
    ).toEqual(expected);
    await block.getByRole("button", { name: "Show one pass" }).click();
    await expect(pass).toHaveCount(3);
  });

  test("a two-row loop twice and then one row five times are two blocks", async ({
    page,
  }) => {
    const transcript = await openNode(page, "loops");
    await expect(blocks(transcript)).toHaveCount(2);
    await expect(blocks(transcript).nth(0)).toHaveAccessibleName(
      "2 events repeated 2 times: cross-dag-satisfied → upstream-modified",
    );
    await expect(blocks(transcript).nth(0).getByRole("article")).toHaveCount(2);
    await expect(blocks(transcript).nth(1)).toHaveAccessibleName(
      "1 event repeated 5 times: criterion-checked",
    );
    await expect(blocks(transcript).nth(1).getByRole("article")).toHaveCount(1);
  });

  test("a loop of eighteen rows gone round twice is one block of its pass, and opens into all 36 rows in order", async ({
    page,
  }) => {
    // Six holds on six producers make a pass of eighteen distinct rows, longer
    // than the stretch a loop is first looked for over, so only the search for
    // where a long pass starts again can find it.
    const events = await nodeEvents(page, "rounds");
    const held = events.filter(({ kind }) => kind === "node-held");
    const unheld = events.filter(({ kind }) => kind === "node-unheld");
    expect(held).toHaveLength(12);
    const transcript = await openNode(page, "rounds");
    await expect(blocks(transcript)).toHaveCount(1);
    const block = blocks(transcript).first();
    await expect(block).toHaveAccessibleName(/^18 events repeated 2 times: /u);
    await expect(block.getByText("×2", { exact: true })).toBeVisible();
    const pass = block.getByRole("article");
    await expect(pass).toHaveCount(18);
    const producers = [
      "schema",
      "types",
      "client",
      "server",
      "docs",
      "release",
    ];
    expect(
      await pass.evaluateAll((articles) =>
        articles.map((article) => article.getAttribute("aria-label")),
      ),
    ).toEqual(
      producers.flatMap((producer) => [
        `Queued waiting on ${producer}`,
        `Held waiting on ${producer}`,
        "Released from dependencies",
      ]),
    );
    await block.getByRole("button", { name: "Show all 36" }).click();
    await expect(pass).toHaveCount(36);
    expect(
      await pass.evaluateAll((articles) =>
        articles.map((article) => article.getAttribute("data-row-id")),
      ),
    ).toEqual(
      held.flatMap((hold, index) => [
        `queued.rounds.${hold.journal_order}`,
        hold.record_id,
        unheld[index]?.record_id,
      ]),
    );
  });

  test("a sequence that never repeats back to back is not collapsed", async ({
    page,
  }) => {
    const transcript = await openNode(page, "plain");
    await expect(transcript.getByRole("article")).toHaveCount(5);
    await expect(blocks(transcript)).toHaveCount(0);
  });

  test("a row an address selects inside a block opens the block on it", async ({
    page,
  }) => {
    const events = await nodeEvents(page, "held");
    const seventh = events.filter(({ kind }) => kind === "node-held")[6];
    if (seventh?.record_id === undefined) throw new Error("no seventh hold");
    const transcript = await openNode(
      page,
      "held",
      `&event=${seventh.record_id}`,
    );
    const block = blocks(transcript).first();
    await expect(
      block.getByRole("button", { name: "Show one pass" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(block.getByRole("article")).toHaveCount(36);
    // The detail opened on it is the seventh hold's, by the moment it records.
    const detail = page.getByRole("complementary", {
      name: "Item detail panel",
    });
    await expect(detail).toBeVisible();
    expect(
      await detail
        .getByRole("time")
        .evaluateAll((times) =>
          times.map((time) => time.getAttribute("datetime")),
        ),
    ).toContain(new Date(seventh.at).toISOString());
  });
});

test.describe("surfaces", () => {
  test("each surface is one row on its node's list, reading answered or read, and its detail holds every step and the reply", async ({
    page,
  }) => {
    const events = await nodeEvents(page, "asker");
    const ids = new Set(
      events.flatMap((event) =>
        event.surface_state === undefined ? [] : [event.surface_state.id],
      ),
    );
    expect(ids).toEqual(new Set([1, 2, 3, 4, 5]));
    const transcript = await openNode(page, "asker");
    const surfaces = transcript
      .getByRole("article")
      .filter({ hasText: /^(Blocking )?surface/iu });
    await expect(surfaces).toHaveCount(ids.size);
    const question = row(
      transcript,
      "planner-question: Should the export keep the v1 columns?",
    );
    await expect(question).toHaveCount(1);
    await expect(question).toContainText("answered");
    for (const name of [
      "check-in: Workstream export: halfway through the writer",
      "quiet-worker: asker has been quiet for 30 minutes",
      "check-failed: ci/lint failed on asker's change",
      "checks-unfollowed: asker's checks are no longer followed",
    ]) {
      await expect(row(transcript, name)).toHaveCount(1);
      await expect(row(transcript, name)).toContainText(" · read");
    }
    await question.getByRole("button").click();
    const detail = page.getByRole("complementary", {
      name: "Item detail panel",
    });
    const state = events.find(
      (event) => event.surface_state?.id === 1,
    )?.surface_state;
    if (state === undefined) throw new Error("no question state served");
    for (const step of ["Queued", "Read", "Answered"])
      await expect(
        detail
          .getByRole("term")
          .filter({ hasText: new RegExp(`^${step}$`, "u") }),
      ).toHaveCount(1);
    const stamped = await detail
      .getByRole("time")
      .evaluateAll((times) =>
        times.map((time) => time.getAttribute("datetime")),
      );
    for (const at of [state.queued_at, state.read_at, state.replied_at]) {
      if (at === undefined) throw new Error("a step the server did not fold");
      expect(stamped).toContain(new Date(at).toISOString());
    }
    await expect(detail).toContainText(
      "Keep the v1 columns until the next release.",
    );
  });

  test("an address naming a surface's later record opens the one row standing for the surface", async ({
    page,
  }) => {
    const events = await nodeEvents(page, "asker");
    const read = events.find(
      (event) =>
        event.kind === "planner-surfaced" && event.surface_state?.id === 1,
    );
    if (read?.record_id === undefined) throw new Error("no read question");
    const transcript = await openNode(
      page,
      "asker",
      `&event=${read.record_id}`,
    );
    const detail = page.getByRole("complementary", {
      name: "Item detail panel",
    });
    await expect(
      detail.getByRole("heading", { name: "Surface 1" }),
    ).toBeVisible();
    await expect(detail).toContainText(
      "Keep the v1 columns until the next release.",
    );
    // Still one row for the question, and it is the one the address opened.
    const question = row(
      transcript,
      "planner-question: Should the export keep the v1 columns?",
    );
    await expect(question).toHaveCount(1);
    await expect(question).toHaveAttribute("aria-current", "true");
  });

  test("an unanswered blocking surface reads waiting", async ({ page }) => {
    const transcript = await openNode(page, "waiting");
    await expect(
      row(transcript, "planner-question: Which region should the canary use?"),
    ).toContainText(" · waiting");
  });
});

test.describe("commands", () => {
  test("a command step reads as one command line in its row, its detail and its node's header", async ({
    page,
  }) => {
    const transcript = await openNode(page, "build");
    const line = "bun run build --name 'a b'";
    const started = row(transcript, line);
    await expect(started).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Command" }).getByText(line, {
        exact: true,
      }),
    ).toBeVisible();
    await started.getByRole("button").click();
    const detail = page.getByRole("complementary", {
      name: "Item detail panel",
    });
    await expect(
      detail
        .getByRole("region", { name: "Recorded fields" })
        .getByText(line, { exact: true }),
    ).toBeVisible();
    await expect(detail).not.toContainText('["bun"');
  });

  test("an empty argument and a single quote read as a shell would take them", async ({
    page,
  }) => {
    const transcript = await openNode(page, "quoted");
    const line = String.raw`printf '%s\n' '' 'it'\''s'`;
    await expect(row(transcript, line)).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Command" }).getByText(line, {
        exact: true,
      }),
    ).toBeVisible();
    await row(transcript, line).getByRole("button").click();
    await expect(
      page
        .getByRole("complementary", { name: "Item detail panel" })
        .getByRole("region", { name: "Recorded fields" })
        .getByText(line, { exact: true }),
    ).toBeVisible();
  });

  test("a 400-character command is cut with an ellipsis in its row and shown whole in its detail and header", async ({
    page,
  }) => {
    const long = corpus.records.find(
      (record) => record.kind === "command-started" && record.node === "long",
    );
    const argv = z.array(z.string()).parse(long?.payload.command);
    const line = argv.join(" ");
    expect(line).toHaveLength(400);
    const transcript = await openNode(page, "long");
    const started = row(transcript, line);
    const label = started.getByText(line, { exact: true });
    const box = await label.boundingBox();
    const rowBox = await started.boundingBox();
    if (box === null || rowBox === null) throw new Error("a row drawn nowhere");
    expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    const cut = await label.evaluate((element) => ({
      overflow: getComputedStyle(element).textOverflow,
      scroll: element.scrollWidth,
      client: element.clientWidth,
    }));
    expect(cut.overflow).toBe("ellipsis");
    expect(cut.scroll).toBeGreaterThan(cut.client);
    await expect(
      page.getByRole("region", { name: "Command" }).getByText(line, {
        exact: true,
      }),
    ).toBeAttached();
    await started.getByRole("button").click();
    await expect(
      page
        .getByRole("complementary", { name: "Item detail panel" })
        .getByRole("region", { name: "Recorded fields" })
        .getByText(line, { exact: true }),
    ).toBeAttached();
  });
});

/** Overall, with the run's own records read. */
async function openOverall(page: Page, extra = ""): Promise<Locator> {
  await page.goto(`${origin()}/?run=${facts.run}&view=overall${extra}`);
  const events = page.getByRole("region", { name: "Run events" });
  await expect(events.getByRole("heading", { name: "Events" })).toBeVisible();
  // An address naming a record reads the run's own records by itself, so the
  // control can leave between being seen and being pressed.
  const load = page.getByRole("button", { name: "Load the run's own records" });
  if (await load.isVisible())
    await load.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(events.getByRole("article").first()).toBeVisible();
  return events;
}

test.describe("the run's own records", () => {
  test("records after the graph ended are rows of Overall's list in time order, with no section of their own", async ({
    page,
  }) => {
    const events = await openOverall(page);
    await expect(page.getByText("After execution ended")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Records after execution" }),
    ).toHaveCount(0);
    const response = await page.request.get(
      `${origin()}/api/v2/runs/${facts.run}/timeline?scope=run`,
    );
    const served = parseRunTimeline(await response.json());
    const runLevel = served.spans
      .filter((span) => span.node_id === undefined)
      .flatMap((span) => span.events)
      .filter((event) => event.node_id === undefined);
    const after = runLevel.filter((event) =>
      ["branches-retired", "scratch-removed"].includes(event.kind),
    );
    expect(after).toHaveLength(2);
    const shown = await events
      .getByRole("article")
      .evaluateAll((articles) =>
        articles.map((article) => article.getAttribute("data-row-id")),
      );
    for (const record of after) expect(shown).toContain(record.record_id);
    const order = runLevel
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      .map(({ record_id }) => record_id);
    expect(shown).toEqual(order.filter((id) => shown.includes(id ?? "")));
  });

  test("replies, edits with their outcomes, notes and human resolutions are rows under their own types", async ({
    page,
  }) => {
    const events = await openOverall(page);
    await expect(row(events, "edit-committed · by planner")).toContainText(
      " · applied",
    );
    await expect(row(events, "edit-rejected · by planner")).toContainText(
      " · not applied",
    );
    await expect(
      row(events, "Redirection deferred to the next dispatch"),
    ).toContainText(" · held");
    await expect(row(events, "planner-replied")).toHaveCount(1);
    await expect(row(events, "command-accepted")).toContainText(" · accepted");
    await row(events, "edit-rejected · by planner").getByRole("button").click();
    await expect(
      page.getByRole("complementary", { name: "Item detail panel" }),
    ).toContainText("decline: node 'plain': the reason cannot be blank");
    // Each of them under its own type: hiding it hides exactly those rows.
    for (const [type, name] of [
      ["reply", "planner-replied"],
      ["edit", "edit-rejected · by planner"],
      ["note", "Redirection deferred to the next dispatch"],
    ] as const) {
      const hidden = await openOverall(page, `&hide-event=${type}`);
      await expect(row(hidden, name)).toHaveCount(0);
    }
    const asker = await openNode(page, "asker");
    await expect(
      row(asker, "check the export at phone width too").or(
        row(asker, "note-shown"),
      ),
    ).toContainText(" · shown");
    const approve = await openNode(page, "approve");
    await expect(row(approve, "human-attested")).toContainText(" · attested");
    await row(approve, "human-attested").getByRole("button").click();
    const detail = page.getByRole("complementary", {
      name: "Item detail panel",
    });
    for (const said of [
      "operator",
      "release-manager",
      "user",
      "keep",
      "Keep them for one more release.",
    ])
      await expect(detail).toContainText(said);
  });

  test("the run's own repeats are one block that opens and closes, and an address inside it opens it", async ({
    page,
  }) => {
    const events = await openOverall(page);
    const block = events.getByRole("region", {
      name: "1 event repeated 3 times: pool-maintenance",
    });
    await expect(block.getByRole("article")).toHaveCount(1);
    await block.getByRole("button", { name: "Show all 3" }).click();
    await expect(block.getByRole("article")).toHaveCount(3);
    await block.getByRole("button", { name: "Show one pass" }).click();
    await expect(block.getByRole("article")).toHaveCount(1);

    const response = await page.request.get(
      `${origin()}/api/v2/runs/${facts.run}/timeline?scope=run`,
    );
    const second = parseRunTimeline(await response.json())
      .spans.flatMap((span) => span.events)
      .filter((event) => event.kind === "pool-maintenance")[1];
    if (second?.record_id === undefined) throw new Error("no second sweep");
    const opened = await openOverall(page, `&event=${second.record_id}`);
    const holding = opened.getByRole("region", {
      name: "1 event repeated 3 times: pool-maintenance",
    });
    await expect(
      holding.getByRole("button", { name: "Show one pass" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(holding.getByRole("article")).toHaveCount(3);
    await expect(holding.getByRole("article").nth(1)).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(
      page.getByRole("complementary", { name: "Item detail panel" }),
    ).toContainText("github.com/example/repo");
  });

  test("until the run's own records are read, Overall's list says none is held", async ({
    page,
  }) => {
    await page.goto(`${origin()}/?run=${facts.run}&view=overall`);
    const events = page.getByRole("region", { name: "Run events" });
    const load = page.getByRole("button", {
      name: "Load the run's own records",
    });
    await expect(load).toBeVisible();
    await expect(events).toContainText(
      "No record of the run's own is held yet.",
    );
    await loadRunRecords(page);
    await expect(events.getByRole("article").first()).toBeVisible();
    await expect(events).not.toContainText(
      "No record of the run's own is held yet.",
    );
  });

  test("no Channel tab or route is there to reach", async ({ page }) => {
    await page.goto(
      `${origin()}/?run=${facts.run}&node=asker&view=graph&tab=channel`,
    );
    await expect(page.getByRole("tab", { name: "Channel" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const route of ["channel", "channel/next", "attest"]) {
      const response = await page.request.fetch(
        `${origin()}/api/v2/runs/${facts.run}/${route}`,
        { method: route === "channel" ? "GET" : "POST" },
      );
      expect(response.status(), route).toBe(404);
    }
  });
});

/** The event-type filter of `list`, opened from its own summary. */
async function typeFilter(list: Locator): Promise<Locator> {
  const group = list.getByRole("group", { name: "Event types" });
  if (!(await group.isVisible()))
    await list.getByText(/^Event types:/u).click();
  await expect(group).toBeVisible();
  return group;
}

/** The filter's checkbox for one type, the filter opened first. */
async function typeBox(list: Locator, label: string): Promise<Locator> {
  return (await typeFilter(list)).getByRole("checkbox", {
    name: label,
    exact: true,
  });
}

for (const where of ["node", "overall"] as const) {
  test.describe(`the event-type filter on ${where === "node" ? "a node's timeline" : "Overall"}`, () => {
    const open = (page: Page, extra = "") =>
      where === "node"
        ? openNode(page, "asker", extra)
        : openOverall(page, extra);

    test("sits with the events, partitions every row into exactly one offered type, and keeps a choice across a reload", async ({
      page,
    }) => {
      const list = await open(page);
      // A block of repeats draws one pass of the rows it holds, and the filter
      // counts every row; opened, the list draws them all.
      await openRepeatedLoops(page);
      await expect(
        page
          .getByRole("banner", { name: "Run header" })
          .getByText("Event types"),
      ).toHaveCount(0);
      await expect(list.getByText(/^Event types:/u)).toBeVisible();
      const filter = await typeFilter(list);
      const offeredTypes: string[] = [];
      for (const label of EVENT_TYPES.map(eventTypeLabel))
        if (
          (await filter
            .getByRole("checkbox", { name: label, exact: true })
            .count()) > 0
        )
          offeredTypes.push(label);
      expect(offeredTypes.length).toBeGreaterThan(1);
      // Each offered type hides rows of its own, says how many, and together
      // they hide every row exactly once: a row of two types would be counted
      // twice, and a row of none never.
      const rows = list.getByRole("article");
      const total = await rows.count();
      let hiddenInAll = 0;
      for (const label of offeredTypes) {
        const box = await typeBox(list, label);
        await box.uncheck();
        await expect(rows).not.toHaveCount(total);
        const hidden = total - (await rows.count());
        expect(hidden, label).toBeGreaterThan(0);
        await expect(box).toHaveAccessibleDescription(String(hidden));
        hiddenInAll += hidden;
        await box.check();
        await expect(rows).toHaveCount(total);
      }
      expect(hiddenInAll).toBe(total);
      const [first] = offeredTypes;
      if (first === undefined) throw new Error("the filter offers nothing");
      await (await typeBox(list, first)).uncheck();
      await expect(rows).not.toHaveCount(total);
      const left = await rows.count();
      await page.reload();
      const reloaded =
        where === "node"
          ? page.getByRole("region", { name: "Node transcript" })
          : page.getByRole("region", { name: "Run events" });
      await expect(
        reloaded.getByRole("heading", { name: "Events" }),
      ).toBeVisible();
      if (where === "overall") {
        const load = page.getByRole("button", {
          name: "Load the run's own records",
        });
        if (await load.isVisible()) await loadRunRecords(page);
      }
      // Which blocks a reader opened is theirs, not the address's.
      await expect(reloaded.getByRole("article").first()).toBeVisible();
      await openRepeatedLoops(page);
      await expect(reloaded.getByRole("article")).toHaveCount(left);
      await expect(await typeBox(reloaded, first)).not.toBeChecked();
    });

    test("a filter hiding every row says so and clears itself", async ({
      page,
    }) => {
      const list = await open(page);
      const filter = await typeFilter(list);
      await filter.getByRole("button", { name: "Clear" }).click();
      await expect(list.getByRole("article")).toHaveCount(0);
      await expect(list.getByRole("status")).toContainText(
        "The event-type filter hides every event in this list.",
      );
      // Closed, so the list's own head holds only its summary again.
      await list.getByText(/^Event types:/u).click();
      await list.getByRole("button", { name: "Show every event type" }).click();
      await expect(list.getByRole("article").first()).toBeVisible();
      expect(new URL(page.url()).searchParams.getAll("hide-event")).toEqual([]);
    });
  });
}

test("Select all puts every hidden type back", async ({ page }) => {
  const list = await openNode(page, "asker");
  const rows = list.getByRole("article");
  const total = await rows.count();
  const filter = await typeFilter(list);
  await filter.getByRole("button", { name: "Clear" }).click();
  await expect(rows).toHaveCount(0);
  await (await typeFilter(list))
    .getByRole("button", { name: "Select all" })
    .click();
  await expect(rows).toHaveCount(total);
  expect(new URL(page.url()).searchParams.getAll("hide-event")).toEqual([]);
});

test("a type hidden on one list is offered on a list holding none of it, and shown again from there", async ({
  page,
}) => {
  const build = await openNode(page, "build");
  await (await typeBox(build, eventTypeLabel("command"))).uncheck();
  await expect(
    build.getByRole("article", { name: /^bun run build/u }),
  ).toHaveCount(0);
  const asker = await openNode(page, "asker", "&hide-event=command");
  const box = await typeBox(asker, eventTypeLabel("command"));
  await expect(box).not.toBeChecked();
  await expect(box).toHaveAccessibleDescription("0");
  // Shown again, a type this list holds none of is no longer offered here.
  await box.click();
  await expect(box).toHaveCount(0);
  expect(new URL(page.url()).searchParams.getAll("hide-event")).toEqual([]);
  const again = await openNode(page, "build");
  await expect(
    again.getByRole("article", { name: "bun run build --name 'a b'" }),
  ).toHaveCount(1);
});

test("hiding the record that broke a repeat up shows the repeat as one block", async ({
  page,
}) => {
  const list = await openNode(page, "split");
  await expect(blocks(list)).toHaveCount(0);
  await expect(
    list.getByRole("article", { name: "criterion-checked" }),
  ).toHaveCount(3);
  await (await typeBox(list, eventTypeLabel("surface"))).uncheck();
  const block = list.getByRole("region", {
    name: "1 event repeated 3 times: criterion-checked",
  });
  await expect(block.getByText("×3", { exact: true })).toBeVisible();
  await expect(list.getByRole("article")).toHaveCount(2);
});

test("no Decisions or Detailed control exists, and nothing the view asks for carries a filter", async ({
  page,
}) => {
  const asked: { url: string; body: string }[] = [];
  page.on("request", (request) =>
    asked.push({ url: request.url(), body: request.postData() ?? "" }),
  );
  const transcript = await openNode(page, "held");
  await loadAllEarlierRows(page);
  await blocks(transcript)
    .first()
    .getByRole("article")
    .first()
    .getByRole("button")
    .click();
  await openOverall(page);
  for (const name of [/^Decisions$/u, /^Detailed( activity)?$/u])
    for (const role of [
      "button",
      "radio",
      "tab",
      "checkbox",
      "switch",
    ] as const)
      await expect(page.getByRole(role, { name })).toHaveCount(0);
  const api = asked.filter(({ url }) =>
    new URL(url).pathname.startsWith("/api/"),
  );
  expect(api.length).toBeGreaterThan(0);
  for (const { url, body } of api) {
    expect(new URL(url).searchParams.has("filter"), url).toBe(false);
    expect(body, url).not.toMatch(/"filter"\s*:/u);
  }
});
