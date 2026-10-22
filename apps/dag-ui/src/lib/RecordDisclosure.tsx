import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useState,
} from "react";

/** Keep large structured records out of the rendered tree until requested. */
function useRecordDisclosure() {
  const [open, setOpen] = useState(false);
  const onToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) =>
      setOpen(event.currentTarget.open),
    [],
  );
  return { open, onToggle };
}

export function RecordDisclosure({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const disclosure = useRecordDisclosure();
  return (
    <details
      aria-label={label}
      className={className}
      open={disclosure.open}
      onToggle={disclosure.onToggle}
    >
      <summary>{label}</summary>
      {disclosure.open && children}
    </details>
  );
}
