import { useCallback, useState } from "react";

/**
 * How one area of the page takes the changes the tab's stream delivers: as they
 * arrive, every so many seconds, or not at all.
 */
export type UpdateSetting = "live" | 10 | 30 | 60 | 300 | "off";

/** The choices one setting offers, in the order its list shows them. */
export const UPDATE_CHOICES: readonly {
  readonly setting: UpdateSetting;
  readonly label: string;
}[] = [
  { setting: "live", label: "Live" },
  { setting: 10, label: "Every 10 seconds" },
  { setting: 30, label: "Every 30 seconds" },
  { setting: 60, label: "Every minute" },
  { setting: 300, label: "Every 5 minutes" },
  { setting: "off", label: "Off" },
];

/** Rows that jump while being read look like something going wrong. */
export const DEFAULT_NAVIGATION_UPDATES: UpdateSetting = 30;
/** Action items are to appear at once. */
export const DEFAULT_MAIN_UPDATES: UpdateSetting = "live";

/** The areas with a setting, and where a browser remembers each. */
const STORAGE_KEYS = {
  navigation: "dag-ui.updates.navigation",
  main: "dag-ui.updates.main",
} as const;

/** The setting a list's value or a stored word names, if it names one. */
export function parseUpdateSetting(
  value: string | null,
): UpdateSetting | undefined {
  return UPDATE_CHOICES.find(({ setting }) => String(setting) === value)
    ?.setting;
}

/** What this browser remembers: storage a browser refuses is nothing remembered. */
function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, setting: UpdateSetting): void {
  try {
    window.localStorage.setItem(key, String(setting));
  } catch {
    // Refused storage costs the memory across a reload and nothing else.
  }
}

function useRememberedSetting(key: string, fallback: UpdateSetting) {
  const [setting, setSetting] = useState<UpdateSetting>(
    () => parseUpdateSetting(remembered(key)) ?? fallback,
  );
  const choose = useCallback(
    (next: UpdateSetting) => {
      setSetting(next);
      remember(key, next);
    },
    [key],
  );
  return [setting, choose] as const;
}

/** The two settings, each remembered per browser, independently of the other. */
export function useUpdateSettings() {
  const [navigation, setNavigation] = useRememberedSetting(
    STORAGE_KEYS.navigation,
    DEFAULT_NAVIGATION_UPDATES,
  );
  const [main, setMain] = useRememberedSetting(
    STORAGE_KEYS.main,
    DEFAULT_MAIN_UPDATES,
  );
  return { navigation, setNavigation, main, setMain };
}
