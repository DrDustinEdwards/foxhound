import type Stripe from "stripe";

import { CAU_EVENT_RETENTION_DAYS, DAY_MS } from "~/lib/constants";
import { pickDeclineCode } from "~/lib/recovery/decline";
import { getConnectedStripe } from "~/lib/stripe/client";
import { latestInvoiceCharge } from "~/lib/stripe/invoice-charge";
import {
  readCardUpdaterEvents,
  readDisputes,
  readOpenInvoices,
  readSubscriptions,
  readUncollectibleInvoices,
} from "~/lib/stripe/reads";

import { runAudit, type AuditInputs, type AuditResult, type ReadOutcome } from "./engine";
import { generateAuditSummary, type AuditSummaryOutcome } from "./summary.server";

// The five live reads, the pure engine and the one AI call, joined. Phase (f).
//
// THIS IS THE SEAM PHASES (a) TO (c) WERE BUILT AROUND, and it is deliberately
// the only impure thing in the audit's compute path: `engine.ts` and
// `summary.ts` contain no `await` at all and are pinned as such. Everything that
// touches the network is here or in `reads.ts`.
//
// NOTHING IN HERE WRITES. No `getDb`, no `executeMoneyWrite`, no
// `recordOutcome`. Persistence is the CALLER's decision because it depends on
// who is asking: legacy stores a run only when a signed-in account resolves, and
// an anonymous audit stores nothing at all. Keeping the write out of this module
// is what lets the anonymous path use it unchanged.
//
// THE FIVE READS RUN CONCURRENTLY AND DEGRADE INDEPENDENTLY. `Promise.all` is
// safe here only because `read()` never rejects: every reader returns a
// ScopeOutcome, so one Stripe failure yields `{ok:false, reason}` for that read
// and the engine turns it into a per-scope status (362 ruling 2). Legacy's
// `allSettled` reached the same shape and then threw the information away by
// zeroing the scope.

export interface AuditRunOutcome {
  result: AuditResult;
  summary: AuditSummaryOutcome;
}

/** The five reads for one account, as the engine consumes them. */
export async function collectAuditInputs(
  stripe: Stripe,
  lookbackDays: number,
  ranAt: Date,
): Promise<AuditInputs> {
  const nowMs = ranAt.getTime();
  const lookbackStartSeconds = Math.floor((nowMs - lookbackDays * DAY_MS) / 1000);
  // THE CARD UPDATER'S WINDOW IS THE SHORTER OF THE TWO, and the asymmetry is
  // legacy's: Stripe retains events for 30 days, so a 90-day lookback cannot ask
  // for 90 days of them. Mirrors the same clamp inside runAudit, which computes
  // the denominator over the same window.
  const cauWindowDays = Math.min(lookbackDays, CAU_EVENT_RETENTION_DAYS);
  const cauWindowStartSeconds = Math.floor((nowMs - cauWindowDays * DAY_MS) / 1000);

  const [uncollectibleInvoices, openInvoices, subscriptions, disputes, cardUpdaterEvents] =
    await Promise.all([
      readUncollectibleInvoices(stripe, lookbackStartSeconds),
      readOpenInvoices(stripe),
      readSubscriptions(stripe),
      readDisputes(stripe),
      readCardUpdaterEvents(stripe, cauWindowStartSeconds),
    ]);

  return {
    uncollectibleInvoices: await withDeclineCodes(stripe, uncollectibleInvoices),
    openInvoices: await withDeclineCodes(stripe, openInvoices),
    subscriptions,
    disputes,
    cardUpdaterEvents,
  };
}

/** Invoices read for their decline code, at most this many per list: each
 *  costs two Stripe calls, and the category breakdown is a sample beyond it. */
const DECLINE_LOOKUP_CAP = 100;

/**
 * Fill in each invoice's real decline code. On the pinned API version an
 * invoice carries no `charge` and no `last_payment_error`, so without this
 * every failed invoice read as "unknown" and the expired-card advice never
 * fired. The code comes off the latest charge, the way webhook intake reads
 * it, and is set where extractDeclineCode looks (`charge.failure_code`). A
 * failed read leaves that invoice as it was.
 */
async function withDeclineCodes(
  stripe: Stripe,
  outcome: ReadOutcome<Stripe.Invoice>,
): Promise<ReadOutcome<Stripe.Invoice>> {
  if (!outcome.ok) return outcome;
  const data = await Promise.all(
    outcome.data.map(async (invoice, index) => {
      if (index >= DECLINE_LOOKUP_CAP || !invoice.id) return invoice;
      try {
        const latest = await latestInvoiceCharge(stripe, invoice.id);
        if (!latest) return invoice;
        const { paymentIntent, charge } = latest;
        const code = pickDeclineCode([
          paymentIntent.last_payment_error?.decline_code,
          charge.outcome?.type === "issuer_declined" ? charge.outcome.reason : null,
          charge.failure_code,
        ]);
        return code ? ({ ...invoice, charge: { failure_code: code } } as Stripe.Invoice) : invoice;
      } catch {
        return invoice;
      }
    }),
  );
  return { ok: true, data };
}

/**
 * One audit, end to end, from a connected account's access token.
 *
 * THE TOKEN IS A PARAMETER AND NEVER A LOOKUP. The anonymous flow holds its
 * token in a five-minute cookie and has no row to read it from, so a signature
 * that took an account id could not serve it. `getConnectedStripe` is the same
 * factory every connected-account call in this repo already uses.
 */
export async function runFullAudit(
  env: Env,
  accessToken: string,
  stripeAccountId: string,
  lookbackDays: number,
  ranAt: Date = new Date(),
): Promise<AuditRunOutcome> {
  const stripe = getConnectedStripe(accessToken);
  const reads = await collectAuditInputs(stripe, lookbackDays, ranAt);
  const result = runAudit({ stripeAccountId, lookbackDays, ranAt, reads });
  const summary = await generateAuditSummary(env, result);
  return { result, summary };
}
