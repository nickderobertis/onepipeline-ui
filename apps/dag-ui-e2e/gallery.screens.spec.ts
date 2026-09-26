import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CAPTURE_INSTANT_MS } from "./capture-clock";
import { fixture, runs } from "./fixture-facts";
import { graphNodes, metrics, timelineLane } from "./observatory-locators";
import { VIEWPORTS, type Viewport } from "./viewports";

/**
 * Every major surface of the DAG Observatory, captured at every viewport in the
 * matrix, against the same fixture server and Vite stack the browser e2e drives.
 *
 * This tier asserts almost nothing on purpose: it is the operator's eyes, and it is
 * where the pictures in `README.md` come from. Polish problems — a column that crowds
 * its neighbour, a panel clipped at one width, a control that has nowhere to go — are
 * invisible to an assertion that was never written for them, and until now the only
 * way to see one was to start the app by hand at each size. The waits below are what
 * make a capture worth looking at: each surface is photographed once its real reads
 * have landed, never mid-skeleton.
 *
 * `screenshots.config.ts` selects this file and nothing else, and pins the clock and
 * the renderer that would otherwise put the host in the pixels; `just dag-ui-screens`
 * is how it runs, inside the browser container both it and CI are pinned to.
 * `apps/dag-ui-e2e/AGENTS.md` is the durable note.
 */

/**
 * Where this run writes its capture, as the capture step named it.
 *
 * `SHOTS_OUT` is screencomp's own name for this directory — the reusable workflow
 * exports it per arch lane as `shots/current/<arch>` and the pre-push guard sets it to
 * the same path — so the one variable this tier reads is the one the gate reads,
 * rather than a second name something has to translate. This tier refuses to run
 * without one rather than inventing a second place a capture can land.
 *
 * A relative value is resolved against the repository root rather than the working
 * directory, because that is what the workflow exports and because resolving it
 * against wherever the process happened to start is how images end up scattered.
 */
const captureDirectory = (): string => {
  const named = process.env.SHOTS_OUT;
  if (named === undefined || named === "") {
    throw new Error(
      "SHOTS_OUT must name the directory this capture is written to; run this tier through 'just dag-ui-screens', which makes one per invocation",
    );
  }
  const directory = resolve(import.meta.dirname, "../..", named);
  mkdirSync(directory, { recursive: true });
  return directory;
};

const gallery = captureDirectory();

/**
 * The toggle dimension this capture varies over, declared as `[[toggle]]` in
 * `screencomp.toml`.
 *
 * One key and no other: this app is dark-only — the document element carries
 * `class="dark"` and there is no light variant and no switch anywhere in `src/` — so
 * a theme dimension would mean building a feature rather than documenting one.
 */
const VIEWPORT_TOGGLE = "viewport";

/**
 * Park the pointer where it hovers nothing, before anything is measured.
 *
 * Reaching a surface means clicking things, and a click leaves the pointer where it
 * landed. That is not a neutral fact about this app: the timeline plots draw a cursor
 * line that follows the pointer, positioned as a percentage across the plot, so two
 * captures of one build differed by a single column of pixels because one of them had
 * left the pointer over a plot and the other just outside one. Moving it to the corner
 * of the viewport makes that state the same every time — and the corner is the brand
 * mark, which has nothing to hover.
 */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
}

/**
 * Collapse every animation and transition to its resting state before the shot.
 *
 * Playwright's `animations: "disabled"` is not enough on its own here, and the way it
 * falls short is the interesting part. This app pulses its running indicators on an
 * infinite opacity animation, and two captures of one build caught the same indicator
 * at two different phases — a single column of pixels a hash gate refuses and an eye
 * cannot see. The obvious repair, injecting `animation: none`, is worse: it pins each
 * animation at whatever phase it had reached, which is exactly the value that was
 * varying. A zero duration instead runs each one to its end instantly, so every
 * animated element rests at its own base style on every run.
 *
 * Transitions are cut outright, which lands them on the value they were travelling
 * towards rather than anywhere between — the same destination `animations: "disabled"`
 * fast-forwards a finite transition to, applied to the ones set from JavaScript that
 * it does not see.
 *
 * Smooth scrolling is the third thing that moves, and it is neither an animation nor a
 * transition, so nothing above reaches it. The shared timeline hook brings a selected
 * row into view with `scrollIntoView({ behavior: "smooth" })` and derives its cursor
 * line from whichever row sits at the reading line when that scroll lands — which is
 * how two captures of one build put that one-pixel line at two different places. Made
 * instant here, so the landing is the same on every run.
 */
async function settleMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }`,
  });
  // Then the authoritative pass, over what the page says is still moving rather than
  // over what a stylesheet can reach: `getAnimations` reports every running animation
  // and transition however it was declared, including ones a rule keyed on a selector
  // would miss. An endless one is rewound to its first frame and held there; anything
  // with an end is sent to it. Asserted empty afterwards, because a capture that
  // photographed something still in motion is the one failure this tier cannot see.
  const moving = await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (
        animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY
      ) {
        animation.currentTime = 0;
        animation.pause();
      } else {
        animation.finish();
      }
    }
    return document
      .getAnimations()
      .filter((animation) => animation.playState === "running").length;
  });
  expect(moving, "every animation is settled before the shot").toBe(0);
}

/**
 * What one shot is called on disk, and the name and toggle screencomp reads it under.
 *
 * The file keeps the name it has always had, so the table in `docs/dag-ui.md` still
 * says how to find a capture in the directory. The index below splits the same two
 * halves back apart — the surface is the screen, the viewport is the toggle — which
 * is what makes the gallery one card per screen you toggle through its five widths
 * rather than seventy unrelated cards.
 */
const fileName = (surface: Surface, size: Viewport): string =>
  `${surface.name}-${size.name}.png`;

/**
 * The clock the browser believes it is, pinned before the page is opened.
 *
 * This is the largest single source of drift between two captures of one build: a
 * relative reading is computed against `Date.now()` and a column's clock time against
 * whether that stamp is today, so an unfrozen browser re-renders half the text in this
 * app every second. `setFixedTime` pins `Date` without faking timers, which is the
 * distinction that matters here — the view polls and re-reads on a real interval, and a
 * faked timer would simply stop it, photographing a first paint rather than a loaded
 * view. It is the same instant `fixtures/runs.mjs` stamps the corpus from, so what the
 * page computes about a run and what the run says about itself agree.
 */
async function freezeClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
}

/**
 * How many consecutive readings of an unchanged page count as "this view has stopped
 * arriving", and how far apart they are taken.
 *
 * A second of quiet, sampled four times. The server this tier drives re-reads its runs
 * root every 125 ms and pushes a fresh snapshot down the event stream, and the view
 * fetches a node's timeline, its transcript and each conversation separately — so a
 * surface whose `open` has asserted its first article is visible can still be one read
 * away from its last. That matters beyond tidiness: the transcript follows its own
 * bottom while the reader is at it, so a list that grows by one row after the wait and
 * before the shot moves the whole panel. Four samples rather than a fixed sleep,
 * because the quantity that has to hold still is the page rather than the clock.
 */
const SETTLED_SAMPLES = 4;
const SETTLE_POLL_MS = 250;

/**
 * Wait until nothing about the rendered page is still changing.
 *
 * The print compared across samples is the body's markup together with every
 * element's scroll offsets, which is exactly the pair that moves here: a read that
 * lands late changes the markup, and a list that follows its own bottom changes an
 * offset without changing a byte of markup. Counted in samples rather than measured
 * against a clock, because this tier pins `Date` to a fixed instant and a wait written
 * against a frozen clock never ends.
 *
 * It runs *after* the motion above is pinned rather than before, which is the ordering
 * that matters: cutting transitions and scroll smoothing lands several things on their
 * final values at once, so a page that had already been quiet for a second moves again
 * the moment they are cut. Quiet is the last thing established before the shot.
 */
async function settleReads(page: Page): Promise<void> {
  await page.waitForFunction(
    (needed: number) => {
      const held = window as unknown as {
        __capturePrint?: string;
        __captureQuiet?: number;
      };
      const scrolls = Array.from(document.querySelectorAll("*"))
        .map((element) => `${element.scrollTop}:${element.scrollLeft}`)
        .join(",");
      const print = `${document.body.innerHTML}|${scrolls}`;
      if (held.__capturePrint === print) {
        held.__captureQuiet = (held.__captureQuiet ?? 0) + 1;
      } else {
        held.__capturePrint = print;
        held.__captureQuiet = 0;
      }
      return (held.__captureQuiet ?? 0) >= needed;
    },
    SETTLED_SAMPLES,
    { polling: SETTLE_POLL_MS },
  );
}

/** One photographed surface: how to reach it, and how to know it has finished loading. */
interface Surface {
  readonly name: string;
  readonly title: string;
  readonly open: (page: Page) => Promise<void>;
}

const SURFACES: readonly Surface[] = [
  {
    name: "01-run-list-overall",
    title: "Run list and the overall view",
    open: async (page) => {
      await page.goto(`/?list=runs&run=${runs().live}&view=overall`);
      await settleReads(page);
      await expect(page.getByText("DAG Observatory")).toBeVisible();
      await expect(metrics(page)).toHaveCount(4);
      await expect(
        page.getByRole("region", { name: "Graph timeline" }),
      ).toBeVisible();
    },
  },
  {
    name: "02-graph-rows",
    title: "Overall view: one row per node, plus the run's own",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&view=overall`);
      await settleReads(page);
      await page
        .getByRole("region", { name: "Graph timeline" })
        .getByRole("button", { name: "Expand timeline" })
        .click();
      // Photographed with the rows drawn, and with one of them opened again into
      // the category lanes that are the third level of this reading.
      const dashboard = page.getByRole("region", {
        name: "dashboard timeline",
      });
      await dashboard.getByRole("button", { name: "Expand timeline" }).click();
      // An opened row names each of its lanes for a reader who cannot see the plot,
      // and that name is what says the lanes have arrived.
      await expect(timelineLane(dashboard, "worker")).toBeAttached();
    },
  },
  {
    name: "03-run-level-session",
    title: "Overall view with a run-level session open over it",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&view=overall`);
      await settleReads(page);
      await page
        .getByRole("region", { name: "Graph timeline" })
        .getByRole("button", { name: "Expand timeline" })
        .click();
      await page
        .getByRole("region", { name: "Run-level timeline" })
        .getByRole("button", { name: /^Run-level · monitor/ })
        .click();
      await expect(
        page
          .getByRole("region", { name: "Timeline item detail" })
          .getByRole("article", { name: /^Turn / })
          .first(),
      ).toBeVisible();
    },
  },
  {
    name: "04-graph",
    title: "Graph view",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&view=graph`);
      await settleReads(page);
      await expect(graphNodes(page, "running")).toHaveAccessibleName(
        "dashboard: running",
      );
      await expect(graphNodes(page, "failed").first()).toBeVisible();
    },
  },
  {
    name: "05-node-collapsed",
    title: "Node view: the collapsed line over its transcript",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&node=dashboard`);
      await settleReads(page);
      await expect(
        page.getByRole("region", { name: "Timeline for dashboard" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Node timeline" })
          .getByRole("button", { name: /engineer-dashboard/ }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Node transcript" })
          .getByRole("article")
          .first(),
      ).toBeVisible();
    },
  },
  {
    name: "06-node-expanded",
    title: "Node view: one row per category",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&node=dashboard`);
      await settleReads(page);
      const plot = page.getByRole("region", { name: "Node timeline" });
      await plot.getByRole("button", { name: "Expand timeline" }).click();
      // Photographed with the lanes drawn, not with the line they replaced.
      await expect(
        plot.getByRole("button", { name: /^worker · judge/ }),
      ).toBeVisible();
    },
  },
  {
    name: "07-node-item-detail",
    title: "Node view with a verification open over the reading",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&node=foundation`);
      await settleReads(page);
      const plot = page.getByRole("region", { name: "Node timeline" });
      await plot.getByRole("button", { name: "Expand timeline" }).click();
      await plot
        .getByRole("button", { name: new RegExp(fixture().artifacts.gate) })
        .click();
      await expect(
        page.getByRole("region", { name: "Timeline item detail" }),
      ).toContainText("Verification record");
    },
  },
  {
    name: "08-conversation",
    title: "A conversation in the right panel",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&node=dashboard`);
      await settleReads(page);
      await page
        .getByRole("region", { name: "Node transcript" })
        .getByRole("button", { name: /^Open worker · judge/ })
        .click();
      await expect(
        page
          .getByRole("region", { name: "Timeline item detail" })
          .getByRole("article", { name: /^Turn / })
          .first(),
      ).toBeVisible();
    },
  },
  {
    name: "09-node-redirected",
    title: "A node whose running turn a planner redirected",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&node=dashboard`);
      await settleReads(page);
      // The header's reading of whether this node can be corrected, and the record
      // of the correction that already reached it, in one frame: the badge is what a
      // planner acts on and the transcript row is what explains the turn afterwards.
      await expect(page.getByLabel(/^Turn reachable: /)).toBeVisible();
      await page
        .getByRole("region", { name: "Node transcript" })
        .getByRole("article")
        .filter({ hasText: "Redirected into the running turn" })
        .click();
      await expect(
        page.getByRole("region", { name: "Timeline item detail" }),
      ).toContainText("Live — into the turn that was already running");
    },
  },
  {
    name: "10-node-no-turn-to-reach",
    title: "A node with no lever, and the note that could only be deferred",
    open: async (page) => {
      await page.goto(`/?run=${runs().unattributed}&node=orphan`);
      await settleReads(page);
      await expect(page.getByLabel(/^No turn to reach: /)).toBeVisible();
      await page
        .getByRole("region", { name: "Node transcript" })
        .getByRole("article")
        .filter({ hasText: "Redirection deferred to the next dispatch" })
        .click();
      await expect(
        page.getByRole("region", { name: "Timeline item detail" }),
      ).toContainText("Why it was not delivered");
    },
  },
  {
    name: "11-project-list",
    title: "The projects the app opens on",
    open: async (page) => {
      await page.goto("/");
      await settleReads(page);
      const cards = page.getByRole("list", { name: "Projects" });
      await expect(cards.getByRole("listitem").first()).toBeVisible();
      // Photographed with every group's card drawn, the `(no project)` one
      // among them.
      await expect(cards).toContainText("(no project)");
    },
  },
  {
    name: "12-project-page",
    title: "A project's page: its runs, newest activity first",
    open: async (page) => {
      await page.goto(
        `/?project=${encodeURIComponent(fixture().projects.observatory)}`,
      );
      await expect(
        page
          .getByRole("list", { name: /^Runs of / })
          .getByRole("button", { name: `Open ${runs().live}` }),
      ).toBeVisible();
    },
  },
  {
    name: "13-channel",
    title: "The channel: the queue, the composer and the surface form",
    open: async (page) => {
      await page.goto(`/?run=${runs().supervised}&view=channel`);
      await settleReads(page);
      await expect(
        page.getByRole("region", { name: "Channel queue" }),
      ).toContainText("Replies");
      await expect(page.getByRole("region", { name: "Reply" })).toBeVisible();
    },
  },
  {
    name: "14-channel-graph-overrides",
    title: "The composer editing a node's graph overrides as an ordered list",
    open: async (page) => {
      await page.goto(`/?run=${runs().supervised}&view=channel`);
      await settleReads(page);
      const composer = page.getByRole("region", { name: "Reply" });
      await composer.getByLabel("Shortcut").selectOption("set-node-sets");
      await composer.getByLabel("Node id").fill("build");
      const list = composer.getByRole("group", {
        name: "Node overrides, in order",
      });
      // Two rows, so the reorder controls read in both states, and the longest
      // entry a reader types: a config path the row has to wrap or truncate.
      for (const entry of [
        "members.worker.agent.oneharness_config=./configs/worker-large.toml",
        "members.worker.agent.model=claude-opus",
      ]) {
        await list.getByRole("button", { name: "Add override" }).click();
        await list.getByRole("textbox").last().fill(entry);
      }
      await composer.getByRole("button", { name: "Compose envelope" }).click();
      await list.scrollIntoViewIfNeeded();
      await expect(
        list.getByRole("button", { name: "Move override 2 up" }),
      ).toBeEnabled();
    },
  },
];

/**
 * One line of screencomp's index, recorded as each shot is taken.
 *
 * Accumulated rather than derived from the two declarations at the end of the run, so
 * that the index describes what this invocation actually photographed: `--grep` is a
 * documented way to capture one width, and an index that named the other four would
 * reference images nobody wrote. A shot a test never reached is simply absent, which
 * `screencomp classify` reports as a removal against the committed baseline and the
 * strict gate refuses — which is the right answer for a capture that stopped part way.
 */
interface Shot {
  readonly name: string;
  readonly toggles: Readonly<Record<string, string>>;
  readonly hash: string;
  readonly image: string;
}

const captured: Shot[] = [];

for (const size of VIEWPORTS) {
  test.describe(`at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test.beforeEach(async ({ page }) => {
      await freezeClock(page);
    });

    for (const surface of SURFACES) {
      test(`captures ${surface.title}`, async ({ page }) => {
        await surface.open(page);
        await parkPointer(page);
        await settleReads(page);
        await settleMotion(page);
        await settleReads(page);
        const image = fileName(surface, size);
        // The viewport, not the full page, and they are the same picture: the shell
        // is exactly one viewport tall and every region inside it scrolls on its own,
        // which `dag-ui-navigation.spec.ts` asserts of every journey. Asking for the
        // full page therefore captures the same rectangle through Chromium's
        // beyond-the-viewport path, which re-lays out the scrollbar gutter and left a
        // pixel of the right edge landing differently between two runs of one build.
        await page.screenshot({
          path: join(gallery, image),
          animations: "disabled",
        });
        captured.push({
          name: surface.name,
          toggles: { [VIEWPORT_TOGGLE]: size.name },
          hash: createHash("sha256")
            .update(readFileSync(join(gallery, image)))
            .digest("hex"),
          image,
        });
      });
    }
  });
}

/**
 * The index screencomp reads this capture through, written once every image exists.
 *
 * `captures.json` is screencomp's contract rather than this tier's: `{schema, shots}`,
 * where each shot names the screen, the toggle values that variant was captured at,
 * the SHA-256 of the image, and the image's path relative to this directory. Authored
 * here rather than by `screencomp index`, because the capture runs inside a browser
 * container that carries no host tools and installing the CLI into it to hash files
 * this process just wrote would be the longer way round to the same bytes.
 *
 * Sorted by image name rather than left in the order the tests ran, because this file
 * is part of what two runs of one build have to agree on byte for byte.
 */
test.afterAll(() => {
  const shots = [...captured].sort((one, other) =>
    one.image.localeCompare(other.image),
  );
  writeFileSync(
    join(gallery, "captures.json"),
    `${JSON.stringify({ schema: 1, shots }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `dag-ui screens: ${shots.length} shots indexed in ${gallery}/captures.json\n`,
  );
});
