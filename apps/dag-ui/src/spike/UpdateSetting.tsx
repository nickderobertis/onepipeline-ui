// SPIKE: throwaway mock of one update setting; counts are hard-coded. Nothing here lands.
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

const CHOICES = [
  { value: "live", label: "Live" },
  { value: "10", label: "Every 10 seconds" },
  { value: "30", label: "Every 30 seconds" },
  { value: "60", label: "Every minute" },
  { value: "300", label: "Every 5 minutes" },
  { value: "off", label: "Off" },
] as const;
type Choice = (typeof CHOICES)[number]["value"];

/** A disclosure rather than a native select, whose open list no screenshot can show. */
export function UpdateSetting({
  label,
  initial,
  intervalWaiting,
  offWaiting,
}: {
  readonly label: string;
  readonly initial: Choice;
  readonly intervalWaiting: number;
  readonly offWaiting: number;
}) {
  const [choice, setChoice] = useState<Choice>(initial);
  const menu = useRef<HTMLDetailsElement>(null);
  const waiting =
    choice === "live" ? 0 : choice === "off" ? offWaiting : intervalWaiting;
  return (
    <fieldset className="spike-update">
      <legend>{label}</legend>
      <div className="spike-update-row">
        <details className="spike-update-menu" ref={menu}>
          <summary aria-label={label}>
            {CHOICES.find(({ value }) => value === choice)?.label}
            <ChevronDown aria-hidden="true" size={12} />
          </summary>
          <div role="menu">
            {CHOICES.map(({ value, label: words }) => (
              <button
                aria-checked={value === choice}
                key={value}
                onClick={() => {
                  setChoice(value);
                  if (menu.current) menu.current.open = false;
                }}
                role="menuitemradio"
                type="button"
              >
                {words}
              </button>
            ))}
          </div>
        </details>
        {waiting > 0 && <span className="spike-waiting">{waiting} waiting</span>}
      </div>
    </fieldset>
  );
}
