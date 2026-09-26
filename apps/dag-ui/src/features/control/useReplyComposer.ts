import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useState } from "react";
import {
  composeEnvelope,
  type Shortcut,
  type ShortcutFields,
} from "./reply-shortcuts";
import { useVerb, type Verb } from "./useVerb";

export interface ReplyComposerState {
  readonly shortcut: Shortcut;
  readonly setShortcut: (shortcut: Shortcut) => void;
  readonly fields: ShortcutFields;
  readonly setField: (
    key: keyof ShortcutFields,
    value: string | boolean | readonly string[],
  ) => void;
  /** Why the last compose produced no envelope, in the grammar's own words. */
  readonly problem?: string;
  /** Render the shortcut and its fields into the editor. */
  readonly compose: () => void;
  /** The editor's text: what is sent, byte for byte. */
  readonly envelope: string;
  readonly setEnvelope: (envelope: string) => void;
  readonly correlation: string;
  readonly setCorrelation: (correlation: string) => void;
  readonly send: Verb<[]>;
}

/**
 * The composer's state: the shortcut and its fields, the editor they render
 * into, and the verb that sends the editor's text.
 *
 * `defaults` are what a choice field says before anybody touches it, composed
 * from the same table the form draws its choices from. What is sent is always
 * `envelope` — the editor's text — and never a parse of it.
 */
export function useReplyComposer(
  client: TelemetryClient,
  runId: string,
  defaults: ShortcutFields,
  onSent: () => void,
): ReplyComposerState {
  const [shortcut, setShortcut] = useState<Shortcut>("continue");
  const [fields, setFields] = useState<ShortcutFields>({});
  const [problem, setProblem] = useState<string>();
  const [envelope, setEnvelope] = useState("");
  const [correlation, setCorrelation] = useState("");
  const setField = useCallback(
    (key: keyof ShortcutFields, value: string | boolean | readonly string[]) =>
      setFields((previous) => ({ ...previous, [key]: value })),
    [],
  );
  const compose = useCallback(() => {
    const composed = composeEnvelope(shortcut, { ...defaults, ...fields });
    if ("problem" in composed) {
      setProblem(composed.problem);
      return;
    }
    setProblem(undefined);
    setEnvelope(composed.bytes);
  }, [shortcut, fields, defaults]);
  const send = useVerb(
    "Reply",
    useCallback(
      () =>
        client.reply(
          runId,
          envelope,
          correlation.trim() === "" ? undefined : correlation.trim(),
        ),
      [client, runId, envelope, correlation],
    ),
    onSent,
  );
  return {
    shortcut,
    setShortcut,
    fields,
    setField,
    problem,
    compose,
    envelope,
    setEnvelope,
    correlation,
    setCorrelation,
    send,
  };
}
