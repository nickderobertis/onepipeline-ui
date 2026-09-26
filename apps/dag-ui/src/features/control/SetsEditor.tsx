import { Button, Input } from "@oneharness/ui";
import { ArrowDown, ArrowUp, Plus, RotateCcw, X } from "lucide-react";
import { useId } from "react";

/**
 * An ordered list of graph overrides, edited in place: one `PATH=VALUE` entry a
 * row, in the order the engine applies them, so the last entry for a path wins.
 *
 * What it holds is the whole replacement list a `set-node-sets` or
 * `set-run-node-sets` sends — an empty list included, which clears. Each entry
 * is sent as typed; the grammar is oneagentgraph's, read by the engine, and this
 * control is only the list's shape. `current` is the list the served graph holds
 * for the same target, offered to load rather than loaded, so what the editor
 * shows is always what the reader chose to send.
 */
export function SetsEditor({
  legend,
  sets,
  onChange,
  current,
}: {
  readonly legend: string;
  readonly sets: readonly string[];
  readonly onChange: (sets: readonly string[]) => void;
  /** The list the graph holds now, or `undefined` where there is none to name. */
  readonly current?: readonly string[];
}) {
  const id = useId();
  const replace = (index: number, entry: string) =>
    onChange(sets.map((old, at) => (at === index ? entry : old)));
  const move = (from: number, to: number) => {
    const next = [...sets];
    const [entry] = next.splice(from, 1);
    if (entry !== undefined) next.splice(to, 0, entry);
    onChange(next);
  };
  return (
    <fieldset aria-describedby={`${id}-hint`} className="sets-editor">
      <legend>{legend}</legend>
      <p className="sets-hint" id={`${id}-hint`}>
        One PATH=VALUE a row, applied in order — the whole list is replaced, and
        an empty list clears it.
      </p>
      {sets.length === 0 ? (
        <p className="sets-empty">No overrides: sends an empty list.</p>
      ) : (
        <ol className="sets-list">
          {sets.map((entry, index) => {
            const position = index + 1;
            return (
              // Rows are positions, not identities: an entry is its text, and two
              // equal entries are still two rows.
              // biome-ignore lint/suspicious/noArrayIndexKey: an override's identity is its position in the ordered list.
              <li className="sets-row" key={index}>
                <Input
                  aria-label={`Override ${position}`}
                  className="sets-entry"
                  onChange={(event) => replace(index, event.target.value)}
                  placeholder="members.worker.agent.model=VALUE"
                  spellCheck={false}
                  value={entry}
                />
                <Button
                  aria-label={`Move override ${position} up`}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <ArrowUp />
                </Button>
                <Button
                  aria-label={`Move override ${position} down`}
                  disabled={index === sets.length - 1}
                  onClick={() => move(index, index + 1)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <ArrowDown />
                </Button>
                <Button
                  aria-label={`Remove override ${position}`}
                  onClick={() => onChange(sets.filter((_, at) => at !== index))}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="composer-actions">
        <Button
          onClick={() => onChange([...sets, ""])}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus size={14} /> Add override
        </Button>
        <Button
          disabled={current === undefined}
          onClick={() => {
            if (current !== undefined) onChange([...current]);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <RotateCcw size={14} /> Load current list
        </Button>
        <span className="sets-current">
          {current === undefined
            ? "No current list to load"
            : current.length === 0
              ? "Current list: none"
              : `Current list: ${current.join(" · ")}`}
        </span>
      </div>
    </fieldset>
  );
}
