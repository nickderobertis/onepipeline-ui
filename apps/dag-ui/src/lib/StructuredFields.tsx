/** Render SDK records as labelled fields and lists, retaining absent/null readings. */
export function StructuredFields({
  value,
  label = "Record",
}: {
  readonly value: unknown;
  readonly label?: string;
}) {
  if (value === null || value === undefined) return <span>Not recorded</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "string" || typeof value === "number")
    return (
      <span className="whitespace-pre-wrap break-words">{String(value)}</span>
    );
  if (Array.isArray(value))
    return value.length === 0 ? (
      <span>None</span>
    ) : (
      <ol aria-label={label}>
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: SDK arrays may repeat identical values and carry no identity; these read-only fields hold no state or controls to transfer between entries.
          <li aria-label={`${label}.${index}`} key={index}>
            <StructuredFields label={`${label}.${index}`} value={item} />
          </li>
        ))}
      </ol>
    );
  if (typeof value === "object")
    return (
      <div className="structured-fields">
        {Object.entries(value).map(([key, field]) => (
          <fieldset aria-label={`${label}.${key}`} key={key}>
            <legend>{key.replaceAll("_", " ")}</legend>
            <StructuredFields label={`${label}.${key}`} value={field} />
          </fieldset>
        ))}
      </div>
    );
  return <span>Not recorded</span>;
}
