import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import {
  accountMembers,
  accountSubscriptions,
  accounts,
  alertHistory,
  alerts,
  billingInvoices,
  billingLineItems,
  customerContext,
  disputeApprovals,
  disputeEvidence,
  disputes,
  expiringCardAlerts,
  failedPayments,
  getDb,
  healthScoreHistory,
  intelligenceReports,
  mrrSnapshots,
  predictions,
  recoveredPayments,
  recoverySteps,
  stripeConnections,
  winBackSequences,
  winBackSteps,
} from "~/db";
import { grantIntelligence } from "~/lib/admin/merchants.server";
import { isBillableDisputeRow, isBillableRecoveryRow } from "~/lib/billing/billable-predicates";
import { disputeFeeCents, recoveryFeeCents } from "~/lib/billing/fees";
import { CRON_LOCK_LEASE_MS, DISPUTE_FEE_CAP_CENTS} from "~/lib/constants";

import {
  DEMO_ACCOUNT_ID,
  DEMO_ACCOUNT_NAME,
  DEMO_MEMBER_EMAIL,
  DEMO_MEMBER_USER_ID,
  DEMO_RESET_CRON_NAME,
} from "./constants";
import { buildTeamflowBase } from "./customer-base";
import { buildDisputesSeed } from "./disputes-seed";
import { buildIntelligenceSeed } from "./intelligence-seed";
import { buildNarrativeSeed } from "./narratives-seed";
import { buildRecoverySeed } from "./recovery-seed";

// The demo seeder. Builds ONE real account (Teamflow) and populates every product
// table with believable, DETERMINISTIC data, so the REAL app routes render a
// convincing portfolio (TASK-foxhound-demo-data-engine.md, porting the legacy
// six-module demo engine: customer-base, recovery-seed, disputes-seed,
// intelligence-seed, narratives-seed, composed here). This is NOT a set of mock
// pages: /dashboard, /recovery/*, /disputes/*, /intelligence/* all read these
// rows through their normal loaders.
//
// Two hard invariants:
//  - Firewall: the account id carries DEMO_ACCOUNT_ID_PREFIX and the row is
//    billing_exempt + processing_paused, so every Stripe/AI account enumeration
//    (billable.ts, recovery-tick, intelligence sync/ai) skips it. Every seed
//    module makes NO Stripe or Anthropic call: narratives/assessments are
//    pre-written strings, never a live model call. Every write here is a direct
//    db.insert/db.batch, never lib/engine/outcomes.ts's recordOutcome() -
//    demo rows must never reach the Network Intelligence Layer.
//  - Deterministic + idempotent: a fixed FNV-1a seed + fixed ids mean the same
//    data every run, and the seed always wipes the demo account's rows first,
//    so the reset cron can rebuild it repeatedly without drift or duplicate rows.
//
// Money is integer cents. Timestamps are relative to the passed-in `now`, so the
// data always looks recent no matter when the reset cron last ran.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Split an array into fixed-size chunks (keeps D1 statement/param counts bounded). */
function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Run a list of write statements as batched transactions (<=50 per batch). */
async function runBatched(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  for (const group of chunk(statements, 50)) {
    if (group.length === 0) continue;
    await db.batch(group as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

/** Every demo row, deleted child-table-first so D1's foreign keys never block a
 *  reset. All demo rows carry the demo account id, so a single equality wipes each. */
async function wipeDemoAccount(db: Db): Promise<void> {
  const acct = DEMO_ACCOUNT_ID;
  // Order matters under real FK enforcement (D1): children before parents.
  await runBatched(db, [
    db.delete(billingLineItems).where(eq(billingLineItems.accountId, acct)),
    db.delete(billingInvoices).where(eq(billingInvoices.accountId, acct)),
    db.delete(disputeApprovals).where(eq(disputeApprovals.accountId, acct)),
    db.delete(disputeEvidence).where(eq(disputeEvidence.accountId, acct)),
    db.delete(disputes).where(eq(disputes.accountId, acct)),
    db.delete(healthScoreHistory).where(eq(healthScoreHistory.accountId, acct)),
    db.delete(predictions).where(eq(predictions.accountId, acct)),
    db.delete(recoveredPayments).where(eq(recoveredPayments.accountId, acct)),
    db.delete(recoverySteps).where(eq(recoverySteps.accountId, acct)),
    db.delete(failedPayments).where(eq(failedPayments.accountId, acct)),
    db.delete(winBackSteps).where(eq(winBackSteps.accountId, acct)),
    db.delete(winBackSequences).where(eq(winBackSequences.accountId, acct)),
    db.delete(expiringCardAlerts).where(eq(expiringCardAlerts.accountId, acct)),
    db.delete(customerContext).where(eq(customerContext.accountId, acct)),
    db.delete(mrrSnapshots).where(eq(mrrSnapshots.accountId, acct)),
    db.delete(intelligenceReports).where(eq(intelligenceReports.accountId, acct)),
    db.delete(alertHistory).where(eq(alertHistory.accountId, acct)),
    db.delete(alerts).where(eq(alerts.accountId, acct)),
    db.delete(accountSubscriptions).where(eq(accountSubscriptions.accountId, acct)),
    db.delete(accountMembers).where(eq(accountMembers.accountId, acct)),
    db.delete(stripeConnections).where(eq(stripeConnections.accountId, acct)),
  ]);
  await db.delete(accounts).where(eq(accounts.id, acct));
}

/**
 * Seed (or re-seed) the demo account and all its data. Deletes the demo account's
 * existing rows first, so it is safe to run on every reset. Deterministic: same
 * `now` in, same data out (every seed module is a pure function of `now`).
 * Makes NO external call.
 */
export async function seedDemoAccount(db: Db, now: Date): Promise<void> {
  await wipeDemoAccount(db);

  const customers = buildTeamflowBase(now);
  const recovery = buildRecoverySeed(DEMO_ACCOUNT_ID, customers, now);
  const disputesSeed = buildDisputesSeed(DEMO_ACCOUNT_ID, now, DEMO_MEMBER_EMAIL);
  const intelligence = buildIntelligenceSeed({
    accountId: DEMO_ACCOUNT_ID,
    now,
    customers,
    failedPayments: recovery.failedPayments,
    recoveredPayments: recovery.recoveredPayments,
    disputes: disputesSeed.disputes,
  });
  const narrative = buildNarrativeSeed(DEMO_ACCOUNT_ID, now);
  const latestMrr = intelligence.mrrSnapshots[intelligence.mrrSnapshots.length - 1];

  // 1) Account + member. billing_exempt + processing_paused = the firewall flags
  //    (belt and suspenders alongside the demo_ id prefix).
  await db.insert(accounts).values({
    id: DEMO_ACCOUNT_ID,
    name: DEMO_ACCOUNT_NAME,
    currency: "usd",
    createdAt: new Date(now.getTime() - 400 * DAY_MS),
    billingExempt: true,
    processingPaused: true,
    onboardingCompleted: true,
    theme: "dark",
    mrrEstimateCents: latestMrr?.totalMrrCents ?? 0,
    notificationEmail: DEMO_MEMBER_EMAIL,
    digestEmail: DEMO_MEMBER_EMAIL,
  });
  await db.insert(accountMembers).values({
    id: `${DEMO_ACCOUNT_ID}_member`,
    accountId: DEMO_ACCOUNT_ID,
    userId: DEMO_MEMBER_USER_ID,
    role: "owner",
    status: "active",
    createdAt: new Date(now.getTime() - 400 * DAY_MS),
  });

  // Recovery dashboard parity (TASK-foxhound-recovery-surface-parity.md Phase
  // 2) needs a real, primary, still-connected stripe_connections row: Teamflow
  // is a fully operating simulated merchant, not an onboarding zero-state, so
  // connection-dependent panels (webhook health, "connected since") must have
  // something real to read instead of permanently reading as disconnected.
  // No access token: the demo firewall means nothing here ever calls Stripe.
  await db.insert(stripeConnections).values({
    id: `${DEMO_ACCOUNT_ID}_connection`,
    accountId: DEMO_ACCOUNT_ID,
    stripeUserId: "acct_demo_teamflow",
    isPrimary: true,
    connectedAt: new Date(now.getTime() - 380 * DAY_MS),
    lastWebhookAt: new Date(now.getTime() - 15 * 60_000),
    createdAt: new Date(now.getTime() - 380 * DAY_MS),
    senderName: DEMO_ACCOUNT_NAME,
  });

  // 2) Intelligence entitlement, via the real admin grant path (pure DB row,
  //    admin_granted, never Stripe), so the paid /intelligence surfaces render.
  await grantIntelligence(db, DEMO_ACCOUNT_ID, now);

  // 3) Customer portfolio (200 Teamflow + 7 net-new dispute customers) + health
  //    history + predictions for the at-risk subset.
  await runBatched(
    db,
    intelligence.customerContext.map((row) => db.insert(customerContext).values(row)),
  );
  await runBatched(
    db,
    intelligence.healthScoreHistory.map((row) => db.insert(healthScoreHistory).values(row)),
  );
  const predictionStmts: BatchItem<"sqlite">[] = intelligence.customerContext
    .filter((c) => (c.healthScore ?? 100) < 70)
    .map((c) =>
      db.insert(predictions).values({
        id: `dpred_${c.stripeCustomerId}`,
        accountId: DEMO_ACCOUNT_ID,
        stripeCustomerId: c.stripeCustomerId,
        score: c.healthScore ?? 0,
        bandEvidenceHash: `demo_${c.healthScore}`,
        horizonDays: 30,
        predictedAt: new Date(now.getTime() - 5 * DAY_MS),
        realizedOutcome: null,
      }),
    );
  await runBatched(db, predictionStmts);

  // 4) Recovery: failed payments + steps + recovered payments + win-back +
  //    expiring-card alerts (the day-walk simulator, app/lib/demo/recovery-seed.ts).
  await runBatched(
    db,
    recovery.failedPayments.map((row) => db.insert(failedPayments).values(row)),
  );
  await runBatched(
    db,
    recovery.recoverySteps.map((row) => db.insert(recoverySteps).values(row)),
  );
  await runBatched(
    db,
    recovery.recoveredPayments.map((row) => db.insert(recoveredPayments).values(row)),
  );
  await runBatched(
    db,
    recovery.winBackSequences.map((row) => db.insert(winBackSequences).values(row)),
  );
  await runBatched(
    db,
    recovery.winBackSteps.map((row) => db.insert(winBackSteps).values(row)),
  );
  await runBatched(
    db,
    recovery.expiringCardAlerts.map((row) => db.insert(expiringCardAlerts).values(row)),
  );

  // 5) Disputes: the 8-dispute Teamflow set, with evidence + approvals for the
  //    Foxhound-submitted ones (app/lib/demo/disputes-seed.ts).
  await runBatched(
    db,
    disputesSeed.disputes.map((row) => db.insert(disputes).values(row)),
  );
  await runBatched(
    db,
    disputesSeed.disputeEvidence.map((row) => db.insert(disputeEvidence).values(row)),
  );
  await runBatched(
    db,
    disputesSeed.disputeApprovals.map((row) => db.insert(disputeApprovals).values(row)),
  );

  // 6) Intelligence: mrr_snapshots (12 monthly points) + demo alert rules.
  await runBatched(
    db,
    intelligence.mrrSnapshots.map((row) => db.insert(mrrSnapshots).values(row)),
  );
  await runBatched(db, intelligence.alerts.map((row) => db.insert(alerts).values(row)));
  await runBatched(db, intelligence.alertHistory.map((row) => db.insert(alertHistory).values(row)));

  // 7) Intelligence report narrative (pre-written, NEVER an AI call).
  await db.insert(intelligenceReports).values(narrative);

  // 8) Billing ledger: one finalized invoice covering the billable subset of
  //    this run's own recoveries + disputes. isBillableRecoveryRow/
  //    isBillableDisputeRow (app/lib/billing/billable-predicates.ts) are the
  //    exact row-level rules app/db/billable.ts's live query encodes, factored
  //    out so the two cannot diverge; the demo account itself is firewalled out
  //    of that live query by accountBillingEligibleCondition() (billing_exempt +
  //    processing_paused + the demo_ id prefix), which is why the ledger is
  //    seeded directly here instead of calling getBillableRecoveries/
  //    getBillableDisputes.
  const approvedDisputeIds = new Set(disputesSeed.disputeApprovals.map((a) => a.disputeId));
  const billableRecoveries = recovery.recoveredPayments.filter((r) =>
    isBillableRecoveryRow(r, now.getTime()),
  );
  const billableDisputes = disputesSeed.disputes.filter((d) =>
    isBillableDisputeRow(d, approvedDisputeIds.has(d.id as string), now.getTime()),
  );

  if (billableRecoveries.length > 0 || billableDisputes.length > 0) {
    const invoiceId = "dinv_0";
    await db.insert(billingInvoices).values({
      id: invoiceId,
      accountId: DEMO_ACCOUNT_ID,
      currency: "usd",
      periodStart: new Date(now.getTime() - 30 * DAY_MS),
      periodEnd: now,
      status: "paid",
      totalCents: 0,
      idempotencyKey: `${invoiceId}_${DEMO_ACCOUNT_ID}`,
      createdAt: new Date(now.getTime() - 2 * DAY_MS),
      finalizedAt: new Date(now.getTime() - 2 * DAY_MS),
    });

    const lineItemStmts: BatchItem<"sqlite">[] = [];
    let invoiceTotal = 0;
    for (const r of billableRecoveries) {
      const fee = recoveryFeeCents(r.amountCents);
      invoiceTotal += fee;
      lineItemStmts.push(
        db.insert(billingLineItems).values({
          id: `dli_recovery_${r.id}`,
          invoiceId,
          accountId: DEMO_ACCOUNT_ID,
          type: "recovery_fee",
          currency: "usd",
          amountCents: fee,
          feeCents: fee,
          recoveredPaymentId: r.id,
          description: "20% of a recovered payment",
          createdAt: new Date(now.getTime() - 2 * DAY_MS),
        }),
      );
    }
    for (const d of billableDisputes) {
      const fee = d.resolvedFeeCents ?? disputeFeeCents(d.amountCents, DISPUTE_FEE_CAP_CENTS);
      invoiceTotal += fee;
      lineItemStmts.push(
        db.insert(billingLineItems).values({
          id: `dli_dispute_${d.id}`,
          invoiceId,
          accountId: DEMO_ACCOUNT_ID,
          type: "dispute_fee",
          currency: "usd",
          amountCents: fee,
          feeCents: fee,
          disputeId: d.id,
          description: "20% of a won dispute (capped at $500)",
          createdAt: new Date(now.getTime() - 2 * DAY_MS),
        }),
      );
    }
    await runBatched(db, lineItemStmts);
    await db.update(billingInvoices).set({ totalCents: invoiceTotal }).where(eq(billingInvoices.id, invoiceId));
  }
}

async function demoAccountExists(db: Db): Promise<boolean> {
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, DEMO_ACCOUNT_ID))
    .limit(1);
  return existing.length > 0;
}

interface DemoResetLock {
  acquire(leaseMs: number): Promise<boolean>;
  release(): Promise<void>;
}

const ENSURE_SEED_POLL_INTERVAL_MS = 150;
const ENSURE_SEED_POLL_MAX_ITERATIONS = 20; // ~3s, past one 1-2s reseed

/** Core of ensureDemoSeeded, taking the lock directly so it is testable against
 *  the in-memory DB without a Durable Object namespace. See ensureDemoSeeded. */
export async function ensureDemoSeededWithLock(db: Db, lock: DemoResetLock): Promise<void> {
  if (await demoAccountExists(db)) return; // fast path, no lock

  const acquired = await lock.acquire(CRON_LOCK_LEASE_MS);
  if (!acquired) {
    // The reset cron (or another enter) is mid-seed. Do not seed a second time
    // and do not fall through to an empty shell: poll for it to land.
    for (let i = 0; i < ENSURE_SEED_POLL_MAX_ITERATIONS; i++) {
      await new Promise((resolve) => setTimeout(resolve, ENSURE_SEED_POLL_INTERVAL_MS));
      if (await demoAccountExists(db)) return;
    }
    return; // budget expired; caller lands on a briefly thin dashboard, never a 500
  }
  try {
    // Re-check inside the lock: another enter or the reset cron may have
    // seeded between the fast-path check above and acquiring the lock.
    if (!(await demoAccountExists(db))) {
      await seedDemoAccount(db, new Date());
    }
  } finally {
    await lock.release();
  }
}

/**
 * Ensure the demo account exists before a visitor enters it, serialized against
 * the daily demo-reset cron (and any other concurrent caller) through the same
 * CronLock Durable Object the reset uses. See TASK-foxhound-demo-seed-race.md.
 */
export async function ensureDemoSeeded(env: Env): Promise<void> {
  const db = getDb(env);
  const lockNs = env.CRON_LOCK;
  const lock = lockNs.get(lockNs.idFromName(DEMO_RESET_CRON_NAME));
  await ensureDemoSeededWithLock(db, lock);
}
