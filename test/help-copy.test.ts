import { describe, expect, it } from "vitest";

import { SECTIONS } from "~/routes/app/help";

// Ruling 232's user-facing carrier, corrected under 394 halt 3.
//
// THIS FILE'S OWN PREMISE WAS FALSE AT HEAD AND IS REPLACED, not extended. It
// read "at HEAD the database still enforces one active membership per user:
// `account_members_one_active_per_user_uq` is a unique index on user_id where
// status = 'active'", and drove its assertions from that. Migration 0018 DROPS
// that index and creates `account_members_user_account_active_uq` on
// (user_id, account_id), so one login holds many accounts. The test was pinning
// copy that had stopped being true, which is the worst failure mode available to
// a test: it does not merely miss the defect, it defends it.
//
// What the copy must now match, each verified at this sha rather than inherited:
//   - one login holds several accounts (migration 0018's index);
//   - the account switcher renders (app/components/header.tsx, both the desktop
//     and the mobile cluster, gated on isAuthenticated && accounts.length > 0);
//   - an invited teammate joins the account that invited them
//     (`evaluateAcceptInvite` returns the INVITE's accountId either way, and its
//     `existingOnInvitedAccount` argument is scoped to that account, not to any).
//
// 20b still binds in the other direction: the copy may say what is true now and
// may not advertise what is not built.

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

  it("does NOT deny the switcher that ships", () => {
    // The exact defect 394 halt 3 found. Phrased as a denial check rather than
    // as a search for "account switcher", because the OLD copy contained that
    // phrase too, inside "the app has no account switcher". A test looking only
    // for the words passed on both the true and the false sentence.
    expect(team?.body).not.toMatch(/no account switcher/i);
    expect(team?.body).not.toMatch(/one account at a time/i);
    expect(team?.body).not.toMatch(/belongs to one account/i);
  });

  it("does NOT promise anything beyond what ships", () => {
    expect(team?.body).not.toMatch(/soon|coming|will be able|in future/i);
  });

  it("says a login can hold several accounts", () => {
    expect(team?.body).toMatch(/several accounts/i);
  });

  it("says where the switcher is, not merely that one exists", () => {
    expect(team?.body).toMatch(/switcher in the header/i);
  });

  it("says an invite joins the inviting account, which is what the code does", () => {
    expect(team?.body).toMatch(/joins the account that invited them/i);
  });
});

describe("help copy: the whole section list", () => {
  it("carries no revoked single-account rule anywhere", () => {
    for (const section of SECTIONS) {
      expect(section.body).not.toMatch(/single-account/i);
    }
  });

  it("denies the switcher nowhere", () => {
    for (const section of SECTIONS) {
      expect(section.body).not.toMatch(/no account switcher/i);
    }
  });

  it("every section has a title and a non-empty body", () => {
    for (const section of SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(0);
    }
  });
});
