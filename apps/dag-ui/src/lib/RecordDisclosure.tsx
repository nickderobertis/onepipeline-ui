import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useState,
} from "react";

/** Keep large structured records out of the rendered tree until requested. */
function useRecordDisclosure(onOpen?: () => void) {
  const [open, setOpen] = useState(false);
  const onToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      const opened = event.currentTarget.open;
      setOpen(opened);
      if (opened) onOpen?.();
    },
    [onOpen],
  );
  return { open, onToggle };
}

export function RecordDisclosure({
  label,
  className,
  onOpen,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  /** Called each time the reader opens it, for a record read on request. */
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}) {
  const disclosure = useRecordDisclosure(onOpen);
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
