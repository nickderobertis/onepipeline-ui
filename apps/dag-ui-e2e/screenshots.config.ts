import { defineConfig } from "@playwright/test";
import { CAPTURE_INSTANT } from "./capture-clock";
import e2eConfig from "./playwright.config";

/**
 * The screenshot tier: the same stack the browser e2e boots, driven to capture rather
 * than to assert.
 *
 * It reuses `playwright.config.ts`'s configuration object wholesale rather than
 * describing servers of its own. That is the point — everything two concurrent runs
 * must not share is chosen there, per run, by asking the kernel for free ports and
 * making a fixture directory of its own, and a gallery config that restated any of it
 * would reintroduce exactly the fixed ports and shared fixture path that choice
 * replaced. Importing the module runs that choice, so `just dag-ui-screens` twice at
 * once is two independent stacks.
 *
 * Two things are inverted, and one is added. The e2e tier ignores `*.screens.spec.ts`
 * and this config runs nothing else; the spread carries that `testIgnore` along, so it
 * is cleared here — without which this tier would select the gallery and then ignore
 * it. And the whole capture is made byte-reproducible, because screencomp gates on the
 * content hash of every image it is handed.
 */

/**
 * The corpus's clock, named before anything starts.
 *
 * `fixtures/serve-fixture.mjs` is spawned by the `webServer` entries this config
 * inherits, and Playwright starts them with this process's environment — so a value
 * exported here is the one the fixture writer reads. Exported rather than passed
 * through a `webServer` entry so it reaches the fixture server whichever entry starts
 * it, and set here rather than by the caller so no capture can be taken without it:
 * an operator running this tier by hand would otherwise photograph a corpus stamped
 * from the wall clock and hand screencomp a tree that hashes differently every time.
 * `capture-clock.ts` holds the instant and why it is that one.
 */
process.env.DAG_UI_FIXTURE_NOW = CAPTURE_INSTANT;

export default defineConfig({
  ...e2eConfig,
  testMatch: "**/*.screens.spec.ts",
  testIgnore: [],
  // Every viewport across every gallery surface, each waiting for real reads to
  // settle — a count here only drifts from the two lists that decide it.
  timeout: 120_000,
  use: {
    ...e2eConfig.use,
    /**
     * Two device pixels per CSS pixel, which is what finally made this capture
     * byte-reproducible rather than merely nearly so.
     *
     * At one device pixel a run in ten would land a two-pixel band along the top edge
     * of the node header's gradient one level of 255 away from where the run before it
     * had put it — invisible to a reader and fatal to a gate that compares content
     * hashes. A sub-pixel difference in where a box edge falls has to be resolved into
     * a single device pixel, so it flips that pixel's value; at twice the density the
     * same difference is spread across more gradations and each one stays under the
     * quantization step. It is screencomp's own remedy for the class, and it costs
     * roughly four times the bytes — which is a trade worth making for a text-dense
     * UI, and why the committed pictures in `README.md` are also the sharp ones.
     */
    deviceScaleFactor: 2,
    launchOptions: {
      /**
       * Chromium's determinism flags, which are what make one build's pixels the
       * same on two hosts of one architecture rather than merely similar.
       *
       * Every entry changes the *bytes*: the GPU is out of the render path
       * entirely and rasterisation goes through SwiftShader's software path, the
       * colour profile is pinned rather than taken from the display, and glyph
       * hinting and subpixel anti-aliasing — both of which are a function of the
       * font stack and the screen the browser thinks it has — are off. The
       * stability flags screencomp also documents are deliberately absent:
       * `--single-process` in particular is the one that takes a whole browser
       * down with a renderer fault on a page doing real client-side work, and
       * dropping it changes no byte of output. Scrollbars are hidden because this
       * app scrolls every region of its shell independently, so a gutter that
       * appears only once a list is long enough is a layout difference between a
       * capture and the same capture with one more recorded event.
       */
      args: [
        "--disable-skia-runtime-opts",
        "--disable-gpu",
        "--disable-gpu-rasterization",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        "--disable-lcd-text",
        "--hide-scrollbars",
      ],
    },
  },
});
