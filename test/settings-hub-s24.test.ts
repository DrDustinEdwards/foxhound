import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isSettingsItemActive,
  SETTINGS_NAV_GROUPS,
} from "~/components/settings-sidebar";
import { SETTINGS_HUB_ENTRIES } from "~/routes/app/settings/hub";

// SESSION 59: S24's hub and S25's sub-nav, replacing the inline-card index
// under 336 binding 2.
//
// THE ASSERTION THAT MATTERS IS "NO DEAD LINK". Legacy has twelve entries and
// Foxhound has eleven targets (J69 added /settings/intelligence); an entry to a route that 404s is a false promise,
// so the hub and the sub-nav are both checked against the ROUTE TABLE rather
// than against a list in this file.

/** Every settings path registered in routes.ts, derived from the source. */
const REGISTERED: string[] = (() => {
  const src = readFileSync(
    fileURLToPath(new URL("../app/routes.ts", import.meta.url)),
    "utf8",
  );
  const block = src.slice(src.indexOf('...prefix("settings"'), src.indexOf('route("help"'));
  const paths = ["/settings"];
  for (const m of block.matchAll(/route\("([a-z-]+)",\s*"\.\/routes\/app\/settings\//g)) {
    paths.push(`/settings/${m[1]}`);
  }
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

describe("PLANT 4: every settings path the docs name resolves", () => {
  it("the guides name no settings route that does not exist", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    const body = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .join(" ");

    // The docs name settings destinations in prose ("Settings and Team"), not
    // as URLs, so the check is that each named destination has a route.
    const named: [string, string][] = [
      ["Settings and Notifications", "/settings/notifications"],
      ["Settings and Alerts", "/settings/alerts"],
      ["Settings and API keys", "/settings/api-keys"],
      ["Settings and Team", "/settings/team"],
      ["Settings and Brand voice", "/settings/brand-voice"],
      ["Settings and Email", "/settings/email"],
      ["Settings and My account", "/settings/account"],
      ["features page", "/settings/features"],
      ["notifications page", "/settings/notifications"],
    ];
    for (const [phrase, path] of named) {
      expect(body, `${phrase} is named in the docs`).toContain(phrase);
      expect(REGISTERED, `${phrase} resolves to ${path}`).toContain(path);
    }
  });
});
