// `styles.css` imports the @oneharness/ui stylesheet through this app's Tailwind
// build, so the design system's tokens, variants and layers arrive with the app's
// own CSS rather than as raw text injected after first paint.
import "./styles.css";
// The schema-free route table: this chunk loads no zod.
import { API_V2_PATHS } from "@onepipeline-ui/dag-model/paths";
import {
  READ_DEADLINE_MS,
  TelemetryDeadlineError,
} from "@onepipeline-ui/telemetry-client/deadline";
import { createRoot } from "react-dom/client";
import {
  type FirstAddress,
  firstAddress,
  isOpaqueId,
} from "./first-screen/address";
import { checkFirstAnswer } from "./first-screen/check";
import {
  type FirstAnswer,
  FirstScreen,
  FirstScreenLoading,
} from "./first-screen/FirstScreen";

/**
 * The transcript of the conversation the address opens, read beside the app's own
 * code rather than after the app has drawn the panel that shows it.
 *
 * Opening a shared address to a session used to read its transcript only once the
 * whole app had mounted and drawn an empty panel, and then draw it behind every live
 * frame and history page that had queued up meanwhile: on a starved page that chain,
 * not the read, was what kept the reader waiting. The panel takes this read over as
 * its first, so the page still asks for the transcript once.
 */
export interface FirstTranscript {
  readonly runId: string;
  readonly conversationId: string;
  /** The read's body, where it had landed by the time the app mounted. */
  readonly landed?: { readonly body: unknown };
  /** The read itself: its body, or why there is none. */
  readonly read: Promise<unknown>;
}

/** How the first read went, handed to the app that takes it over. */
export interface FirstRead {
  readonly address: FirstAddress;
  readonly answer?: unknown;
  readonly error?: Error;
  readonly transcript?: FirstTranscript;
}

/**
 * The conversation the address's item opens, where the first answer names it: a
 * span the timeline served under that id, whose reference is a conversation. An
 * event row's reference is not among what the first screen checks, so a turn the
 * address names is read by its panel as before.
 */
function openedConversation(
  address: FirstAddress,
  answer: FirstAnswer,
): string | undefined {
  const { itemId } = address;
  if (itemId === undefined) return undefined;
  const span = answer.initial.snapshot.visible.timeline?.spans.find(
    ({ id }) => id === itemId,
  );
  const reference = span?.reference;
  return reference?.kind === "conversation" && isOpaqueId(reference.value)
    ? reference.value
    : undefined;
}

/** Start reading one transcript, and say whether it has landed whenever asked. */
function readTranscript(
  runId: string,
  conversationId: string,
): () => FirstTranscript {
  let landed: { readonly body: unknown } | undefined;
  const read = fetch(API_V2_PATHS.conversation(runId, conversationId)).then(
    async (response) => {
      // A refusal is the panel's to read in the server's words, through its client.
      if (!response.ok)
        throw new Error(`transcript read failed with ${response.status}`);
      const body: unknown = await response.json();
      landed = { body };
      return body;
    },
  );
  // Whoever takes the read over reads its failure; nothing else may report it.
  read.catch(() => undefined);
  return () => ({
    runId,
    conversationId,
    read,
    ...(landed === undefined ? {} : { landed }),
  });
}

/** The `{error: {code, message}}` a refusal carries, in the server's own words. */
function refusalOf(
  body: unknown,
): { readonly code?: string; readonly message?: string } | undefined {
  if (typeof body !== "object" || body === null || !("error" in body))
    return undefined;
  const error = (body as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

async function firstRead(address: FirstAddress): Promise<FirstRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
  try {
    const response = await fetch(API_V2_PATHS.subscriptions, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: address.view }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const refused = await response.json().then(
        (body: unknown) => refusalOf(body),
        () => undefined,
      );
      // A run or node the address names that is not served is the app's to
      // answer, as it always has: by opening what is served instead.
      if (
        refused?.code === "run_not_found" ||
        refused?.code === "node_not_found"
      )
        return { address };
      return {
        address,
        error: new Error(
          refused?.message ??
            `Telemetry request failed with status ${response.status}`,
        ),
      };
    }
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
  let read = await firstRead(address);
  // Every field the first screen draws is checked before it is drawn; the app holds
  // the same answer to the full contract when it takes it over. One that fails is
  // the app's to show, as the contract failure it is, and no screen is drawn from it.
  let transcript: (() => FirstTranscript) | undefined;
  if (read.answer !== undefined) {
    const checked = checkFirstAnswer(read.answer);
    if (checked instanceof Error) read = { address, error: checked };
    else {
      const conversationId = openedConversation(address, checked);
      if (conversationId !== undefined)
        transcript = readTranscript(address.runId, conversationId);
      drawn.render(<FirstScreen address={address} answer={checked} />);
    }
  }
  const { mountApp } = await import("./app/mount");
  mountApp(
    element,
    transcript === undefined ? read : { ...read, transcript: transcript() },
    drawn,
  );
}

void start();
