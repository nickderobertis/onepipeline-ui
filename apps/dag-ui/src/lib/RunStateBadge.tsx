import {
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  CircleX,
  Hand,
  LoaderCircle,
  type LucideIcon,
  OctagonMinus,
  Unplug,
} from "lucide-react";
import type { RunState, RunStateWord } from "./run-model";

/**
 * Each word's own icon. Its colour is `styles.css`'s, keyed by the same slug, so
 * no two words share a shape or a colour — two words of one family (Failed and
 * Driver dead, both red) differ in shade.
 */
const ICONS: Readonly<Record<RunStateWord, LucideIcon>> = {
  Complete: CircleCheck,
  Failed: CircleX,
  Stopped: OctagonMinus,
  Unfinished: CircleSlash,
  "Waiting on you": Hand,
  "Driver dead": Unplug,
  Idle: CirclePause,
  Running: LoaderCircle,
};

const slug = (word: string): string =>
  word.toLowerCase().replaceAll(/[^a-z]+/gu, "-");

/**
 * The run's one state as a word with its icon and colour, and — for a run that has
 * not ended — its failed nodes counted beside it in the failure colour.
 *
 * The icon carries the word as its accessible name and the drawn word is hidden
 * from the accessibility tree, so the state is read once.
 */
export function RunStateBadge({
  state,
  large = false,
}: {
  readonly state: RunState;
  readonly large?: boolean;
}) {
  const Icon = state.known ? ICONS[state.word] : CircleDashed;
  const size = large ? 16 : 13;
  return (
    <span className="run-state-group" data-large={large}>
      {/* biome-ignore lint/a11y/useSemanticElements: one reading named as a whole; `fieldset` is for controls. */}
      <span
        aria-label="Run state"
        className="run-state"
        data-run-state={state.known ? slug(state.word) : "unknown"}
        role="group"
        title={state.word}
      >
        <Icon aria-label={state.word} role="img" size={size} />
        <span aria-hidden="true">{state.word}</span>
      </span>
      {state.failed > 0 && (
        <span className="run-failures" title={`${state.failed} failed nodes`}>
          <CircleX aria-hidden="true" size={size} />
          {state.failed} failed
        </span>
      )}
    </span>
  );
}
