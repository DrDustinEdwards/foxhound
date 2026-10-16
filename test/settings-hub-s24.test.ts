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

  it("S32 arrived with J06 as one line in each list, as S35 did (J69)", () => {
    expect(SETTINGS_HUB_ENTRIES.map((e) => e.to)).toContain("/settings/disputes");
    const products = SETTINGS_NAV_GROUPS.find((g) => g.label === "Products");
    expect(products?.items.map((i) => i.to)).toEqual([
      "/settings/disputes",
      "/settings/intelligence",
      "/settings/audit",
    ]);
  });
});

describe("PLANT 2: the hub is legacy's list, in legacy's order", () => {
  it("twelve entries with legacy's labels and descriptions", () => {
    expect(
      SETTINGS_HUB_ENTRIES.map((e) => [e.to, e.label, e.description]),
    ).toEqual([
      ["/settings/stripe", "Stripe connections", "Connected accounts"],
      ["/settings/email", "Email", "Sender name, reply-to"],
      ["/settings/brand-voice", "Brand voice", "Per-category AI tone"],
      ["/settings/features", "Features", "Win-back, expiring cards"],
      // Recova's "Auto-submit, product description": auto-submit is not built
      // (RULES.md 5.6), so the description names what the page holds.
      ["/settings/disputes", "Disputes", "Product description, shipping"],
      ["/settings/intelligence", "Intelligence", "Notification preferences, not built yet"],
      ["/settings/audit", "Audit", "Lookback period, auto-run"],
      ["/settings/notifications", "Notifications", "Email, Slack, digest"],
      ["/settings/alerts", "Alerts", "Metric thresholds"],
      ["/settings/team", "Team", "Members, invite, roles"],
      ["/settings/api-keys", "API keys", "MCP server credentials"],
      ["/settings/account", "My account", "Profile, sign out"],
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

  it("THE GUIDE DESCRIBES THE HUB, every entry and nothing else", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    const body = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .join(" ");

    expect(body).toContain("Settings is a hub:");

    // BOTH DIRECTIONS. The LIST clause runs to the end of its sentence, and it
    // must name every rendered entry AND nothing else.
    const start = body.indexOf("Settings is a hub:");
    const listClause = body.slice(start, body.indexOf(", each on its own page", start));
    const named = listClause
      .replace("Settings is a hub:", "")
      .split(/,\s*(?:and\s+)?/)
      .map((n) => n.trim())
      .filter(Boolean);
    expect(named).toEqual(SETTINGS_HUB_ENTRIES.map((e) => e.label));
    // The caveat went with the page it described.
    expect(body).not.toContain("Disputes settings are not built yet");
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
      "Settings and Brand voice sets a different tone for each failure category",
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
    // J32: Recova saves the name and the context fields as ONE form, so one
    // intent carries both, written through applyIntelligenceContext.
    expect(account).toContain('name="_action" value="profile"');
    expect(account).toContain('name="merchantIndustry"');
    expect(account).toContain("applyIntelligenceContext(");
    expect(account).toContain('value="cancel-account"');
    // And each intent is handled, not just rendered.
    expect(account).toContain('case "profile"');
    expect(account).toContain('case "cancel-account"');
  });

  it("THE GENERAL BRAND VOICE KEEPS A WRITER, though not on the brand-voice page", () => {
    // CHANGED BY J36. Session 59 moved the general voice onto the brand-voice
    // page on the reading that Recova writes it from that form. It does not:
    // Recova's BrandVoiceSection (blob 9f4de70c) posts only the four category
    // fields, and no Recova page posts brand_voice_preset. RULES.md 1.2 makes a
    // control Recova never had an addition, so the page no longer carries it.
    expect(brandVoice).not.toContain('name="brandVoice"');
    // The column still has a writer: the merchant's agent tool, through the
    // same `applyBrandVoice` the page saves through, which writes the column
    // with `buildBrandVoiceUpdate`.
    const tools = readFileSync(
      fileURLToPath(new URL("../app/lib/mcp/tools.server.ts", import.meta.url)),
      "utf8",
    );
    expect(tools).toMatch(/applyBrandVoice\([\s\S]*?general:/);
    expect(brandVoice).toContain("applyBrandVoice");
    expect(
      readFileSync(
        fileURLToPath(new URL("../app/lib/settings/apply.server.ts", import.meta.url)),
        "utf8",
      ),
    ).toContain("buildBrandVoiceUpdate");
  });

  it("THE ACCOUNT PAGE CARRIES LEGACY'S EMAIL LINE AND SIGN OUT (S27, session 60)", () => {
    // Legacy's AccountSection opens with the signed-in address and a sign-out
    // control. Both were absent until session 60. Sign out POSTs to the
    // existing /logout route rather than legacy's GET link.
    expect(account).toContain("{userEmail}");
    expect(account).toContain('action="/logout"');
    expect(account).toContain("Sign out");
  });

  it("offers Cancel (333 binding 2) and, since S40, Delete through the deletion that keeps fee evidence", () => {
    // Until S40 this asserted Delete was ABSENT, because legacy's delete
    // cascades recovered_payments, the table PRICING rev 3 bills on. Dustin
    // ruled Q14 and Q16 (parity/ANSWERS-2026-10-14.md): deletion keeps those
    // records with personal details removed. So Delete is now offered, and the
    // assertion that matters is that it reaches the deletion module and not a
    // cascade.
    //
    // COMMENTS STRIPPED FIRST: the page's own comments explain the history, so
    // a raw grep would match the explanation (session 57's lesson).
    const code = account
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("Cancel account");
    expect(code).toContain("Delete account");
    expect(code).toContain("deleteUserAccount(env, auth.userId)");
    expect(code).not.toMatch(/delete_account_cascade|delete\(recoveredPayments\)/);
  });

  it("the stripe page carries the per-connection disconnect", () => {
    expect(stripe).toContain('value="disconnect-stripe"');
    expect(stripe).toContain('name="connectionId" value={conn.id}');
  });
});
