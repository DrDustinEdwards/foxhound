// Pure theme primitives (task Appendix A: "light exists as a first-class
// mode via [data-theme]"). Ported from the legacy lib/theme.ts.

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "dark";

// Shared with theme.server.ts (read) and theme-toggle.tsx (client write); lives
// here, not in the .server module, since the client component needs it too.
export const THEME_COOKIE = "fh_theme";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}
