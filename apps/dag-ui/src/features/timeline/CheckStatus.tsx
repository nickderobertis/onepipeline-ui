import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

/**
 * One check's standing in a word: its outcome once it has one, its progress
 * before. Every outcome that is neither a pass, a skip nor neutral reads failed —
 * a cancellation, a timeout or a completion with no verdict fails the merge as a
 * failure does — and the producer's own words stay in the icon's title. A record
 * that names neither is `not recorded`, never a progress made up for it.
 */
type CheckWord =
  | "passed"
  | "failed"
  | "skipped"
  | "neutral"
  | "queued"
  | "running"
  | "not recorded";

const ICONS: Readonly<Record<CheckWord, LucideIcon>> = {
  passed: CircleCheck,
  failed: CircleX,
  skipped: CircleMinus,
  neutral: CircleDot,
  queued: CircleDashed,
  running: LoaderCircle,
  "not recorded": CircleHelp,
};

function checkWord(check: {
  readonly status?: string;
  readonly conclusion?: string;
}): CheckWord {
  if (check.conclusion === undefined) {
    if (check.status === undefined) return "not recorded";
    if (check.status === "in_progress") return "running";
    if (check.status !== "completed") return "queued";
  }
  switch (check.conclusion) {
    case "success":
      return "passed";
    case "skipped":
      return "skipped";
    case "neutral":
      return "neutral";
    default:
      return "failed";
  }
}

/**
 * The Status cell: one coloured icon and its word, the colour `styles.css` gives
 * that word, and the icon named by the word for a reader who cannot see either.
 */
export function CheckStatus({
  check,
}: {
  readonly check: { readonly status?: string; readonly conclusion?: string };
}) {
  const word = checkWord(check);
  const Icon = ICONS[word];
  return (
    <span
      className="check-status"
      data-check={word.replace(" ", "-")}
      title={[check.status ?? "not recorded", check.conclusion]
        .filter(Boolean)
        .join(": ")}
    >
      <Icon aria-label={word} role="img" size={14} />
      <span aria-hidden="true">{word}</span>
    </span>
  );
}
