import {
  parseUpdateSetting,
  type UpdateSetting as Setting,
  UPDATE_CHOICES,
} from "./update-settings";

/**
 * One area's update setting and how many changes it is holding. A native list,
 * which nothing around it can clip and which a phone already knows how to show.
 */
export function UpdateSetting({
  name,
  caption,
  setting,
  waiting,
  onChange,
}: {
  /** The accessible name, which says which area it governs. */
  readonly name: string;
  /** The words beside the list. */
  readonly caption: string;
  readonly setting: Setting;
  readonly waiting: number;
  readonly onChange: (setting: Setting) => void;
}) {
  return (
    <div className="update-setting">
      <label>
        <span>{caption}</span>
        <select
          aria-label={name}
          onChange={(event) => {
            const next = parseUpdateSetting(event.target.value);
            if (next !== undefined) onChange(next);
          }}
          value={String(setting)}
        >
          {UPDATE_CHOICES.map(({ setting: choice, label }) => (
            <option key={choice} value={String(choice)}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {waiting > 0 && (
        <output aria-label={`${name} waiting`} className="update-waiting">
          {waiting} waiting
        </output>
      )}
    </div>
  );
}
