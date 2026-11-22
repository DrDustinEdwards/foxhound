// Pure theme primitives (task Appendix A: "light exists as a first-class mode via [data-theme]").
import { isThemeChoice, type ThemeChoice } from "capsomer/theme-server";

export type Theme = ThemeChoice;
export const THEMES: readonly Theme[] = ["dark", "light"];

export const DEFAULT_THEME: Theme = "dark";

// Shared with theme.server.ts (read) and theme-toggle.tsx (client write); lives
// here, not in the .server module, since the client component needs it too.
export const THEME_COOKIE = "fh_theme";

/** Which theme a request should render under. */
export function resolveThemePreference(input: {
  accountTheme: string | null;
  cookieTheme: Theme | null;
}): Theme {
  // An account row exists, so it owns the answer.
  if (input.accountTheme !== null) {
    return isThemeChoice(input.accountTheme) ? input.accountTheme : DEFAULT_THEME;
  }
  return input.cookieTheme ?? DEFAULT_THEME;
}
