import type { Locator } from "@playwright/test";

/**
 * Colours as the DAG view renders them, read off the page the way a person sees
 * them: a computed value of any CSS syntax the browser resolves (`oklch(…)`,
 * `color-mix(…)`, `rgb(…)`) normalised to sRGB by painting it on a canvas, and a
 * translucent background composited over every ancestor's until it is opaque.
 * The contrast ratio is WCAG 2's.
 */

/** One sRGB colour, each channel 0–255, and its alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** A computed style property of `element`, as sRGB. */
export async function computedColour(
  element: Locator,
  property: string,
): Promise<Rgba> {
  return element.evaluate((node, name) => {
    // Painted on a canvas and read back: whatever syntax the browser computed.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("no 2D canvas");
    context.fillStyle = getComputedStyle(node).getPropertyValue(name);
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  }, property);
}

/**
 * What is painted behind `element`'s content: its own background, if `own`, and
 * every ancestor's, composited from the top down until opaque, over the page's
 * white where nothing is.
 */
export async function backdrop(element: Locator, own = true): Promise<Rgba> {
  return element.evaluate((node, includeOwn) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("no 2D canvas");
    const paint = (css: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(
        0,
        0,
        1,
        1,
      ).data;
      return { r, g, b, a: a / 255 };
    };
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    let at: Element | null = includeOwn ? node : node.parentElement;
    while (at !== null) {
      const colour = paint(getComputedStyle(at).backgroundColor);
      if (colour.a > 0) layers.push(colour);
      if (colour.a >= 1) break;
      at = at.parentElement;
    }
    let under = { r: 255, g: 255, b: 255 };
    for (const layer of layers.reverse())
      under = {
        r: layer.r * layer.a + under.r * (1 - layer.a),
        g: layer.g * layer.a + under.g * (1 - layer.a),
        b: layer.b * layer.a + under.b * (1 - layer.a),
      };
    return { ...under, a: 1 };
  }, own);
}

/** `top` laid over `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  return {
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2's contrast ratio between two opaque colours. */
export function contrast(left: Rgba, right: Rgba): number {
  const [light, dark] = [luminance(left), luminance(right)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Whether two colours' channels agree within `tolerance` of 255. */
export function sameColour(left: Rgba, right: Rgba, tolerance = 2): boolean {
  return (
    Math.abs(left.r - right.r) <= tolerance &&
    Math.abs(left.g - right.g) <= tolerance &&
    Math.abs(left.b - right.b) <= tolerance
  );
}
