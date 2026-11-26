import { appOrigin } from "~/lib/app-origin";
import {
  activePrimaryConnectionWhere,
  primaryConnectionValue,
  senderNameOrAccountName,
} from "~/lib/stripe/connections.server";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Db, ExpiringCardAlertReason } from "~/db";
import { accounts, expiringCardAlerts, getDb, stripeConnections } from "~/db";
import { DAY_MS, EXPIRING_CARD_DAYS_AHEAD } from "~/lib/constants";
import { signCardUpdateToken } from "~/lib/card-update/token";
import { processEmailJob } from "~/lib/email/dispatch";
import { recoveryFooterNote } from "~/lib/email/templates";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { recordOutcome } from "~/lib/engine/outcomes";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import {
  expiringCardAlertContent,
  EXPIRING_CARD_TEMPLATE,
} from "~/lib/recovery/expiring-card-email";
import { errorMessage } from "@dustinedwards/site-runtime/log";

// THE EXPIRING-CARD ALERT CRON.
//
// THE OTHER WRITER is the Stripe webhook's customer.updated handler, which
// records candidates and never sends.

export const EXPIRING_CARD_SCAN_SOFT_LIMIT = 1000;

/** How many unsent candidates one tick will send. */
const EXPIRING_CARD_SEND_LIMIT = 100;

interface ScanAccount {
  accountId: string;
  connectionId: string;
  encryptedAccessToken: string;
}

/**
 * The accounts this tick scans: processing-eligible (which excludes demo,
 * paused and canceled) with a live Stripe connection.
 */
async function queryScanAccounts(env: Env): Promise<ScanAccount[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      accountId: stripeConnections.accountId,
      connectionId: stripeConnections.id,
      encryptedAccessToken: stripeConnections.stripeAccessToken,
    })
    .from(stripeConnections)
    .innerJoin(accounts, eq(accounts.id, stripeConnections.accountId))
    .where(and(isNull(stripeConnections.disconnectedAt), accountProcessingEligibleCondition()));

  return rows.flatMap((r) =>
    r.encryptedAccessToken
      ? [
          {
            accountId: r.accountId,
            connectionId: r.connectionId,
            encryptedAccessToken: r.encryptedAccessToken,
          },
        ]
      : [],
  );
}

export function isInsideLeadWindow(
  expMonth: number,
  expYear: number,
  now: Date,
  leadDays: number = EXPIRING_CARD_DAYS_AHEAD,
): boolean {
  const expiry = new Date(Date.UTC(expYear, expMonth - 1, 1));
  const horizon = new Date(now.getTime() + leadDays * DAY_MS);
  return expiry <= horizon && expiry >= now;
}

/**
 * A card is valid through the END of its expiry month, so it fails a charge
 * made on or after the first of the following month. Only the lead window's
 * horizon is dropped, because the charge date, not a fixed lead, is what
 * matters here.
 */
export function expiresBeforeCharge(
  expMonth: number,
  expYear: number,
  now: Date,
  chargeAt: Date,
): boolean {
  const expiry = new Date(Date.UTC(expYear, expMonth - 1, 1));
  const firstInvalid = new Date(Date.UTC(expYear, expMonth, 1));
  return expiry >= now && firstInvalid <= chargeAt;
}

export interface CandidateInput {
  accountId: string;
  connectionId: string;
  stripeCustomerId: string;
  customerEmail: string;
  customerName: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  expiresMonth: number;
  expiresYear: number;
  /** Omitted for a card: only the trial check records 'no_payment_method'. */
  reason?: ExpiringCardAlertReason;
}

/**
 * Record one candidate, or do nothing if this card-month is already recorded.
 *
 * Shared by BOTH writers so they cannot disagree.
 */
export function buildCandidateUpsert(db: Db, input: CandidateInput, now: Date) {
  return db
    .insert(expiringCardAlerts)
    .values({
      id: crypto.randomUUID(),
      accountId: input.accountId,
      stripeConnectionId: input.connectionId,
      stripeCustomerId: input.stripeCustomerId,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      cardBrand: input.cardBrand,
      cardLast4: input.cardLast4,
      expiresMonth: input.expiresMonth,
      expiresYear: input.expiresYear,
      reason: input.reason ?? "card_expiring",
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [
        expiringCardAlerts.accountId,
        expiringCardAlerts.stripeCustomerId,
        expiringCardAlerts.expiresMonth,
        expiringCardAlerts.expiresYear,
      ],
    });
}

export interface ScanResult {
  scanned: number;
  recorded: number;
  /**
   * Accounts whose subscription list crossed the soft ceiling, so the seat can
   * see it rather than infer it.
   */
  overLimit: string[];
}

export async function scanExpiringCards(env: Env, now: Date): Promise<ScanResult> {
  const db = getDb(env);
  const result: ScanResult = { scanned: 0, recorded: 0, overLimit: [] };

  for (const account of await queryScanAccounts(env)) {
    try {
      const stripe = getConnectedStripe(await decryptToken(env, account.encryptedAccessToken));
      let seen = 0;
      for await (const sub of stripe.subscriptions.list({
        status: "active",
        limit: 100,
        expand: [
          "data.customer",
          "data.default_payment_method",
          "data.customer.invoice_settings.default_payment_method",
        ],
      })) {
        if (seen >= EXPIRING_CARD_SCAN_SOFT_LIMIT) {
          result.overLimit.push(account.accountId);
          break;
        }
        seen += 1;
        result.scanned += 1;

        const customer = sub.customer;
        if (!customer || typeof customer === "string" || "deleted" in customer) continue;
        // The subscription's own card, else the customer's default, which is
        // what Stripe charges when the subscription names none.
        const pm = sub.default_payment_method ?? customer.invoice_settings?.default_payment_method;
        if (!pm || typeof pm === "string" || !pm.card) continue;
        const card = pm.card;
        if (!isInsideLeadWindow(card.exp_month, card.exp_year, now)) continue;
        if (!customer.email) continue;

        await db.batch([
          buildCandidateUpsert(
            db,
            {
              accountId: account.accountId,
              connectionId: account.connectionId,
              stripeCustomerId: customer.id,
              customerEmail: customer.email,
              customerName: customer.name ?? null,
              cardBrand: card.brand ?? null,
              cardLast4: card.last4 ?? null,
              expiresMonth: card.exp_month,
              expiresYear: card.exp_year,
            },
            now,
          ),
        ]);
        result.recorded += 1;
      }
    } catch (err) {
      // One account's Stripe failure must not stop the sweep.
      console.error(
        `expiring-card scan failed for account ${account.accountId}:`,
        errorMessage(err),
      );
    }
  }
  return result;
}

export interface SendResult {
  sent: number;
  skipped: number;
}

export async function sendExpiringCardAlerts(env: Env, now: Date): Promise<SendResult> {
  const db = getDb(env);
  const result: SendResult = { sent: 0, skipped: 0 };

  const due = await db
    .select({
      id: expiringCardAlerts.id,
      accountId: expiringCardAlerts.accountId,
      stripeCustomerId: expiringCardAlerts.stripeCustomerId,
      customerEmail: expiringCardAlerts.customerEmail,
      customerName: expiringCardAlerts.customerName,
      cardBrand: expiringCardAlerts.cardBrand,
      cardLast4: expiringCardAlerts.cardLast4,
      expiresMonth: expiringCardAlerts.expiresMonth,
      expiresYear: expiringCardAlerts.expiresYear,
      reason: expiringCardAlerts.reason,
      notificationsEnabled: accounts.expiringCardNotificationsEnabled,
      senderName: senderNameOrAccountName(
        primaryConnectionValue<string>(stripeConnections.senderName, expiringCardAlerts.accountId),
        accounts.name,
      ),
      replyToEmail: primaryConnectionValue<string>(
        stripeConnections.replyToEmail,
        expiringCardAlerts.accountId,
      ),
    })
    .from(expiringCardAlerts)
    .innerJoin(accounts, eq(accounts.id, expiringCardAlerts.accountId))
    .where(
      and(
        isNull(expiringCardAlerts.alertSentAt),
        isNull(expiringCardAlerts.deletedAt),
        accountProcessingEligibleCondition(),
        sql`exists (select 1 from ${stripeConnections} where ${activePrimaryConnectionWhere(expiringCardAlerts.accountId)})`,
      ),
    )
    .limit(EXPIRING_CARD_SEND_LIMIT);

  for (const alert of due) {
    if (!alert.accountId) {
      result.skipped += 1;
      continue;
    }
    // NULL is ON.
    if (alert.notificationsEnabled === false) {
      await stampSent(db, alert.id, now);
      result.skipped += 1;
      continue;
    }

    try {
      const token = await signCardUpdateToken(env, {
        expiringCardAlertId: alert.id,
        accountId: alert.accountId,
      });
      const outcome = await processEmailJob(
        env,
        {
          accountId: alert.accountId,
          to: alert.customerEmail,
          fromName: alert.senderName,
          replyTo: alert.replyToEmail,
          ...expiringCardAlertContent({
            reason: alert.reason,
            customerName: alert.customerName,
            cardBrand: alert.cardBrand,
            cardLast4: alert.cardLast4,
            expiresMonth: alert.expiresMonth,
            expiresYear: alert.expiresYear,
            senderName: alert.senderName,
            updateUrl: `${appOrigin(env)}/p/${token}`,
          }),
          footerNote: recoveryFooterNote(alert.senderName, now.getUTCFullYear()),
          template: EXPIRING_CARD_TEMPLATE,
          // CUSTOMER audience: the CAN-SPAM footer, the unsubscribe headers and
          // the suppression gate all apply, because this is commercial mail
          // sent on the merchant's behalf.
          unsubscribeToken: await signUnsubscribeToken(env, {
            email: alert.customerEmail,
            accountId: alert.accountId,
          }),
          physicalAddress: env.PHYSICAL_ADDRESS ?? "",
          idempotencyKey: `expiring-card:${alert.id}`,
          cronRunId: null,
        },
        null,
      );

      if (outcome.status === "suppressed" || outcome.status === "blocked") {
        await stampSent(db, alert.id, now);
        result.skipped += 1;
        continue;
      }
      if (outcome.status !== "sent") {
        result.skipped += 1;
        continue;
      }

      const claimed = await claimSent(db, alert.id, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      await recordOutcome(env, {
        accountId: alert.accountId,
        product: "recovery",
        eventType: "expiring_card_alert_sent",
        outcome: "sent",
        eventData: {
          expiresMonth: alert.expiresMonth,
          expiresYear: alert.expiresYear,
          cardBrand: alert.cardBrand,
          reason: alert.reason,
        },
        idempotencyKey: `expiring-card-alert:${alert.id}`,
        outcomeAt: now,
      });
      result.sent += 1;
    } catch (err) {
      console.error(`expiring-card send failed for alert ${alert.id}:`, errorMessage(err));
      result.skipped += 1;
    }
  }
  return result;
}

/**
 * Stamp without claiming: used for refusals, where nothing was sent and there
 * is no outcome to record.
 */
async function stampSent(db: Db, alertId: string, now: Date): Promise<void> {
  await db
    .update(expiringCardAlerts)
    .set({ alertSentAt: now })
    .where(and(eq(expiringCardAlerts.id, alertId), isNull(expiringCardAlerts.alertSentAt)));
}

/** THE SEND CLAIM. Returns whether this call took the claim. */
export async function claimSent(db: Db, alertId: string, now: Date): Promise<boolean> {
  await stampSent(db, alertId, now);
  const rows = await db
    .select({ alertSentAt: expiringCardAlerts.alertSentAt })
    .from(expiringCardAlerts)
    .where(eq(expiringCardAlerts.id, alertId))
    .limit(1);
  return rows[0]?.alertSentAt?.getTime() === now.getTime();
}

export interface ExpiringCardRunResult {
  scan: ScanResult;
  send: SendResult;
}

export async function runExpiringCards(env: Env, now: Date): Promise<ExpiringCardRunResult> {
  const scan = await scanExpiringCards(env, now);
  const send = await sendExpiringCardAlerts(env, now);
  return { scan, send };
}

export function describeExpiringCardRun(result: ExpiringCardRunResult): string {
  const over =
    result.scan.overLimit.length > 0
      ? `, ${result.scan.overLimit.length} account(s) over the ${EXPIRING_CARD_SCAN_SOFT_LIMIT} scan ceiling`
      : "";
  return (
    `scanned ${result.scan.scanned}, recorded ${result.scan.recorded}, ` +
    `sent ${result.send.sent}, skipped ${result.send.skipped}${over}`
  );
}
