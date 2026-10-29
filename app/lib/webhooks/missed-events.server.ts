import { and, inArray, isNotNull, isNull, notLike } from "drizzle-orm";
import type Stripe from "stripe";

import { getDb, stripeConnections, webhookEvents } from "~/db";
import { DAY_MS, DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import { processConnectedWebhook } from "./process";

// THE MISSED-EVENT SWEEP. Stripe retries a failed webhook delivery for three
// days and then drops it, and its own advice is to list recent events and
// process the ones you never handled
// (docs.stripe.com/webhooks/process-undelivered-events). An outage longer than
// the retry window, or an endpoint misconfigured for a while, otherwise loses a
// failed payment, a dispute or a recovery for good.
//
// Daily, for every live connection, this lists the last four days of the
// account's events (one day past Stripe's retry window, so a run that is a day
// late still overlaps), skips any already in webhook_events, and feeds the
// rest, oldest first, through processConnectedWebhook: the exact entry the
// /webhooks/stripe route uses, idempotent on stripe_event_id, so a delivery
// racing this sweep is a duplicate and nothing more.
//
// It lists every event rather than delivery_success=false: read with the
// merchant's own token, that filter is not documented to cover Foxhound's
// Connect endpoint, and webhook_events is the record of what we actually
// handled, so "not claimed here" is the test that cannot be wrong.

const MISSED_EVENT_LOOKBACK_DAYS = 4;
/** Events listed per account per run; past it the account is reported, not hidden. */
const MISSED_EVENT_LIST_LIMIT_PER_ACCOUNT = 500;
/** Unclaimed events processed per run across all accounts, a subrequest budget. */
const MISSED_EVENT_PROCESS_LIMIT = 200;

interface MissedEventSweepResult {
  accounts: number;
  listed: number;
  replayed: number;
  applied: number;
  failed: number;
  /** Accounts whose listing hit the per-account cap or whose listing failed. */
  overLimit: number;
  accountErrors: number;
  /** True when the run-wide processing cap stopped the sweep early. */
  truncated: boolean;
}

/** Live connections with a token, demo excluded: the same set the webhook route resolves. */
async function querySweepConnections(env: Env) {
  const rows = await getDb(env)
    .select({ stripeUserId: stripeConnections.stripeUserId, token: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(
      and(
        isNull(stripeConnections.disconnectedAt),
        isNotNull(stripeConnections.stripeAccessToken),
        notLike(stripeConnections.accountId, `${DEMO_ACCOUNT_ID_PREFIX}%`),
      ),
    );
  return rows.flatMap((r) => (r.token ? [{ stripeUserId: r.stripeUserId, token: r.token }] : []));
}

/** The ids in `ids` already claimed in webhook_events. */
async function claimedEventIds(env: Env, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb(env)
    .select({ id: webhookEvents.stripeEventId })
    .from(webhookEvents)
    .where(inArray(webhookEvents.stripeEventId, ids));
  return new Set(rows.map((r) => r.id));
}

export async function sweepMissedStripeEvents(env: Env, now: Date): Promise<MissedEventSweepResult> {
  const result: MissedEventSweepResult = {
    accounts: 0,
    listed: 0,
    replayed: 0,
    applied: 0,
    failed: 0,
    overLimit: 0,
    accountErrors: 0,
    truncated: false,
  };
  const since = Math.floor((now.getTime() - MISSED_EVENT_LOOKBACK_DAYS * DAY_MS) / 1000);

  for (const conn of await querySweepConnections(env)) {
    if (result.replayed >= MISSED_EVENT_PROCESS_LIMIT) {
      result.truncated = true;
      break;
    }
    result.accounts += 1;
    try {
      const stripe = getConnectedStripe(await decryptToken(env, conn.token));
      const unclaimed: Stripe.Event[] = [];
      let page: Stripe.Event[] = [];
      let seen = 0;
      const flush = async () => {
        const claimed = await claimedEventIds(env, page.map((e) => e.id));
        for (const e of page) if (!claimed.has(e.id)) unclaimed.push(e);
        page = [];
      };
      for await (const event of stripe.events.list({ created: { gte: since }, limit: 100 })) {
        if (seen >= MISSED_EVENT_LIST_LIMIT_PER_ACCOUNT) {
          result.overLimit += 1;
          break;
        }
        seen += 1;
        page.push(event);
        if (page.length === 100) await flush();
      }
      await flush();
      result.listed += seen;

      // Stripe lists newest first; replay in the order they happened. The
      // account is set because an event read with the merchant's own token
      // need not carry it, and processConnectedWebhook routes on it.
      for (const event of unclaimed.reverse()) {
        if (result.replayed >= MISSED_EVENT_PROCESS_LIMIT) {
          result.truncated = true;
          break;
        }
        result.replayed += 1;
        const outcome = await processConnectedWebhook(env, { ...event, account: conn.stripeUserId }, new Date());
        if (outcome.status === "applied") result.applied += 1;
        if (outcome.status === "error") result.failed += 1;
      }
    } catch {
      // Counts only: an error here can carry Stripe or token detail.
      result.accountErrors += 1;
    }
  }
  return result;
}

export function describeMissedEventSweep(r: MissedEventSweepResult): string {
  const notes = [
    r.failed > 0 ? `${r.failed} failed` : "",
    r.accountErrors > 0 ? `${r.accountErrors} account(s) errored` : "",
    r.overLimit > 0 ? `${r.overLimit} account(s) over the listing cap` : "",
    r.truncated ? "TRUNCATED at the run cap" : "",
  ].filter(Boolean);
  const tail = notes.length > 0 ? `, ${notes.join(", ")}` : "";
  return `${r.accounts} accounts, ${r.listed} events listed, ${r.replayed} replayed, ${r.applied} applied${tail}`;
}
