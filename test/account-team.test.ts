import { describe, expect, it } from "vitest";

import type { Membership } from "~/lib/auth/account";
import type { InviteView } from "~/lib/auth/invites";
import { evaluateAcceptInvite } from "~/lib/auth/invites";

const invite: InviteView = {
  memberId: "mem_1",
  accountId: "acc_1",
  accountName: "Acme",
  invitedEmail: "teammate@acme.com",
};

// The caller's membership on the invited account.
const membershipOnInvitedAccount: Membership = {
  memberId: "mem_2",
  accountId: "acc_1",
  accountName: "Acme",
  role: "owner",
};

describe("evaluateAcceptInvite (the team invite/role decision, pure)", () => {
  it("rejects a missing/expired invite as invalid", () => {
    expect(evaluateAcceptInvite(null, null, "teammate@acme.com")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(evaluateAcceptInvite(invite, null, "  TEAMMATE@ACME.COM  ")).toEqual({
      ok: true,
      accountId: "acc_1",
      alreadyMember: false,
    });
  });

  it("treats an invite to an account the user ALREADY holds as success, writing nothing", () => {
    expect(evaluateAcceptInvite(invite, membershipOnInvitedAccount, "teammate@acme.com")).toEqual({
      ok: true,
      accountId: "acc_1",
      alreadyMember: true,
    });
  });

  it("refuses a mismatched email even when the user already holds the account", () => {
    // An invite addressed to someone else is not rescued by the caller being a member.
    expect(
      evaluateAcceptInvite(invite, membershipOnInvitedAccount, "someone-else@acme.com"),
    ).toEqual({ ok: false, reason: "email_mismatch" });
  });
});
