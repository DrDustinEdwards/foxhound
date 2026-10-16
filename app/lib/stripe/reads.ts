import type Stripe from "stripe";

import type { ReadOutcome } from "~/lib/audit/engine";

// Phase (b) of the audit port, ruled by 362 ruling 4. The Stripe half the pure
// engine takes as injected input.
//
// EVERY LIST HERE IS PAGINATED TO THE END (RULES.md 3.19), and that is the
// whole reason this module exists. Legacy's audit issues five `limit: 100`
// calls and reads exactly one page of each, so a merchant past their first
// hundred subscriptions gets an audit of their first hundred and no sign that
// anything was left out. 341 found the same defect in the expiring-card scan
// and fixed it there with `for await`; this is that fix generalized.
//
// EVERY ROW IS NARROWED AS IT IS READ (J63 review round 1). Paging to the end
// with whole Stripe objects held in memory puts a large merchant's audit at
// the mercy of the Worker's 128 MB: an expanded subscription carries its
// customer, its payment method and its items, and none of that is read. So
// each page is cut down to the fields the engine reads before the next page
// arrives, and the full object is never kept. The narrowed rows are typed as
// the Stripe objects the engine takes; the fields left out are fields the
// engine does not read, which the equivalence test in
// test/audit-results-j63.test.ts holds.
//
// A FAILED READ IS DATA, NOT A THROW. Each read answers `{ ok: false, reason }`,
// which the engine turns into that scope's failed status, so a Stripe outage
// renders as "we could not read this" instead of as a zero (362 ruling 2).

/**
 * Walk an auto-paginating Stripe list to the end, keeping only what `narrow`
 * returns for each row.
 *
 * THE ONE IMPLEMENTATION. Every reader below goes through this, so a new read
 * cannot arrive with its own hand-rolled paging, with none, or with whole
 * objects kept.
 */
export async function collectPaginated<T, R>(
  list: AsyncIterable<T>,
  narrow: (item: T) => R,
): Promise<R[]> {
  const rows: R[] = [];
  for await (const item of list) rows.push(narrow(item));
  return rows;
}

/** The reason string a caller sees when a read throws. Never the raw error
 *  object, which can carry request context, and never a wide dash. */
function reasonFor(what: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : "unknown error";
  return `Could not read ${what} from Stripe: ${detail}`;
}

/** One audit read, walked to the end, narrowed row by row, its count logged. */
async function read<T>(
  what: string,
  list: () => AsyncIterable<T>,
  narrow: (item: T) => T,
): Promise<ReadOutcome<T>> {
  try {
    const rows = await collectPaginated(list(), narrow);
    console.info(`audit stripe read ${what}: ${rows.length} rows`);
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, reason: reasonFor(what, err) };
  }
}

type InvoiceWithCharge = Stripe.Invoice & {
  charge?: string | Stripe.Charge | null;
  last_payment_error?: { code?: string | null } | null;
};

/** An invoice as the engine reads it: amount, currency, dates and the three
 *  places a decline code can sit (engine.ts extractDeclineCode). */
export function narrowInvoice(invoice: Stripe.Invoice): Stripe.Invoice {
  const full = invoice as InvoiceWithCharge;
  const charge = typeof full.charge === "object" && full.charge ? { failure_code: full.charge.failure_code } : null;
  return {
    amount_due: full.amount_due,
    currency: full.currency,
    due_date: full.due_date,
    created: full.created,
    last_finalization_error: full.last_finalization_error
      ? { decline_code: full.last_finalization_error.decline_code }
      : null,
    last_payment_error: full.last_payment_error ? { code: full.last_payment_error.code } : null,
    charge,
  } as unknown as Stripe.Invoice;
}

/** A subscription as the engine reads it: status, currency, customer id, the
 *  card's expiry, the first item's price, and the cancellation. */
export function narrowSubscription(subscription: Stripe.Subscription): Stripe.Subscription {
  const pm = subscription.default_payment_method;
  const card = pm && typeof pm === "object" ? pm.card : null;
  const price = subscription.items?.data?.[0]?.price;
  return {
    status: subscription.status,
    currency: subscription.currency,
    customer: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    default_payment_method: card ? { card: { exp_month: card.exp_month, exp_year: card.exp_year } } : null,
    items: {
      data: price
        ? [
            {
              price: {
                unit_amount: price.unit_amount,
                recurring: price.recurring
                  ? { interval: price.recurring.interval, interval_count: price.recurring.interval_count }
                  : null,
              },
            },
          ]
        : [],
    },
    canceled_at: subscription.canceled_at,
    cancellation_details: subscription.cancellation_details
      ? { reason: subscription.cancellation_details.reason }
      : null,
  } as unknown as Stripe.Subscription;
}

/** A dispute as the engine reads it. */
export function narrowDispute(dispute: Stripe.Dispute): Stripe.Dispute {
  return {
    status: dispute.status,
    amount: dispute.amount,
    currency: dispute.currency,
    evidence_details: dispute.evidence_details
      ? { submission_count: dispute.evidence_details.submission_count }
      : null,
  } as unknown as Stripe.Dispute;
}

/** The engine counts Card Updater events and reads nothing inside one. */
export function narrowEvent(): Stripe.Event {
  return {} as Stripe.Event;
}

/** Uncollectible invoices created inside the lookback. */
export function readUncollectibleInvoices(
  stripe: Stripe,
  lookbackStartSeconds: number,
): Promise<ReadOutcome<Stripe.Invoice>> {
  return read("failed invoices", () =>
    stripe.invoices.list({
      status: "uncollectible",
      created: { gte: lookbackStartSeconds },
      limit: 100,
    }),
    narrowInvoice,
  );
}

/** Open invoices. The overdue filter is the ENGINE's, not this module's: a read
 *  returns what Stripe has and the pure half decides what counts. */
export function readOpenInvoices(stripe: Stripe): Promise<ReadOutcome<Stripe.Invoice>> {
  return read("open invoices", () => stripe.invoices.list({ status: "open", limit: 100 }), narrowInvoice);
}

/**
 * Every subscription in any state, with the default payment method expanded.
 *
 * THE EXPANSION AND THE PAGINATION ARE THE SAME ONES `cron/expiring-cards.ts`
 * ALREADY USES. The cron narrows to `status: "active"` because it only alerts on
 * live subscriptions; the audit needs `"all"` because past-due and cancelled
 * subscriptions are two of its six scopes. Same call, one parameter apart.
 */
export function readSubscriptions(stripe: Stripe): Promise<ReadOutcome<Stripe.Subscription>> {
  return read("subscriptions", () =>
    stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.default_payment_method"],
    }),
    narrowSubscription,
  );
}

/** Disputes. NEW to Foxhound's Stripe surface: the wrapper previously called
 *  `disputes.update` and nothing else. */
export function readDisputes(stripe: Stripe): Promise<ReadOutcome<Stripe.Dispute>> {
  return read("disputes", () => stripe.disputes.list({ limit: 100 }), narrowDispute);
}

/**
 * Card Updater events in the CAU window. NEW to Foxhound's Stripe surface.
 *
 * ONE EVENT NAME, and legacy's own comment is the citation: the historical
 * `card.automatically_updated` and `payment_method.card_automatically_updated`
 * are no longer emitted, so a fallback would match nothing and imply coverage
 * that does not exist.
 */
export function readCardUpdaterEvents(
  stripe: Stripe,
  windowStartSeconds: number,
): Promise<ReadOutcome<Stripe.Event>> {
  return read("card updater events", () =>
    stripe.events.list({
      type: "payment_method.automatically_updated",
      created: { gte: windowStartSeconds },
      limit: 100,
    }),
    narrowEvent,
  );
}
