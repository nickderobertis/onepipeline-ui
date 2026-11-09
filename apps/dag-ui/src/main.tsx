import "@xyflow/react/dist/style.css";
// Every task this app shows is rendered by `@onetaskgraph/ui`; its stylesheet comes
// first so this app's own rules, which theme it, follow it.
import "@onetaskgraph/ui/styles.css";
// `styles.css` imports the @oneharness/ui stylesheet through this app's Tailwind
// build, so the design system's tokens, variants and layers arrive with the app's
// own CSS rather than as raw text injected after first paint.
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";

const root = document.getElementById("root");
if (!root) throw new Error("DAG UI root element is missing");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
