import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

/**
 * One check's standing in a word: its outcome once it completed, its progress
 * before. Every completed check that is neither a pass, a skip nor neutral reads
 * failed — a cancellation or a timeout fails the merge as a failure does — and the
 * producer's own words stay in the icon's title.
 */
type CheckWord =
  | "passed"
  | "failed"
  | "skipped"
  | "neutral"
  | "queued"
  | "running";

const ICONS: Readonly<Record<CheckWord, LucideIcon>> = {
  passed: CircleCheck,
  failed: CircleX,
  skipped: CircleMinus,
  neutral: CircleDot,
  queued: CircleDashed,
  running: LoaderCircle,
};

/** The word a check's `status` and `conclusion` read as. */
function checkWord(check: {
  readonly status?: string;
  readonly conclusion?: string;
}): CheckWord {
  if (check.status !== "completed")
    return check.status === "in_progress" ? "running" : "queued";
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
      data-check={word}
      title={[check.status ?? "not recorded", check.conclusion]
        .filter(Boolean)
        .join(": ")}
    >
      <Icon aria-label={word} role="img" size={14} />
      <span aria-hidden="true">{word}</span>
    </span>
  );
}
