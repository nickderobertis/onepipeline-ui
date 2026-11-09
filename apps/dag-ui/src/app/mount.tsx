import "@xyflow/react/dist/style.css";
// Every task this app shows is rendered by `@onetaskgraph/ui`; its stylesheet comes
// first so this app's own rules, which theme it, follow it.
import "@onetaskgraph/ui/styles.css";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FirstRead } from "../main";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";

/**
 * Bring the app up, and — where a first screen stands — behind it: it takes the first
 * answer over, and the screen comes down in the frame after the app has drawn its own,
 * so nothing a reader is looking at jumps.
 */
export function mountApp(
  firstRoot: HTMLElement,
  first: FirstRead | undefined,
  drawn?: Root,
): void {
  // Nothing drawn behind means the app takes the root straight over.
  const app = drawn === undefined ? firstRoot : document.createElement("div");
  if (app !== firstRoot) {
    app.setAttribute("data-app-behind-first-screen", "");
    app.style.cssText = "position:fixed;inset:0;visibility:hidden;";
    document.body.appendChild(app);
  }
  const reveal = () => {
    if (app === firstRoot) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        drawn?.unmount();
        firstRoot.replaceWith(app);
        app.id = "root";
        app.removeAttribute("data-app-behind-first-screen");
        app.style.cssText = "";
      }),
    );
  };
  createRoot(app).render(
    <StrictMode>
      <AppErrorBoundary>
        <App first={first} onDrawn={reveal} />
      </AppErrorBoundary>
    </StrictMode>,
  );
}
