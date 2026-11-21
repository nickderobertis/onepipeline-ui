import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { FIXTURE_WORKSPACE } from "./playwright.config";

/**
 * Expiry on Action items: what an open item will expire on, an item the engine
 * retired leaving an open page with no reload, why it expired under State
 * Expired, a check that is failing, and the expired card's own look.
 *
 * Every world is the engine's own (`human-items-world.mjs`): items are raised by
 * the provisioned CLI, checks are real scripts the engine runs, runs are settled
 * by its own driver, and the page reads the real server over the one journal.
 * A wait's time limit here only guards against a hang: a time condition a few
 * seconds out and a check's timeout are the conditions under test, never bounds
 * telling two outcomes apart.
 */

const factsSchema = z.object({
  ids: z.record(z.string(), z.string()),
  runs: z.record(z.string(), z.string()),
  workspace: z.string(),
  engine: z.string(),
  cwd: z.string(),
  journal: z.string(),
  environment: z.record(z.string(), z.string()),
  removed: z.array(z.string()),
});
type Facts = z.infer<typeof factsSchema>;

/** A line of the human-item journal, as far as these journeys read it. */
const journalRecordSchema = z.looseObject({
  payload: z.looseObject({ action: z.string(), item_id: z.string() }),
});

/** A line of a run's journal, as far as these journeys read it. */
const runRecordSchema = z.looseObject({
  kind: z.string(),
  payload: z.looseObject({
    pid: z.number().optional(),
    settlement: z.string().optional(),
  }),
});

const servedItemSchema = z.object({
  item: z.looseObject({
    state: z.string(),
    expiry: z.array(z.unknown()).optional(),
  }),
});

/** Where this run keeps each world it built, removed with the run's fixtures. */
const WORLD_TEMPLATES = join(FIXTURE_WORKSPACE, "human-items-worlds");

/** How long a wait for the page or the store may take before it is a hang. */
const HANG = 90_000;

/** The session every item here is raised as. */
const OWNER = "claude-code-supervising-session";

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test.use({ viewport: { width: 1440, height: 900 } });

async function serveWorld(name: string): Promise<Facts> {
  server = await startFixtureServer(
    `human-items-${name}`,
    ["--human-items-world", name],
    { DAG_UI_E2E_WORLD_TEMPLATES: WORLD_TEMPLATES },
    { samePath: true },
  );
  return factsSchema.parse(server.facts);
}

function origin(): string {
  if (server === undefined) throw new Error("no world is served");
  return server.origin;
}

/** The world's environment, as its own processes run in it. */
function worldEnv(facts: Facts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of facts.removed) delete env[name];
  Object.assign(env, facts.environment);
  env.ONEPIPELINE_LAUNCHER_SESSION = OWNER;
  return env;
}

/** Raise `input` through the provisioned CLI before the page is opened; its id. */
function raise(facts: Facts, input: Record<string, unknown>): string {
  const path = join(facts.workspace, `raise-${String(input.dedup_key)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 1,
      approval: null,
      priority: "high",
      owner: { session: OWNER, run: null, plan: null },
      block: { scope: "nothing" },
      ...input,
    }),
  );
  const printed = execFileSync(
    facts.engine,
    ["human-items", "raise", "--input", path],
    { cwd: facts.cwd, env: worldEnv(facts), encoding: "utf8" },
  );
  return z
    .object({ item: z.object({ item: z.object({ id: z.string() }) }) })
    .parse(JSON.parse(printed)).item.item.id;
}

/** The ids the human-item journal holds a `human-item-expired` event for, read from the file itself. */
function expiredInJournal(facts: Facts): Set<string> {
  const path = join(facts.journal, "events.ndjson");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return new Set(
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => journalRecordSchema.parse(JSON.parse(line)).payload)
      .filter(({ action }) => action === "human-item-expired")
      .map(({ item_id: id }) => id),
  );
}

function listRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Action item list" });
}

function card(page: Page, title: string): Locator {
  return listRegion(page).getByRole("article", { name: title });
}

function detailPane(page: Page): Locator {
  return page.getByRole("complementary", { name: "Action item detail" });
}

function stateFilter(page: Page): Locator {
  return page
    .getByRole("group", { name: "Filter action items" })
    .getByLabel("State", { exact: true });
}

/** Open the page, counting every load of it: a journey here never reloads. */
async function openPage(page: Page): Promise<() => number> {
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  await page.goto(`${origin()}/human-items`);
  await expect(listRegion(page)).toBeVisible();
  return () => loads;
}

/** How many times a card's text says it expired: once, in its badge. */
async function expiredWords(located: Locator): Promise<number> {
  return ((await located.innerText()).match(/expired/giu) ?? []).length;
}

/** A stamp as the page's cards print one of today's: its local clock time. */
function clockOf(at: string): string {
  const parsed = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
}

/** Expect `card` to be under State Expired, saying so once, with `reason` and `held`. */
async function expectExpired(
  page: Page,
  title: string,
  reason: string | RegExp,
  held: string,
): Promise<void> {
  const shown = card(page, title);
  await expect(shown).toBeVisible();
  await expect(shown.getByText(reason)).toBeVisible();
  await expect(shown).toContainText(held);
  expect(await expiredWords(shown)).toBe(1);
  await expect(
    shown.getByRole("button", { name: `Reopen: ${title}` }),
  ).toBeVisible();
  for (const control of ["Complete", "Dismiss"])
    await expect(
      shown.getByRole("button", { name: `${control}: ${title}` }),
    ).toHaveCount(0);
}

test("an item that expires at a time a few seconds out says when, leaves the open page on its own, and says why under State Expired", async ({
  page,
}) => {
  const facts = await serveWorld("expiry");
  const at = new Date(Date.now() + 6_000).toISOString();
  const title = "Approve the hotfix before the release window closes";
  const id = raise(facts, {
    dedup_key: "hotfix-window",
    kind: "task",
    title,
    body: "The hotfix is green; approve it while the window is open.",
    expiry: [{ when: "time", at }],
  });
  const loads = await openPage(page);
  await expect(card(page, title)).toContainText(`Expires at ${clockOf(at)}`);

  // Nothing but the page's own server reads or writes the store from here.
  await expect(card(page, title)).toHaveCount(0, { timeout: HANG });
  expect(expiredInJournal(facts).has(id)).toBe(true);
  expect(loads()).toBe(1);

  await stateFilter(page).selectOption("expired");
  await expectExpired(
    page,
    title,
    /^Its expiry time .* was reached/u,
    `At ${clockOf(at)}`,
  );
});

/**
 * The run's driver: `adopt --attach` and the driver it hands the run to, run to
 * the run's end. Answers once that driver has said it exited with the run
 * complete, and every driver the run was handed to has gone.
 */
async function driveToTheEnd(
  facts: Facts,
  run: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const adopting = spawn(facts.engine, ["adopt", run, "--attach"], {
    cwd: facts.cwd,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    adopting.once("error", reject);
    adopting.once("exit", () => resolve());
  });
  const records = () =>
    readFileSync(join(facts.workspace, "runs", run, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => runRecordSchema.parse(JSON.parse(line)));
  await expect
    .poll(
      () =>
        records().some(
          ({ kind, payload }) =>
            kind === "driver-exited" && payload.settlement === "complete",
        ),
      { timeout: HANG },
    )
    .toBe(true);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const drivers = records()
    .filter(({ kind }) => kind === "driver-adopted")
    .flatMap(({ payload }) => (payload.pid === undefined ? [] : [payload.pid]));
  await expect.poll(() => drivers.filter(alive), { timeout: HANG }).toEqual([]);
}

/** Three items whose conditions name the run `run` and its one node. */
function raiseOnRun(facts: Facts, run: string) {
  return [
    {
      title: "Check the migrated rows once the migration step settles",
      condition: { when: "node", run, node: "migrate" },
      expires: `Expires when step migrate of run ${run} settles`,
      reason: new RegExp(`^Node migrate of run ${run} settled done`, "u"),
      held: `Step migrate of run ${run} settled`,
    },
    {
      title: "Watch the retire run until every step of it is done",
      condition: { when: "run", run, on: "settled" },
      expires: `Expires when run ${run} settles`,
      reason: new RegExp(`^Run ${run} settled`, "u"),
      held: `Run ${run} settled`,
    },
    {
      title: "Keep the staging database frozen while the retire run lasts",
      condition: { when: "run", run, on: "ended" },
      expires: `Expires when run ${run} ends`,
      reason: new RegExp(`^Run ${run} `, "u"),
      held: `Run ${run} ended`,
    },
  ].map((raised, index) => ({
    ...raised,
    id: raise(facts, {
      dedup_key: `on-run-${index}`,
      kind: "task",
      title: raised.title,
      body: "Nothing to do once the run has moved on.",
      expiry: [raised.condition],
    }),
  }));
}

/**
 * A step settled and its run ended by the engine's own driver, while the page is
 * open: the run's and the node's items leave the open page with no reload.
 *
 * `isolated` drives the run under a configuration whose human items are off, so
 * the driver settles the node and ends the run without sweeping expiry — a
 * setting a host may hold — and every process that could sweep has exited before
 * the page's server does: what retires the items is the page's own server and
 * nothing else. Without it, the driver runs under the world's own configuration
 * and sweeps them itself as it settles the node, as a host's driver does, and the
 * journey holds only what the page shows.
 */
for (const { name, isolated } of [
  { name: "with only the page's server left to sweep them", isolated: true },
  {
    name: "under the driver that sweeps them as it settles",
    isolated: false,
  },
])
  test(`items expiring on a run's node, its settling and its end leave the open page once the driver ends the run, ${name}`, async ({
    page,
  }) => {
    const facts = await serveWorld("expiry");
    const run = facts.runs.retire;
    if (run === undefined) throw new Error("the world launched no run");
    const items = raiseOnRun(facts, run);
    const loads = await openPage(page);
    for (const { title, expires } of items)
      await expect(card(page, title)).toContainText(expires);

    // The step is completed on the page, before any condition holds.
    const step = "Run the schema migration";
    await card(page, step)
      .getByRole("button", { name: `Complete: ${step}` })
      .click();
    await expect(card(page, step)).toHaveCount(0);

    const env = worldEnv(facts);
    if (isolated) {
      const config = join(facts.workspace, "driver-config", "onepipeline");
      mkdirSync(config, { recursive: true });
      writeFileSync(
        join(config, "config.yaml"),
        "human_items:\n  enabled: false\n",
      );
      env.XDG_CONFIG_HOME = join(facts.workspace, "driver-config");
    }
    await driveToTheEnd(facts, run, env);
    if (isolated) {
      const swept = expiredInJournal(facts);
      for (const { id } of items) expect(swept.has(id)).toBe(false);
    }

    for (const { title } of items)
      await expect(card(page, title)).toHaveCount(0, { timeout: HANG });
    expect(loads()).toBe(1);
    if (isolated) {
      const swept = expiredInJournal(facts);
      for (const { id } of items) expect(swept.has(id)).toBe(true);
    }

    await stateFilter(page).selectOption("expired");
    for (const { title, reason, held } of items)
      await expectExpired(page, title, reason, held);
  });

/** A check script the engine runs as `node <script>`, from the world's workspace. */
function check(
  facts: Facts,
  name: string,
  source: string,
  more: Record<string, unknown> = {},
) {
  const dir = join(facts.workspace, "checks");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, source);
  return {
    when: "check",
    command: [process.execPath, script],
    cwd: facts.workspace,
    interval_seconds: 10,
    ...more,
  };
}

/** The failing check's error: several lines, as `df` prints its complaint. */
const DISK_ERROR = [
  "df: /mnt/capture: No such file or directory",
  "disk-free: could not read the capture volume",
  "disk-free: No space left on device",
].join("\n");

test("a failing check shows on its card in one line and whole in its detail, what fails is never read as not yet, and once it holds the item expires and reopens", async ({
  page,
}) => {
  const facts = await serveWorld("expiry");
  const mode = join(facts.workspace, "disk-mode");
  writeFileSync(mode, "fail");
  const disk = {
    title: "Free space on /mnt/capture before the nightly capture writes to it",
    condition: check(
      facts,
      "disk-free",
      `import { readFileSync } from "node:fs";
if (readFileSync(${JSON.stringify(mode)}, "utf8") === "holds") {
  process.stdout.write(JSON.stringify({ expired: true, reason: "the disk has space again" }));
} else {
  process.stderr.write(${JSON.stringify(`${DISK_ERROR}\n`)});
  process.exit(2);
}
`,
    ),
  };
  const failing = [
    {
      title: "Restart the mirror once its health check passes",
      source: "setTimeout(() => {}, 30_000);\n",
      more: { timeout_seconds: 1 },
      detail: "the check timed out after 1 s",
    },
    {
      title: "Re-run the nightly import that stopped",
      source: "process.exit(1);\n",
      more: {},
      detail: "the check exited with status 1",
    },
    {
      title: "Answer the vendor's renewal email",
      source: "process.exit(0);\n",
      more: {},
      detail: 'its output was not one JSON object with a boolean "expired"',
    },
    {
      title: "Confirm the backup bucket's retention",
      source: 'process.stdout.write("expired: yes\\n");\n',
      more: {},
      detail: 'its output was not one JSON object with a boolean "expired"',
    },
  ].map((item, index) => ({
    ...item,
    id: raise(facts, {
      dedup_key: `failing-${index}`,
      kind: "task",
      title: item.title,
      body: "Waiting on a check that cannot answer.",
      expiry: [check(facts, `failing-${index}`, item.source, item.more)],
    }),
  }));
  const pending = {
    title: "Rebalance the shards once the new node joins",
    id: "",
  };
  pending.id = raise(facts, {
    dedup_key: "not-yet",
    kind: "task",
    title: pending.title,
    body: "The new node has not joined yet.",
    expiry: [
      check(
        facts,
        "not-yet",
        "process.stdout.write(JSON.stringify({ expired: false }));\n",
      ),
    ],
  });
  const diskId = raise(facts, {
    dedup_key: "capture-disk",
    kind: "task",
    title: disk.title,
    body: "The capture volume is at 97%.",
    expiry: [disk.condition],
  });

  const loads = await openPage(page);
  const diskCard = card(page, disk.title);
  await expect(diskCard).toContainText(
    `Expires when its check ${process.execPath} `,
  );
  await expect(diskCard).toContainText("checked every 10 seconds");
  const failure = diskCard.getByText(
    /^Check failed: the check exited with status 2/u,
  );
  await expect(failure).toBeVisible({ timeout: HANG });
  // One line on the card, however many the error has.
  const { height, line } = await failure.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    line: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(height).toBeLessThan(line * 1.5);
  await diskCard
    .getByRole("button", { name: `Details: ${disk.title}` })
    .click();
  const expiry = detailPane(page).getByRole("region", { name: "Expiry" });
  for (const said of DISK_ERROR.split("\n"))
    await expect(expiry).toContainText(said);
  await expect(expiry).toContainText(
    "Last check failed: the check exited with status 2",
  );
  await detailPane(page).getByRole("button", { name: "Close detail" }).click();

  for (const { title, detail } of failing) {
    const shown = card(page, title);
    await expect(shown.getByText(`Check failed: ${detail}`)).toBeVisible({
      timeout: HANG,
    });
    await expect(shown).not.toContainText("not yet");
    await shown.getByRole("button", { name: `Details: ${title}` }).click();
    const pane = detailPane(page);
    await expect(pane.getByRole("region", { name: "Expiry" })).toContainText(
      `Last check failed: ${detail}`,
    );
    await expect(pane).not.toContainText("not yet");
    await pane.getByRole("button", { name: "Close detail" }).click();
  }

  const quiet = card(page, pending.title);
  await quiet
    .getByRole("button", { name: `Details: ${pending.title}` })
    .click();
  await expect(
    detailPane(page).getByRole("region", { name: "Expiry" }),
  ).toContainText("Last check not yet", { timeout: HANG });
  await expect(detailPane(page)).not.toContainText(/failed|expired/iu);
  await expect(quiet).not.toContainText(/failed|expired/iu);
  await detailPane(page).getByRole("button", { name: "Close detail" }).click();

  // Nothing but the page's own server reads or writes the store from here.
  writeFileSync(mode, "holds");
  await expect(diskCard).toHaveCount(0, { timeout: HANG });
  expect(loads()).toBe(1);
  for (const { title } of [...failing, pending])
    await expect(card(page, title)).toBeVisible();

  await stateFilter(page).selectOption("expired");
  const listed = listRegion(page).getByRole("article");
  await expect(listed).toHaveCount(1);
  await expectExpired(
    page,
    disk.title,
    /^The disk has space again/u,
    `Its check ${process.execPath} `,
  );

  // Reopened from its card, it returns to the open view with no expiry left.
  await card(page, disk.title)
    .getByRole("button", { name: `Reopen: ${disk.title}` })
    .click();
  await expect(card(page, disk.title)).toHaveCount(0);
  await stateFilter(page).selectOption("open");
  await expect(card(page, disk.title)).toBeVisible();
  await expect(card(page, disk.title)).not.toContainText("Expires");
  expect(loads()).toBe(1);
  const served = servedItemSchema.parse(
    await (
      await page.request.get(`${origin()}/api/human-items/${diskId}`)
    ).json(),
  );
  expect(served.item.state).toBe("open");
  expect(served.item.expiry ?? []).toEqual([]);
});

/**
 * The computed colours and opacities a card's look is made of. Its surface is
 * the card's own child holding its heading, reached from the card and that
 * heading rather than from a class the design system names.
 */
async function looks(article: Locator) {
  const handle = await article.elementHandle();
  if (handle === null) throw new Error("the card is not on the page");
  return article.getByRole("heading").evaluate((title, card) => {
    let surface: Element | null = title;
    while (surface !== null && surface.parentElement !== card)
      surface = surface.parentElement;
    if (surface === null) throw new Error("no card surface holds the title");
    const of = (node: Element) => getComputedStyle(node);
    return {
      surface: of(surface).backgroundColor,
      edge: of(surface).boxShadow,
      titleColor: of(title).color,
      titleOpacity: of(title).opacity,
    };
  }, handle);
}

/**
 * The contrast against the card's own surface of the text `located` holds, from
 * the colours the browser rendered: its colour, faded by its own opacity and
 * every ancestor's up to the card, over the card's opaque background. The
 * surface is the card's child holding that text, as `looks` finds it.
 */
async function contrastOn(article: Locator, located: Locator): Promise<number> {
  const handle = await article.elementHandle();
  if (handle === null) throw new Error("the card is not on the page");
  return located.evaluate((element, card) => {
    let surface: Element | null = element;
    while (surface !== null && surface.parentElement !== card)
      surface = surface.parentElement;
    if (surface === null) throw new Error("no card surface holds the text");
    const channels = (color: string) => {
      const parts = color.match(/[\d.]+/gu)?.map(Number) ?? [];
      return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 };
    };
    const background = channels(getComputedStyle(surface).backgroundColor);
    if (background.alpha !== 1)
      throw new Error("the card's surface is not opaque");
    let fade = 1;
    for (
      let node: Element | null = element;
      node !== null && node !== surface;
      node = node.parentElement
    )
      fade *= Number(getComputedStyle(node).opacity);
    const text = channels(getComputedStyle(element).color);
    const alpha = text.alpha * fade;
    const shown = text.rgb.map(
      (value, index) =>
        value * alpha + (background.rgb[index] ?? 0) * (1 - alpha),
    );
    const luminance = (rgb: number[]) => {
      const [r = 0, g = 0, b = 0] = rgb.map((value) => {
        const unit = value / 255;
        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light, dark] = [luminance(shown), luminance(background.rgb)].sort(
      (a, b) => b - a,
    );
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
  }, handle);
}

test("the page opens on open items alone, State Expired lists the expired one in a look of its own, and its text reads at AA in both palettes", async ({
  page,
}) => {
  await serveWorld("expiry-states");
  const openTitle = "Rotate the release signing key";
  const expiredTitle =
    "Free space on /mnt/capture before the nightly capture writes to it";
  await openPage(page);
  await expect(stateFilter(page)).toHaveValue("open");
  await expect(card(page, openTitle)).toBeVisible();
  await expect(card(page, expiredTitle)).toHaveCount(0);
  const open = await looks(card(page, openTitle));

  await stateFilter(page).selectOption("expired");
  const expired = card(page, expiredTitle);
  await expect(expired).toBeVisible();
  await expect(card(page, openTitle)).toHaveCount(0);
  const retired = await looks(expired);
  expect(retired.surface !== open.surface || retired.edge !== open.edge).toBe(
    true,
  );
  expect(
    retired.titleColor !== open.titleColor ||
      retired.titleOpacity !== open.titleOpacity,
  ).toBe(true);

  const texts = {
    title: expired.getByRole("heading", { name: expiredTitle }),
    reason: expired.getByText(/^The disk has space again/u),
    label: expired.getByText("Expired", { exact: true }),
  };
  for (const palette of ["dark", "light"]) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      palette === "dark",
    );
    for (const [name, located] of Object.entries(texts))
      expect(
        await contrastOn(expired, located),
        `${name} in the ${palette} palette`,
      ).toBeGreaterThanOrEqual(4.5);
  }
});
