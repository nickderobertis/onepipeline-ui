import { useCallback, useEffect, useRef, useState } from "react";

/** The width the navigation stops being a column, as `styles.css` states it. */
const PHONE_WIDTH = "(max-width: 640px)";

/**
 * The navigation as a drawer at phone width: closed until the menu button opens
 * it, and closed by Escape, by its scrim, or by the caller when a choice is made.
 * Focus goes in with it and comes back to the button, so a keyboard is never left
 * on something hidden. Above that width none of this is on screen, so growing past
 * it closes the drawer rather than leaving the page beneath it inert.
 */
export function useNavigationDrawer() {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const opened = useRef(false);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((held) => !held), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const phone = window.matchMedia(PHONE_WIDTH);
    const onResize = () => {
      if (!phone.matches) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    phone.addEventListener("change", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      phone.removeEventListener("change", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (open) drawer.current?.querySelector("button")?.focus();
    else if (opened.current) menuButton.current?.focus();
    opened.current = open;
  }, [open]);

  return { open, close, toggle, menuButton, drawer };
}
