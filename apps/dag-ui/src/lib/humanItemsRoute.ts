import { useCallback, useSyncExternalStore } from "react";

/**
 * The action-items page lives at its own path, `/human-items`, beside the app's
 * root, rather than in the query every run view shares: it is a separate view
 * with its own navigation entry, and an address naming it opens it whatever
 * else the query says. The bundle is served at the root — its assets are
 * root-absolute — so the page's path is too.
 */
export const HUMAN_ITEMS_PATH = "/human-items";

/** Whether `pathname` is the page's: the whole path, with or without its slash. */
export function isHumanItemsPath(pathname: string): boolean {
  return pathname === HUMAN_ITEMS_PATH || pathname === `${HUMAN_ITEMS_PATH}/`;
}

/** The path every run view is read at, from wherever the app is. */
export function appRootPath(pathname: string): string {
  return isHumanItemsPath(pathname) ? "/" : pathname;
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
  // The page carries the sidebar's run-kind preference, which it shows too;
  // what a run view had selected stays behind with that view.
  const open = useCallback(() => {
    const kept = new URLSearchParams();
    for (const kind of new URLSearchParams(window.location.search).getAll(
      "hide-kind",
    ))
      kept.append("hide-kind", kind);
    const query = kept.size > 0 ? `?${kept}` : "";
    window.history.pushState(null, "", `${HUMAN_ITEMS_PATH}${query}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return { active: isHumanItemsPath(pathname), open };
}
