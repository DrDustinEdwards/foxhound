import { DEFAULT_THEME, isTheme, THEME_COOKIE, type Theme } from "./theme";

// Cookie-persisted theme (task Appendix A: "persisted via cookie so SSR
// renders the right mode with no flash", the legacy getThemeForRequest
// pattern rebuilt for Workers/RR8). Not HttpOnly: the client toggle
// (theme-toggle.tsx) writes it directly via document.cookie for an
// optimistic flip with zero round-trip.
export function getThemeFromRequest(request: Request): Theme {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== THEME_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return isTheme(value) ? value : DEFAULT_THEME;
  }
  return DEFAULT_THEME;
}
