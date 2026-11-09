// `styles.css` imports the @oneharness/ui stylesheet through this app's Tailwind
// build, so the design system's tokens, variants and layers arrive with the app's
// own CSS rather than as raw text injected after first paint.
import "./styles.css";
import {
  READ_DEADLINE_MS,
  TelemetryDeadlineError,
} from "@onepipeline-ui/telemetry-client/deadline";
import { createRoot } from "react-dom/client";
import { type FirstAddress, firstAddress } from "./first-screen/address";
import {
  type FirstAnswer,
  FirstScreen,
  FirstScreenLoading,
} from "./first-screen/FirstScreen";

/** How the first read went, handed to the app that takes it over. */
export interface FirstRead {
  readonly address: FirstAddress;
  readonly answer?: unknown;
  readonly error?: Error;
}

async function firstRead(address: FirstAddress): Promise<FirstRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
  try {
    const response = await fetch("/api/v2/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: address.view }),
      signal: controller.signal,
    });
    if (!response.ok)
      return {
        address,
        error: new Error(
          `Telemetry request failed with status ${response.status}`,
        ),
      };
    return { address, answer: await response.json() };
  } catch (caught) {
    return {
      address,
      error: controller.signal.aborted
        ? new TelemetryDeadlineError("The read of this run's history")
        : caught instanceof Error
          ? caught
          : new Error(String(caught)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The page's entry. A run's address draws its first screen from one read and then
 * fetches the rest of the app, the canvas and sidebar included, which takes that same
 * read over and replaces the screen; any other address goes straight to the app.
 */
async function start(): Promise<void> {
  const element = document.getElementById("root");
  if (!element) throw new Error("DAG UI root element is missing");
  const address = firstAddress(
    window.location.search,
    window.location.pathname,
  );
  if (address === undefined) {
    const { mountApp } = await import("./app/mount");
    mountApp(element, undefined, undefined);
    return;
  }
  const drawn = createRoot(element);
  drawn.render(<FirstScreenLoading address={address} />);
  const read = await firstRead(address);
  if (read.answer !== undefined)
    drawn.render(
      <FirstScreen address={address} answer={read.answer as FirstAnswer} />,
    );
  const { mountApp } = await import("./app/mount");
  mountApp(element, read, drawn);
}

void start();
