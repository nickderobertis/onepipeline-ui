// SPIKE: throwaway mock of one update setting; counts are hard-coded. Nothing here lands.
import { useState } from "react";

export function UpdateSetting({
  label,
  initial,
  intervalWaiting,
  offWaiting,
}: {
  readonly label: string;
  readonly initial: "live" | "interval" | "off";
  readonly intervalWaiting: number;
  readonly offWaiting: number;
}) {
  const [mode, setMode] = useState(initial);
  const waiting =
    mode === "live" ? 0 : mode === "interval" ? intervalWaiting : offWaiting;
  return (
    <fieldset className="spike-update">
      <legend>{label}</legend>
      <div className="spike-update-row">
        <button
          aria-pressed={mode === "live"}
          onClick={() => setMode("live")}
          type="button"
        >
          Live
        </button>
        <select
          aria-label={`${label} interval`}
          data-on={mode === "interval"}
          defaultValue="30"
          onChange={() => setMode("interval")}
          onClick={() => setMode("interval")}
        >
          <option value="10">10s</option>
          <option value="30">30s</option>
          <option value="60">1m</option>
          <option value="300">5m</option>
        </select>
        <button
          aria-pressed={mode === "off"}
          aria-label={`${label} off`}
          onClick={() => setMode("off")}
          type="button"
        >
          Off
        </button>
        {waiting > 0 && <span className="spike-waiting">{waiting} waiting</span>}
      </div>
    </fieldset>
  );
}
