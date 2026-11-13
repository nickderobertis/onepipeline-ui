import type { RejectedEdit } from "@onepipeline-ui/dag-model";

/**
 * The live edits the run refused, as its `edit-rejected` records said them: who sent
 * each, and the refusal in the engine's own words, which name the op refused and,
 * where a plan-edit hook refused it, that hook. A refused correction changed nothing
 * on the graph, so without this a manager watching the graph would see no trace of a
 * correction that never landed.
 */
export function RejectedEdits({
  edits,
}: {
  readonly edits?: readonly RejectedEdit[];
}) {
  if (edits === undefined) return null;
  return (
    <section aria-labelledby="rejected-edits-title" className="rejected-edits">
      <h2 id="rejected-edits-title">Refused edits</h2>
      <ol>
        {edits.map((edit) => (
          <li key={`${edit.at}:${edit.envelope ?? ""}:${edit.index ?? ""}`}>
            <span className="rejected-edit-what">{edit.author}</span>
            <span className="rejected-edit-reason">{edit.reason}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
