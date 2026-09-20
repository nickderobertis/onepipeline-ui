import { Button, Input, Label, Textarea } from "@oneharness/ui";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { Send, Wand2 } from "lucide-react";
import { useId, useState } from "react";
import { Outcome, outcomeOf, type VerbOutcome } from "./Outcome";
import {
  composeEnvelope,
  isShortcut,
  SHORTCUT_FIELDS,
  SHORTCUTS,
  type Shortcut,
  type ShortcutFields,
  VERDICT_SHORTCUTS,
} from "./reply-shortcuts";

/** What each field asks for, in the words the engine's own schema uses. */
const FIELD_LABELS: Readonly<Record<keyof ShortcutFields, string>> = {
  message: "Message",
  reason: "Reason",
  id: "Node id",
  text: "Text",
  addressee: "Addressee",
  deliver: "Deliver",
  persist: "Carry to the next dispatch if no turn takes it",
  criterion: "Criterion (optional)",
  dependents: "Dependents",
  deps: "Dependencies, one per line",
  reference: "Reference",
  outcome: "Outcome",
  evidence: "Evidence",
  landing: "Landing (optional)",
  blocking: "Blocking",
  json: "Mapping (JSON)",
};

/** The closed choices some fields take, as the engine's enums spell them. */
const CHOICES: Partial<Record<keyof ShortcutFields, readonly string[]>> = {
  addressee: ["worker", "supervisor", "both"],
  deliver: ["live", "next"],
  dependents: ["detach", "drop"],
  outcome: ["done", "failed"],
};

/**
 * What a choice field says before anybody touches it: the first choice, which
 * is what the select shows. Composed from the same table the select is drawn
 * from, so the envelope cannot carry a value the form did not show.
 */
const CHOICE_DEFAULTS: ShortcutFields = Object.fromEntries(
  Object.entries(CHOICES).map(([field, choices]) => [field, choices[0]]),
);

/**
 * The reply composer: an editor for the envelope, with shortcuts that write the
 * common ones into it.
 *
 * What is sent is the editor's text, byte for byte — never a parse of it — so a
 * manager can type an envelope this app has never heard of, and a shortcut only
 * ever *fills the editor*: what reaches the engine is always what the reader is
 * looking at. The receipt or the refusal comes back as the API returned it.
 */
export function ReplyComposer({
  client,
  runId,
  onSent,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly onSent: () => void;
}) {
  const id = useId();
  const [shortcut, setShortcut] = useState<Shortcut>("continue");
  const [fields, setFields] = useState<ShortcutFields>({});
  const [problem, setProblem] = useState<string>();
  const [envelope, setEnvelope] = useState("");
  const [correlation, setCorrelation] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<VerbOutcome>();

  const compose = () => {
    const composed = composeEnvelope(shortcut, {
      ...CHOICE_DEFAULTS,
      ...fields,
    });
    if ("problem" in composed) {
      setProblem(composed.problem);
      return;
    }
    setProblem(undefined);
    setEnvelope(composed.bytes);
  };

  const send = async () => {
    setSending(true);
    const answered = await outcomeOf("Reply", () =>
      client.reply(
        runId,
        envelope,
        correlation.trim() === "" ? undefined : correlation.trim(),
      ),
    );
    setOutcome(answered);
    setSending(false);
    if (answered.kind === "answered") onSent();
  };

  const set = (key: keyof ShortcutFields, value: string | boolean) =>
    setFields((previous) => ({ ...previous, [key]: value }));

  return (
    <section aria-labelledby={`${id}-heading`} className="composer">
      <h3 id={`${id}-heading`}>Reply</h3>
      <div className="composer-shortcut">
        <Label htmlFor={`${id}-shortcut`}>Shortcut</Label>
        <select
          className="composer-select"
          id={`${id}-shortcut`}
          onChange={(event) => {
            const chosen = event.target.value;
            if (isShortcut(chosen)) setShortcut(chosen);
          }}
          value={shortcut}
        >
          <optgroup label="Verdict">
            {Object.entries(VERDICT_SHORTCUTS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Edit">
            {SHORTCUTS.filter((key) => !(key in VERDICT_SHORTCUTS)).map(
              (key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ),
            )}
          </optgroup>
        </select>
      </div>
      <div className="composer-fields">
        {SHORTCUT_FIELDS[shortcut].map((field) => {
          const fieldId = `${id}-${field}`;
          const choices = CHOICES[field];
          if (field === "persist" || field === "blocking") {
            return (
              <div className="composer-check" key={field}>
                <input
                  checked={
                    field === "persist"
                      ? fields.persist !== false
                      : fields.blocking === true
                  }
                  id={fieldId}
                  onChange={(event) => set(field, event.target.checked)}
                  type="checkbox"
                />
                <Label htmlFor={fieldId}>{FIELD_LABELS[field]}</Label>
              </div>
            );
          }
          const value = fields[field];
          const text = typeof value === "string" ? value : "";
          return (
            <div className="composer-field" key={field}>
              <Label htmlFor={fieldId}>{FIELD_LABELS[field]}</Label>
              {choices !== undefined ? (
                <select
                  className="composer-select"
                  id={fieldId}
                  onChange={(event) => set(field, event.target.value)}
                  value={text || choices[0]}
                >
                  {choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : field === "message" ||
                field === "text" ||
                field === "json" ||
                field === "deps" ||
                field === "evidence" ? (
                <Textarea
                  id={fieldId}
                  onChange={(event) => set(field, event.target.value)}
                  rows={field === "json" ? 5 : 2}
                  value={text}
                />
              ) : (
                <Input
                  id={fieldId}
                  onChange={(event) => set(field, event.target.value)}
                  value={text}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="composer-actions">
        <Button onClick={compose} size="sm" type="button" variant="outline">
          <Wand2 size={14} /> Compose envelope
        </Button>
        {problem !== undefined && (
          <p className="composer-problem" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="composer-field">
        <Label htmlFor={`${id}-envelope`}>Envelope (sent as typed)</Label>
        <Textarea
          className="composer-envelope"
          id={`${id}-envelope`}
          onChange={(event) => setEnvelope(event.target.value)}
          rows={8}
          spellCheck={false}
          value={envelope}
        />
      </div>
      <div className="composer-field composer-correlation">
        <Label htmlFor={`${id}-correlation`}>Correlation (optional)</Label>
        <Input
          id={`${id}-correlation`}
          onChange={(event) => setCorrelation(event.target.value)}
          value={correlation}
        />
      </div>
      <div className="composer-actions">
        <Button
          disabled={sending || envelope.trim() === ""}
          onClick={() => void send()}
          size="sm"
          type="button"
        >
          <Send size={14} /> Send reply
        </Button>
        <span aria-live="polite" className="run-list-status">
          {sending ? "Sending…" : ""}
        </span>
      </div>
      <Outcome label="Reply" outcome={outcome} />
    </section>
  );
}
