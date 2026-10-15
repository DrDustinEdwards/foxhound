// What the admin Overview's Needs attention list holds, and when its lists are
// being read again. Pure display helpers (not a .server module: the page
// renders them), tested without a database.
//
// Recova's overview (app/admin/page.tsx, blob acb4ccbe) listed paused
// merchants, open disputes a week old with no response and failed billing
// charges under "Needs attention". Foxhound keeps those three, computed by its
// own engine (overview.server.ts), and adds its failed cron runs, so the one
// worst-first list (Capsomer's attention list, the family overview pattern)
// never says "All clear" while a cron is failing.

import type { AttentionGroupInfo, AttentionItem } from "capsomer/react/attention-list";
import { relative } from "capsomer/behaviour/time";

import { PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { cronRunHref } from "~/lib/admin/crons";
import type { AdminOverview } from "~/lib/admin/overview.server";
import { daysUntilDeadline, deadlineLabel, humanizeDisputeReason } from "~/lib/disputes/labels";
import { formatMoney } from "~/lib/money-format";

const DAY_MS = 24 * 60 * 60 * 1000;

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function merchantHref(accountId: string): string {
  return `/admin/merchants/${encodeURIComponent(accountId)}`;
}

/** A row's time in words, by UTC's calendar ("yesterday" means the UTC day
 *  before). The words are worked out from the loader's clock in the server
 *  render and again in the browser, so they must not depend on the browser's
 *  zone, or the hydrated text would differ from the delivered HTML. */
function when(at: Date, nowMs: number): AttentionItem["when"] {
  return { text: relative(at.getTime(), nowMs, "UTC"), datetime: at.toISOString() };
}

/**
 * One row per thing that needs a person, each linked to the page where it is
 * dealt with: a paused merchant to its page (Resume is there), a dispute and a
 * failed fee charge to their merchant's page (the admin has no dispute or
 * invoice page of its own), a failed cron run to that run on /admin/crons.
 * Every row is a warning: none is an outage of the platform, and Capsomer
 * folds warnings of one kind into one row while it never folds a critical one.
 */
export function overviewAttention(overview: AdminOverview, nowMs: number): AttentionItem[] {
  const { pausedMerchants, staleDisputes, failedFeeInvoices } = overview.attention;
  const items: AttentionItem[] = [];

  for (const m of pausedMerchants) {
    items.push({
      id: `paused-${m.id}`,
      tone: "warn",
      group: "paused",
      title: `${m.name ?? m.id} is paused`,
      detail:
        m.pauseReason === PAUSE_REASON_BRAKE
          ? "Paused by the emergency brake; releasing the brake resumes it"
          : "Processing paused by an operator; resume it on its page",
      href: merchantHref(m.id),
    });
  }

  for (const d of staleDisputes) {
    const days = Math.floor((nowMs - d.createdAt.getTime()) / DAY_MS);
    const deadline = deadlineLabel(daysUntilDeadline(d.evidenceDeadline, nowMs)) ?? "No evidence deadline";
    items.push({
      id: `dispute-${d.id}`,
      tone: "warn",
      group: "disputes",
      title: `${d.merchantName ?? d.accountId} has a dispute with no response after ${days} days`,
      detail: [formatMoney(d.amountCents, d.currency), humanizeDisputeReason(d.reason), deadline].join(" · "),
      when: when(d.createdAt, nowMs),
      href: merchantHref(d.accountId),
    });
  }

  for (const i of failedFeeInvoices) {
    items.push({
      id: `billing-${i.id}`,
      tone: "warn",
      group: "billing",
      title:
        i.status === "payment_failed"
          ? `${i.merchantName ?? i.accountId}'s fee invoice payment failed`
          : `${i.merchantName ?? i.accountId}'s fee invoice was not collected`,
      detail: `${formatMoney(i.totalCents, i.currency)} · ${plural(i.chargeAttemptCount, "charge attempt", "charge attempts")}`,
      when: when(i.failedAt, nowMs),
      href: merchantHref(i.accountId),
    });
  }

  for (const run of overview.cronHealth.failedRuns) {
    items.push({
      id: `cron-${run.id}`,
      tone: "warn",
      group: "crons",
      title: `${run.cronName} failed`,
      detail: run.message ?? "No message was recorded",
      when: when(run.finishedAt, nowMs),
      href: cronRunHref(run.id),
    });
  }

  return items;
}

/** How a group of like rows is named and where it links on to. The counts are
 *  the engine's own, not the number of rows read, so a group past the read's
 *  ceiling still says how many there are. A group links on only to a page that
 *  lists its rows: /admin/merchants shows a Paused badge and /admin/crons
 *  every failed run; no admin page lists disputes or fee invoices, so those
 *  groups have no link, and each row still links to its merchant. */
export function overviewAttentionGroups(overview: AdminOverview): Record<string, AttentionGroupInfo> {
  return {
    paused: {
      title: () => `${plural(overview.pausedCount, "merchant is", "merchants are")} paused`,
      view: { href: "/admin/merchants", label: "Merchants" },
    },
    disputes: {
      title: () => `${plural(overview.staleDisputesCount, "dispute has", "disputes have")} had no response for a week`,
    },
    billing: {
      title: () => `${plural(overview.failedFeeInvoicesCount, "fee invoice", "fee invoices")} not paid`,
    },
    crons: {
      title: (n) => `${plural(n, "cron run", "cron runs")} failed in the last 24 hours`,
      view: { href: "/admin/crons", label: "Crons" },
    },
  };
}

/** The Overview's lists are pending while its own data is read again (a
 *  revalidation, or a navigation back to /admin), never while the admin is
 *  leaving for another page. The last good data stays on screen meanwhile. */
export function overviewPending(
  navigation: { state: string; location?: { pathname: string } },
  revalidatorState: string,
): boolean {
  if (revalidatorState === "loading") return true;
  return navigation.state === "loading" && navigation.location?.pathname === "/admin";
}
