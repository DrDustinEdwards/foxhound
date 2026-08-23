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
// Foxhound has ten targets; an entry to a route that 404s is a false promise,
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
  it("the route table was actually parsed, so a miss cannot read as a pass", () => {
    expect(REGISTERED.length).toBeGreaterThanOrEqual(11);
    expect(REGISTERED).toContain("/settings");
  });

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

  it("the two absent targets are omitted rather than rendered dead", () => {
    // S32 and S35. When either ships it is one line in each list.
    const all = [
      ...SETTINGS_HUB_ENTRIES.map((e) => e.to),
      ...SETTINGS_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to)),
    ];
    expect(all).not.toContain("/settings/disputes");
    expect(all).not.toContain("/settings/intelligence");
  });
});

describe("PLANT 2: the hub is legacy's list, in legacy's order", () => {
  it("ten entries with legacy's labels and descriptions", () => {
    expect(
      SETTINGS_HUB_ENTRIES.map((e) => [e.to, e.label, e.description]),
    ).toEqual([
      ["/settings/stripe", "Stripe connections", "Connected accounts"],
      ["/settings/email", "Email", "Sender name, reply-to, domain"],
      ["/settings/brand-voice", "Brand voice", "Per-category AI tone"],
      ["/settings/features", "Features", "Win-back, expiring cards"],
      ["/settings/audit", "Audit", "Lookback period, auto-run"],
      ["/settings/notifications", "Notifications", "Email, Slack, digest"],
      ["/settings/alerts", "Alerts", "Metric thresholds"],
      ["/settings/team", "Team", "Members, invite, roles"],
      ["/settings/api-keys", "API keys", "MCP server credentials"],
      ["/settings/account", "My account", "Profile, appearance, sign out"],
    ]);
  });

  it("the sub-nav keeps legacy's five groups in legacy's order", () => {
    expect(SETTINGS_NAV_GROUPS.map((g) => g.label)).toEqual([
      "Recovery",
      "Products",
      "Notifications",
      "Workspace",
      "Account",
    ]);
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

  it("the relocated destinations are named at their NEW home", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    const body = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .join(" ");

    expect(body).toContain("cancel the account under Danger zone in Settings and My account");
    expect(body).toContain(
      "The industry, customer type and monthly revenue you enter under Settings and My account",
    );
    expect(body).toContain(
      "Settings and Brand voice holds the main brand voice and, below it, a different tone for each failure category",
    );
  });
});

describe("PLANT 5: the split left no surface without a writer", () => {
  const account = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/account.tsx", import.meta.url)),
    "utf8",
  );
  const brandVoice = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/brand-voice.tsx", import.meta.url)),
    "utf8",
  );
  const stripe = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/stripe.tsx", import.meta.url)),
    "utf8",
  );

  it("the account page carries the profile, the context fields and the danger zone", () => {
    // The first two go through SettingsCard, which renders the hidden
    // `_action` input from its `action` prop; the danger zone writes its own.
    expect(account).toContain('action="profile"');
    expect(account).toContain('action="intelligence-context"');
    expect(account).toContain('value="cancel-account"');
    // And each intent is handled, not just rendered.
    expect(account).toContain('case "profile"');
    expect(account).toContain('case "intelligence-context"');
    expect(account).toContain('case "cancel-account"');
  });

  it("THE GENERAL BRAND VOICE KEPT ITS WRITER, which the split would otherwise have removed", () => {
    // It lived on the index card. Legacy writes it from the brand-voice form,
    // so that is where it went; without this the column would have had no
    // writer at all after the split.
    expect(brandVoice).toContain('name="brandVoice"');
    expect(brandVoice).toContain("buildBrandVoiceUpdate");
  });

  it("the stripe page carries the per-connection disconnect", () => {
    expect(stripe).toContain('value="disconnect-stripe"');
    expect(stripe).toContain('name="connectionId" value={conn.id}');
  });
});
