import type { HumanItemReopen } from "@onepipeline-ui/dag-model";
import { useId, useState } from "react";

/**
 * Restore or Reopen, as the engine's `reopen` answer has it. Where the engine
 * says it cannot be, it is greyed, and a small question mark set on its text as
 * a superscript gives the reason — on hover, and on a press, which is the one a
 * phone has. The mark is a control of its own beside the greyed one, never
 * inside a disabled one, so it stays pressable.
 *
 * `control` is what every button here carries beyond its own name: a class, and
 * on a card the attributes that put it in the card-action group.
 */
export function ReopenAction({
  label,
  item,
  busyLabel = `${label}…`,
  reopen,
  sending,
  disabled = false,
  onPress,
  className,
  control = {},
}: {
  /** What the control reads. */
  readonly label: string;
  /** The item's title, where the words alone would not say which item it is for. */
  readonly item?: string;
  /** What it reads while its write is out. */
  readonly busyLabel?: string;
  readonly reopen?: HumanItemReopen;
  readonly sending: boolean;
  /** Another write on the item is out, so this one waits for it. */
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly className: string;
  readonly control?: {
    readonly "data-card-action"?: string;
    readonly tabIndex?: number;
  };
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const tip = useId();
  const name = item === undefined ? label : `${label}: ${item}`;
  const why = `Why ${label} is unavailable${item === undefined ? "" : `: ${item}`}`;
  if (reopen?.available !== false)
    return (
      <button
        {...control}
        aria-busy={sending}
        aria-label={sending ? undefined : name}
        className={className}
        disabled={disabled}
        onClick={() => {
          if (!sending) onPress();
        }}
        type="button"
      >
        {sending ? busyLabel : label}
      </button>
    );
  return (
    <fieldset
      aria-label={`${name} (unavailable)`}
      className={`${className} human-items-unavailable`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button aria-describedby={tip} disabled type="button">
        {label}
      </button>
      <sup className="human-items-why-anchor">
        <button
          {...control}
          aria-controls={tip}
          aria-expanded={pinned}
          aria-label={why}
          className="human-items-why"
          onClick={(event) => {
            // On a card the mark is one of its controls, and never selects it.
            event.stopPropagation();
            setPinned((open) => !open);
          }}
          type="button"
        >
          ?
        </button>
      </sup>
      <span
        className="human-items-why-tip"
        hidden={!(pinned || hovered)}
        id={tip}
        role="tooltip"
      >
        {reopen.reason}
      </span>
    </fieldset>
  );
}
