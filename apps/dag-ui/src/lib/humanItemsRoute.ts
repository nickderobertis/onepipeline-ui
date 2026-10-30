import { useCallback, useSyncExternalStore } from "react";

/**
 * The action-items page lives at its own path, `/human-items`, beside the app's
 * root, rather than in the query every run view shares: it is a separate view
 * with its own navigation entry, and an address naming it opens it whatever
 * else the query says. Read relative to wherever the app is served, so a bundle
 * served under a prefix keeps its pages under that prefix.
 */
const SEGMENT = /human-items\/?$/u;

export function isHumanItemsPath(pathname: string): boolean {
  return SEGMENT.test(pathname);
}

/** The app's root path: the address every run view is read at. */
export function appRootPath(pathname: string): string {
  return pathname.replace(SEGMENT, "") || "/";
}

function humanItemsPath(pathname: string): string {
  const root = appRootPath(pathname);
  return `${root.endsWith("/") ? root : `${root}/`}human-items`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

const currentPath = () => window.location.pathname;

export function useHumanItemsRoute(): {
  readonly active: boolean;
  readonly open: () => void;
} {
  const pathname = useSyncExternalStore(subscribe, currentPath, currentPath);
  const open = useCallback(() => {
    window.history.pushState(
      null,
      "",
      humanItemsPath(window.location.pathname),
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return { active: isHumanItemsPath(pathname), open };
}
