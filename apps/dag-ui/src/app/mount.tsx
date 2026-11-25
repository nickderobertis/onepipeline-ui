import "@xyflow/react/dist/style.css";
// Every task this app shows is rendered by `@onetaskgraph/ui`; its stylesheet comes
// first so this app's own rules, which theme it, follow it.
import "@onetaskgraph/ui/styles.css";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FirstTranscriptContext } from "../features/timeline/useConversation";
import type { FirstRead } from "../main";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";

/**
 * Bring the app up, and — where a first screen stands — behind it: it takes the first
 * answer over, and the screen comes down in the same commit the app first draws in,
 * so nothing a reader is looking at jumps.
 */
export function mountApp(
  firstRoot: HTMLElement,
  first: FirstRead | undefined,
  drawn?: Root,
): void {
  const app = drawn === undefined ? firstRoot : document.createElement("div");
  if (app !== firstRoot) {
    app.setAttribute("data-app-behind-first-screen", "");
    app.style.cssText = "position:fixed;inset:0;visibility:hidden;";
    document.body.appendChild(app);
  }
  const reveal = () => {
    if (app === firstRoot) return;
    // Called from a layout effect, so this lands before the app's commit paints:
    // the two trade places in one frame, with no scheduled callback to wait on.
    drawn?.unmount();
    firstRoot.replaceWith(app);
    app.id = "root";
    app.removeAttribute("data-app-behind-first-screen");
    app.style.cssText = "";
  };
  // One handoff for the page: the first panel to open the address's conversation
  // takes the entry's read of it, and every later one reads for itself.
  const transcript = {
    ...(first?.transcript === undefined
      ? {}
      : { transcript: first.transcript }),
    taken: first?.transcript === undefined,
  };
  createRoot(app).render(
    <StrictMode>
      <AppErrorBoundary>
        <FirstTranscriptContext.Provider value={transcript}>
          <App first={first} onDrawn={reveal} />
        </FirstTranscriptContext.Provider>
      </AppErrorBoundary>
    </StrictMode>,
  );
}
