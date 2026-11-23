import { describe, expect, it } from "vitest";

import routes from "~/routes";
import { isSettingsItemActive, SETTINGS_NAV_GROUPS } from "~/components/settings-sidebar";
import { SETTINGS_HUB_ENTRIES } from "~/routes/app/settings/hub";

// An entry to a route that 404s is a false promise, so the hub and the sub-nav
// are checked against the route table rather than a list in this file.

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

describe("settings navigation", () => {
  it("every hub entry and sub-nav item resolves to a registered route", () => {
    for (const entry of SETTINGS_HUB_ENTRIES) {
      expect(REGISTERED, `${entry.label} points at ${entry.to}`).toContain(entry.to);
    }
    for (const group of SETTINGS_NAV_GROUPS) {
      for (const item of group.items) {
        expect(REGISTERED, `${item.label} points at ${item.to}`).toContain(item.to);
      }
    }
  });

  it("an item matches itself or a child path", () => {
    expect(isSettingsItemActive("/settings/email/anything", "/settings/email")).toBe(true);
    expect(isSettingsItemActive("/settings/emails", "/settings/email")).toBe(false);
    expect(isSettingsItemActive("/settings/team", "/settings/email")).toBe(false);
  });
});
