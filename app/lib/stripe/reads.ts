import type Stripe from "stripe";

import type { ReadOutcome } from "~/lib/audit/engine";

// Phase (b) of the audit port, ruled by 362 ruling 4. The Stripe half the pure
// engine takes as injected input.
//
// EVERY LIST HERE IS PAGINATED, and that is the whole reason this module exists.
// Legacy's audit issues five `limit: 100` calls and reads exactly one page of
// each, so a merchant past their first hundred subscriptions gets an audit of
// their first hundred and no sign that anything was left out. 341 found the same
// defect in the expiring-card scan and fixed it there with `for await`; this is
// that fix generalized, with the soft ceiling made explicit rather than implied.
//
// A FAILED READ IS DATA, NOT A THROW. Each read answers `{ ok: false, reason }`,
// which the engine turns into that scope's failed status, so a Stripe outage
// renders as "we could not read this" instead of as a zero (362 ruling 2).

/** Bounded work per read. A merchant past this gets `overLimit`, which the
 *  caller can surface; nothing is silently truncated without a flag. */
export const AUDIT_READ_SOFT_LIMIT = 2000;

export interface PaginatedRead<T> {
  items: T[];
  /** True when the soft ceiling stopped the walk before Stripe ran out of pages. */
  overLimit: boolean;
}

/**
 * Walk an auto-paginating Stripe list to the soft ceiling.
 *
 * THE ONE IMPLEMENTATION. Every reader below goes through this, so a new read
 * cannot arrive with its own hand-rolled paging or with none.
 */
export async function collectPaginated<T>(
  list: AsyncIterable<T>,
  softLimit: number = AUDIT_READ_SOFT_LIMIT,
): Promise<PaginatedRead<T>> {
  const items: T[] = [];
  for await (const item of list) {
    if (items.length >= softLimit) return { items, overLimit: true };
    items.push(item);
  }
  return { items, overLimit: false };
}

/** The reason string a caller sees when a read throws. Never the raw error
 *  object, which can carry request context, and never a wide dash. */
function reasonFor(what: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : "unknown error";
  return `Could not read ${what} from Stripe: ${detail}`;
}

async function read<T>(what: string, list: () => AsyncIterable<T>): Promise<ReadOutcome<T>> {
  try {
    const { items } = await collectPaginated(list());
    return { ok: true, data: items };
  } catch (err) {
    return { ok: false, reason: reasonFor(what, err) };
  }
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
  );
}

/** Open invoices. The overdue filter is the ENGINE's, not this module's: a read
 *  returns what Stripe has and the pure half decides what counts. */
export function readOpenInvoices(stripe: Stripe): Promise<ReadOutcome<Stripe.Invoice>> {
  return read("open invoices", () => stripe.invoices.list({ status: "open", limit: 100 }));
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
  );
}

/** Disputes. NEW to Foxhound's Stripe surface: the wrapper previously called
 *  `disputes.update` and nothing else. */
export function readDisputes(stripe: Stripe): Promise<ReadOutcome<Stripe.Dispute>> {
  return read("disputes", () => stripe.disputes.list({ limit: 100 }));
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
  );
}
