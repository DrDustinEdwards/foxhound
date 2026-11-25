// Pure: no env, no database, no clock, built on Capsomer's blocks. Its link is a digest token:
// following it switches off this account's digest and suppresses no address.

import { plural } from "@drdustinedwards/site-helpers/text";
import type { Block } from "capsomer/email";

import { recoveryFooterNote } from "~/lib/email/templates";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import type { CurrencyAmount } from "~/lib/money/totals";
import { percent } from "capsomer/behavior/meter";

export const DIGEST_TEMPLATE = "weekly_digest";

export interface DigestNumbers {
  totalFailed: number;
  totalRecovered: number;
  /** Per currency (hard rule 2): a merchant paid in two currencies sees both. */
  recoveredRevenue: CurrencyAmount[];
  atRiskRevenue: CurrencyAmount[];
  activeCount: number;
  emailsSent: number;
  winBackCount: number;
  expiringCardCount: number;
  openDisputeCount: number;
  openDisputeAmounts: CurrencyAmount[];
  /** The account's main currency, shown when a total is empty. */
  currency: string;
}

export interface DigestInput extends DigestNumbers {
  senderName: string | null;
  disputesActive: boolean;
  highRiskCustomers: { name: string; mrrCents: number | null; currency: string | null }[];
  /** Customers the nightly scoring flagged for personal outreach. */
  personalOutreachCount: number;
  /** The digest's own clock, so the header line and subject agree. */
  now: Date;
  /** The app's origin. Passed in so this module stays free of env. */
  baseUrl: string;
}

const DIGEST_SENDER_FALLBACK = "Foxhound";

const DIGEST_FROM_NAME = "Foxhound";

/**
 * Whether the recommendations button is shown: true only while routes.ts serves the page it opens.
 * A test holds the two equal.
 */
const DIGEST_RECOMMENDATIONS_LIVE = true;

export function resolveDigestCurrency(
  recovered: { currency: string | null }[],
  failed: { currency: string | null }[],
): string {
  if (recovered.length > 0) {
    const counts: Record<string, number> = {};
    for (const p of recovered) {
      if (p.currency) counts[p.currency] = (counts[p.currency] ?? 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
  }
  return failed[0]?.currency ?? "usd";
}

/** Per-currency totals joined ("$693.00 + €40.00"), or zero in the account's
 *  currency when there is nothing to total. */
function formatAmounts(amounts: CurrencyAmount[], fallbackCurrency: string): string {
  const shown = amounts.filter((a) => a.cents !== 0);
  if (shown.length === 0) return formatMoney(0, fallbackCurrency);
  return shown.map((a) => formatMoney(a.cents, a.currency)).join(" + ");
}

/**
 * Intelligence is on for every account, so it is always `platform`. The date is formatted in UTC.
 */
function digestSubject(input: { now: Date }): string {
  const date = input.now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Your weekly platform report: ${date}`;
}

function row(label: string, value: string): Block {
  return { type: "paragraph", text: `${label}: ${value}` };
}

function disputesSection(input: DigestInput): Block[] {
  if (!input.disputesActive || input.openDisputeCount === 0) return [];
  const noun = input.openDisputeCount === 1 ? "dispute" : "disputes";
  const amount = formatAmounts(input.openDisputeAmounts, input.currency);
  return [
    { type: "paragraph", text: "Disputes" },
    {
      type: "paragraph",
      text:
        `${input.openDisputeCount} open ${noun} totaling ${amount} need a response. ` +
        "Foxhound has staged evidence for each.",
    },
    { type: "button", label: "View disputes \u2192", url: `${input.baseUrl}/disputes/dashboard` },
  ];
}

function intelligenceSection(input: DigestInput): Block[] {
  const outreach = input.personalOutreachCount;
  if (input.highRiskCustomers.length === 0 && outreach === 0) return [];
  const out: Block[] = [{ type: "paragraph", text: "Intelligence" }];
  if (outreach > 0) {
    out.push({
      type: "paragraph",
      text: `${plural(outreach, "customer")} flagged for personal outreach.`,
    });
  }
  if (input.highRiskCustomers.length > 0) {
    out.push(
      { type: "paragraph", text: "Top at-risk customers" },
      ...input.highRiskCustomers.map((c): Block =>
        c.mrrCents != null
          ? row(c.name, `${formatMoney(c.mrrCents, c.currency ?? input.currency)}/mo`)
          : { type: "paragraph", text: c.name },
      ),
    );
  }
  if (DIGEST_RECOMMENDATIONS_LIVE) {
    out.push({
      type: "button",
      label: "View recommendations \u2192",
      url: `${input.baseUrl}/intelligence/recommendations`,
    });
  }
  return out;
}

/** Pure. */
function buildDigestBlocks(input: DigestInput): Block[] {
  const rate = percent(input.totalRecovered, input.totalFailed);
  const weekEnding = input.now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return [
    { type: "fine", text: `Week ending ${weekEnding}` },
    { type: "heading", text: "Your recovery summary" },
    row("Revenue recovered", formatAmounts(input.recoveredRevenue, input.currency)),
    row("Recovery rate", `${rate}%`),
    row("Failed payments detected", String(input.totalFailed)),
    row("Payments recovered", String(input.totalRecovered)),
    row("Revenue at risk", formatAmounts(input.atRiskRevenue, input.currency)),
    row("Active recovery sequences", String(input.activeCount)),
    row("Recovery emails sent", String(input.emailsSent)),
    row("Active win-back sequences", String(input.winBackCount)),
    ...(input.expiringCardCount > 0
      ? [row("Cards expiring soon", String(input.expiringCardCount))]
      : []),
    ...(input.disputesActive && input.openDisputeCount > 0
      ? [
          row(
            "Open disputes",
            `${input.openDisputeCount}, ${formatAmounts(input.openDisputeAmounts, input.currency)}`,
          ),
        ]
      : []),
    ...disputesSection(input),
    ...intelligenceSection(input),
    { type: "button", label: "View Dashboard", url: `${input.baseUrl}/recovery/dashboard` },
  ];
}

/** Everything the digest says and carries, from its numbers. */
export function digestContent(input: DigestInput): {
  fromName: string;
  subject: string;
  blocks: Block[];
  footerNote: string;
} {
  return {
    fromName: DIGEST_FROM_NAME,
    subject: digestSubject(input),
    blocks: buildDigestBlocks(input),
    footerNote: recoveryFooterNote(
      input.senderName?.trim() || DIGEST_SENDER_FALLBACK,
      input.now.getUTCFullYear(),
    ),
  };
}
