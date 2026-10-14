import { isBillableRecoveryRow } from "~/lib/billing/billable-predicates";
import { recoveryFeeCents } from "~/lib/billing/fees";
import { RECOVERY_FEE_BPS, type DeclineCategory } from "~/lib/constants";
import { recoveryRateBand, recoveryRateTone } from "~/lib/dashboard/recovery-rate";
import { formatRelativeTime } from "~/lib/dashboard/recovery-window";
import { groupSumByCurrency } from "~/lib/dashboard/stats.server";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";
import { formatMoney } from "~/lib/money-format";
import { FAILED_PAYMENT_STATUS_LABELS, formatStepType } from "~/lib/recovery/labels";

import type { PreviewPaymentRow, RecoveryPreview, RoiColumn } from "./recovery-preview";

// The data behind the /products/recovery previews (J56): the demo account's
// seed, never a merchant's rows. Recova draws these from hardcoded Teamflow
// numbers (RecoveryDashboardPreview.tsx, blob 565b772c) and a hand-written
// eight-payment array (RecoveryPaymentsPreview.tsx, blob da19edf0). Foxhound
// builds the same Teamflow account its demo runs on (app/lib/demo/, the pure
// builders, no database and no Stripe), then reads it the way the merchant
// dashboard reads its own rows:
//
// - Recovered (30d): recoveries in the last 30 days, renewal noise left out,
//   as listRecoveredWithFailureContext.
// - Currently at risk: every active failure, as listActiveFailedPayments.
// - Recovery rate: the 30-day cohort of failures by the date they failed, as
//   getRecoveryDashboardWindow, with recoveryRateBand's word.
// - ROI: billable recoveries (isBillableRecoveryRow) and recoveryFeeCents, as
//   the dashboard's RoiWidget, for this calendar month and all time.
// - Payments: the eight most recent failures, as listRecentFailedPayments,
//   with each one's steps and the customer's failure count.
//
// Strings are formatted here, on the server, so the page renders the same
// text on the server and in the browser.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Recova's preview lists eight payments; so does the dashboard's own list. */
const PREVIEW_PAYMENT_ROWS = 8;

function money(rows: { amountCents: number; currency: string }[]): string {
  // One computation for a money total (RULES.md 3.20). The demo bills in one
  // currency; a second one would be a seed change, and this shows the first.
  const [first] = groupSumByCurrency(rows);
  return formatMoney(first?.cents ?? 0, first?.currency ?? "usd");
}

function roiColumn(rows: { amountCents: number; currency: string }[]): RoiColumn {
  const [total] = groupSumByCurrency(rows);
  const cents = total?.cents ?? 0;
  const currency = total?.currency ?? "usd";
  const fee = recoveryFeeCents(cents);
  return {
    recovered: formatMoney(cents, currency),
    fee: formatMoney(fee, currency),
    kept: formatMoney(cents - fee, currency),
  };
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Build the preview as of `now`. Pure: the same instant gives the same preview. */
export function buildRecoveryPreview(now: Date): RecoveryPreview {
  const nowMs = now.getTime();
  const seed = buildRecoverySeed(DEMO_ACCOUNT_ID, buildTeamflowBase(now), now);

  const failures = seed.failedPayments
    .filter((f) => !f.isRenewalNoise && f.deletedAt == null)
    .map((f) => ({ ...f, id: f.id as string, detectedAt: f.detectedAt as Date, status: f.status as string }))
    .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
  // listRecoveredWithFailureContext joins on renewal noise only, not on a
  // soft-deleted failure, so the recovered total does the same.
  const noiseIds = new Set(seed.failedPayments.filter((f) => f.isRenewalNoise).map((f) => f.id));
  const recoveredIds = new Set(seed.recoveredPayments.map((r) => r.failedPaymentId));

  const cutoff30 = nowMs - 30 * DAY_MS;
  const recovered30 = seed.recoveredPayments.filter(
    (r) => !noiseIds.has(r.failedPaymentId) && r.recoveredAt.getTime() >= cutoff30,
  );
  const active = failures.filter((f) => f.status === "active");
  const cohort = failures.filter((f) => f.detectedAt.getTime() >= cutoff30);
  const ratePct =
    cohort.length > 0 ? Math.round((cohort.filter((f) => recoveredIds.has(f.id)).length / cohort.length) * 100) : null;

  const billable = seed.recoveredPayments.filter((r) => isBillableRecoveryRow(r, nowMs));
  const firstOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const failuresByCustomer = new Map<string, number>();
  for (const f of failures) failuresByCustomer.set(f.stripeCustomerId, (failuresByCustomer.get(f.stripeCustomerId) ?? 0) + 1);

  const rows = failures.slice(0, PREVIEW_PAYMENT_ROWS).map((f): PreviewPaymentRow => {
    const steps = seed.recoverySteps.filter((s) => s.failedPaymentId === f.id);
    const next = steps.find((s) => !s.executedAt && !s.result);
    return {
      id: f.id,
      customer: f.customerName ?? f.customerEmail,
      email: f.customerName ? f.customerEmail : null,
      plan: f.planName ?? null,
      amount: formatMoney(f.amountCents, f.currency ?? "usd"),
      category: f.declineCategory as DeclineCategory,
      declineCode: f.declineCode ?? null,
      stepsDone: steps.filter((s) => s.executedAt).length,
      stepsTotal: steps.length,
      nextStep: next ? formatStepType(next.stepType) : null,
      status: f.status,
      statusLabel: FAILED_PAYMENT_STATUS_LABELS[f.status] ?? f.status,
      failureCount: failuresByCustomer.get(f.stripeCustomerId) ?? 1,
      detectedAgo: formatRelativeTime(f.detectedAt, nowMs) ?? "",
      detectedDate: DATE_FORMAT.format(f.detectedAt),
    };
  });

  return {
    asOf: now.toISOString(),
    dashboard: {
      recovered30d: money(recovered30.map((r) => ({ amountCents: r.amountCents, currency: r.currency }))),
      atRisk: money(active.map((f) => ({ amountCents: f.amountCents, currency: f.currency ?? "usd" }))),
      ratePct,
      rateBand: recoveryRateBand(ratePct),
      rateTone: ratePct === null ? null : recoveryRateTone(ratePct),
    },
    roi: {
      feePct: RECOVERY_FEE_BPS / 100,
      thisMonth: roiColumn(billable.filter((r) => r.recoveredAt.getTime() >= firstOfMonth)),
      allTime: roiColumn(billable),
    },
    payments: { totalCount: failures.length, activeCount: active.length, rows },
  };
}

// The seed walks ninety days of a 200-customer account, which is real work, so
// one preview serves every request in the same hour. Its relative times ("2d
// ago") are read at the hour too, which keeps them right to the day.
let cached: { hour: number; preview: RecoveryPreview } | null = null;

export function recoveryPreviewFor(nowMs: number): RecoveryPreview {
  const hour = Math.floor(nowMs / HOUR_MS);
  if (cached?.hour !== hour) cached = { hour, preview: buildRecoveryPreview(new Date(hour * HOUR_MS)) };
  return cached.preview;
}
