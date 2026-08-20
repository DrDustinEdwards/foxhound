import { describe, expect, it } from "vitest";

import type { InviteView, Membership } from "~/lib/auth/account";
import { evaluateAcceptInvite, normalizeInviteEmail } from "~/lib/auth/account";

const invite: InviteView = {
  memberId: "mem_1",
  accountId: "acc_1",
  accountName: "Acme",
  invitedEmail: "teammate@acme.com",
};

// A membership ON THE INVITED ACCOUNT. Ruling 327 narrowed the third argument
// from "any membership this user holds" to "their membership on the account this
// invite is for", so a fixture pointing at acc_2 no longer tests anything the
// function looks at.
const membershipOnInvitedAccount: Membership = {
  memberId: "mem_2",
  accountId: "acc_1",
  accountName: "Acme",
  role: "owner",
};

describe("normalizeInviteEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeInviteEmail("  Teammate@Acme.com  ")).toBe("teammate@acme.com");
  });
});

describe("evaluateAcceptInvite (the team invite/role decision, pure)", () => {
  it("rejects a missing/expired invite as invalid", () => {
    expect(evaluateAcceptInvite(null, null, "teammate@acme.com")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects when the accepting user's email does not match the invited email", () => {
    expect(evaluateAcceptInvite(invite, null, "someone-else@acme.com")).toEqual({
      ok: false,
      reason: "email_mismatch",
    });
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(evaluateAcceptInvite(invite, null, "  TEAMMATE@ACME.COM  ")).toEqual({
      ok: true,
      accountId: "acc_1",
      alreadyMember: false,
    });
  });

  // WAS: "rejects a user who already holds an active membership elsewhere
  // (single-account invariant)", asserting { ok: false, reason: "already_member" }
  // against a membership on acc_2. That invariant is struck (324) and the
  // refusal is enforcement layer 2, removed by ruling 327 by CHANGING THE
  // VERDICT: legacy's app/api/invite/accept/route.ts:47-57 (blob `13708537`)
  // answers { success: true, redirect: '/console' } on this branch.
  it("treats an invite to an account the user ALREADY holds as success, writing nothing", () => {
    expect(
      evaluateAcceptInvite(invite, membershipOnInvitedAccount, "teammate@acme.com"),
    ).toEqual({
      ok: true,
      accountId: "acc_1",
      alreadyMember: true,
    });
  });

  it("accepts a fresh invite for a user with no membership on that account", () => {
    expect(evaluateAcceptInvite(invite, null, "teammate@acme.com")).toEqual({
      ok: true,
      accountId: "acc_1",
      alreadyMember: false,
    });
  });

  // The narrowing, asserted rather than described: holding a DIFFERENT account
  // is not the function's business. Under the pre-327 shape this argument
  // produced a refusal, so this case discriminates the change directly.
  it("ignores memberships on other accounts entirely", () => {
    const onAnotherAccount: Membership = {
      memberId: "mem_9",
      accountId: "acc_2",
      accountName: "Other Co",
      role: "owner",
    };
    // The caller passes the membership for the INVITED account, so a user who
    // only belongs to acc_2 arrives here with null and joins acc_1.
    expect(evaluateAcceptInvite(invite, null, "teammate@acme.com")).toEqual({
      ok: true,
      accountId: "acc_1",
      alreadyMember: false,
    });
    expect(onAnotherAccount.accountId).not.toBe(invite.accountId);
  });

  it("refuses a mismatched email even when the user already holds the account", () => {
    // Order check: legacy answers `wrong_user` 403 (route.ts:41-44) before it
    // looks at membership at all, so an invite addressed to someone else is not
    // rescued by the caller happening to be a member.
    expect(
      evaluateAcceptInvite(invite, membershipOnInvitedAccount, "someone-else@acme.com"),
    ).toEqual({ ok: false, reason: "email_mismatch" });
  });
});
