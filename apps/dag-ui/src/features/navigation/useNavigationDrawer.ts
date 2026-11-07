import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The navigation as a drawer at phone width: closed until the menu button opens
 * it, and closed by Escape, by its scrim, or by the caller when a choice is made.
 * Focus goes in with it and comes back to the button, so a keyboard is never left
 * on something hidden. `styles.css` alone says at which width the navigation is a
 * drawer, by showing the menu button; once a resize has hidden the button, the drawer
 * closes rather than leaving the page beneath it inert.
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
    const onResize = () => {
      if (menuButton.current?.offsetParent === null) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (open) drawer.current?.querySelector("button")?.focus();
    else if (opened.current) menuButton.current?.focus();
    opened.current = open;
  }, [open]);

  return { open, close, toggle, menuButton, drawer };
}
