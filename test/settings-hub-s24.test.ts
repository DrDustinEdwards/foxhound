import { describe, expect, it } from "vitest";

import routes from "~/routes";
import {
  isSettingsItemActive,
  SETTINGS_NAV_GROUPS,
} from "~/components/settings-sidebar";
import { SETTINGS_HUB_ENTRIES } from "~/routes/app/settings/hub";

// SESSION 59: S24's hub and S25's sub-nav, replacing the inline-card index
// under 336 binding 2.
//
// THE ASSERTION THAT MATTERS IS "NO DEAD LINK". Legacy has twelve entries and
// Foxhound has nine (three were combined into others, 2026-10-29); an entry to a route that 404s is a false promise,
// so the hub and the sub-nav are both checked against the ROUTE TABLE rather
// than against a list in this file.

interface RouteEntry {
  path?: string;
  file: string;
  children?: RouteEntry[];
}

/** Every settings page path in the route table. */
const REGISTERED: string[] = (() => {
  const paths: string[] = [];
  const walk = (entries: RouteEntry[], base: string) => {
    for (const e of entries) {
      const full = e.path ? `${base}/${e.path}`.replace(/\/+/g, "/") : base;
      if (e.file.startsWith("./routes/app/settings/")) paths.push(full);
      if (e.children) walk(e.children, full);
    }
  };
  walk(routes as unknown as RouteEntry[], "");
  return paths;
})();

describe("PLANT 1: the hub has no dead link", () => {

  it("EVERY HUB ENTRY RESOLVES to a registered route", () => {
    for (const entry of SETTINGS_HUB_ENTRIES) {
      expect(REGISTERED, `${entry.label} points at ${entry.to}`).toContain(entry.to);
    }
  });

  it("EVERY SUB-NAV ITEM RESOLVES too", () => {
    for (const group of SETTINGS_NAV_GROUPS) {
      for (const item of group.items) {
        expect(REGISTERED, `${item.label} points at ${item.to}`).toContain(item.to);
      }
    }
  });
});

describe("PLANT 3: the active rule is legacy's, both halves", () => {
  it("OVERVIEW IS EXACT-MATCH, which is why it is not permanently active", () => {
    expect(isSettingsItemActive("/settings", "/settings")).toBe(true);
    expect(isSettingsItemActive("/settings/email", "/settings")).toBe(false);
    expect(isSettingsItemActive("/settings/team", "/settings")).toBe(false);
  });

  it("every other item matches itself or a child path", () => {
    expect(isSettingsItemActive("/settings/email", "/settings/email")).toBe(true);
    expect(isSettingsItemActive("/settings/email/anything", "/settings/email")).toBe(true);
    expect(isSettingsItemActive("/settings/emails", "/settings/email")).toBe(false);
    expect(isSettingsItemActive("/settings/team", "/settings/email")).toBe(false);
  });
});
