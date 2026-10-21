import "@xyflow/react/dist/style.css";
// `styles.css` imports the @oneharness/ui stylesheet through this app's Tailwind
// build, so the design system's tokens, variants and layers arrive with the app's
// own CSS rather than as raw text injected after first paint.
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { SpikeMock } from "./spike/SpikeMock";

// THROWAWAY visual spike: `?spike=<view>` renders the static mock instead.
const spike = new URLSearchParams(window.location.search).get("spike");

const root = document.getElementById("root");
if (!root) throw new Error("DAG UI root element is missing");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      {spike === null ? <App /> : <SpikeMock view={spike} />}
    </AppErrorBoundary>
  </StrictMode>,
);
