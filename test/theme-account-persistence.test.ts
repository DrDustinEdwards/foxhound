import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, resolveThemePreference } from "~/lib/theme";

// Ruling 59: legacy persists an authenticated merchant's theme to
// accounts.theme so the choice follows them across devices and sessions
// (legacy lib/theme-server.ts:18-19 is the reader spec, and the writer is the
// authenticated toggle POSTing to /api/account/theme). Foxhound was cookie
// only because the write was never ported, which is the whole reason
// accounts.theme looked like a dead column.
//
// These tests are written to FAIL against the cookie-only path. The two that
// matter are "the stored theme wins over a stale cookie" and "a signed-in
// merchant on a fresh device gets their stored theme": both are exactly the
// cross-device behaviour a cookie cannot provide.
describe("resolveThemePreference (ruling 59)", () => {
  it("prefers the stored account theme over a stale cookie", () => {
    // The cross-device case in miniature: this browser last wrote dark, the
    // account says light. Legacy returns the account value. Cookie-only
    // returns dark.
    expect(
      resolveThemePreference({ accountTheme: "light", cookieTheme: "dark" }),
    ).toBe("light");
  });

  it("returns the stored theme on a device with no cookie at all", () => {
    // A merchant signing in on a second device. There is no cookie to read,
    // so a cookie-only implementation falls back to the default and silently
    // loses the preference.
    expect(
      resolveThemePreference({ accountTheme: "light", cookieTheme: null }),
    ).toBe("light");
  });

  it("falls back to the cookie when there is no account theme", () => {
    // Anonymous visitor, or signed in with no membership. Legacy reads the
    // cookie here, which is what keeps the unauthenticated toggle working.
    expect(
      resolveThemePreference({ accountTheme: null, cookieTheme: "light" }),
    ).toBe("light");
  });

  it("falls back to the default with neither source", () => {
    expect(
      resolveThemePreference({ accountTheme: null, cookieTheme: null }),
    ).toBe(DEFAULT_THEME);
  });

  it("ignores a corrupt stored value rather than rendering an invalid theme", () => {
    // accounts.theme is a free text column (schema.ts:93), so it can hold
    // anything. Legacy guards with isTheme and falls through to the default.
    // It does NOT fall through to the cookie: a corrupt account row should
    // not silently hand control back to the device.
    expect(
      resolveThemePreference({ accountTheme: "chartreuse", cookieTheme: "light" }),
    ).toBe(DEFAULT_THEME);
  });

  it("does not treat an empty stored value as a preference", () => {
    expect(
      resolveThemePreference({ accountTheme: "", cookieTheme: "light" }),
    ).toBe(DEFAULT_THEME);
  });
});
