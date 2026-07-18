import { describe, expect, it } from "vitest";

import type { InviteView, Membership } from "~/lib/auth/account";
import { evaluateAcceptInvite, normalizeInviteEmail } from "~/lib/auth/account";

const invite: InviteView = {
  memberId: "mem_1",
  accountId: "acc_1",
  accountName: "Acme",
  invitedEmail: "teammate@acme.com",
};

const existingMembership: Membership = {
  memberId: "mem_2",
  accountId: "acc_2",
  accountName: "Other Co",
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
    });
  });

  it("rejects a user who already holds an active membership elsewhere (single-account invariant)", () => {
    expect(evaluateAcceptInvite(invite, existingMembership, "teammate@acme.com")).toEqual({
      ok: false,
      reason: "already_member",
    });
  });

  it("accepts a fresh invite for a user with no existing membership", () => {
    expect(evaluateAcceptInvite(invite, null, "teammate@acme.com")).toEqual({
      ok: true,
      accountId: "acc_1",
    });
  });
});
