// The weekly digest's copy, ported from Recova's `buildDigestEmail` in
// app/api/cron/weekly-digest/route.ts (blob `b6ff2a8c`, 22,247 bytes).
// Pure: no env, no database, no clock. Extracted so a plant reads the real
// assembly rather than a hand-built copy of it (337 binding 4).
//
// ON CAPSOMER'S BLOCKS (E23, job J95). The digest is written as Capsomer's
// typed blocks, Recova's words in Recova's order, and the send module renders
// both parts from them (RULES.md 3.16, Q3). Capsomer escapes every value, so a
// customer name carrying markup is shown as written.
//
// WHAT CAPSOMER CANNOT YET SAY, named in the PR as Capsomer jobs rather than
// forked here: Recova's two figure tiles and its label-and-value rows have no
// block of their own, so each is one line, "label: value"; Recova's h3 section
// titles ("Disputes", "Intelligence") have no second heading level, so each is a
// paragraph, keeping the mail's one h1 ("Your recovery summary"); Recova's
// "View disputes" text link is a button, as every Capsomer link is.
//
// IT CARRIES RECOVA'S UNSUBSCRIBE (E23). Recova suppression-checks the digest
// and wraps it with an unsubscribe token, so its footer carries Unsubscribe and
// the postal address. The cron sends it on the "digest" audience, which is that
// footer on this one merchant mail; every other merchant notice keeps none
// (RULES.md 3.16). Its link is a digest token: following it switches off this
// account's digest and suppresses no address (PR 158 review round 1).

import type { Block } from "capsomer/email";

import { recoveryFooterNote } from "~/lib/email/templates";
import { formatMoney } from "~/lib/money-format";

export const DIGEST_TEMPLATE = "weekly_digest";

export interface DigestNumbers {
  totalFailed: number;
  totalRecovered: number;
  recoveredRevenueCents: number;
  atRiskRevenueCents: number;
  activeCount: number;
  emailsSent: number;
  winBackCount: number;
  expiringCardCount: number;
  openDisputeCount: number;
  openDisputeCents: number;
  currency: string;
}

export interface DigestInput extends DigestNumbers {
  /** The merchant's sender name (`stripe_connections.sender_name`), for
   *  Recova's footer sentence only. */
  senderName: string | null;
  /** Recova gates the Disputes row and section on the product being active. */
  disputesActive: boolean;
  /** Recova gates the Intelligence section on the product being active. */
  intelligenceActive: boolean;
  highRiskCustomers: { name: string; mrrCents: number | null }[];
  /** The digest's own clock, so the header line and subject agree. */
  now: Date;
  /** The app's origin (Recova's APP_URL). Passed in so this module stays free
   *  of env. */
  baseUrl: string;
}

/** Recova's `senderName = connection.sender_name || 'Recova'`, with Foxhound's
 *  brand in the fallback. It names the sender in the footer sentence. */
const DIGEST_SENDER_FALLBACK = "Foxhound";

/** Recova sends the digest from FROM_HELLO, `Recova <hello@...>`: the platform
 *  speaks, never the merchant's sender name. */
const DIGEST_FROM_NAME = "Foxhound";

/**
 * Recova's Intelligence section ends with "View recommendations", to
 * APP_URL/intelligence/recommendations (row S20). The button waited for that
 * page (RULES.md 2.7: an email ships after its link has somewhere to go), and
 * returns with it (job J78). A test holds this equal to whether routes.ts
 * serves the page.
 */
export const DIGEST_RECOMMENDATIONS_LIVE = true;

/** Legacy's `recoveryRate`: whole percent, and ZERO when nothing failed, never
 *  a division by zero and never "n/a". */
export function recoveryRate(totalFailed: number, totalRecovered: number): number {
  if (totalFailed <= 0) return 0;
  return Math.round((totalRecovered / totalFailed) * 100);
}

/**
 * Legacy's currency resolution, in order: the most common currency across the
 * week's recovered payments, else the first failed payment's, else `usd`.
 */
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

function formatAmount(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}

/**
 * Legacy's subject: `platform` when Intelligence or Disputes is active, else
 * `recovery`, so a single-product merchant is not sent a multi-product framing.
 *
 * The date is formatted in UTC. Legacy's `toLocaleDateString` runs in the
 * server's zone; both platforms run UTC in production, and pinning it here
 * makes the render independent of where the test runs (342 binding 2).
 */
function digestSubject(input: {
  now: Date;
  intelligenceActive: boolean;
  disputesActive: boolean;
}): string {
  const scope = input.intelligenceActive || input.disputesActive ? "platform" : "recovery";
  const date = input.now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Your weekly ${scope} report: ${date}`;
}

/** Recova's label and value, on one line: its rows set the label left and
 *  the value right, which Capsomer has no block for. */
function row(label: string, value: string): Block {
  return { type: "paragraph", text: `${label}: ${value}` };
}

/** Recova's Disputes section: rendered only when Disputes is active AND there
 *  is at least one open dispute. Recova sets the amount whenever the count is
 *  above zero, so a dispute with no amount reads "totaling $0.00". */
function disputesSection(input: DigestInput): Block[] {
  if (!input.disputesActive || input.openDisputeCount === 0) return [];
  const noun = input.openDisputeCount === 1 ? "dispute" : "disputes";
  const amount = formatAmount(input.openDisputeCents, input.currency);
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

/**
 * Recova's Intelligence section, minus one line.
 *
 * RECOVA'S PERSONAL-OUTREACH COUNT IS OMITTED, not approximated. It reads
 * `health_factors->>recommended_action = 'personal_outreach'`, and nothing in
 * Foxhound writes `recommended_action`: it exists only as demo seed data and as
 * the unwritten `ai_recommended_actions` column (parity/ENGINE-DIGEST.md binding
 * 5, RULES.md 3.18). The top-at-risk list stays, because health_score and
 * mrr_contribution_cents ARE written.
 */
function intelligenceSection(input: DigestInput): Block[] {
  if (!input.intelligenceActive) return [];
  if (input.highRiskCustomers.length === 0) return [];
  const out: Block[] = [
    { type: "paragraph", text: "Intelligence" },
    { type: "paragraph", text: "Top at-risk customers" },
    ...input.highRiskCustomers.map((c): Block =>
      c.mrrCents != null ? row(c.name, `${formatAmount(c.mrrCents, input.currency)}/mo`) : { type: "paragraph", text: c.name },
    ),
  ];
  if (DIGEST_RECOMMENDATIONS_LIVE) {
    out.push({
      type: "button",
      label: "View recommendations \u2192",
      url: `${input.baseUrl}/intelligence/recommendations`,
    });
  }
  return out;
}

/** Recova's body, in Recova's order, with Recova's labels. Pure. */
export function buildDigestBlocks(input: DigestInput): Block[] {
  const rate = recoveryRate(input.totalFailed, input.totalRecovered);
  const weekEnding = input.now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return [
    { type: "fine", text: `Week ending ${weekEnding}` },
    { type: "heading", text: "Your recovery summary" },
    row("Revenue recovered", formatAmount(input.recoveredRevenueCents, input.currency)),
    row("Recovery rate", `${rate}%`),
    row("Failed payments detected", String(input.totalFailed)),
    row("Payments recovered", String(input.totalRecovered)),
    row("Revenue at risk", formatAmount(input.atRiskRevenueCents, input.currency)),
    row("Active recovery sequences", String(input.activeCount)),
    row("Recovery emails sent", String(input.emailsSent)),
    row("Active win-back sequences", String(input.winBackCount)),
    ...(input.expiringCardCount > 0 ? [row("Cards expiring soon", String(input.expiringCardCount))] : []),
    // Recova writes "{n} &mdash; {amount}"; a comma here, as the dash is kept
    // out of Foxhound's copy.
    ...(input.disputesActive && input.openDisputeCount > 0
      ? [row("Open disputes", `${input.openDisputeCount}, ${formatAmount(input.openDisputeCents, input.currency)}`)]
      : []),
    ...disputesSection(input),
    ...intelligenceSection(input),
    { type: "button", label: "View Dashboard", url: `${input.baseUrl}/recovery/dashboard` },
  ];
}

/**
 * Everything the digest says and carries, from its numbers. Pure, and shared
 * with the admin preview so a preview is this function's output: the
 * platform's From name, Recova's subject, the blocks, and Recova's footer
 * sentence, which names the merchant's sender (`sender_name || 'Recova'`). The
 * send module puts Unsubscribe and the postal address under that sentence on
 * the digest audience, as Recova's wrapEmailHtml does with a token.
 */
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
    footerNote: recoveryFooterNote(input.senderName?.trim() || DIGEST_SENDER_FALLBACK, input.now.getUTCFullYear()),
  };
}
