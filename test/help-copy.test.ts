import { describe, expect, it } from "vitest";

import { SECTIONS } from "~/routes/app/help";

// Ruling 232's user-facing carrier. app/routes/app/help.tsx line 20 told
// merchants "Foxhound is single-account: ... they cannot create or switch
// between separate accounts", which states DESIGN.md's single-account RULE as a
// permanent product property. Ruling 53 revoked that rule.
//
// The correction is NOT to promise multi-account. At HEAD the database still
// enforces one active membership per user: app/db/schema.ts's
// `account_members_one_active_per_user_uq` is a unique index on user_id where
// status = 'active', and app/lib/auth/account.ts resolves a single membership
// and returns `already_member` on a second create. So the BEHAVIOUR the old copy
// described is real; what was wrong was presenting it as what Foxhound IS.
//
// These assertions pin the distinction: describe the behaviour, cite no revoked
// rule, and make no claim about a build that has not shipped.

const team = SECTIONS.find((s) => s.title === "Team");

describe("help copy: the Team section", () => {
  it("exists, so a rename cannot silently drop these assertions", () => {
    expect(team).toBeDefined();
  });

  it("still tells the merchant where to invite from", () => {
    expect(team?.body).toContain("Settings > Team");
  });

  it("does NOT assert the revoked single-account rule as a product property", () => {
    expect(team?.body).not.toMatch(/single-account/i);
    expect(team?.body).not.toMatch(/cannot create or switch/i);
  });

  it("does NOT promise the unshipped multi-account build", () => {
    // Promise-ahead-of-product is its own defect class (ruling 20b). The copy
    // may say what is true now; it may not advertise what is not built.
    expect(team?.body).not.toMatch(/multi-account/i);
    expect(team?.body).not.toMatch(/soon|coming|will be able|in future/i);
  });

  it("describes the behaviour the schema actually enforces today", () => {
    // One active membership per user, so an invite joins the existing account
    // and there is nothing to switch between.
    expect(team?.body).toMatch(/one account at a time/i);
    expect(team?.body).toMatch(/account switcher/i);
  });
});

describe("help copy: the whole section list", () => {
  it("carries no revoked single-account rule anywhere", () => {
    for (const section of SECTIONS) {
      expect(section.body).not.toMatch(/single-account/i);
    }
  });

  it("every section has a title and a non-empty body", () => {
    for (const section of SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(0);
    }
  });
});
