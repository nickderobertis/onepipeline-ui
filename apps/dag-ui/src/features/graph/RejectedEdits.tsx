import type { RejectedEdit } from "@onepipeline-ui/dag-model";

/**
 * The live edits the run refused, as its `edit-rejected` records said them: who sent
 * each, what it would have done, and the refusal in the engine's own words — which
 * name the plan-edit hook where one refused it. A refused correction changed nothing
 * on the graph, so without this a manager watching the graph would see no trace of a
 * correction that never landed.
 */
export function RejectedEdits({
  edits,
}: {
  readonly edits?: readonly RejectedEdit[];
}) {
  if (edits === undefined || edits.length === 0) return null;
  return (
    <section aria-labelledby="rejected-edits-title" className="rejected-edits">
      <h2 id="rejected-edits-title">
        {edits.length === 1
          ? "1 refused edit"
          : `${edits.length} refused edits`}
      </h2>
      <ol>
        {edits.map((edit) => (
          <li key={`${edit.at}:${edit.envelope ?? ""}:${edit.index ?? ""}`}>
            <span className="rejected-edit-what">
              {edit.author}: {opOf(edit.command)}
            </span>
            <span className="rejected-edit-reason">{edit.reason}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The command's op — `add`, `drop`, `decline` — which is all of it a reader needs
 * beside the refusal; the reason names the node it was about. A command from an
 * envelope this engine could not decode is journalled as it was sent, which may
 * carry no op, and is then named as an edit.
 */
function opOf(command: Readonly<Record<string, unknown>>): string {
  return typeof command.op === "string" ? command.op : "edit";
}
