import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { runs } from "./fixture-facts";

/**
 * The first screen draws only an answer it has checked, read the way a person opening
 * a run's address meets it: the served page, the real read API's answer to its
 * `POST /api/v2/subscriptions`, altered in flight one field at a time.
 *
 * Every field the first screen draws, as `apps/dag-ui/src/first-screen/fields.json`
 * lists them (the list that app's unit test holds its check to), in the answers Graph,
 * a node and Overall receive, is taken out where the contract requires it and, in a
 * second pass, given a value of the wrong type. Each time the page must say
 * the answer failed its contract, naming that field, and must never have drawn a first
 * screen from it; the answer as served draws each view's first screen. One server and
 * one settled run serve every pass.
 */

declare global {
  interface Window {
    /** Set once a first screen is drawn from an answer, by the observer below. */
    __firstScreenDrawn?: boolean;
  }
}

/**
 * A first screen drawn from an answer, by the roles and names a person's assistive
 * technology reads it by: Graph's canvas, Overall's metrics and a node's timeline. The
 * screen that stands while the answer is out names none of them.
 */
// llmlint: ignore-block[e2e_uses_accessible_selectors] whether a first screen was ever drawn, even for a frame before the app replaced it, is visible only to an observer inside the page, which Playwright's locators are not; that observer selects by exactly the ARIA role and accessible names `getByRole` would, written as the attribute selectors `querySelector` takes.
const DRAWN =
  '[role="group"][aria-label="DAG execution graph"], section[aria-label="Run metrics"], section[aria-label="Node timeline"]';
// llmlint: ignore-end[e2e_uses_accessible_selectors]

type Json = Record<string | number, unknown>;
type Path = readonly (string | number)[];

/** The fields the first screen draws, each a pattern and whether it may be left out. */
const FIELDS = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../dag-ui/src/first-screen/fields.json"),
      "utf8",
    ),
  ) as { fields: string[] }
).fields.map((listed) => ({
  steps: listed
    .replace(/\?$/u, "")
    .replace(/\[0\]/gu, ".0")
    .split(".")
    .slice(1),
  required: !listed.endsWith("?"),
}));

/** How the page names the field at `path`: `answer`, then its keys and indices. */
const namedPath = (path: Path): string =>
  path.reduce<string>(
    (named, step) =>
      typeof step === "number" ? `${named}[${step}]` : `${named}.${step}`,
    "answer",
  );

/**
 * The fields of `answer` the list names, each where it is in this answer: `0` the
 * first item of a list and `*` the first entry of a record. A field this answer does
 * not hold is not drawn from it and is left out.
 */
function fieldsOf(answer: unknown): { path: Path; required: boolean }[] {
  const found: { path: Path; required: boolean }[] = [];
  for (const { steps, required } of FIELDS) {
    let at: unknown = answer;
    const path: (string | number)[] = [];
    let held = true;
    for (const step of steps) {
      if (typeof at !== "object" || at === null) {
        held = false;
        break;
      }
      const key =
        step === "*"
          ? Object.keys(at)[0]
          : step === "0" && Array.isArray(at)
            ? 0
            : step;
      if (key === undefined || !(key in at)) {
        held = false;
        break;
      }
      path.push(key);
      at = (at as Json)[key];
    }
    if (held) found.push({ path, required });
  }
  return found;
}

/** A value of another type than `value`'s, which no field the list names may hold. */
const wrongFor = (value: unknown): unknown =>
  typeof value === "string"
    ? 42
    : typeof value === "number"
      ? "many"
      : typeof value === "boolean"
        ? "yes"
        : value === null
          ? { wrong: true }
          : "an object";

/** `answer` with the value at `path` replaced, or removed where `value` is `undefined`. */
function altered(answer: unknown, path: Path, value: unknown): unknown {
  const copy = structuredClone(answer) as Json;
  let at: Json = copy;
  for (const step of path.slice(0, -1)) {
    const next = at[step];
    if (typeof next !== "object" || next === null)
      throw new Error(`the answer has no ${namedPath(path)}`);
    at = next as Json;
  }
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

/** The page, with each first answer passed through whatever `alter` holds then. */
async function opened(page: Page) {
  const held: {
    alter?: (answer: unknown) => unknown;
    received?: unknown;
  } = {};
  await page.addInitScript((selector: string) => {
    window.__firstScreenDrawn = false;
    new MutationObserver(() => {
      if (document.querySelector(selector) !== null)
        window.__firstScreenDrawn = true;
    }).observe(document, { childList: true, subtree: true });
  }, DRAWN);
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the acceptance criteria require the served first answer altered in flight, one field missing or of the wrong type at a time, to show the page refusing each; the real server's answer is fetched and only that one field is changed, and with nothing to alter the answer passes through untouched, as `read-latency/first-screen-marks.spec.ts` feeds its answers.
  await page.route("**/api/v2/subscriptions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const answer: unknown = await response.json();
    // Only a page's first answer: the app subscribes again as a person moves.
    const alter = held.alter;
    held.alter = undefined;
    held.received ??= answer;
    await route.fulfill({
      response,
      json: alter === undefined ? answer : alter(answer),
    });
  });
  // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
  return held;
}

test("an answer missing or mistyping any field the first screen draws shows its contract failure, and no first screen", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const held = await opened(page);
  const run = runs().history;
  const addresses: Record<string, string> = {
    graph: `/?run=${run}&view=graph`,
    overall: `/?run=${run}&view=overall`,
  };
  const answers: Record<string, unknown> = {};

  // As served, each view's first screen is drawn from its answer.
  const draws = async (view: string) => {
    held.received = undefined;
    await page.goto(addresses[view] as string);
    await expect
      .poll(() => page.evaluate(() => window.__firstScreenDrawn))
      .toBe(true);
    answers[view] = held.received;
  };
  await draws("graph");
  const tasks = (
    answers.graph as {
      initial: {
        snapshot: {
          visible: { detail: { graph: { plan: { tasks: { id: string }[] } } } };
        };
      };
    }
  ).initial.snapshot.visible.detail.graph.plan.tasks;
  const node = tasks[0]?.id;
  expect(node, "the run has a node to open").toBeDefined();
  addresses.node = `/?run=${run}&view=graph&node=${encodeURIComponent(node as string)}`;
  await draws("node");
  await draws("overall");

  // Each field once, from the first view whose answer holds it.
  const seen = new Set<string>();
  const passes: {
    view: string;
    name: string;
    path: Path;
    value: unknown;
    pass: string;
  }[] = [];
  for (const view of ["graph", "node", "overall"]) {
    for (const field of fieldsOf(answers[view])) {
      const name = namedPath(field.path);
      if (seen.has(name)) continue;
      seen.add(name);
      let current: unknown = answers[view];
      for (const step of field.path) current = (current as Json)[step];
      if (field.required)
        passes.push({
          view,
          name,
          path: field.path,
          value: undefined,
          pass: "missing",
        });
      passes.push({
        view,
        name,
        path: field.path,
        value: wrongFor(current),
        pass: "of the wrong type",
      });
    }
  }
  // The node's rows and Overall's spans are among what is altered.
  expect(seen).toContain(
    "answer.initial.snapshot.visible.timeline.spans[0].events[0].at",
  );
  expect(seen).toContain("answer.initial.snapshot.visible.detail.run.state");

  const alert = page
    .getByRole("alert")
    .filter({ hasText: "This run's history did not load" });
  for (const { view, name, path, value, pass } of passes) {
    held.alter = (answer) => altered(answer, path, value);
    await page.goto(addresses[view] as string);
    await expect(
      alert,
      `${view}'s answer with ${name} ${pass} shows the contract failure`,
    ).toContainText(`The first answer failed contract validation: ${name} `);
    expect(
      await page.evaluate(() => window.__firstScreenDrawn),
      `no first screen is drawn from ${view}'s answer with ${name} ${pass}`,
    ).toBe(false);
  }
});
