// The browser half of Foxhound's theme memory, shared by useThemeMemory (components/site-header.tsx) on a
// page that hydrates and the header island (islands/header.ts) on one that does not. Relative imports only:
// the islands are bundled on their own, without the app's `~` alias.
import { themeCookie } from "capsomer/theme-server";

import { THEME_COOKIE, type Theme } from "./theme";

/** Where a switch is saved: an authenticated merchant's to accounts.theme, anyone else's to the cookie. */
export type ThemeSave = "account" | "cookie";

/** Sets the theme button's browser memory to the server's answer, before the button reads it. */
export function rememberServerTheme(serverTheme: Theme, prefKey: string): void {
  try {
    localStorage.setItem(prefKey, serverTheme);
  } catch {
    // Storage blocked: the button falls back to <html data-theme>.
  }
}

/** Saves every switch of Capsomer's theme button (its `cap-theme` event) where Foxhound keeps it; returns
 *  the function that stops. `showing` is the theme on screen, so a repeat of it saves nothing. */
export function watchThemeChoice(
  showing: { current: Theme },
  save: ThemeSave,
  onChange?: (theme: Theme) => void,
): () => void {
  const onTheme = (e: Event) => {
    const choice = (e as CustomEvent<{ choice?: string }>).detail?.choice;
    if ((choice !== "light" && choice !== "dark") || choice === showing.current) return;
    showing.current = choice;
    onChange?.(choice);
    persistTheme(choice, save);
  };
  document.addEventListener("cap-theme", onTheme);
  return () => document.removeEventListener("cap-theme", onTheme);
}

function persistTheme(theme: Theme, save: ThemeSave): void {
  if (save === "account") {
    void fetch("/api/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    });
    return;
  }
  document.cookie = themeCookie(theme, { name: THEME_COOKIE, secure: location.protocol === "https:" });
}
