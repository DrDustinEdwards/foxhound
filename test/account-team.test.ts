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

  it("refuses a mismatched email even when the user already holds the account", () => {
    // Order check: legacy answers `wrong_user` 403 (route.ts:41-44) before it
    // looks at membership at all, so an invite addressed to someone else is not
    // rescued by the caller happening to be a member.
    expect(
      evaluateAcceptInvite(invite, membershipOnInvitedAccount, "someone-else@acme.com"),
    ).toEqual({ ok: false, reason: "email_mismatch" });
  });
});
