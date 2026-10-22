import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  projectListSchema,
  runListSchema,
  TELEMETRY_SCHEMA_VERSION,
} from "@onepipeline-ui/dag-model";
import { expect, test } from "@playwright/test";
import { startFixtureServer } from "./fixture-server";

test("groups effective labels and copy origins, filters open kinds in the URL, and orders by activity", async ({
  page,
}) => {
  const server = await startFixtureServer("projects", [
    "--project-centric-corpus",
  ]);
  try {
    const listed = runListSchema.parse(
      await (
        await page.request.get(
          `${server.origin}/api/v2/runs?include_settled=true`,
        )
      ).json(),
    );
    const projects = projectListSchema.parse(
      await (await page.request.get(`${server.origin}/api/v2/projects`)).json(),
    );
    expect(
      listed.runs.find((run) => run.run_id === "project-before-labels")?.state,
    ).toBe("ended-stopped");
    expect(listed.telemetry_schema_version).toBe(TELEMETRY_SCHEMA_VERSION);
    const main = listed.runs.find((run) => run.run_id === "project-main");
    expect(main).toMatchObject({
      project: "local-md:board-copy",
      group: "local-md:project-centric",
      labels: { kind: "main" },
    });
    expect(
      listed.runs.find((run) => run.run_id === "project-before-labels"),
    ).toMatchObject({
      group: "local-md:overlay-project",
      labels: { kind: "spike-brief" },
    });
    expect(
      JSON.parse(
        readFileSync(
          join(server.workspace, "runs/project-before-labels/labels.json"),
          "utf8",
        ),
      ),
    ).toHaveProperty("labels.kind", "spike-brief");
    expect(
      projects.projects.find((group) => group.project === main?.group)?.runs,
    ).toHaveLength(6);
    await page.goto(server.origin);
    await expect(page).toHaveURL(/run=project-follow-ups/);
    const nav = page.getByRole("navigation", { name: "Projects" });
    await expect(
      nav.getByRole("button", { name: "Open project-centric", exact: true }),
    ).toBeVisible();
    for (const kind of [
      "main",
      "planning",
      "spikes",
      "finalize",
      "design",
      "follow-ups",
      "field-research",
      "spike-brief",
    ])
      await expect(
        nav.getByRole("checkbox", { name: kind, exact: true }),
      ).toBeChecked();
    const group = nav.getByRole("group", {
      name: "Project project-centric",
      exact: true,
    });
    await expect(group.getByRole("button")).toHaveCount(7);
    await group.getByText("project-centric", { exact: true }).click();
    await expect(
      group.getByRole("button", { name: "Open project-centric", exact: true }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      group.getByRole("button", { name: "Open project-centric", exact: true }),
    ).not.toBeVisible();
    await group.getByText("project-centric", { exact: true }).click();
    await expect(
      group.getByRole("button", { name: "Open project-centric", exact: true }),
    ).toBeVisible();
    await expect(
      group.getByRole("button", { name: /project-main main/ }),
    ).toBeVisible();
    const rows = await group.getByRole("button").allTextContents();
    expect(
      rows
        .slice(1)
        .map(
          (text) =>
            text.match(
              /^project-(follow-ups|design|finalize|main|spikes|planning)/,
            )?.[1],
        ),
    ).toEqual([
      "follow-ups",
      "design",
      "finalize",
      "main",
      "spikes",
      "planning",
    ]);
    await nav
      .getByRole("button", { name: "Open project-centric", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/run=project-follow-ups/);
    await page.getByText("Run details", { exact: true }).click();
    await expect(
      page.getByText(/Launching session: Claude session/),
    ).toBeVisible();
    await expect(nav.getByText(/session/)).toHaveCount(0);
    await expect(
      nav.getByRole("button", { name: /Shut down|^Runs$|^Projects$/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("tab", { name: "Reads", exact: true }),
    ).toHaveCount(0);
    for (const kind of ["planning", "spikes", "follow-ups"])
      await nav.getByRole("checkbox", { name: kind, exact: true }).uncheck();
    await expect(page).toHaveURL(/run=project-design/);
    await page.reload();
    const filteredLanding = new URL(page.url());
    filteredLanding.searchParams.delete("run");
    await page.goto(filteredLanding.href);
    await expect(page).toHaveURL(/run=project-design/);
    for (const kind of ["planning", "spikes", "follow-ups"]) {
      await expect(
        nav.getByRole("checkbox", { name: kind, exact: true }),
      ).not.toBeChecked();
      await expect(
        nav.getByRole("button", { name: new RegExp(`^project-${kind}`) }),
      ).toHaveCount(0);
    }
    const other = nav.getByRole("group", {
      name: "Project Other runs",
      exact: true,
    });
    await expect(other.getByText("Other runs", { exact: true })).toBeVisible();
    await expect(
      other.getByRole("button", { name: /project-ungrouped/ }),
    ).toBeVisible();
    await expect(
      other
        .getByRole("button", { name: /project-ungrouped/ })
        .getByText("main", { exact: true }),
    ).toHaveCount(0);
    await expect(
      nav.getByRole("button", { name: /project-before-labels spike-brief/ }),
    ).toBeVisible();
    for (const kind of ["main", "finalize", "design"])
      await nav.getByRole("checkbox", { name: kind, exact: true }).uncheck();
    await expect(
      group.getByRole("button", { name: "Open project-centric", exact: true }),
    ).toBeDisabled();
    await expect(group.getByRole("status")).toHaveText(
      "No runs of the shown kinds.",
    );
    await nav.getByRole("checkbox", { name: "design", exact: true }).check();
    await expect(
      group.getByRole("button", { name: "Open project-centric", exact: true }),
    ).toBeEnabled();
    const ordering = nav.getByRole("group", {
      name: "Project ordering",
      exact: true,
    });
    const expectedOrder = [
      "order-tied-active",
      "order-tied-a",
      "order-tied-b",
      "order-undated-active",
      "order-undated-old",
    ];
    for (const [index, id] of expectedOrder.entries())
      await expect(ordering.getByRole("button").nth(index + 1)).toContainText(
        id,
      );
    await ordering
      .getByRole("button", { name: "Open ordering", exact: true })
      .click();
    await expect(page).toHaveURL(/run=order-tied-active/);
    await nav
      .getByRole("button", { name: "Open project-centric", exact: true })
      .click();
    const oldRun = join(server.workspace, "runs/project-planning/events.jsonl");
    appendFileSync(
      oldRun,
      `${JSON.stringify({ v: 1, ts: new Date().toISOString(), stream: "late-old-run", seq: 0, source: "pipeline", kind: "completion-requested", labels: { run_id: "project-planning" }, payload: {} })}\n`,
    );
    await page.reload();
    await expect(
      nav.getByRole("group", { name: "Project project-centric", exact: true }),
    ).toBeVisible();
    await nav.getByRole("checkbox", { name: "planning", exact: true }).check();
    await nav
      .getByRole("button", { name: "Open project-centric", exact: true })
      .click();
    await expect(page).toHaveURL(/run=project-design/);
    const path = join(server.workspace, "runs/project-unfamiliar/events.jsonl");
    appendFileSync(
      path,
      `${JSON.stringify({ v: 1, ts: new Date().toISOString(), stream: "project-activity", seq: 0, source: "pipeline", kind: "run-started", labels: { run_id: "project-unfamiliar" }, payload: {} })}\n`,
    );
    await expect(
      nav.getByRole("group", { name: /^Project / }).first(),
    ).toHaveAccessibleName("Project another-project");
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Projects unavailable" }),
    ).toBeVisible();
    await page.context().setOffline(false);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Projects unavailable" }),
    ).toHaveCount(0);
    await expect(
      nav.getByRole("button", { name: "Open project-centric", exact: true }),
    ).toBeVisible();
  } finally {
    await server.stop();
  }
});
