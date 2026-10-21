import {
  apiErrorSchema,
  artifactContentSchema,
  type ProjectGroup,
  projectAgentsSchema,
  projectListSchema,
  renderedRootSchema,
  renderedRunSchema,
  runAgentsSchema,
  runDetailSchema,
  runStatusSchema,
  runTranscriptSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { fixture, runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";

/**
 * Supervising a run from the browser: the projects the app opens on, and every
 * verb the CLI has once a plan is running, driven against the real read API over
 * runs the fixture harness recorded.
 *
 * These journeys **write** to the served runs — a surface raised, a reply queued,
 * a run adopted, two runs stopped — so they act on runs written for them alone:
 * the supervised run the acting session owns, the run another session owns, and
 * the run nothing is driving. The live run every other journey reads is left as
 * it was — but a write is a write *now*, and the run written to becomes the
 * newest activity the flat list leads with, which is why the journeys over the
 * live run name it rather than opening whatever is served first. They share the
 * fixture server with `dag-ui.spec.ts`, whose last journeys take every served run
 * away, these three included, and sort ahead of it by name.
 *
 * The order within this file matters too: the adoption is what puts the human
 * action in front of the attest, the watch is held before the run it watches is
 * stopped, and the stop of the run the session owns is the last thing done to it.
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

async function servedProjects(page: Page): Promise<readonly ProjectGroup[]> {
  return (await served(page, "/api/v2/projects", projectListSchema)).projects;
}

const receipt = (page: Page, label: string): Locator =>
  page.getByRole("alert", { name: `${label} receipt` });
const refusal = (page: Page, label: string): Locator =>
  page.getByRole("alert", { name: `${label} refused` });

test("opens on the projects in the order the API serves them, and a project opens to its runs", async ({
  page,
}) => {
  const groups = await servedProjects(page);
  expect(groups.length).toBeGreaterThan(2);
  const none = groups.findIndex((group) => group.project === null);
  expect(none).toBeGreaterThanOrEqual(0);

  await page.goto("/");
  const cards = page.getByRole("list", { name: "Projects" });
  await expect(cards.getByRole("listitem")).toHaveCount(groups.length);
  // Card by card, the same order — the server's, newest activity first — and
  // the `(no project)` group where its own recency puts it.
  for (const [index, group] of groups.entries()) {
    const card = cards.getByRole("listitem").nth(index);
    await expect(card).toContainText(group.name ?? "(no project)");
    if (group.project !== null) await expect(card).toContainText(group.project);
    await expect(card).toContainText(
      `${group.runs.length} ${group.runs.length === 1 ? "run" : "runs"}`,
    );
  }
  // The navigation lists the same groups in the same order.
  const rows = page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("list", { name: "Project rows" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(groups.length);
  await expect(rows.nth(none)).toContainText("(no project)");

  // The supervision project's page: its runs newest first, exactly as served,
  // each with its settlement, liveness, node counts and last write.
  const supervision = groups.find(
    (group) => group.project === fixture().projects.supervision,
  );
  expect(supervision).toBeDefined();
  if (supervision === undefined) return;
  await cards
    .getByRole("button", { name: supervision.name ?? "" })
    .first()
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `project=${encodeURIComponent(fixture().projects.supervision).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  const list = page.getByRole("list", { name: `Runs of ${supervision.name}` });
  await expect(list.getByRole("listitem")).toHaveCount(supervision.runs.length);
  for (const [index, run] of supervision.runs.entries()) {
    const row = list.getByRole("listitem").nth(index);
    await expect(row).toContainText(run.run_id);
    await expect(row).toContainText(run.state);
    if (run.liveness !== undefined)
      await expect(row).toContainText(run.liveness);
    await expect(row).toContainText(/\d+ (done|running|pending|waiting)/);
    await expect(row).toContainText("Last write");
  }

  // A run opens to the run view that exists today, with the page one step back.
  await list.getByRole("button", { name: `Open ${runs().supervised}` }).click();
  await expect(
    page.getByRole("region", { name: "Graph timeline" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`run=${runs().supervised}`));
  await page
    .getByRole("button", { name: `Back to ${supervision.name}` })
    .click();
  await expect(list).toBeVisible();

  // And a project page is linkable: the address alone opens it, and the flat
  // run list is one toggle away.
  await page.goto(
    `/?project=${encodeURIComponent(fixture().projects.archive)}`,
  );
  await expect(
    page.getByRole("list", { name: /^Runs of / }).getByRole("button", {
      name: `Open ${runs().history}`,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  // The flat list, with the live run on it — every run row is a button named
  // by its mark, live or historical, and then its id.
  await expect(
    page.getByRole("navigation", { name: "DAG runs" }).getByRole("button", {
      name: RegExp(`^(Live|Historical) ${runs().live}`),
    }),
  ).toBeVisible();
});

test("raises a surface, claims it, and answers it with a reply composed by shortcut and sent as typed", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().supervised}&view=channel`);
  const queue = page.getByRole("region", { name: "Channel queue" });
  await expect(
    queue.getByRole("region", { name: "Waiting surfaces" }),
  ).toContainText("No unread surfaces.");

  // Surface: a kind under the engine's grammar and a message.
  const surface = page.getByRole("region", { name: "Surface" });
  await surface.getByLabel("Kind").fill("finding");
  await surface
    .getByLabel("Message")
    .fill("the gate went red on the same hunk");
  await surface.getByRole("button", { name: "Raise surface" }).click();
  await expect(receipt(page, "Surface")).toContainText('"state": "queued"');
  const waiting = queue.getByRole("region", { name: "Waiting surfaces" });
  await expect(waiting).toContainText("finding");
  await expect(waiting).toContainText("from proposal");
  await expect(waiting).toContainText("non-blocking");
  await expect(waiting).toContainText(/\d+(ms|s) old/);
  await expect(waiting).toContainText("the gate went red on the same hunk");

  // Next: the channel's one consumer. A non-blocking surface is read and done —
  // it leaves the unread list for the answered ones, and holds nothing.
  await queue.getByRole("button", { name: "Next" }).click();
  const next = receipt(page, "Next");
  await expect(next).toContainText('"status": "surface"');
  await expect(next).toContainText(
    '"message": "the gate went red on the same hunk"',
  );
  await expect(
    queue.getByRole("region", { name: "Answered surfaces" }),
  ).toContainText("the gate went red on the same hunk");
  await expect(waiting).toContainText("No unread surfaces.");

  // An edit by shortcut: a blocking finding, which the engine raises as a
  // surface holding the node it names — and claims into the pending slot.
  const composer = page.getByRole("region", { name: "Reply" });
  // The engine's graph edits are available through the shortcut composer; the
  // commands that edit no graph — a review pass, a readjustment, a decline of
  // review comments, a withdrawal of a sent note — are spelled by the grammar
  // and offered no shortcut.
  const shortcut = composer.getByLabel("Shortcut");
  await expect(
    shortcut.getByRole("option", { name: "rework", exact: true }),
  ).toHaveCount(1);
  await expect(
    shortcut.getByRole("option", { name: "retitle", exact: true }),
  ).toHaveCount(1);
  for (const unoffered of ["decline", "review", "readjust", "withdraw-note"]) {
    await expect(
      shortcut.getByRole("option", { name: unoffered, exact: true }),
    ).toHaveCount(0);
  }
  await shortcut.selectOption("finding");
  await composer.getByLabel("Message").fill("stop and read this first");
  await composer.getByLabel("Blocking").check();
  await composer.getByLabel("Node id").fill("build");
  await composer.getByRole("button", { name: "Compose envelope" }).click();
  const editor = composer.getByLabel("Envelope (sent as typed)");
  await expect(editor).toHaveValue(
    '{\n  "version": 3,\n  "commands": [\n    {\n      "op": "finding",\n      "message": "stop and read this first",\n      "blocking": true,\n      "id": "build"\n    }\n  ]\n}',
  );
  await composer.getByRole("button", { name: "Send reply" }).click();
  const applied = receipt(page, "Reply");
  await expect(applied).toContainText('"state": "applied"');
  await expect(applied).toContainText('"commands": "applied"');
  await expect(waiting).toContainText("stop and read this first");
  await expect(waiting).toContainText("blocking");
  await expect(waiting).toContainText("node build");
  await queue.getByRole("button", { name: "Next" }).click();
  const pending = queue.getByRole("region", { name: "Pending surfaces" });
  await expect(pending).toContainText("stop and read this first");
  await expect(waiting).toContainText("No unread surfaces.");

  // The composer: a verdict by shortcut, rendered into the editor and sent as
  // the bytes there — with a space typed after the shortcut composed it, so the
  // envelope on the wire is provably the editor's text and not a re-encoding.
  await composer.getByLabel("Shortcut").selectOption("continue");
  await composer.getByLabel("Message").fill("carry on; the hunk is fine");
  await composer.getByRole("button", { name: "Compose envelope" }).click();
  await expect(editor).toHaveValue(
    '{\n  "message": "carry on; the hunk is fine"\n}',
  );
  await editor.press("End");
  await editor.type(" ");
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().includes("/channel/reply"),
  );
  await composer.getByRole("button", { name: "Send reply" }).click();
  expect((await sent).postData()).toBe(
    '{\n  "message": "carry on; the hunk is fine"\n} ',
  );
  const replied = receipt(page, "Reply");
  await expect(replied).toContainText('"state": "delivered"');
  await expect(replied).toContainText('"verdict": "delivered"');
  await expect(queue.getByRole("region", { name: "Replies" })).toContainText(
    '"message": "carry on; the hunk is fine"',
  );

  // A refusal is the engine's own words: what the API answers for these bytes
  // is what the page shows, unaltered.
  const malformed = '{"nonsense": 1}';
  const error = await refusedBy(
    await page.request.post(`/api/v2/runs/${runs().supervised}/channel/reply`, {
      data: malformed,
      headers: { "content-type": "application/json" },
    }),
    422,
  );
  expect(error.code).toBe("refused");
  await editor.fill(malformed);
  await composer.getByRole("button", { name: "Send reply" }).click();
  const refused = refusal(page, "Reply");
  await expect(refused).toContainText("422 refused");
  await expect(refused).toContainText(error.message);

  // And a shortcut whose form cannot compose an envelope the grammar reads says
  // which field, before anything is sent.
  await composer.getByLabel("Shortcut").selectOption("drop");
  await composer.getByLabel("Node id").fill("");
  await composer.getByRole("button", { name: "Compose envelope" }).click();
  await expect(
    composer.getByRole("alert", { name: "Envelope not composed" }),
  ).toContainText("commands.0.id");
});

test("composes review replies, applies rework and reports retitle delivery refusal", async ({
  page,
}) => {
  // Review edits change the graph and its watch debts; keep them off the
  // shared corpus that the other supervising journeys drive.
  const server = await startFixtureServer("review", ["--review-corpus"]);
  try {
    const run = z
      .object({ runs: z.object({ supervised: z.string().min(1) }) })
      .parse(server.facts).runs.supervised;
    await page.goto(`${server.origin}/?run=${run}&view=channel`);
    const composer = page.getByRole("region", { name: "Reply" });
    await composer.getByLabel("Shortcut").selectOption("rework");
    await composer.getByLabel("Node id", { exact: true }).fill("review-draft");
    await composer
      .getByLabel("Reason", { exact: true })
      .fill("Review found a missing check");
    await composer.getByLabel("Instruction").fill("Add the missing check");
    const cannotCompose = async (
      label: string,
      valid: string,
      problem: string,
    ) => {
      await composer.getByLabel(label, { exact: true }).fill("");
      await composer.getByRole("button", { name: "Compose envelope" }).click();
      await expect(
        composer.getByRole("alert", { name: "Envelope not composed" }),
      ).toContainText(problem);
      await composer.getByLabel(label, { exact: true }).fill(valid);
    };
    await cannotCompose("Node id", "review-draft", "commands.0.id");
    await cannotCompose(
      "Reason",
      "Review found a missing check",
      "commands.0.reason",
    );
    await cannotCompose(
      "Instruction",
      "Add the missing check",
      "commands.0.instruction",
    );
    const comments = [
      {
        id: "review-1",
        url: "https://github.com/example/repo/pull/1#discussion_r1",
      },
    ];
    await composer.getByLabel("Review comments (JSON, optional)").fill("{");
    await composer.getByRole("button", { name: "Compose envelope" }).click();
    await expect(composer).toContainText("comments:");
    await composer
      .getByLabel("Review comments (JSON, optional)")
      .fill('[{"id":"review-1"}]');
    await composer.getByRole("button", { name: "Compose envelope" }).click();
    await expect(
      composer.getByRole("alert", { name: "Envelope not composed" }),
    ).toContainText("commands.0.comments.0.url");
    await composer
      .getByLabel("Review comments (JSON, optional)")
      .fill(JSON.stringify(comments));
    await composer
      .getByLabel("Title", { exact: true })
      .fill("fix: add review coverage");
    await composer
      .getByLabel("Replacement node id (optional)")
      .fill("review-draft-rework");
    const send = async (command: unknown, semanticRefusal?: string) => {
      await composer.getByRole("button", { name: "Compose envelope" }).click();
      const expected = { version: 3, commands: [command] };
      const editor = composer.getByLabel("Envelope (sent as typed)");
      await expect(editor).toHaveValue(JSON.stringify(expected, null, 2));
      const answered = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes(`/runs/${run}/channel/reply`),
      );
      await composer.getByRole("button", { name: "Send reply" }).click();
      const response = await answered;
      expect(response.request().postDataJSON()).toEqual(expected);
      if (semanticRefusal !== undefined) {
        // A retitle with no host session passes the engine's reply schema and
        // graph validation, then refuses delivery. Schema errors cannot satisfy
        // this specific downstream refusal (the manager's agreed boundary).
        const error = await refusedBy(response, 422);
        expect(error.code).toBe("refused");
        expect(error.message).toBe(semanticRefusal);
        await expect(refusal(page, "Reply")).toContainText(semanticRefusal);
      } else {
        expect(response.status()).toBe(200);
        await expect(receipt(page, "Reply")).toContainText(
          '"state": "applied"',
        );
      }
    };
    await composer.getByLabel("Shortcut").selectOption("retitle");
    await composer.getByLabel("Node id", { exact: true }).fill("review-draft");
    await composer
      .getByLabel("Title", { exact: true })
      .fill("fix: cover the review findings");
    await composer
      .getByLabel("Reason", { exact: true })
      .fill("Describe the reviewed scope");
    await cannotCompose("Node id", "review-draft", "commands.0.id");
    await cannotCompose(
      "Title",
      "fix: cover the review findings",
      "commands.0.title",
    );
    await cannotCompose(
      "Reason",
      "Describe the reviewed scope",
      "commands.0.reason",
    );
    await send(
      {
        op: "retitle",
        id: "review-draft",
        title: "fix: cover the review findings",
        reason: "Describe the reviewed scope",
      },
      "refused: retitle: node 'review-draft' has no session on the run's record to address its change request through",
    );
    // Declining is answered by replies the run drafts rather than composed from
    // a form, so no shortcut names it; typed into the editor, it reaches the
    // engine as a decline, which refuses it past its schema — the comment was
    // never read on this run — rather than as an unknown op.
    const shortcutOption = (name: string) =>
      composer
        .getByLabel("Shortcut")
        .getByRole("option", { name, exact: true });
    await expect(shortcutOption("retitle")).toHaveCount(1);
    await expect(shortcutOption("decline")).toHaveCount(0);
    const declineRefusal =
      "refused: decline: node 'review-draft': comment review-1 was not read for it — run `onepipeline review` and decline a comment it surfaced";
    const decline = {
      version: 3,
      commands: [
        {
          op: "decline",
          id: "review-draft",
          comments,
          reason: "Out of scope for this change",
        },
      ],
    };
    await composer
      .getByLabel("Envelope (sent as typed)")
      .fill(JSON.stringify(decline));
    const declined = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/runs/${run}/channel/reply`),
    );
    await composer.getByRole("button", { name: "Send reply" }).click();
    const declineResponse = await declined;
    expect(declineResponse.request().postDataJSON()).toEqual(decline);
    const declineError = await refusedBy(declineResponse, 422);
    expect(declineError.code).toBe("refused");
    expect(declineError.message).toBe(declineRefusal);
    await expect(refusal(page, "Reply")).toContainText(declineRefusal);
    await composer.getByLabel("Shortcut").selectOption("rework");
    await composer
      .getByLabel("Title", { exact: true })
      .fill("fix: add review coverage");
    await composer
      .getByLabel("Reason", { exact: true })
      .fill("Review found a missing check");
    await send({
      op: "rework",
      id: "review-draft",
      reason: "Review found a missing check",
      instruction: "Add the missing check",
      comments,
      title: "fix: add review coverage",
      replacement: "review-draft-rework",
    });
    await composer
      .getByLabel("Node id", { exact: true })
      .fill("review-draft-optional");
    await composer.getByLabel("Review comments (JSON, optional)").fill("");
    await composer.getByLabel("Title", { exact: true }).fill("");
    await composer.getByLabel("Replacement node id (optional)").fill("");
    await send({
      op: "rework",
      id: "review-draft-optional",
      reason: "Review found a missing check",
      instruction: "Add the missing check",
    });
  } finally {
    await server.stop();
  }
});

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
  await expect(page.getByLabel("Liveness ACTIVE")).toBeVisible();
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

test("reads status, results, goals, the transcript, telemetry and the host as the API renders them", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().supervised}&view=reads`);
  const status = await served(
    page,
    `/api/v2/runs/${runs().supervised}/status`,
    runStatusSchema,
  );
  const panel = page.getByRole("region", { name: "Status" });
  await expect(panel).toContainText(status.liveness);
  // The rendering carries a clock — how long a node has been running — that
  // moves between the API's read and the browser's, so it is held to its
  // first line, which is the run's own standing.
  await expect(panel).toContainText(status.rendered.split("\n")[0] ?? "");

  const results = await served(
    page,
    `/api/v2/runs/${runs().supervised}/results`,
    renderedRunSchema,
  );
  await page.getByRole("tab", { name: "Results" }).click();
  await expect(
    page
      .getByRole("region", { name: "Results" })
      .getByText(results.rendered, { exact: true }),
  ).toBeVisible();

  const goals = await served(
    page,
    `/api/v2/runs/${runs().supervised}/goals`,
    renderedRunSchema,
  );
  await page.getByRole("tab", { name: "Goals" }).click();
  await expect(
    page
      .getByRole("region", { name: "Goals" })
      .getByText(goals.rendered, { exact: true }),
  ).toBeVisible();

  const transcript = await served(
    page,
    `/api/v2/runs/${runs().supervised}/transcript`,
    runTranscriptSchema,
  );
  await page.getByRole("tab", { name: "Transcript" }).click();
  const transcriptPanel = page.getByRole("region", { name: "Transcript" });
  await expect(
    transcriptPanel.getByText(transcript.rendered, { exact: true }),
  ).toBeVisible();
  // A node this run dispatched nothing for is the engine's refusal rather than
  // an empty transcript, and it is shown as the API worded it.
  const { message } = await refusedBy(
    await page.request.get(
      `/api/v2/runs/${runs().supervised}/transcript?node=prepare`,
    ),
    422,
  );
  await transcriptPanel.getByLabel("Node").selectOption("prepare");
  await expect(refusal(page, "Transcript")).toContainText(message);

  await page.getByRole("tab", { name: "Telemetry" }).click();
  await expect(page.getByRole("region", { name: "Telemetry" })).toContainText(
    `"run_id": "${runs().supervised}"`,
  );

  const host = await served(page, "/api/v2/host", renderedRootSchema);
  await page.getByRole("tab", { name: "Host" }).click();
  // The host view carries a clock per dispatch too, so it is held to its head:
  // the host and the root it is reading.
  const hostPanel = page.getByRole("region", { name: "Host" });
  for (const line of host.rendered.split("\n").slice(0, 2))
    await expect(hostPanel).toContainText(line.trim());
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
  // The run's own record says so now: the stop is journalled, and the
  // liveness reads what the engine makes of a stopped run — on the status
  // read's next landing, which on a loaded host is seconds away.
  await expect(page.getByLabel("Liveness DRIVER DEAD")).toBeVisible({
    timeout: 60_000,
  });
});

/**
 * Every agent a run launched, off the run's own pointer file — the file the
 * engine has every oneharness under its launches append to — grouped by which
 * launch each session was written under, and each opening to its transcript in
 * the store oneharness itself kept it in. Held to the served API on both sides:
 * the sessions the listing serves are the ones the fixture's pointer file names,
 * and the count beside the run is the number of them.
 */
test("lists every agent the run launched, grouped by scope and attempt, and opens one to its transcript", async ({
  page,
}) => {
  const listing = await served(
    page,
    `/api/v2/runs/${runs().live}/agents`,
    runAgentsSchema,
  );
  expect(listing.sessions).toHaveLength(fixture().agents.live);
  expect(listing.skipped).toBe(0);
  const detail = await served(
    page,
    `/api/v2/runs/${runs().live}`,
    runDetailSchema,
  );
  expect(detail.run.agent_count).toBe(fixture().agents.live);

  await page.goto(`/?run=${runs().live}&view=agents`);
  const panel = page.getByRole("region", { name: "Agents" });
  await expect(panel).toContainText(`${fixture().agents.live} agents`);
  // The worker's dispatch of its node at its first attempt, then the run's
  // observer: the engine's own scope order, with the labels a reader wants —
  // the node, and the repository's own `role` — and the harness run by its
  // configured id.
  const dispatch = panel.getByRole("list", {
    name: "Node dispatch · attempt 1",
  });
  await expect(dispatch).toContainText("engineer-dashboard");
  await expect(dispatch).toContainText(`node ${fixture().agents.worker.node}`);
  await expect(dispatch).toContainText("role engineer");
  await expect(dispatch).toContainText("claude-code:alternate");
  await expect(dispatch).toContainText("started");
  const observer = panel.getByRole("list", { name: "Observer" });
  await expect(observer).toContainText("monitor");
  // The drafting of a reply to a review comment on that node's draft, read
  // under its own scope after the observer, in the engine's scope order.
  const replier = panel.getByRole("list", {
    name: "Review reply author · attempt 1",
  });
  await expect(replier).toContainText("replier-dashboard");
  await expect(replier).toContainText(`node ${fixture().agents.worker.node}`);
  const headings = await panel
    .getByRole("heading", { level: 4 })
    .allTextContents();
  expect(headings).toEqual([
    "Node dispatch · attempt 1",
    "Observer",
    "Review reply author · attempt 1",
  ]);

  // Opening the worker's harness run: the conversation view the app has for a
  // oneharness session, over the record its pointer line names — which is the
  // record the artifact route serves under that history id.
  await dispatch.getByRole("button", { name: "Open transcript" }).click();
  await expect(dispatch).toContainText(fixture().agents.worker.text);
  const transcript = await served(
    page,
    `/api/v2/runs/${runs().live}/artifacts/${fixture().agents.worker.history_id}`,
    artifactContentSchema,
  );
  expect(transcript.kind).toBe("oneharness_session");
  expect(transcript.content).toContain(fixture().agents.worker.text);
  // No location on the host reaches the reader: the store's path is the
  // record's own business, and the panel asks by the history id alone.
  await expect(panel).not.toContainText("oneharness-history");
  await dispatch.getByRole("button", { name: "Close transcript" }).click();
  await expect(dispatch).not.toContainText(fixture().agents.worker.text);

  // A run whose launches wrote nothing — one an earlier engine launched, or
  // one that has dispatched nothing yet — is a count of zero and an empty
  // listing, never an error.
  const none = await served(
    page,
    `/api/v2/runs/${runs().history}`,
    runDetailSchema,
  );
  expect(none.run.agent_count).toBe(fixture().agents.history);
  await page.goto(`/?run=${runs().history}&view=agents`);
  await expect(panel).toContainText("0 agents");
  await expect(panel).toContainText("No agents launched.");
});

test("shows a node's own agents on its Agents tab, and a node that dispatched nothing as none", async ({
  page,
}) => {
  const node = fixture().agents.worker.node;
  const mine = await served(
    page,
    `/api/v2/runs/${runs().live}/nodes/${node}/agents`,
    runAgentsSchema,
  );
  expect(mine.node).toBe(node);
  // The node's worker and the drafting of a reply on its draft, both stamped
  // with the node; the run's observer is no node's.
  expect(
    mine.sessions.map((session) => session.labels["onepipeline.scope"]),
  ).toEqual(["node", "review-reply"]);
  expect(mine.sessions[0]?.runs[0]?.history_id).toBe(
    fixture().agents.worker.history_id,
  );
  await page.goto(`/?run=${runs().live}&node=${node}&tab=agents`);
  const panel = page.getByRole("region", { name: `Agents of ${node}` });
  await expect(
    panel.getByRole("button", { name: "Open transcript" }),
  ).toHaveCount(2);
  await expect(panel).not.toContainText("Observer");
  await panel
    .getByRole("list", { name: "Node dispatch · attempt 1" })
    .getByRole("button", { name: "Open transcript" })
    .click();
  await expect(panel).toContainText(fixture().agents.worker.text);

  const quiet = await served(
    page,
    `/api/v2/runs/${runs().live}/nodes/foundation/agents`,
    runAgentsSchema,
  );
  expect(quiet.sessions).toEqual([]);
  await page.goto(`/?run=${runs().live}&node=foundation&tab=agents`);
  await expect(
    page.getByRole("region", { name: "Agents of foundation" }),
  ).toContainText("No agents launched.");
});

test("shows the union of a project's agents across its runs, with the count on its row", async ({
  page,
}) => {
  const observatory = fixture().projects.observatory;
  const union = await served(
    page,
    `/api/v2/projects/${encodeURIComponent(observatory)}/agents`,
    projectAgentsSchema,
  );
  expect(union.sessions).toHaveLength(fixture().agents.observatory);
  const group = (await servedProjects(page)).find(
    (served) => served.project === observatory,
  );
  expect(group?.agent_count).toBe(fixture().agents.observatory);
  // Each entry names the run it is under, which is the run its transcript is
  // opened through: the live run's sessions and the sibling's, across two runs.
  expect(
    union.sessions.filter((session) => session.run_id === runs().live),
  ).toHaveLength(fixture().agents.live);
  expect(
    union.sessions.filter((session) => session.run_id === runs().sibling),
  ).toHaveLength(fixture().agents.sibling);

  await page.goto(`/?project=${encodeURIComponent(observatory)}`);
  const label = group?.name ?? observatory;
  await expect(
    page.getByRole("list", { name: `Runs of ${label}` }),
  ).toBeVisible();
  const row = page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("button", { name: new RegExp(label) });
  await expect(row).toContainText(`${fixture().agents.observatory} agents`);
  const panel = page.getByRole("region", { name: `Agents of ${label}` });
  await expect(panel).toContainText(`${fixture().agents.observatory} agents`);
  await expect(
    panel.getByRole("button", { name: "Open transcript" }),
  ).toHaveCount(fixture().agents.observatory);
  // The sibling run's worker, opened from the project page under the run its
  // entry names.
  // The session's own item is the outermost one naming its node: the harness
  // runs are items inside it.
  const sibling = panel
    .getByRole("listitem")
    .filter({ hasText: `node ${fixture().agents.sibling_worker.node}` })
    .first();
  await sibling.getByRole("button", { name: "Open transcript" }).click();
  await expect(sibling).toContainText(fixture().agents.sibling_worker.text);
  const transcript = await served(
    page,
    `/api/v2/runs/${runs().sibling}/artifacts/${fixture().agents.sibling_worker.history_id}`,
    artifactContentSchema,
  );
  expect(transcript.content).toContain(fixture().agents.sibling_worker.text);
});
