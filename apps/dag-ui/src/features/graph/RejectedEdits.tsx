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
              {edit.author}: {editSummary(edit.command)}
            </span>
            <span className="rejected-edit-reason">{edit.reason}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The command in a few words — its op and the node it named — read only for
 * display; the reason beside it is the record's whole account.
 */
function editSummary(command: Readonly<Record<string, unknown>>): string {
  const op = typeof command.op === "string" ? command.op : "edit";
  const node = command.node;
  const named =
    typeof node === "string"
      ? node
      : typeof node === "object" &&
          node !== null &&
          typeof (node as { id?: unknown }).id === "string"
        ? (node as { id: string }).id
        : undefined;
  return named === undefined ? op : `${op} ${named}`;
}
