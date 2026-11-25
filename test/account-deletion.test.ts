import { DAY, NOW, OLD, OLDER, OWNER_EMAIL } from "./helpers/account-deletion-seed";
import {
  db,
  deleteUserAccountLocal,
  dumpAll,
  feePicture,
  foreignKeyViolations,
  seedBoth,
} from "./helpers/account-deletion";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { user } from "~/db/auth-schema";
import { accountDeletionHooks } from "~/lib/auth/delete-account.server";
import { ownedAccountNames } from "~/lib/auth/deletion-copy";
import { listMemberships } from "~/lib/auth/account";

describe("account deletion: the fee survives", () => {
  it("the fee for the account computes to the same amount after deletion as before", async () => {
    const { me } = await seedBoth();
    const before = await feePicture(me.accountId);
    expect(before.estimatedInvoice).toEqual([{ currency: "usd", cents: 2_000 + 10_000 }]);

    const result = await deleteUserAccountLocal(db, me.userId, NOW);
    expect(result.status).toBe("deleted");

    expect(await feePicture(me.accountId)).toEqual(before);
    expect(foreignKeyViolations()).toEqual([]);
  });

  it("keeps the evidence chain action -> recovery -> line item, by id", async () => {
    const { me } = await seedBoth();
    await deleteUserAccountLocal(db, me.userId, NOW);

    const rp = await db
      .select()
      .from(schema.recoveredPayments)
      .where(eq(schema.recoveredPayments.accountId, me.accountId));
    expect(rp.map((r) => r.id).sort()).toEqual(["me-rp-billable", "me-rp-billed", "me-rp-free"]);
    const steps = await db
      .select()
      .from(schema.recoverySteps)
      .where(eq(schema.recoverySteps.accountId, me.accountId));
    expect(steps.map((s) => s.id).sort()).toEqual(["me-step-billable", "me-step-billed"]);
    // The attributing click survives with its timing, so email_engaged stays provable.
    const clicks = await db
      .select()
      .from(schema.engagementEvents)
      .where(eq(schema.engagementEvents.accountId, me.accountId));
    expect(clicks.map((c) => c.id)).toEqual(["me-click-billable"]);
    expect(clicks[0].occurredAt).toEqual(OLDER);
    const fps = await db
      .select()
      .from(schema.failedPayments)
      .where(eq(schema.failedPayments.accountId, me.accountId));
    expect(fps.map((f) => f.id).sort()).toEqual(["me-fp-billable", "me-fp-billed", "me-fp-free"]);
    const disputes = await db
      .select()
      .from(schema.disputes)
      .where(eq(schema.disputes.accountId, me.accountId));
    expect(disputes.map((d) => d.id)).toEqual(["me-d-won"]);
    expect(disputes[0]).toMatchObject({
      stripeDisputeId: "dp_me_d-won",
      amountCents: 50_000,
      resolvedFeeCents: 10_000,
    });
    const approvals = await db
      .select()
      .from(schema.disputeApprovals)
      .where(eq(schema.disputeApprovals.accountId, me.accountId));
    expect(approvals.map((a) => a.id)).toEqual(["me-d-won-approval"]);
    const lines = await db
      .select()
      .from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.accountId, me.accountId));
    expect(lines.map((l) => l.recoveredPaymentId)).toEqual(["me-rp-billed"]);
    // The account row survives as the key the fee and its invoices hang from,
    // with the platform customer the invoice is charged to.
    const acct = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, me.accountId));
    expect(acct).toHaveLength(1);
    expect(acct[0].platformStripeCustomerId).toBe("cus_platform_me");
    expect(acct[0].cancelledAt).toEqual(NOW);
    expect(acct[0].liveSendsEnabled).toBe(false);
  });
});

describe("account deletion: scope", () => {
  it("a second deletion is a no-op and writes nothing", async () => {
    const { me } = await seedBoth();
    await deleteUserAccountLocal(db, me.userId, NOW);
    const after = dumpAll();
    const second = await deleteUserAccountLocal(db, me.userId, new Date(NOW.getTime() + DAY));
    expect(second.status).toBe("not_found");
    expect(dumpAll()).toEqual(after);
  });

  it("a member who owns nothing loses only their own membership and personal rows", async () => {
    const { other } = await seedBoth();
    await db.insert(user).values({
      id: "user_teammate",
      name: "Tess Teammate",
      email: "tess@globex.test",
      updatedAt: OLD,
    });
    await db.insert(schema.accountMembers).values({
      id: "ot-tess",
      accountId: other.accountId,
      userId: "user_teammate",
      role: "member",
      status: "active",
      createdAt: OLD,
    });
    await db.insert(schema.disputeApprovals).values({
      id: "ot-tess-approval",
      disputeId: "ot-d-open",
      accountId: other.accountId,
      approvedByUserId: "user_teammate",
      approvedByEmail: "tess@globex.test",
      evidenceVersionHash: "h",
      approvedAt: OLD,
    });
    const accountBefore = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, other.accountId));

    const result = await deleteUserAccountLocal(db, "user_teammate", NOW);
    expect(result).toEqual({ status: "deleted", accountIds: [], liveConnections: [] });

    expect(await db.select().from(user).where(eq(user.id, "user_teammate"))).toEqual([]);
    expect(
      await db.select().from(schema.accountMembers).where(eq(schema.accountMembers.id, "ot-tess")),
    ).toEqual([]);
    // The owner's membership and the account itself are untouched.
    expect(
      await db.select().from(schema.accountMembers).where(eq(schema.accountMembers.id, "ot-owner")),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.accounts).where(eq(schema.accounts.id, other.accountId)),
    ).toEqual(accountBefore);
    // Their email is gone from the approval they signed, and the approval stays.
    const approval = await db
      .select()
      .from(schema.disputeApprovals)
      .where(eq(schema.disputeApprovals.id, "ot-tess-approval"));
    expect(approval[0]).toMatchObject({
      approvedByEmail: null,
      approvedByUserId: null,
      evidenceVersionHash: "h",
    });
    expect(JSON.stringify(dumpAll())).not.toContain("tess@globex.test");
    expect(foreignKeyViolations()).toEqual([]);
  });
});

describe("account deletion: what the person is told and what an admin can retry", () => {
  it("a failed Stripe revoke after deletion leaves one admin_audit_log row with no personal data", async () => {
    const { me } = await seedBoth();
    const hooks = accountDeletionHooks({} as Env, {
      deauthorize: async (_env, stripeUserId) =>
        stripeUserId === "acct_me" ? { ok: false, error: "grant not found" } : { ok: true },
    });
    await hooks.beforeDelete({ id: me.userId });
    await db.delete(user).where(eq(user.id, me.userId));
    await hooks.afterDelete({ id: me.userId });

    const rows = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "user_self_deleted_account_deauthorize_failed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetUserId: me.userId,
      targetEmail: null,
      metadata: { connection_id: "me-conn", stripe_user_id: "acct_me", error: "grant not found" },
    });
    expect(JSON.stringify(rows[0])).not.toContain(OWNER_EMAIL);
  });

  it("the owned-account list names only accounts the person owns", async () => {
    const { me } = await seedBoth();
    await db.insert(schema.accounts).values({ id: "acct_beta", name: "Beta Co", createdAt: OLD });
    await db.insert(schema.accountMembers).values({
      id: "m_beta",
      accountId: "acct_beta",
      userId: me.userId,
      role: "owner",
      status: "active",
      createdAt: OLD,
    });
    // A membership in the other merchant's account is not owned, so it goes unnamed.
    await db.insert(schema.accountMembers).values({
      id: "m_joined",
      accountId: "acct_other",
      userId: me.userId,
      role: "member",
      status: "active",
      createdAt: OLD,
    });
    const names = ownedAccountNames(await listMemberships(db, me.userId));
    expect([...names].sort()).toEqual(["Acme Widgets LLC", "Beta Co"]);
  });
});
