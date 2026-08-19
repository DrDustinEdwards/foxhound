import { and, desc, eq, lt } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, auditDigestRuns, getDb } from "~/db";
import { computeFoxhoundAddsCents, type CurrencyCents } from "~/lib/audit/full-audit.server";
import { accountProcessingEligibleCondition } from "~/lib/cron/recovery-tick";
import { sendTransactionalEmail } from "~/lib/email/send";
import { formatMoney } from "~/lib/money-format";
import { isDigestEnabled } from "~/lib/settings/audit-settings";

// The monthly audit digest (S30's cron, ruling 316, spec standing from 314).
//
// WHY IT EXISTS: /settings/audit ships legacy's copy promising "on the 1st of
// each month, we run a fresh audit and email you a comparison versus the prior
// month". 316 accepted that promise-ahead-of-product for a ONE-SESSION window.
// This closes it.
//
// THE GATE IS THE SHARED PREDICATE, NEVER A RE-DERIVED NULL READING. The
// account rows are selected on the PROCESSING gate only, and `isDigestEnabled`
// (app/lib/settings/audit-settings.ts) decides the opt-in in TypeScript, not a
// `= true` in SQL. That is deliberate and it is the whole design note of 316:
// Session 25 halted because nothing could SET the column, and the subtler
// repeat would be a cron that DISAGREES WITH THE PAGE about what NULL means.
// One exported predicate, read by both, forecloses it. A SQL-side
// `eq(auditAutoRun, true)` would silently re-derive that rule and could drift
// from the page without any test noticing.
//
// ACCOUNT STATES, ENUMERATED AND MATCHED rather than invented. All three
// per-account crons (recovery-tick, intelligence-sync, intelligence-ai) gate on
// exactly the same triple, so this reuses their predicate verbatim instead of
// minting a fourth copy:
//   processing_paused = false, cancelled_at IS NULL, id NOT LIKE 'demo\_%'
// And, like them, it deliberately does NOT gate on billing_exempt: the digest
// is free (the copy says "no extra charge"), so a billing-exempt merchant still
// gets theirs.
//
// CONTENT SCOPE, RULED THIS SESSION. Legacy's own cron
// (app/api/cron/run-scheduled-audits/route.ts, blob be1ed2ca, read whole) is
// the template spec, but it is filled by legacy's runAudit(), which produces
// MRR, ARR, active subscriptions, voluntary and involuntary churn bps, open
// disputes, disputes accepted, dispute win rate, expiring cards, past-due
// subscriptions, a card-updater advisory and an AI summary. Foxhound's audit
// entry point produces NONE of those. Dustin ruled the narrow option: Foxhound
// side numbers only, no live Stripe call. So `computeStripeInvoiceLiftBands` is
// deliberately NOT called here, which also keeps this cron off a path that
// full-audit.server.ts's own header records as never live-verified and which
// needs a connected access token (the single live connection's token is NULL).
//
// THE CONSEQUENCE IS STATED RATHER THAN HIDDEN: the account's lookback setting
// is therefore UNUSED by this cron. `computeFoxhoundAddsCents` is all-time and
// takes no window. The lookback control on /settings/audit still has no reader
// anywhere, which was true before this cron and is unchanged by it.

/** The month a run fires in covers the month that just ended. The cron fires on
 *  the 1st, so on 2026-09-01 the digest is September's send about August.
 *  Date.UTC normalizes month -1 across a year boundary. */
export function digestPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface CurrencyComparison {
  currency: string;
  /** The cumulative attributed-recovery total, this run. */
  cents: number;
  /** Change since the prior digest, or null when there is no prior snapshot. */
  changeCents: number | null;
}

/**
 * Compare this run's cumulative snapshot against the previous digest's.
 *
 * PER CURRENCY, NEVER SUMMED ACROSS THEM. core.md records cross-currency
 * summing as a live data-correctness defect in Intelligence; this does not
 * repeat it. A currency present in only one of the two snapshots still produces
 * a row (missing side reads 0), the same rule mergeAuditLiftBands already
 * applies, so a currency that went to zero is visible as a fall rather than
 * vanishing.
 *
 * A null `prior` means no previous digest exists, which is a FIRST RUN and not
 * a zero. The change is null, and the email says so rather than printing "+$0".
 */
export function compareTotals(
  current: CurrencyCents[],
  prior: CurrencyCents[] | null,
): CurrencyComparison[] {
  const priorByCurrency = new Map((prior ?? []).map((c) => [c.currency, c.cents]));
  const currentByCurrency = new Map(current.map((c) => [c.currency, c.cents]));
  const currencies = new Set([...currentByCurrency.keys(), ...priorByCurrency.keys()]);

  return [...currencies].sort().map((currency) => {
    const cents = currentByCurrency.get(currency) ?? 0;
    return {
      currency,
      cents,
      changeCents: prior === null ? null : cents - (priorByCurrency.get(currency) ?? 0),
    };
  });
}

/** The digest email. Named separately so its content is assertable without
 *  sending anything, mirroring buildFailureAlertEmail.
 *
 *  Plain semantic HTML, matching every other body this repo builds
 *  (app/lib/demo/email-copy.ts, app/lib/cron/alerts.server.ts). Legacy's
 *  designed table of inline-styled tiles has no counterpart here because
 *  Foxhound has no EMAIL_COLORS module and this is not the session to mint one. */
export function buildDigestEmail(
  comparisons: CurrencyComparison[],
  periodMonth: string,
): { subject: string; bodyHtml: string } {
  const lines = comparisons.length
    ? comparisons.map((c) => {
        const total = `<strong>${formatMoney(c.cents, c.currency)}</strong>`;
        if (c.changeCents === null) {
          return `<p>${total} recovered to date (${c.currency.toUpperCase()}).</p>`;
        }
        const dir = c.changeCents >= 0 ? "up" : "down";
        const delta = formatMoney(Math.abs(c.changeCents), c.currency);
        return `<p>${total} recovered to date (${c.currency.toUpperCase()}), ${dir} ${delta} since your last digest.</p>`;
      })
    : [`<p>No recovered payments are attributed to Foxhound yet.</p>`];

  const firstRun = comparisons.length > 0 && comparisons.every((c) => c.changeCents === null);

  return {
    subject: `Your monthly Foxhound report: ${periodMonth}`,
    bodyHtml: [
      `<p>Here is your audit digest for ${periodMonth}.</p>`,
      ...lines,
      firstRun
        ? `<p>This is your first digest, so there is no prior month to compare against yet. Next month's will show the change.</p>`
        : "",
      `<p>You are receiving this because the monthly audit digest is switched on in your Foxhound audit settings. Switch it off there at any time.</p>`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export interface DigestAccountRow {
  id: string;
  auditAutoRun: boolean | null;
  notificationEmail: string | null;
}

/** The processing-eligible accounts, with the columns the opt-in decision needs.
 *  Note what is NOT in the WHERE clause: the toggle. See the header. */
export async function digestCandidates(db: Db): Promise<DigestAccountRow[]> {
  return db
    .select({
      id: accounts.id,
      auditAutoRun: accounts.auditAutoRun,
      notificationEmail: accounts.notificationEmail,
    })
    .from(accounts)
    .where(accountProcessingEligibleCondition());
}

/** The prior digest's cumulative snapshot for this account, or null when this is
 *  the first one. Ordered by the period string, which sorts correctly because it
 *  is zero-padded YYYY-MM. */
export async function priorTotals(
  db: Db,
  accountId: string,
  periodMonth: string,
): Promise<CurrencyCents[] | null> {
  const row = (
    await db
      .select({ totals: auditDigestRuns.totals })
      .from(auditDigestRuns)
      .where(
        and(
          eq(auditDigestRuns.accountId, accountId),
          lt(auditDigestRuns.periodMonth, periodMonth),
        ),
      )
      .orderBy(desc(auditDigestRuns.periodMonth))
      .limit(1)
  )[0];
  return row?.totals ?? null;
}

/**
 * Claim this account's slot for this month. TRUE means this caller may send.
 *
 * THE REFUSAL IS THE DATABASE'S. The unique index on
 * (account_id, period_month) rejects the second insert, so two concurrent
 * monthly runs cannot both mail one merchant. Application-side
 * "select then insert" could interleave between the two statements; an index
 * cannot. Same shape as claimAlertSlot, for the reason 314 item 3 gave.
 */
export async function claimDigestSlot(
  db: Db,
  accountId: string,
  periodMonth: string,
  now: Date,
  cronRunId: string | null,
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await db.insert(auditDigestRuns).values({
      id,
      accountId,
      periodMonth,
      totals: null,
      status: "pending",
      error: null,
      sentAt: null,
      cronRunId,
      createdAt: now,
    });
    return id;
  } catch {
    // The unique index rejected it: this account already has this month's row.
    return null;
  }
}

export interface DigestRunResult {
  eligible: number;
  optedIn: number;
  sent: number;
  skippedDuplicate: number;
  skippedNoRecipient: number;
  failed: number;
  firstError: string | null;
}

/**
 * The whole run: every processing-eligible account, opted in through the shared
 * predicate, claimed by the database, mailed through the existing sender.
 *
 * FAILURE POSTURE, and it diverges from billing-monthly deliberately. Sibling
 * per-account crons swallow a per-account error and report it in the message.
 * This one isolates per account the same way (one merchant's failure never
 * stops another's digest) and then RETHROWS at the end if any account failed,
 * so runCronJob records the run failed and Session 24's alert path fires. A
 * digest that silently stops reaching a merchant is exactly the class 311 and
 * 313 exist to kill, and unlike billing there is no second surface where its
 * absence would show up.
 *
 * A CLAIMED MONTH IS NOT RETRIED. A failed send leaves the claim row in place
 * carrying its error, so next month's run does not re-attempt this month.
 * Retry-from-DLQ is explicitly out of scope; the row is the trace a human can
 * query, which is the same one-step posture the dead-letter table took.
 */
export async function runAuditDigest(
  env: Env,
  now: Date,
  cronRunId: string | null,
): Promise<DigestRunResult> {
  const db = getDb(env);
  const periodMonth = digestPeriod(now);
  const candidates = await digestCandidates(db);

  const result: DigestRunResult = {
    eligible: candidates.length,
    optedIn: 0,
    sent: 0,
    skippedDuplicate: 0,
    skippedNoRecipient: 0,
    failed: 0,
    firstError: null,
  };

  for (const account of candidates) {
    // THE SHARED PREDICATE. NULL and false are both off, exactly as the page
    // renders them.
    if (!isDigestEnabled(account.auditAutoRun)) continue;
    result.optedIn += 1;

    const claimId = await claimDigestSlot(db, account.id, periodMonth, now, cronRunId);
    if (claimId === null) {
      result.skippedDuplicate += 1;
      continue;
    }

    try {
      const totals = await computeFoxhoundAddsCents(db, account.id);
      const prior = await priorTotals(db, account.id, periodMonth);
      const comparisons = compareTotals(totals, prior);

      if (!account.notificationEmail) {
        await db
          .update(auditDigestRuns)
          .set({ totals, status: "no_recipient" })
          .where(eq(auditDigestRuns.id, claimId));
        result.skippedNoRecipient += 1;
        continue;
      }

      const message = buildDigestEmail(comparisons, periodMonth);
      await sendTransactionalEmail(env, {
        to: account.notificationEmail,
        subject: message.subject,
        bodyHtml: message.bodyHtml,
      });

      await db
        .update(auditDigestRuns)
        .set({ totals, status: "sent", sentAt: now })
        .where(eq(auditDigestRuns.id, claimId));
      result.sent += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : "digest failed";
      result.failed += 1;
      result.firstError ??= error;
      await db
        .update(auditDigestRuns)
        .set({ status: "failed", error })
        .where(eq(auditDigestRuns.id, claimId))
        .catch(() => {
          // Best effort. The throw below is what surfaces the failure.
        });
    }
  }

  if (result.failed > 0) {
    throw new Error(
      `${result.failed} of ${result.optedIn} digest(s) failed: ${result.firstError ?? "unknown"}`,
    );
  }

  return result;
}

/** How the run reads in cron_run_history and on /admin/operations. */
export function describeDigestRun(result: DigestRunResult): string {
  return (
    `${result.eligible} eligible, ${result.optedIn} opted in, ${result.sent} sent, ` +
    `${result.skippedDuplicate} already sent this month, ` +
    `${result.skippedNoRecipient} without a notification email`
  );
}
