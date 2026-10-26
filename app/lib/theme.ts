// Pure theme primitives (task Appendix A: "light exists as a first-class
// mode via [data-theme]"). Ported from the legacy lib/theme.ts. The choice type
// and its check are Capsomer's (capsomer/theme-server); what Foxhound adds is
// the account's stored preference, which outranks the device's cookie.
import { isThemeChoice, type ThemeChoice } from "capsomer/theme-server";

export type Theme = ThemeChoice;
export const THEMES: readonly Theme[] = ["dark", "light"];

export const DEFAULT_THEME: Theme = "dark";

// Shared with theme.server.ts (read) and theme-toggle.tsx (client write); lives
// here, not in the .server module, since the client component needs it too.
export const THEME_COOKIE = "fh_theme";

export const isTheme = isThemeChoice;

/**
 * Which theme a request should render under.
 *
 * `accountTheme` is the accounts.theme value for the viewer's resolved
 * membership, or null when there is no session or no membership. Pure so the
 * decision is testable without a DB, matching the house pattern
 * (evaluateAcceptInvite in lib/auth/account).
 */
export function resolveThemePreference(input: {
  accountTheme: string | null;
  cookieTheme: Theme | null;
}): Theme {
  // An account row exists, so it owns the answer. A corrupt value falls to the
  // default rather than back to the cookie: accounts.theme is free text
  // (schema.ts:93), and handing control back to the device on a bad row would
  // make the stored preference silently stop applying.
  if (input.accountTheme !== null) {
    return isTheme(input.accountTheme) ? input.accountTheme : DEFAULT_THEME;
  }
  return input.cookieTheme ?? DEFAULT_THEME;
}
