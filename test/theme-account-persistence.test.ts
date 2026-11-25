import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, resolveThemePreference } from "~/lib/theme";

describe("resolveThemePreference", () => {
  it("falls back to the cookie without an account theme, and ignores an empty one", () => {
    expect(resolveThemePreference({ accountTheme: null, cookieTheme: "light" })).toBe("light");
    expect(resolveThemePreference({ accountTheme: "", cookieTheme: "light" })).toBe(DEFAULT_THEME);
  });
});
