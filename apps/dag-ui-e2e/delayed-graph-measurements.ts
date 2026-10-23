import type { Page } from "@playwright/test";

// Keep native measurements, but hold their delivery for graph nodes until the
// reader resizes the window. The canvas container is still measured normally.
// This makes a slow first measurement deterministic without replacing API data
// or the graph renderer.
// llmlint: ignore-block[tests_mirror_real_usage] this scheduling fault cannot be
// produced reliably by clicking the UI. Hold real native observations, with their
// original sizes, to reproduce a loaded runner's delayed delivery; the built graph,
// real API, fixture storage and all user interactions remain under test.
export async function delayGraphMeasurements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const immediate = entries.filter(
            (entry) => !entry.target.classList.contains("react-flow__node"),
          );
          const delayed = entries.filter((entry) =>
            entry.target.classList.contains("react-flow__node"),
          );
          if (immediate.length > 0) callback(immediate, observer);
          if (delayed.length > 0)
            window.addEventListener(
              "resize",
              () => callback(delayed, observer),
              {
                once: true,
              },
            );
        });
      }
    };
  });
}
// llmlint: ignore-end[tests_mirror_real_usage]
