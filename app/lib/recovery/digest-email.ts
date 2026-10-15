// The weekly digest's copy, ported from legacy's `buildDigestEmail` in
// app/api/cron/weekly-digest/route.ts (blob `b6ff2a8c`, 22,247 bytes).
// Pure: no env, no database, no clock. Extracted so a plant reads the real
// assembly rather than a hand-built copy of it (337 binding 4).
//
// THIS IS MERCHANT-FACING MAIL. It carries no CAN-SPAM footer and no
// unsubscribe, which is 339 binding 4 and a DIVERGENCE from legacy: legacy
// suppression-checks the digest and attaches an unsubscribe token, and
// `email_suppressions` is keyed by ADDRESS, so honouring that here would
// silence the merchant's recovery and sequence-complete notices too.
//
// ONE TREATMENT DIFFERENCE, forced and recorded: legacy styles the whole email
// from its EMAIL_COLORS module, and check-tokens fails the build on raw hex.
// The structure, the row labels and the ordering are legacy's; the colour is
// not reproduced.

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
  senderName: string | null;
  /** Legacy gates the Disputes row and section on the product being active. */
  disputesActive: boolean;
  /** Legacy gates the Intelligence section on the product being active. */
  intelligenceActive: boolean;
  highRiskCustomers: { name: string; mrrCents: number | null }[];
  /** The digest's own clock, so the header line and subject agree. */
  now: Date;
  /** Legacy links to `${APP_URL}/recovery/dashboard`; Foxhound's equivalent
   *  route is /console. Passed in so this module stays free of env. */
  dashboardUrl: string;
}

/** Legacy's `senderName = connection.sender_name || 'Recova'`, with Foxhound's
 *  brand in the fallback. */
export const DIGEST_SENDER_FALLBACK = "Foxhound";

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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** Legacy's HTML escape, so a customer name carrying quotes or angle brackets
 *  cannot corrupt the markup. Ported character for character. */
export function escapeDigestHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Legacy's subject: `platform` when Intelligence or Disputes is active, else
 * `recovery`, so a single-product merchant is not sent a multi-product framing.
 *
 * The date is formatted in UTC. Legacy's `toLocaleDateString` runs in the
 * server's zone; both platforms run UTC in production, and pinning it here
 * makes the render independent of where the test runs (342 binding 2).
 */
export function digestSubject(input: {
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

function row(label: string, value: string): string {
  return `<tr><td><span>${label}</span><span>${value}</span></td></tr>`;
}

/** Legacy's Disputes section: rendered only when Disputes is active AND there
 *  is at least one open dispute. */
function disputesSection(input: DigestInput): string {
  if (!input.disputesActive || input.openDisputeCount === 0) return "";
  const noun = input.openDisputeCount === 1 ? "dispute" : "disputes";
  const amount =
    input.openDisputeCents > 0
      ? ` totaling ${formatAmount(input.openDisputeCents, input.currency)}`
      : "";
  return (
    `<h3>Disputes</h3>` +
    `<p>${input.openDisputeCount} open ${noun}${amount} need a response. ` +
    `Foxhound has staged evidence for each.</p>`
  );
}

/**
 * Legacy's Intelligence section, minus one line.
 *
 * LEGACY'S PERSONAL-OUTREACH COUNT IS OMITTED, not approximated. It reads
 * `health_factors->>recommended_action = 'personal_outreach'`, and nothing in
 * Foxhound writes `recommended_action`: it exists only as demo seed data and as
 * the unwritten `ai_recommended_actions` column.
 * `dashboard/console.server.ts:179-181` already met this exact query and made
 * the same call. The top-at-risk list stays, because health_score and
 * mrr_contribution_cents ARE written.
 */
function intelligenceSection(input: DigestInput): string {
  if (!input.intelligenceActive) return "";
  if (input.highRiskCustomers.length === 0) return "";
  const rows = input.highRiskCustomers
    .map((c) => {
      const mrr = c.mrrCents != null ? ` ${formatAmount(c.mrrCents, input.currency)}/mo` : "";
      return `<tr><td>${escapeDigestHtml(c.name)}${escapeDigestHtml(mrr)}</td></tr>`;
    })
    .join("");
  return (
    `<h3>Intelligence</h3>` +
    `<p>Top at-risk customers</p>` +
    `<table>${rows}</table>`
  );
}

/** Legacy's body, in legacy's order, with legacy's labels. */
export function buildDigestEmail(input: DigestInput): string {
  const rate = recoveryRate(input.totalFailed, input.totalRecovered);
  const weekEnding = input.now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const conditional =
    (input.expiringCardCount > 0
      ? row("Cards expiring soon", String(input.expiringCardCount))
      : "") +
    (input.disputesActive && input.openDisputeCount > 0
      ? row(
          "Open disputes",
          input.openDisputeCents > 0
            ? `${input.openDisputeCount}, ${formatAmount(input.openDisputeCents, input.currency)}`
            : String(input.openDisputeCount),
        )
      : "");

  return (
    `<p>Week ending ${weekEnding}</p>` +
    `<h2>Your recovery summary</h2>` +
    `<table>` +
    `<tr><td>${formatAmount(input.recoveredRevenueCents, input.currency)}<span>Revenue recovered</span></td>` +
    `<td>${rate}%<span>Recovery rate</span></td></tr>` +
    `</table>` +
    `<table>` +
    row("Failed payments detected", String(input.totalFailed)) +
    row("Payments recovered", String(input.totalRecovered)) +
    row("Revenue at risk", formatAmount(input.atRiskRevenueCents, input.currency)) +
    row("Active recovery sequences", String(input.activeCount)) +
    row("Recovery emails sent", String(input.emailsSent)) +
    row("Active win-back sequences", String(input.winBackCount)) +
    conditional +
    `</table>` +
    disputesSection(input) +
    intelligenceSection(input) +
    `<p><a href="${input.dashboardUrl}">View Dashboard</a></p>`
  );
}
