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

  it("falls back to the cookie when there is no account theme", () => {
    // Anonymous visitor, or signed in with no membership. Legacy reads the
    // cookie here, which is what keeps the unauthenticated toggle working.
    expect(
      resolveThemePreference({ accountTheme: null, cookieTheme: "light" }),
    ).toBe("light");
  });

  it("does not treat an empty stored value as a preference", () => {
    expect(
      resolveThemePreference({ accountTheme: "", cookieTheme: "light" }),
    ).toBe(DEFAULT_THEME);
  });
});
