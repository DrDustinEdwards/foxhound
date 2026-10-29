import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { buildDisputeTimeline } from "~/lib/disputes/timeline";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The rest of the dispute lifecycle on the connected-account webhook:
// charge.dispute.updated keeps the row current, funds_withdrawn and
// funds_reinstated record the money Stripe moved, and charge.dispute.closed as
// warning_closed closes an inquiry. Run end to end through
// processConnectedWebhook against the real migrated schema.

const ACCOUNT_ID = "acc_lifecycle";
const CONNECTION_ID = "conn_lifecycle";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const DAY = 24 * 60 * 60 * 1000;

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[] },
  ): Promise<{ applied: boolean }> => {
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch (err) {
      if (String(err).includes("UNIQUE")) return { applied: false };
      throw err;
    }
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const schema = await import("~/db/schema");

function disputeEvent(
  id: string,
  type: string,
  created: Date,
  dispute: Partial<Stripe.Dispute> & Record<string, unknown>,
): Stripe.Event {
  return {
    id,
    type,
    created: sec(created),
    account: "acct_connected_lifecycle",
    data: { object: { id: "dp_1", object: "dispute", charge: "ch_1", currency: "usd", ...dispute } },
  } as unknown as Stripe.Event;
}

async function seed(opts: { withDispute: boolean; status?: string }) {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(schema.accounts).values({ id: ACCOUNT_ID, name: "Lifecycle Co", createdAt: NOW });
  await db.insert(schema.stripeConnections).values({
    id: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    stripeUserId: "acct_connected_lifecycle",
    stripeAccessToken: "encrypted:token",
    isPrimary: true,
    createdAt: NOW,
  });
  if (opts.withDispute) {
    await db.insert(schema.disputes).values({
      id: "dsp_1",
      accountId: ACCOUNT_ID,
      stripeDisputeId: "dp_1",
      stripeChargeId: "ch_1",
      amountCents: 5000,
      currency: "usd",
      reason: "general",
      status: opts.status ?? "needs_response",
      evidenceDeadline: new Date(NOW.getTime() + 7 * DAY),
      createdAt: NOW,
      state: "pending_review",
    });
  }
  return db;
}

async function readDispute(db: Awaited<ReturnType<typeof seed>>) {
  const [row] = await db.select().from(schema.disputes).where(eq(schema.disputes.id, "dsp_1"));
  return row!;
}

describe("charge.dispute.updated", () => {
  it("keeps status, deadline, evidence counts, amount and reason current, and an older update never wins", async () => {
    const db = await seed({ withDispute: true });
    const newDeadline = new Date(NOW.getTime() + 12 * DAY);
    const at = new Date(NOW.getTime() + DAY);
    const updated = disputeEvent("evt_upd_2", "charge.dispute.updated", at, {
      status: "under_review",
      amount: 4500,
      reason: "fraudulent",
      evidence_details: { due_by: sec(newDeadline), has_evidence: true, submission_count: 1 } as Stripe.Dispute.EvidenceDetails,
    });
    expect(await processConnectedWebhook({} as Env, updated, at)).toEqual({ status: "applied" });

    // An update Stripe created earlier, delivered late.
    const stale = disputeEvent("evt_upd_1", "charge.dispute.updated", new Date(at.getTime() - 60_000), {
      status: "needs_response",
      amount: 5000,
      evidence_details: { due_by: sec(NOW), has_evidence: false, submission_count: 0 } as Stripe.Dispute.EvidenceDetails,
    });
    expect(await processConnectedWebhook({} as Env, stale, at)).toEqual({ status: "applied" });

    const row = await readDispute(db);
    expect(row).toMatchObject({
      status: "under_review",
      evidenceDeadline: newDeadline,
      stripeHasEvidence: true,
      stripeSubmissionCount: 1,
      amountCents: 4500,
      reason: "fraudulent",
      // Billing state is charge.dispute.closed's alone.
      state: "pending_review",
      submittedAt: null,
      resolvedFeeCents: null,
    });
  });
});

describe("charge.dispute.funds_withdrawn and funds_reinstated", () => {
  it("records each balance transaction once, even before intake has written the dispute", async () => {
    const db = await seed({ withDispute: false });
    const withdrawn = {
      id: "txn_w",
      object: "balance_transaction",
      amount: -5000,
      fee: 1500,
      currency: "usd",
      created: sec(NOW),
      reporting_category: "dispute",
    };
    const reinstated = {
      id: "txn_r",
      object: "balance_transaction",
      amount: 5000,
      fee: 0,
      currency: "usd",
      created: sec(new Date(NOW.getTime() + 20 * DAY)),
      reporting_category: "dispute_reversal",
    };
    const first = disputeEvent("evt_fw", "charge.dispute.funds_withdrawn", NOW, {
      status: "needs_response",
      balance_transactions: [withdrawn] as unknown as Stripe.BalanceTransaction[],
    });
    expect(await processConnectedWebhook({} as Env, first, NOW)).toEqual({ status: "applied" });
    expect(await processConnectedWebhook({} as Env, first, NOW)).toEqual({ status: "duplicate" });
    const second = disputeEvent("evt_fr", "charge.dispute.funds_reinstated", NOW, {
      status: "won",
      balance_transactions: [withdrawn, reinstated] as unknown as Stripe.BalanceTransaction[],
    });
    expect(await processConnectedWebhook({} as Env, second, NOW)).toEqual({ status: "applied" });

    const rows = await db.select().from(schema.disputeBalanceTransactions);
    expect(rows.map((r) => [r.kind, r.amountCents, r.feeCents, r.currency])).toEqual([
      ["withdrawn", -5000, 1500, "usd"],
      ["reinstated", 5000, 0, "usd"],
    ]);

    const labels = buildDisputeTimeline({
      createdAt: NOW,
      amountCents: 5000,
      currency: "usd",
      reason: "general",
      aiGeneratedAt: null,
      stagedAt: null,
      submittedAt: null,
      submittedBy: null,
      outcomeNotifiedAt: null,
      resolvedAt: null,
      state: "pending_review",
      funds: rows,
    }).map((i) => i.label);
    expect(labels).toContain("Funds withdrawn by Stripe: $50.00, plus a $15.00 Stripe dispute fee.");
    expect(labels).toContain("Funds reinstated by Stripe: $50.00.");
  });
});

describe("charge.dispute.closed as warning_closed", () => {
  it("closes the inquiry with no ruling and nothing billable", async () => {
    const db = await seed({ withDispute: true, status: "warning_needs_response" });
    const closed = disputeEvent("evt_closed", "charge.dispute.closed", NOW, { status: "warning_closed" });
    expect(await processConnectedWebhook({} as Env, closed, NOW)).toEqual({ status: "applied" });

    const row = await readDispute(db);
    expect(row).toMatchObject({
      state: "inquiry_closed",
      status: "warning_closed",
      resolvedAt: NOW,
      resolvedFeeCents: null,
      outcome: null,
    });

    // A late update does not reopen it.
    const late = disputeEvent("evt_late", "charge.dispute.updated", new Date(NOW.getTime() + 1000), {
      status: "warning_under_review",
    });
    await processConnectedWebhook({} as Env, late, NOW);
    expect((await readDispute(db)).state).toBe("inquiry_closed");
  });
});
