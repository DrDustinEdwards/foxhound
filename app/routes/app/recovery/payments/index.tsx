import { useRef, useState } from "react";
import { Form, Link, data, useNavigate, useNavigation, useRouteLoaderData } from "react-router";

import { Badge } from "~/components/badge";
import { DualRangeSlider } from "~/components/dual-range-slider";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatMoney } from "~/lib/money-format";
import { formatRelativeTime } from "~/lib/dashboard/recovery-window";
import {
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  failedPaymentStatusTone,
} from "~/lib/recovery/labels";
import {
  getAmountBounds,
  getGlobalPaymentStatusCounts,
  listFilteredFailedPayments,
  listPaymentSummaryRows,
  listStepsForFailedPayments,
  countFailuresByCustomer,
  tallyStatusCounts,
} from "~/lib/recovery/queries.server";
import type { AmountBounds, FailedPaymentPageSize, FailedPaymentSort } from "~/lib/recovery/queries.server";
import { buildPaymentParams, withParams } from "~/lib/recovery/payment-filters";
import { recoveryRateValueClass, showingCountFor } from "~/lib/recovery/payments-stats";
import { nextRovingIndex } from "~/lib/a11y/roving-index";
import {
  actionableSelection,
  allVisibleSelected,
  selectedCount,
  toggleAllVisible,
  toggleOne,
} from "~/lib/recovery/bulk-selection";
import type { loader as appShellLoader } from "~/layouts/app-shell";
import { runBulkAction } from "~/lib/recovery/bulk-actions.server";
import {
  failedIds,
  isBulkActionIntent,
  isBulkRefusal,
  orderForDisplay,
  type BulkActionIntent,
  type BulkFailureReason,
} from "~/lib/recovery/bulk-results";
import {
  moneyWriteCommit,
  resendDepsFor,
  triggerDepsFor,
} from "~/lib/recovery/manual-actions.server";
import {
  BULK_ACTION_CONFIRM_THRESHOLD,
  BULK_ACTION_MAX_PER_SUBMISSION,
} from "~/lib/constants";
import { priorFailureCount } from "~/lib/recovery/prior-failures";
import { summarizeSequence } from "~/lib/recovery/sequence-summary";
import { isPaymentTimeRange, resolvePaymentTimeRangeCutoff, type PaymentTimeRange } from "~/lib/recovery/time-range";

import type { Route } from "./+types/index";

// /recovery/payments (TASK-foxhound-recovery-surface-parity.md Phase 3):
// header stats line + five summary cards, search across name/email/plan,
// status pills with counts, time/category/sort dropdowns, a dual-handle
// amount range, rows-per-page, pagination with a result count, and CSV
// export. Every filter lives in the loader's search params; nothing here
// re-filters an already-fetched page client-side.

export function meta() {
  return [{ title: "Payments - Foxhound" }];
}

const DECLINE_CATEGORY_OPTIONS = Object.keys(DECLINE_CATEGORY_LABELS) as (keyof typeof DECLINE_CATEGORY_LABELS)[];
const PAGE_SIZE_OPTIONS: FailedPaymentPageSize[] = [10, 25, 50, 100, "all"];
// Duplicated from queries.server.ts's DEFAULT_PAYMENT_PAGE_SIZE rather than
// imported: this constant is used by buildParams, which the client component
// calls, and a .server.ts value import there breaks the client bundle split
// (React Router only strips server-only code from loader/action/etc, not
// from a route's other exports).
const DEFAULT_PAGE_SIZE: FailedPaymentPageSize = 50;

function parseSort(value: string | null): FailedPaymentSort {
  return value === "oldest" || value === "amount_desc" || value === "amount_asc" ? value : "newest";
}

function parseTimeRange(value: string | null): PaymentTimeRange {
  return value && isPaymentTimeRange(value) ? value : "all";
}

function parsePageSize(value: string | null): FailedPaymentPageSize {
  if (value === "all") return "all";
  const n = Number(value);
  return (PAGE_SIZE_OPTIONS as (number | "all")[]).includes(n) ? (n as FailedPaymentPageSize) : DEFAULT_PAGE_SIZE;
}

function parseAmountParam(value: string | null, floorCents: number, ceilingCents: number): number | null {
  if (!value) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, floorCents), ceilingCents);
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const nowMs = Date.now();

  const params = new URL(request.url).searchParams;
  const search = params.get("q")?.trim() || null;
  const status = params.get("status") || null;
  const declineCategory = params.get("category") || null;
  const sort = parseSort(params.get("sort"));
  const time = parseTimeRange(params.get("time"));
  const pageParam = Number(params.get("page") ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;
  const pageSize = parsePageSize(params.get("perPage"));

  const bounds = await getAmountBounds(db, accountId);
  const amountMinParsed = parseAmountParam(params.get("amountMin"), bounds.minCents, bounds.maxCents);
  const amountMaxParsed = parseAmountParam(params.get("amountMax"), bounds.minCents, bounds.maxCents);
  // Only push a bound into the query when it actually narrows the range;
  // a slider left at its own default extremes is "no filter", not a filter
  // that happens to equal the bounds.
  const amountMinCents = amountMinParsed !== null && amountMinParsed > bounds.minCents ? amountMinParsed : null;
  const amountMaxCents = amountMaxParsed !== null && amountMaxParsed < bounds.maxCents ? amountMaxParsed : null;
  const detectedAfterMs = resolvePaymentTimeRangeCutoff(time, nowMs);

  const filterInput = { search, declineCategory, detectedAfterMs, amountMinCents, amountMaxCents };

  const [result, globalCounts, summaryRows] = await Promise.all([
    listFilteredFailedPayments(db, accountId, { ...filterInput, status, sort, page, pageSize }),
    getGlobalPaymentStatusCounts(db, accountId),
    listPaymentSummaryRows(db, accountId, filterInput),
  ]);

  const [previousFailureCounts, stepRows] = await Promise.all([
    countFailuresByCustomer(db, accountId, [...new Set(result.payments.map((p) => p.stripeCustomerId))]),
    listStepsForFailedPayments(db, accountId, result.payments.map((p) => p.id)),
  ]);

  const stepSummaries: Record<string, { completedCount: number; totalCount: number }> = {};
  for (const payment of result.payments) {
    const ownSteps = stepRows.filter((s) => s.failedPaymentId === payment.id);
    stepSummaries[payment.id] = summarizeSequence(ownSteps);
  }

  const pillCounts = tallyStatusCounts(summaryRows.map((r) => r.status));
  const headerRows = status ? summaryRows.filter((r) => r.status === status) : summaryRows;
  const atRiskCents = headerRows.filter((r) => r.status === "active").reduce((s, r) => s + r.amountCents, 0);
  const recoveredCents = headerRows.filter((r) => r.status === "recovered").reduce((s, r) => s + r.amountCents, 0);
  const recoveredRowCount = headerRows.filter((r) => r.status === "recovered").length;
  const headerRecoveryRatePct = headerRows.length > 0 ? Math.round((recoveredRowCount / headerRows.length) * 100) : null;
  // Legacy's exact computation, ported 2026-08-14 under 285: an account with no
  // failed payments reads 0, never null. This returned null and rendered a hyphen
  // until then, an unratified divergence and so a defect under the PRIME
  // DIRECTIVE. Legacy: `globalCounts.all > 0 ? Math.round(...) : 0`.
  const globalRecoveryRatePct = globalCounts.all > 0 ? Math.round((globalCounts.recovered / globalCounts.all) * 100) : 0;

  return {
    result,
    globalCounts,
    globalRecoveryRatePct,
    pillCounts,
    atRiskCents,
    recoveredCents,
    headerRecoveryRatePct,
    bounds,
    previousFailureCounts,
    stepSummaries,
    nowMs,
    filters: {
      search: search ?? "",
      status: status ?? "",
      declineCategory: declineCategory ?? "",
      time,
      sort,
      pageSize,
      amountMinCents: amountMinParsed ?? bounds.minCents,
      amountMaxCents: amountMaxParsed ?? bounds.maxCents,
    },
  };
}

/**
 * The bulk POST target, Session 2 (274 decisions one, four and five).
 *
 * An action on THIS route rather than a sibling, following the repo's own
 * precedent: detail.tsx carries the loader and the action for the forms it
 * renders, and posting here re-runs this loader so the list reflects the
 * mutations without a second navigation. app/routes.ts keeps its sibling
 * resource route (export.csv) for a NON-component response, which this is not.
 *
 * Nothing the browser sends is trusted: every id is re-derived through
 * dispatchManualAction's own account-scoped read and per-intent preconditions,
 * so an unowned id answers not_found exactly as it would singly. Nothing is
 * dropped on the way in either, so an id that was submitted appears in the
 * results carrying its reason.
 */
export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const ids = form.getAll("ids").map(String).filter(Boolean);

  const outcome = await runBulkAction({
    db,
    accountId: auth.membership.accountId,
    intent,
    ids,
    commit: moneyWriteCommit(env),
    trigger: triggerDepsFor(env, db),
    resend: resendDepsFor(env),
  });

  // ONE shape either way. A refusal is still an answer about this
  // submission, so it rides the same key and the client narrows it with
  // isBulkRefusal rather than probing two optional fields.
  return data({ bulk: outcome }, { status: isBulkRefusal(outcome) ? 400 : 200 });
}

interface Filters {
  search: string;
  status: string;
  declineCategory: string;
  time: PaymentTimeRange;
  sort: FailedPaymentSort;
  pageSize: FailedPaymentPageSize;
  amountMinCents: number;
  amountMaxCents: number;
}

function buildParams(
  filters: Filters,
  bounds: AmountBounds,
  overrides: Partial<Record<string, string>> = {},
): URLSearchParams {
  return buildPaymentParams(filters, { bounds, defaultPageSize: DEFAULT_PAGE_SIZE, overrides });
}

function statusPillHref(filters: Filters, bounds: AmountBounds, status: string): string {
  return withParams("/recovery/payments", buildParams(filters, bounds, { status }));
}

function pageHref(filters: Filters, bounds: AmountBounds, page: number): string {
  const params = buildParams(filters, bounds);
  if (page > 1) params.set("page", String(page));
  return withParams("/recovery/payments", params);
}

function exportHref(filters: Filters, bounds: AmountBounds): string {
  return withParams("/recovery/payments/export.csv", buildParams(filters, bounds));
}

// Legacy's STATUS_TABS order exactly (PaymentsFilters.tsx): All, Active,
// Recovered, Cancelled, Failed. "Cancelled" was MISSING here until S7 Phase 2
// Session B, which is what S6's row already recorded ("the status filter set
// differs and LOSES a value"). Without it, a payment stopped by "Stop recovery"
// was reachable only under All and counted by no pill at all.
const STATUS_PILLS = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "recovered", label: "Recovered" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed_unrecovered", label: "Failed" },
] as const;

interface PillCounts {
  all: number;
  active: number;
  recovered: number;
  failedUnrecovered: number;
  cancelled: number;
}

/**
 * Legacy's status filter is a `role="radiogroup"` with a roving tabindex and
 * full arrow-key handling (app/(app)/recovery/payments/components/
 * PaymentsFilters.tsx). Foxhound shipped four plain links: it RENDERS the same
 * and ANNOUNCES nothing, so a screen reader hears four unrelated links rather
 * than one four-option control, and a keyboard user tabs through every option
 * instead of arrowing within a single stop.
 *
 * Third and last of ruling 189's accessibility unit, after 146's main landmark
 * and 197's <h2> conversion. Legacy ACTIVATES on arrow rather than merely
 * moving focus, so arrowing both focuses and applies the filter; that is ported
 * rather than approximated. Home and End jump to first and last, as legacy does.
 *
 * The links stay links because Foxhound's filter state lives in the URL, not in
 * client state. Every className below is byte-identical to the pre-port markup:
 * this changes semantics only, per 197's standard while 187's type freeze holds.
 */
function StatusPills({
  filters,
  bounds,
  pillCounts,
}: {
  filters: Filters;
  bounds: AmountBounds;
  pillCounts: PillCounts;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Every pill reads its own count explicitly. This used to fall through to
  // failedUnrecovered for anything unmatched, which was harmless while the last
  // pill WAS failed_unrecovered and became a wrong number the moment Cancelled
  // was added: the new pill would have displayed the not-recovered total.
  function countFor(value: string): number {
    if (value === "") return pillCounts.all;
    if (value === "active") return pillCounts.active;
    if (value === "recovered") return pillCounts.recovered;
    if (value === "cancelled") return pillCounts.cancelled;
    return pillCounts.failedUnrecovered;
  }

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    // Index arithmetic lives in ~/lib/a11y/roving-index so it is testable;
    // vitest runs environment: "node" with no DOM (ruling 209's residue).
    const next = nextRovingIndex(event.key, index, STATUS_PILLS.length);
    if (next === null) return;
    event.preventDefault();
    groupRef.current?.querySelectorAll<HTMLAnchorElement>('[role="radio"]')[next]?.focus();
    void navigate(statusPillHref(filters, bounds, STATUS_PILLS[next].value));
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Filter by status"
      className="mt-6 flex flex-wrap gap-2"
    >
      {STATUS_PILLS.map((pill, index) => {
        const active = filters.status === pill.value;
        return (
          <Link
            key={pill.value}
            to={statusPillHref(filters, bounds, pill.value)}
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`rounded-full border px-3 py-1 text-label ${
              active ? "border-brand bg-brand text-on-brand" : "border-border text-text-tertiary hover:border-border-i"
            }`}
          >
            {pill.label} <span className="font-mono text-micro">{countFor(pill.value)}</span>
          </Link>
        );
      })}
    </div>
  );
}

/** Why one payment did not take the action, in the merchant's words. 274
 *  decision one bans bare counts, so every failed row names its own reason
 *  rather than being folded into "3 failed". */
const BULK_REASON_LABELS: Record<BulkFailureReason, string> = {
  not_found: "No longer on this account",
  not_active: "No longer active",
  already_resolved: "Already resolved",
  write_failed: "The change did not save",
  no_pending_step: "No step left to run",
  unknown_step_type: "This step has no action",
  processing_paused: "Processing is paused for this account",
  customer_unsubscribed: "The customer is unsubscribed, so nothing was sent",
  send_retrying: "The send did not go through, and will be retried",
  step_failed: "The step ran and did not complete",
  unexpected: "Unexpected response, nothing changed",
};

/** Per-intent copy for the bar, the confirmation and the result surface.
 *
 *  Every intent names its own verb rather than sharing one, because 274
 *  decision one's ban on folding applies to the WORDS as much as to the
 *  counts: a merchant reading a result list needs to know a payment was
 *  stopped, or run, or recorded, not that something generic happened to it.
 *  `label` is the button and the confirmation's action name; `didLabel` and
 *  `didNotLabel` are the per-row verdicts. */
const BULK_INTENTS = {
  trigger: {
    label: "Trigger next step",
    didLabel: "Ran",
    didNotLabel: "Did not run",
    question: "Run the next step now for",
    consequence:
      "Each payment's next scheduled step runs immediately, and a step that sends email will send it.",
  },
  mark_recovered: {
    label: "Mark recovered",
    didLabel: "Recorded",
    didNotLabel: "Not recorded",
    question: "Mark as recovered",
    consequence:
      "This records a recovery you have confirmed elsewhere. It does not charge anyone and it does not contact the customer.",
  },
  cancel: {
    label: "Stop recovery",
    didLabel: "Stopped",
    didNotLabel: "Not stopped",
    question: "Stop recovery for",
    consequence:
      "Their remaining steps will not send. This does not refund anything and it does not contact the customer.",
  },
} as const satisfies Record<BulkActionIntent, {
  label: string;
  didLabel: string;
  didNotLabel: string;
  question: string;
  consequence: string;
}>;

function bulkCopy(intent: string) {
  return isBulkActionIntent(intent) ? BULK_INTENTS[intent] : null;
}

/**
 * One bulk control, shared by all three intents.
 *
 * Below the confirmation threshold it is a plain submit carrying its own
 * intent, which is the whole wiring: the browser's form submitter supplies the
 * name and value, so there is no click handler in the mutating path at all.
 * Above it, or over the ceiling, it becomes a button that opens the dialog and
 * the dialog carries the submit instead, so a large bulk money action cannot be
 * fired by one click anywhere on this page (274 decision four).
 */
function BulkIntentButton({
  intent,
  count,
  showCount = false,
  needsConfirm,
  submitting,
  onConfirm,
  className,
}: {
  intent: BulkActionIntent;
  count: number;
  showCount?: boolean;
  needsConfirm: boolean;
  submitting: boolean;
  onConfirm: () => void;
  className: string;
}) {
  return (
    <button
      type={needsConfirm ? "button" : "submit"}
      name="intent"
      value={intent}
      disabled={submitting}
      onClick={needsConfirm ? onConfirm : undefined}
      className={className}
    >
      {BULK_INTENTS[intent].label}
      {showCount ? ` (${count})` : ""}
    </button>
  );
}

export default function RecoveryPayments({ loaderData, actionData }: Route.ComponentProps) {
  const {
    result,
    globalCounts,
    globalRecoveryRatePct,
    pillCounts,
    atRiskCents,
    recoveredCents,
    headerRecoveryRatePct,
    bounds,
    previousFailureCounts,
    stepSummaries,
    nowMs,
    filters,
  } = loaderData;

  // S6 bulk selection, Session 1 (274). Client-only and per page, which is
  // legacy's own model: it is never persisted, never in the URL, and lost on
  // pagination. Every read goes through the pure helpers, so the effective
  // selection is the stored set INTERSECTED with what is on screen and 274
  // decision three's prune-on-filter holds by construction rather than by an
  // effect that has to fire.
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  const isDemo = Boolean(shell?.isDemo);
  // The stored selection is tagged with the response it was last edited
  // against, which is what lets the SELECTION be derived rather than synced.
  // See the Session 2 block below for why that matters.
  const [sel, setSel] = useState<{ ids: ReadonlySet<string>; from: unknown }>(() => ({
    ids: new Set<string>(),
    from: undefined,
  }));
  const rows = result.payments;

  // S6 Session 2 (274 decisions one and four).
  //
  // FAILURES STAY SELECTED. When a response lands the selection becomes
  // exactly the ids that failed, so the next click retries precisely those
  // and nothing else; successes drop out.
  //
  // NOTHING HERE IS AN EFFECT. The first version of this synced state to the
  // response inside useEffect and the lint rule refused it, correctly: this
  // is not synchronisation with an external system, it is a value that the
  // response already determines. So each of the three pieces of post-response
  // behaviour is derived from WHICH response is currently in hand, by tagging
  // the stored state with the response it belongs to:
  //
  //   selection  the stored set wins once it has been edited against THIS
  //              response; until then the failed ids are the selection
  //   dismissal  belongs to one response, so the next response is a new
  //              thing to say and the panel is open again
  //   confirming closes on its own when a response lands, because the
  //              response it was opened against is no longer the current one
  //
  // actionData is a NEW object per submission, so identity is the tag.
  const navigation = useNavigation();
  const submitting = navigation.formMethod === "POST";
  const bulk = actionData?.bulk;
  const applied = bulk && !isBulkRefusal(bulk) ? bulk : null;
  const selected: ReadonlySet<string> =
    sel.from !== bulk && applied ? new Set(failedIds(applied.results)) : sel.ids;
  const setSelected = (ids: ReadonlySet<string>) => setSel({ ids, from: bulk });

  const [dismissedFor, setDismissedFor] = useState<unknown>(null);
  const dismissed = dismissedFor === bulk;
  // The confirmation is tagged with the response it was opened against AND the
  // intent it was opened for, so three buttons share one dialog without three
  // pieces of state, and the dialog can never name one action while its submit
  // carries another.
  const [confirmFor, setConfirmFor] = useState<{
    from: unknown;
    intent: BulkActionIntent;
  } | null>(null);
  const confirming = confirmFor !== null && confirmFor.from === bulk ? confirmFor.intent : null;

  const selectionCount = selectedCount(selected, rows);
  const actionable = actionableSelection(selected, rows);
  const headerChecked = allVisibleSelected(selected, rows);

  // The client half of the ceiling. The server enforces it too and refuses
  // the whole submission, because a hand crafted POST never sees this line.
  const overCeiling = actionable.length > BULK_ACTION_MAX_PER_SUBMISSION;
  const needsConfirm = actionable.length > BULK_ACTION_CONFIRM_THRESHOLD;
  const rowLabel = (id: string) => {
    const row = result.payments.find((p) => p.id === id);
    return row ? (row.customerName ?? row.customerEmail) : id;
  };

  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8 py-10">
      {/* Ruling 147 f1-f3, legacy app/(app)/recovery/payments/PaymentsClient.tsx:
      max-w-[1280px] mx-auto px-4 md:px-8 py-10. Vertical is a flat py-10 here,
      NOT console's py-8 md:py-10: legacy's rhythm varies per page and the set
      is not uniform. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-title font-medium text-text">Payments</h1>
        <Link
          to={exportHref(filters, bounds)}
          className="rounded-md border border-border px-3 py-1.5 text-label text-text-secondary hover:border-border-i"
        >
          Export CSV
        </Link>
      </div>

      <p className="mt-2 text-label text-text-tertiary">
        {formatMoney(atRiskCents, "usd")} at risk · {formatMoney(recoveredCents, "usd")} recovered
        {headerRecoveryRatePct !== null ? ` · ${headerRecoveryRatePct}% recovery rate` : ""}
        {" for the current filters"}
      </p>

      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {/* 279's two raised items, closed 2026-08-14 under 284's Session 1.
            THE SHOWING CARD. Legacy's first card is labelled "Showing" and its
            value is `globalCounts[status] ?? globalCounts.all`, read at the
            PaymentsClient.tsx call site. So it is a GLOBAL count that responds
            ONLY to the selected status pill, never to search, category, date or
            amount. 188 called it "a LOGIC divergence inside a copy divergence:
            filtered count against global" and BOTH halves were wrong; 279
            corrected it from the first read of that call site and VOL3 carries
            the marker. NO NEW QUERY SHAPE: every number this needs is already
            on globalCounts.
            The secondary caption that stood under this value is REMOVED.
            Legacy's card renders label and value only, so removing it restores
            legacy and is a repair rather than a divergence (252). It also became
            actively false the moment the value started tracking the pill. */}
        <StatCard label="Showing" value={String(showingCountFor(globalCounts, filters.status))} />
        {/* THE VALUE COLOURS, legacy's own, ported through StatCard's existing
            optional valueClassName additively per 199. Legacy passes a
            colorClass on ALL FIVE cards, not four: Showing `text-text`, Active
            `text-brand-text`, Recovered `text-green`, Cancelled
            `text-text-subtle`, Recovery rate thresholded. Showing's is
            `text-text`, which is exactly StatCard's own default, so it needs no
            prop and is not a divergence. Cancelled landed at 352de6a. That
            leaves THREE outstanding, not the four 279 and the S6 row recorded. */}
        <StatCard label="Active" value={String(globalCounts.active)} valueClassName="text-brand-text" />
        <StatCard label="Recovered" value={String(globalCounts.recovered)} valueClassName="text-green" />
        {/* 266's gap, closed 2026-08-14. Legacy's PaymentsStats.tsx (blob
            b386c66, read whole) is Showing / Active / Recovered / Cancelled /
            Recovery rate, and position four is Cancelled. Foxhound had a "Not
            recovered" card here, which legacy does not have anywhere, so under
            item 3's inverse corollary (112) it was an unratified Foxhound
            addition and is corrected toward legacy rather than kept alongside.
            The consequence 266 named is what this closes: a payment stopped by
            Stop recovery was counted by the pill and by no card at all.
            NO NEW QUERY SHAPE. `globalCounts.cancelled` has existed since
            Session B (265) taught tallyStatusCounts the fourth status; the gap
            was never a missing number, it was a missing card.
            `text-text-subtle` is legacy's own colour for this card. The
            remaining value colours, which that fold measured and REPORTED as
            open, are CLOSED 2026-08-14 under 284: they were THREE and not the
            "other four" recorded here, because legacy colours all five cards and
            Showing's is StatCard's own default. */}
        <StatCard
          label="Cancelled"
          value={String(globalCounts.cancelled)}
          valueClassName="text-text-subtle"
        />
        {/* Legacy's thresholds, read from source: >= 36 green, >= 21 accent (teal here),
            else red, both boundaries inclusive.
            THE EMPTY-ACCOUNT CASE IS REPAIRED 2026-08-14 under 285. This card
            rendered a hyphen with no colour when an account had no failed
            payments; legacy renders "0%" in its RED band, because 0 is below the
            21 cutoff like any other low rate. No ratification existed for the
            hyphen, so under the PRIME DIRECTIVE it was a defect and is corrected
            toward legacy. The seat recorded the counter-argument, a red zero
            greeting a new account, and declined it. */}
        <StatCard
          label="Recovery rate"
          value={`${globalRecoveryRatePct}%`}
          valueClassName={recoveryRateValueClass(globalRecoveryRatePct)}
        />
      </section>

      <StatusPills filters={filters} bounds={bounds} pillCounts={pillCounts} />

      <Form method="get" className="mt-4 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
        <input type="hidden" name="status" value={filters.status} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Name, email, or plan</span>
            <input
              type="text"
              name="q"
              defaultValue={filters.search}
              placeholder="Search"
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-brand"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Time</span>
            <select
              name="time"
              defaultValue={filters.time}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            >
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Decline</span>
            <select
              name="category"
              defaultValue={filters.declineCategory}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            >
              <option value="">All declines</option>
              {DECLINE_CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {DECLINE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Sort</span>
            <select
              name="sort"
              defaultValue={filters.sort}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="amount_desc">Amount, highest first</option>
              <option value="amount_asc">Amount, lowest first</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Rows per page</span>
            <select
              name="perPage"
              defaultValue={String(filters.pageSize)}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size === "all" ? "All" : size}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-md bg-brand px-4 py-2 text-body font-medium text-on-brand">
            Filter
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between font-mono text-micro text-text-tertiary">
            <span>{formatMoney(filters.amountMinCents, "usd")}</span>
            <span>Amount range</span>
            <span>{formatMoney(filters.amountMaxCents, "usd")}</span>
          </div>
          <DualRangeSlider
            min={bounds.minCents}
            max={bounds.maxCents}
            valueMin={filters.amountMinCents}
            valueMax={filters.amountMaxCents}
            minName="amountMin"
            maxName="amountMax"
          />
        </div>
      </Form>

      {/* S6 Session 2 result surface (274 decision one). ITEMISED, failures
          first, and it persists until the merchant dismisses it. There is no
          timer here on purpose: a bulk money action that partly failed is not
          something to flash and take away, and a merchant who looks up after
          the request lands must still be able to read which payments did not
          take it. Every row names its own payment and its own reason, so no
          outcome is folded into a bare count. */}
      {bulk && !dismissed ? (
        <div
          role="status"
          aria-label="Bulk action result"
          className="mt-6 rounded-lg border border-border bg-surface px-5 py-4"
        >
          {isBulkRefusal(bulk) ? (
            <p className="text-label text-text">
              {bulk.refused === "empty"
                ? "Nothing was selected, so nothing was changed."
                : bulk.refused === "unknown_intent"
                  ? "That is not an action this page performs. Nothing was changed."
                  : `${bulk.submitted} payments is more than the limit of ${bulk.ceiling} per submission. Nothing was changed and nothing was trimmed to fit. Narrow the selection and try again.`}
            </p>
          ) : (
            <>
              <p className="text-label text-text">
                {bulkCopy(bulk.intent)?.label ?? bulk.intent}
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {orderForDisplay(bulk.results).map((r) => (
                  <li key={r.id} className="text-micro">
                    <span className={r.ok ? "text-green" : "text-red"}>
                      {r.ok
                        ? (bulkCopy(bulk.intent)?.didLabel ?? "Applied")
                        : (bulkCopy(bulk.intent)?.didNotLabel ?? "Not applied")}
                    </span>
                    <span className="ml-2 text-text">{rowLabel(r.id)}</span>
                    {r.reason ? (
                      <span className="ml-2 text-text-subtle">{BULK_REASON_LABELS[r.reason]}</span>
                    ) : null}
                    {/* The dispatcher's own detail, carried rather than folded: the
                        STORED step result on a trigger, the offending step type, the
                        failure's result string. A retry that ran and was declined is a
                        true success whose detail says what happened to the charge, and
                        reporting it as a flat Ran would be the fold 274 one bans. */}
                    {r.detail ? (
                      <span className="ml-2 font-mono text-text-subtle">{r.detail}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {failedIds(bulk.results).length > 0 ? (
                <p className="mt-2 text-micro text-text-subtle">
                  The payments that did not take it are still selected, so the next
                  attempt is exactly those.
                </p>
              ) : null}
            </>
          )}
          <button
            type="button"
            onClick={() => setDismissedFor(bulk)}
            className="mt-3 border-none bg-transparent text-micro text-text-subtle"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="mt-6 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-label">
          <thead>
            <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
              {/* Legacy gates BOTH checkboxes on !isDemo (PaymentsTable.tsx and
                  PaymentRow.tsx at the shas parity/S6-BULK-SCOPE.md pins), so the
                  demo renders no column at all rather than a disabled one. Foxhound
                  reads isDemo the way DemoGuardedForm already does, off the
                  app-shell loader, adding no query. The 405 middleware remains the
                  security boundary; this is treatment. */}
              {!isDemo ? (
                <th className="w-10 px-4 py-3 font-normal">
                  <input
                    type="checkbox"
                    checked={headerChecked}
                    onChange={() => setSelected(toggleAllVisible(selected, rows))}
                    aria-label="Select all payments"
                    className="h-6 w-6 cursor-pointer accent-brand"
                  />
                </th>
              ) : null}
              <th className="px-4 py-3 font-normal">Customer</th>
              <th className="px-4 py-3 font-normal">Amount</th>
              <th className="px-4 py-3 font-normal">Decline</th>
              <th className="px-4 py-3 font-normal">Steps</th>
              <th className="px-4 py-3 font-normal">Status</th>
              <th className="px-4 py-3 font-normal">Detected</th>
            </tr>
          </thead>
          <tbody>
            {result.payments.length === 0 ? (
              <tr>
                <td colSpan={isDemo ? 6 : 7} className="px-4 py-8 text-center text-body text-text-tertiary">
                  {filters.search || filters.status || filters.declineCategory
                    ? "No payments match these filters."
                    : "No failed payments yet. Foxhound will list every failed payment it detects here."}
                </td>
              </tr>
            ) : (
              result.payments.map((p) => {
                const priorCount = priorFailureCount(previousFailureCounts[p.stripeCustomerId]);
                const steps = stepSummaries[p.id];
                return (
                  <tr key={p.id} className="border-b border-border-sub last:border-0">
                    {!isDemo ? (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => setSelected(toggleOne(selected, p.id))}
                          aria-label={`Select payment for ${p.customerEmail}`}
                          className="h-6 w-6 cursor-pointer accent-brand"
                        />
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      <Link to={`/recovery/payments/${p.id}`} className="text-text hover:text-brand-text">
                        {p.customerName ?? p.customerEmail}
                      </Link>
                      {priorCount > 0 ? (
                        <span className="ml-2 text-micro text-text-subtle">+{priorCount} prior</span>
                      ) : null}
                      <p className="text-micro text-text-subtle">{p.customerEmail}</p>
                      {p.planName ? <p className="text-micro text-text-subtle">{p.planName}</p> : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-text">{formatMoney(p.amountCents, p.currency)}</td>
                    <td className="px-4 py-3 text-text-tertiary">
                      {DECLINE_CATEGORY_LABELS[p.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
                        p.declineCategory}
                      {p.declineCode ? (
                        <span className="ml-2 font-mono text-micro text-text-subtle">{p.declineCode}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-text-tertiary">
                      {steps ? `${steps.completedCount} of ${steps.totalCount}` : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={failedPaymentStatusTone(p.status)}>
                        {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">
                      <p>{formatRelativeTime(p.detectedAt, nowMs)}</p>
                      <p className="text-micro text-text-subtle">{p.detectedAt.toLocaleDateString()}</p>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {result.totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-label text-text-tertiary">
          {result.page > 1 ? (
            <Link to={pageHref(filters, bounds, result.page - 1)} className="text-brand-text hover:underline">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="font-mono text-micro">
            Page {result.page} of {result.totalPages} · {result.totalCount} result
            {result.totalCount === 1 ? "" : "s"}
          </span>
          {result.page < result.totalPages ? (
            <Link to={pageHref(filters, bounds, result.page + 1)} className="text-brand-text hover:underline">
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : (
        <p className="mt-4 text-right font-mono text-micro text-text-tertiary">
          {result.totalCount} result{result.totalCount === 1 ? "" : "s"}
        </p>
      )}

      {/* Legacy's BulkActionBar, treatment and gating ported from the blob
          parity/S6-BULK-SCOPE.md pins: fixed, centred, above the fold, shown
          only when something is selected and never in demo, with the three
          actions themselves gated on there being an ACTIONABLE (active) row.
          SESSION 2 WIRES ONE INTENT (274). Stop recovery posts to this route
          action; Trigger next step and Mark recovered stay disabled for
          Session 3, because a control that looks live and does nothing is
          worse than one that says it is not ready. Clear is selection state
          and mutates nothing.
          THE FORM CARRIES `actionable`, NOT the whole selection, so the set
          the label counts is the set that is submitted. The server re-derives
          every id regardless: this is treatment, never authority. */}
      {!isDemo && selectionCount > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className="fixed bottom-6 left-1/2 z-[100] flex max-w-[90vw] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-5 py-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        >
          <Form method="post" className="flex flex-col gap-3">
            {actionable.map((id) => (
              <input key={id} type="hidden" name="ids" value={id} />
            ))}
            {/* 274 decision four. Above the threshold the action does not fire
                on the first click: it opens this, which names the EXACT count
                and the EXACT action. Over the ceiling there is no confirm
                button at all, because the submission is refused whole rather
                than trimmed to the first hundred, and the ceiling is stated
                rather than left to be discovered. */}
            {confirming ? (
              <div
                role="alertdialog"
                aria-label={`Confirm ${BULK_INTENTS[confirming].label}`}
                className="rounded-md border border-brand/40 px-4 py-3"
              >
                {overCeiling ? (
                  <>
                    <p className="text-label text-text">
                      {actionable.length} payments selected, and{" "}
                      {BULK_INTENTS[confirming].label} takes at most{" "}
                      {BULK_ACTION_MAX_PER_SUBMISSION} at a time.
                    </p>
                    <p className="mt-1 text-micro text-text-subtle">
                      Nothing has been changed, and nothing will be trimmed to fit.
                      Narrow the selection to {BULK_ACTION_MAX_PER_SUBMISSION} or fewer.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-label text-text">
                      {BULK_INTENTS[confirming].question} {actionable.length} payments?
                    </p>
                    <p className="mt-1 text-micro text-text-subtle">
                      {BULK_INTENTS[confirming].consequence}
                    </p>
                  </>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!overCeiling ? (
                    <button
                      type="submit"
                      name="intent"
                      value={confirming}
                      disabled={submitting}
                      className="rounded-md border border-brand/40 bg-transparent px-3.5 py-1.5 text-micro text-text disabled:opacity-60"
                    >
                      {BULK_INTENTS[confirming].label} for {actionable.length} payments
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setConfirmFor(null)}
                    className="border-none bg-transparent text-micro text-text-subtle"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-label text-text-subtle">{selectionCount} selected</span>
              <div className="h-5 w-px bg-border" />
              {actionable.length > 0 ? (
                <>
                  {/* SESSION 3 wires the two that were inert. All three take the
                      same path: same fan-out, same ceiling, same confirmation, same
                      itemised result surface. The only per-intent thing is the
                      value on the control, which is what the server reads. */}
                  <BulkIntentButton
                    intent="trigger"
                    count={actionable.length}
                    showCount
                    needsConfirm={needsConfirm || overCeiling}
                    submitting={submitting}
                    onConfirm={() => setConfirmFor({ from: bulk, intent: "trigger" })}
                    className="rounded-md border-none bg-brand px-3.5 py-1.5 text-micro font-semibold text-on-brand disabled:opacity-60"
                  />
                  <BulkIntentButton
                    intent="mark_recovered"
                    count={actionable.length}
                    needsConfirm={needsConfirm || overCeiling}
                    submitting={submitting}
                    onConfirm={() => setConfirmFor({ from: bulk, intent: "mark_recovered" })}
                    className="rounded-md border border-green/30 bg-transparent px-3.5 py-1.5 text-micro text-green disabled:opacity-60"
                  />
                  <BulkIntentButton
                    intent="cancel"
                    count={actionable.length}
                    needsConfirm={needsConfirm || overCeiling}
                    submitting={submitting}
                    onConfirm={() => setConfirmFor({ from: bulk, intent: "cancel" })}
                    className="rounded-md border border-red/30 bg-transparent px-3.5 py-1.5 text-micro text-red disabled:opacity-60"
                  />
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="border-none bg-transparent text-micro text-text-subtle"
              >
                Clear
              </button>
            </div>
          </Form>
        </div>
      ) : null}
    </div>
  );
}
