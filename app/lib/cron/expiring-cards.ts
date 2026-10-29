import { and, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, expiringCardAlerts, getDb, stripeConnections } from "~/db";
import { DAY_MS, EXPIRING_CARD_DAYS_AHEAD } from "~/lib/constants";
import { signCardUpdateToken } from "~/lib/card-update/token";
import { processEmailJob } from "~/lib/email/dispatch";
import { recoveryFooterNote } from "~/lib/email/templates";
import { recordOutcome } from "~/lib/engine/outcomes";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import {
  buildExpiringCardEmail,
  expiringCardSubject,
  EXPIRING_CARD_TEMPLATE,
} from "~/lib/recovery/expiring-card-email";

// THE EXPIRING-CARD ALERT CRON. Ported from legacy's
// app/api/cron/expiring-cards/route.ts (blob `717f6bbe`, 15,163 bytes), which
// runs two passes in one daily job (09:00 UTC, legacy's vercel.json "0 9 * * *")
// and this reproduces both.
//
// PASS 1, the scan: per connected account, list ACTIVE SUBSCRIPTIONS with the
// customer and default payment method expanded, and record a candidate for every
// card expiring inside the lead window. Legacy's candidate source is
// subscriptions, not customers and not payment methods.
//
// PASS 2, the send: every unsent candidate becomes one customer-facing email,
// claimed on `alert_sent_at` so a second tick sends nothing more.
//
// THE OTHER WRITER is the Stripe webhook's customer.updated handler, which
// records candidates and never sends. Both write through the same upsert onto
// the unique tuple migration 0019 added (341 bindings 3 and 4).

/** Legacy caps its scan at ONE page of 100 subscriptions per account with no
 *  pagination at all, so an account past its first page is silently skipped
 *  every night. 341 binding 5 rules that a defect, not a cap: this paginates
 *  fully and logs the count. The soft ceiling below only exists so one
 *  invocation stays inside a subrequest budget, and crossing it is reported
 *  rather than hidden. */
export const EXPIRING_CARD_SCAN_SOFT_LIMIT = 1000;

/** How many unsent candidates one tick will send. Legacy's is 100. */
const EXPIRING_CARD_SEND_LIMIT = 100;

interface ScanAccount {
  accountId: string;
  connectionId: string;
  encryptedAccessToken: string;
}

/**
 * The accounts this tick scans: processing-eligible (which excludes demo,
 * paused and canceled) with a live Stripe connection.
 *
 * The per-account toggle is deliberately NOT applied here. Legacy scans every
 * eligible account and applies `expiring_card_notifications_enabled` in the SEND
 * pass, stamping a disabled account's candidate so it is never retried. Ported
 * as found: the record of an expiring card is worth having even when the
 * merchant does not want the customer emailed.
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
      ? [{ accountId: r.accountId, connectionId: r.connectionId, encryptedAccessToken: r.encryptedAccessToken }]
      : [],
  );
}

/**
 * Legacy's band guard, ported as found (341 binding 6).
 *
 * `cardExpiry > now + lead` skips a card too far out; `cardExpiry < now` skips
 * one that has ALREADY EXPIRED. The window is a band, not a deadline, so a
 * lapsed card is never alerted on: legacy takes the view that the failure has
 * already happened and dunning owns it from there.
 *
 * The expiry instant is the FIRST of the expiry month, as legacy constructs it,
 * but in UTC rather than local time. Legacy's `new Date(year, month - 1, 1)` is
 * a LOCAL midnight; both platforms run UTC in production so the two agree
 * there, and `Date.UTC` makes the guard deterministic off it as well. A card
 * expiry month is a calendar fact, not a local-time instant.
 */
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
}

/**
 * Record one candidate, or do nothing if this card-month is already recorded.
 *
 * THE UPSERT IS THE DEDUPE and it is enforced by the database, not by a
 * preceding SELECT (314). Legacy's cron reads-then-inserts, which races its own
 * webhook writer; migration 0019's unique index makes the conflict a no-op
 * instead. Shared by BOTH writers so they cannot disagree.
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
  /** Accounts whose subscription list crossed the soft ceiling, so the seat can
   *  see it rather than infer it (341 binding 5). */
  overLimit: string[];
}

/** PASS 1. Fully paginated: `for await` walks every page, unlike legacy's single
 *  `limit: 100` call. */
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
        expand: ["data.customer", "data.default_payment_method"],
      })) {
        if (seen >= EXPIRING_CARD_SCAN_SOFT_LIMIT) {
          result.overLimit.push(account.accountId);
          break;
        }
        seen += 1;
        result.scanned += 1;

        const customer = sub.customer;
        if (!customer || typeof customer === "string" || "deleted" in customer) continue;
        const pm = sub.default_payment_method;
        if (!pm || typeof pm === "string" || !pm.card) continue;
        const card = pm.card;
        if (!isInsideLeadWindow(card.exp_month, card.exp_year, now)) continue;
        // No address, no email to send. Legacy inserts the row anyway and its
        // send pass would fail; refusing here keeps an unsendable candidate out
        // of the table entirely.
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
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

export interface SendResult {
  sent: number;
  skipped: number;
}

/**
 * PASS 2. Every unsent candidate, one email each.
 *
 * THE TOGGLE IS READ AS `!== false`, so NULL is ON, and a disabled account's
 * candidate is STAMPED rather than skipped, which is legacy's behavior: an
 * unstamped candidate would be reconsidered every night forever.
 *
 * The send is claimed on `alert_sent_at` conditionally, so a second tick over
 * the same candidate sends nothing.
 */
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
      notificationsEnabled: accounts.expiringCardNotificationsEnabled,
      senderName: sql<string | null>`(
        select ${stripeConnections.senderName} from ${stripeConnections}
        where ${stripeConnections.accountId} = ${expiringCardAlerts.accountId}
          and ${stripeConnections.isPrimary} = 1
          and ${stripeConnections.disconnectedAt} is null
        limit 1
      )`,
      // The Reply-To (J03), from the same primary row as the sender name.
      replyToEmail: sql<string | null>`(
        select ${stripeConnections.replyToEmail} from ${stripeConnections}
        where ${stripeConnections.accountId} = ${expiringCardAlerts.accountId}
          and ${stripeConnections.isPrimary} = 1
          and ${stripeConnections.disconnectedAt} is null
        limit 1
      )`,
    })
    .from(expiringCardAlerts)
    .innerJoin(accounts, eq(accounts.id, expiringCardAlerts.accountId))
    .where(
      and(
        isNull(expiringCardAlerts.alertSentAt),
        isNull(expiringCardAlerts.deletedAt),
        accountProcessingEligibleCondition(),
        // Recova skips an alert whose account has no primary live Stripe
        // connection and leaves it unstamped, so the customer is still warned
        // if the merchant reconnects inside the window (E12). Filtered here,
        // not in the loop, so unsendable rows never fill the 100-row page and
        // starve other merchants' alerts (RULES.md 1.5).
        sql`exists (
          select 1 from ${stripeConnections}
          where ${stripeConnections.accountId} = ${expiringCardAlerts.accountId}
            and ${stripeConnections.isPrimary} = 1
            and ${stripeConnections.disconnectedAt} is null
        )`,
      ),
    )
    .limit(EXPIRING_CARD_SEND_LIMIT);

  for (const alert of due) {
    if (!alert.accountId) {
      result.skipped += 1;
      continue;
    }
    // NULL is ON. A disabled account's candidate is stamped so it is never
    // reconsidered, which is legacy's behavior and not a Foxhound choice.
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
          subject: expiringCardSubject({
            cardBrand: alert.cardBrand,
            cardLast4: alert.cardLast4,
          }),
          blocks: buildExpiringCardEmail({
            customerName: alert.customerName,
            cardBrand: alert.cardBrand,
            cardLast4: alert.cardLast4,
            expiresMonth: alert.expiresMonth,
            expiresYear: alert.expiresYear,
            senderName: alert.senderName,
            updateUrl: `${env.BETTER_AUTH_URL ?? ""}/p/${token}`,
          }),
          // Recova's footer sentence (lib/email.ts wrapEmailHtml), with the
          // sender name as its From has it, before the unsubscribe link and
          // the postal address (E12).
          footerNote: recoveryFooterNote(alert.senderName, now.getUTCFullYear()),
          template: EXPIRING_CARD_TEMPLATE,
          // CUSTOMER audience: the CAN-SPAM footer, the unsubscribe headers and
          // the suppression gate all apply, because this is commercial mail sent
          // on the merchant's behalf.
          unsubscribeToken: await signUnsubscribeFor(env, alert.customerEmail, alert.accountId),
          physicalAddress: env.PHYSICAL_ADDRESS ?? "",
          idempotencyKey: `expiring-card:${alert.id}`,
          cronRunId: null,
        },
        null,
      );

      if (outcome.status === "suppressed" || outcome.status === "blocked") {
        // Legacy stamps a suppressed address so it stops burning a Stripe call
        // every night. A blocked account (demo, or live sends off) is stamped
        // for the same reason.
        await stampSent(db, alert.id, now);
        result.skipped += 1;
        continue;
      }
      if (outcome.status !== "sent") {
        // Transient: leave alert_sent_at NULL so tomorrow retries, exactly as
        // legacy does. The email_sends row already records the failure.
        result.skipped += 1;
        continue;
      }

      const claimed = await claimSent(db, alert.id, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      // THE OUTCOME, at legacy's fields (341 binding 1), recorded only by the
      // tick that took the claim, exactly as legacy records only after its own
      // conditional claim returns rows.
      //
      // It is a MOAT row, not a billing row: billable.ts keys on
      // recovered_payments and findAttributionSignals reads recovery_steps,
      // neither of which an alert touches. recordOutcome is used unchanged.
      await recordOutcome(env, {
        accountId: alert.accountId,
        product: "recovery",
        eventType: "expiring_card_alert_sent",
        outcome: "sent",
        eventData: {
          expiresMonth: alert.expiresMonth,
          expiresYear: alert.expiresYear,
          cardBrand: alert.cardBrand,
        },
        idempotencyKey: `expiring-card-alert:${alert.id}`,
        outcomeAt: now,
      });
      result.sent += 1;
    } catch (err) {
      console.error(
        `expiring-card send failed for alert ${alert.id}:`,
        err instanceof Error ? err.message : err,
      );
      result.skipped += 1;
    }
  }
  return result;
}

async function signUnsubscribeFor(env: Env, email: string, accountId: string): Promise<string> {
  const { signUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
  return signUnsubscribeToken(env, { email, accountId });
}

/** Stamp without claiming: used for refusals, where nothing was sent and there
 *  is no outcome to record. */
async function stampSent(db: Db, alertId: string, now: Date): Promise<void> {
  await db
    .update(expiringCardAlerts)
    .set({ alertSentAt: now })
    .where(and(eq(expiringCardAlerts.id, alertId), isNull(expiringCardAlerts.alertSentAt)));
}

/**
 * THE SEND CLAIM. Conditional on `alert_sent_at IS NULL`, so only the tick that
 * flips it counts the send, exactly as legacy claims before recording its
 * outcome. Returns whether this call took the claim.
 */
export async function claimSent(db: Db, alertId: string, now: Date): Promise<boolean> {
  await db
    .update(expiringCardAlerts)
    .set({ alertSentAt: now })
    .where(and(eq(expiringCardAlerts.id, alertId), isNull(expiringCardAlerts.alertSentAt)));
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

/** One daily run (09:00 UTC): scan, then send. */
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
