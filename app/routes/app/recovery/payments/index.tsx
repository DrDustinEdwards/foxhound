import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, data, useNavigate, useNavigation, useRouteLoaderData, useSubmit } from "react-router";
import { Banner } from "capsomer/react/banner";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Glyph, Pill, type Tone as StatusTone } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/bulk-bar.css";
import "capsomer/button.css";
import "capsomer/chips.css";
import "capsomer/confirm-dialog.css";
import "capsomer/dialog.css";
import "capsomer/empty.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/pagination.css";
import "capsomer/panel.css";
import "capsomer/segmented.css";
import "capsomer/select.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the teal family, which the components above read, as
// /intelligence/customers and /disputes load them.
import "~/site-header.css";

import { DualRangeSlider } from "~/components/dual-range-slider";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatTimeAgo } from "~/lib/date-format";
import { formatLongDate, paymentStepSummary } from "~/lib/dashboard/recovery-dashboard";
import { formatMoney } from "~/lib/money-format";
import { FAILED_PAYMENT_STATUS_LABELS, failedPaymentStatusTone } from "~/lib/recovery/labels";
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
import {
  AMOUNT_SLIDER_STEP_CENTS,
  DECLINE_CATEGORY_WORDS,
  PAYMENTS_DEFAULT_PAGE_SIZE,
  PAYMENTS_PAGE_SIZE_OPTIONS,
  BULK_RESULT_DISMISS_MS,
  bulkResultClearsItself,
  bulkResultLine,
  parsePaymentsPage,
  parsePaymentsPageSize,
  declineWord,
  paymentsHeaderLine,
  paymentsShowingText,
} from "~/lib/recovery/payments-list";
import { paymentHeaderStats, paymentStepLabel } from "~/lib/recovery/payments-list.server";
import { recoveryRateValueClass, showingCountFor } from "~/lib/recovery/payments-stats";
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
import { isPaymentTimeRange, resolvePaymentTimeRangeCutoff, type PaymentTimeRange } from "~/lib/recovery/time-range";

import type { Route } from "./+types/index";

// /recovery/payments (row S6, job J75). Recova is the spec: its page,
// app/(app)/recovery/payments/page.tsx at blob bab8d48d, PaymentsClient.tsx
// 94043896, components/PaymentsHeader.tsx 27cd8e4a, PaymentsStats.tsx
// b386c660, PaymentsFilters.tsx b6612faf, PaymentsTable.tsx 95a10450,
// BulkActionBar.tsx 7f40166f, components/recovery/PaymentRow.tsx 0d2e1f52,
// components/AmountRangeSlider.tsx d6bb58e8 and lib/payments-data.ts
// 14e0a6a3, each read whole. In Recova's order and width (1280px): the head
// with Export CSV, the five count cards, the bulk result, the filter panel
// (search and status, then date, decline, sort, amount, the result count and
// Clear filters), the rows-per-page links, the table, the pager, and the bulk
// bar while something is selected.
//
// Built from Capsomer 0.9.0's parts (Q10), teal throughout (Q11). No Foxhound
// class sits on a Capsomer element: Recova's mono figures, its sizes and its
// spacing go on elements of the page's own inside or around them. Recova's
// per-status colours on the status filter and the row pills, its filled (now
// teal) Next button in the pager, and its 12px radius wait for Capsomer's
// per-site layer (capsomer job_ec5ec0754626), listed in the J75 pull request.
//
// Approved differences kept (APPROVED-DIFFERENCES): status pills say the tab
// word (2026-08-14); "Stop recovery" (2026-08-10); bulk actions submit exactly
// what the button counts and only rows on screen can be selected
// (2026-08-13); they report per payment and keep the failures selected, and
// ask above 25 and refuse above 100 (2026-09-19); "Payments - Foxhound"
// (2026-08-28). Recova's personal-outreach mark after a name waits for its
// producer (J78, row S20): nothing in Foxhound writes recommended_action yet
// (RULES.md 3.18).
//
// Every filter is in the URL and runs in the loader. Script applies a filter
// on change, as Recova's controls do; without script the form still submits
// on Enter.

export function meta() {
  return [{ title: "Payments - Foxhound" }];
}

function parseSort(value: string | null): FailedPaymentSort {
  return value === "oldest" || value === "amount_desc" || value === "amount_asc" ? value : "newest";
}

function parseTimeRange(value: string | null): PaymentTimeRange {
  return value && isPaymentTimeRange(value) ? value : "all";
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
  const page = parsePaymentsPage(params.get("page"));
  const pageSize = parsePaymentsPageSize(params.get("perPage"));

  const bounds = await getAmountBounds(db, accountId);
  const amountMinParsed = parseAmountParam(params.get("amountMin"), bounds.minCents, bounds.maxCents);
  const amountMaxParsed = parseAmountParam(params.get("amountMax"), bounds.minCents, bounds.maxCents);
  // A handle resting on its own end is no filter.
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

  // Only what the page shows reaches the browser: no Stripe ids, and a note
  // as whether there is one, since the row shows Recova's "note" chip and not
  // the note.
  const payments = result.payments.map((p) => ({
    id: p.id,
    customerName: p.customerName,
    customerEmail: p.customerEmail,
    planName: p.planName,
    amountCents: p.amountCents,
    currency: p.currency,
    declineCategory: p.declineCategory,
    declineCode: p.declineCode,
    status: p.status,
    detectedAt: p.detectedAt,
    hasNote: Boolean(p.notes?.trim()),
    priorFailures: priorFailureCount(previousFailureCounts[p.stripeCustomerId]),
    steps: paymentStepSummary(
      stepRows.filter((s) => s.failedPaymentId === p.id),
      (stepType) => paymentStepLabel(p.declineCategory, stepType),
    ),
  }));

  // Recova's status counts respect every filter but status itself.
  const pillCounts = tallyStatusCounts(summaryRows.map((r) => r.status));
  // Legacy's exact computation: an account with no failed payments reads 0.
  const globalRecoveryRatePct = globalCounts.all > 0 ? Math.round((globalCounts.recovered / globalCounts.all) * 100) : 0;

  return {
    result: {
      payments,
      totalCount: result.totalCount,
      page: result.page,
      totalPages: result.totalPages,
      pageSize: result.pageSize,
    },
    globalCounts,
    globalRecoveryRatePct,
    pillCounts,
    header: paymentHeaderStats(result.payments),
    bounds,
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
 * The bulk POST target (274 decisions one, four and five).
 *
 * Nothing the browser sends is trusted: every id is re-derived through
 * dispatchManualAction's own account-scoped read and per-intent preconditions,
 * one payment and one key at a time (RULES.md 3.2), so an unowned id answers
 * not_found exactly as it would singly. A submission over the ceiling is
 * refused whole.
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

const BASE = "/recovery/payments";

function hrefWith(filters: Filters, bounds: AmountBounds, overrides: Partial<Record<string, string>> = {}): string {
  return withParams(
    BASE,
    buildPaymentParams(filters, { bounds, defaultPageSize: PAYMENTS_DEFAULT_PAGE_SIZE, overrides }),
  );
}

function pageHref(filters: Filters, bounds: AmountBounds, page: number): string {
  return hrefWith(filters, bounds, { page: page > 1 ? String(page) : "" });
}

/** Recova's Export CSV writes the rows on screen (PaymentsClient.tsx
 *  handleExport, exportToCSV(filtered)), so the link carries this page and
 *  this page size as well as the filters. */
function exportHref(filters: Filters, bounds: AmountBounds, page: number): string {
  return withParams(
    `${BASE}/export.csv`,
    buildPaymentParams(filters, {
      bounds,
      defaultPageSize: PAYMENTS_DEFAULT_PAGE_SIZE,
      overrides: { page: String(page), perPage: String(filters.pageSize) },
    }),
  );
}

/** Recova's Clear filters keeps the sort and the page size and drops the rest. */
function clearHref(filters: Filters, bounds: AmountBounds): string {
  return hrefWith(
    {
      ...filters,
      search: "",
      status: "",
      declineCategory: "",
      time: "all",
      amountMinCents: bounds.minCents,
      amountMaxCents: bounds.maxCents,
    },
    bounds,
  );
}

// Recova's STATUS_TABS, in order (PaymentsFilters.tsx).
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

function countFor(pillCounts: PillCounts, value: string): number {
  if (value === "") return pillCounts.all;
  if (value === "active") return pillCounts.active;
  if (value === "recovered") return pillCounts.recovered;
  if (value === "cancelled") return pillCounts.cancelled;
  return pillCounts.failedUnrecovered;
}

// Recova's DATE_RANGES and its sort options, in its words.
const DATE_RANGES: { value: PaymentTimeRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const SORTS: { value: FailedPaymentSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "amount_desc", label: "Highest amount" },
  { value: "amount_asc", label: "Lowest amount" },
];

const SEARCH_DELAY_MS = 300;

/** Why one payment did not take the action, in the merchant's words. */
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

/** Per-intent copy for the bar, the confirmation and the result list. */
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

const BULK_VARIANTS: Record<BulkActionIntent, "primary" | undefined | "danger"> = {
  trigger: "primary",
  mark_recovered: undefined,
  cancel: "danger",
};

const PILL_TONE: Record<"success" | "failure" | "neutral", StatusTone | undefined> = {
  success: "ok",
  failure: "crit",
  neutral: undefined,
};

function bulkCopy(intent: string) {
  return isBulkActionIntent(intent) ? BULK_INTENTS[intent] : null;
}

export default function RecoveryPayments({ loaderData, actionData }: Route.ComponentProps) {
  const {
    result,
    globalCounts,
    globalRecoveryRatePct,
    pillCounts,
    header,
    bounds,
    nowMs,
    filters,
  } = loaderData;
  const navigate = useNavigate();
  const submit = useSubmit();

  // Selection is client-only and per page, Recova's own model. Every read goes
  // through the pure helpers, so the effective selection is the stored set
  // intersected with what is on screen (approved 2026-08-13).
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  const isDemo = Boolean(shell?.isDemo);
  const [sel, setSel] = useState<{ ids: ReadonlySet<string>; from: unknown }>(() => ({
    ids: new Set<string>(),
    from: undefined,
  }));
  const rows = result.payments;

  // Failures stay selected (approved 2026-09-19): when a response lands the
  // selection becomes exactly the ids that failed, until it is edited again.
  // The dismissal and the confirmation are tagged with the response they
  // belong to, so each new response starts fresh with no effect.
  const navigation = useNavigation();
  const submitting = navigation.formMethod === "POST";
  const submittingIntent = submitting ? String(navigation.formData?.get("intent") ?? "") : "";
  const bulk = actionData?.bulk;
  const applied = bulk && !isBulkRefusal(bulk) ? bulk : null;
  const selected: ReadonlySet<string> =
    sel.from !== bulk && applied ? new Set(failedIds(applied.results)) : sel.ids;
  const setSelected = (ids: ReadonlySet<string>) => setSel({ ids, from: bulk });

  const [dismissedFor, setDismissedFor] = useState<unknown>(null);
  const dismissed = dismissedFor === bulk;
  // Recova clears the result after 3 seconds. Here only an all-succeeded
  // result does; one with a failure or a refusal waits to be dismissed
  // (WCAG 2.2.1), pending Dustin's ruling. The failures stay selected.
  useEffect(() => {
    if (!bulkResultClearsItself(bulk)) return;
    const t = setTimeout(() => setDismissedFor(bulk), BULK_RESULT_DISMISS_MS);
    return () => clearTimeout(t);
  }, [bulk]);
  const [confirmFor, setConfirmFor] = useState<{ from: unknown; intent: BulkActionIntent } | null>(null);
  const confirming = confirmFor !== null && confirmFor.from === bulk ? confirmFor.intent : null;
  const [lastConfirm, setLastConfirm] = useState<BulkActionIntent>("trigger");

  const selectionCount = selectedCount(selected, rows);
  const actionable = actionableSelection(selected, rows);
  const headerChecked = allVisibleSelected(selected, rows);

  // The client half of the approved limits; the server refuses over the
  // ceiling too, because a hand-made POST never sees this line.
  const overCeiling = actionable.length > BULK_ACTION_MAX_PER_SUBMISSION;
  const needsConfirm = actionable.length > BULK_ACTION_CONFIRM_THRESHOLD;
  const rowLabel = (id: string) => {
    const r = rows.find((p) => p.id === id);
    return r ? (r.customerName ?? r.customerEmail) : id;
  };
  const confirmLine = (id: string) => {
    const r = rows.find((p) => p.id === id);
    return r
      ? `${r.customerName ?? r.customerEmail}, ${formatMoney(r.amountCents, r.currency)}, detected ${formatLongDate(r.detectedAt)}`
      : id;
  };

  // Recova applies a filter on change. The search waits a moment after typing
  // stops, so each key is not its own page load.
  const [search, setSearch] = useState(filters.search);
  const sentSearch = useRef(filters.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (filters.search !== sentSearch.current) {
      sentSearch.current = filters.search;
      setSearch(filters.search);
    }
  }, [filters.search]);
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );
  function onSearch(value: string) {
    setSearch(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      sentSearch.current = value.trim();
      void navigate(hrefWith(filters, bounds, { q: value.trim() }), { replace: true, preventScrollReset: true });
    }, SEARCH_DELAY_MS);
  }
  const go = (overrides: Partial<Record<string, string>>) =>
    void navigate(hrefWith(filters, bounds, overrides), { preventScrollReset: true });

  const hasActiveFilters = Boolean(
    filters.search ||
      filters.status ||
      filters.declineCategory ||
      filters.time !== "all" ||
      filters.amountMinCents > bounds.minCents ||
      filters.amountMaxCents < bounds.maxCents,
  );
  const resultCount = result.totalCount;

  async function performConfirmed(intent: BulkActionIntent) {
    const form = new FormData();
    for (const id of actionable) form.append("ids", id);
    form.append("intent", intent);
    await submit(form, { method: "post" });
  }

  const cards: { label: string; value: string; className?: string }[] = [
    { label: "Showing", value: String(showingCountFor(globalCounts, filters.status)) },
    { label: "Active", value: String(globalCounts.active), className: "text-brand-text" },
    { label: "Recovered", value: String(globalCounts.recovered), className: "text-green" },
    { label: "Cancelled", value: String(globalCounts.cancelled), className: "text-text-subtle" },
    {
      label: "Recovery rate",
      value: `${globalRecoveryRatePct}%`,
      className: recoveryRateValueClass(globalRecoveryRatePct),
    },
  ];

  return (
    // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-10. The shell owns
    // the page's one <main> (ruling 146), so this is a plain wrapper.
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
      <div className="mb-6">
        <PageHead
          title="Payments"
          lead={paymentsHeaderLine(header)}
          actions={
            <Link to={exportHref(filters, bounds, result.page)} className="cap-btn" reloadDocument>
              Export CSV
            </Link>
          }
        />
      </div>

      {/* Recova's PaymentsStats: five cards, label over a mono figure. */}
      <div
        role="group"
        aria-label="Payment counts"
        className="mb-5 grid grid-cols-2 gap-3 min-[480px]:grid-cols-3 md:grid-cols-5"
      >
        {cards.map((card) => (
          <Panel key={card.label} size="sm" title={card.label}>
            <p className={`m-0 font-mono text-title font-bold tabular-nums ${card.className ?? "text-text"}`}>
              {card.value}
            </p>
          </Panel>
        ))}
      </div>

      {/* Recova's bulk result sits here, between the cards and the filters.
          Per payment, failures first (approved 2026-09-19). Capsomer's React
          Banner puts its children inside a <p>, which cannot hold the list,
          so the itemised result is Capsomer's banner markup with the title,
          the list and the note as siblings in .cap-banner-body. */}
      {bulk && !dismissed ? (
        <div className="mb-4">
          {isBulkRefusal(bulk) ? (
            <Banner tone="crit" onDismiss={() => setDismissedFor(bulk)}>
              {bulk.refused === "empty"
                ? "Nothing was selected, so nothing was changed."
                : bulk.refused === "unknown_intent"
                  ? "That is not an action this page performs. Nothing was changed."
                  : `${bulk.submitted} payments is more than the limit of ${bulk.ceiling} per submission. Nothing was changed and nothing was trimmed to fit. Narrow the selection and try again.`}
            </Banner>
          ) : (
            <div
              className="cap-banner"
              data-tone={failedIds(bulk.results).length === 0 ? "ok" : "crit"}
              role={failedIds(bulk.results).length === 0 ? "status" : "alert"}
            >
              <Glyph name={failedIds(bulk.results).length === 0 ? "ok" : "crit"} />
              <div className="cap-banner-body">
                <p className="cap-banner-title">{bulkResultLine(bulk.intent, bulk.results)}</p>
                <ul className="cap-banner-text m-0 flex list-none flex-col gap-1 p-0 text-label">
                  {orderForDisplay(bulk.results).map((r) => (
                    <li key={r.id}>
                      <span className={r.ok ? "text-success-text" : "text-error-text"}>
                        {r.ok
                          ? (bulkCopy(bulk.intent)?.didLabel ?? "Applied")
                          : (bulkCopy(bulk.intent)?.didNotLabel ?? "Not applied")}
                      </span>
                      <span className="ml-2 text-text">{rowLabel(r.id)}</span>
                      {r.reason ? <span className="ml-2 text-text-subtle">{BULK_REASON_LABELS[r.reason]}</span> : null}
                      {/* The dispatcher's own detail, carried rather than folded. */}
                      {r.detail ? <span className="ml-2 font-mono text-text-subtle">{r.detail}</span> : null}
                    </li>
                  ))}
                </ul>
                {failedIds(bulk.results).length > 0 ? (
                  <p className="cap-banner-text m-0 text-label text-text-subtle">
                    The payments that did not take it are still selected, so the next attempt is exactly those.
                  </p>
                ) : null}
              </div>
              <div className="cap-banner-actions">
                <button type="button" className="cap-btn" data-variant="quiet" onClick={() => setDismissedFor(bulk)}>
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Recova's PaymentsFilters: one panel, two rows. */}
      <Form
        method="get"
        className="cap-panel"
        onSubmit={() => {
          if (searchTimer.current) clearTimeout(searchTimer.current);
        }}
      >
        <div className="cap-panel-body">
          <div className="flex flex-col gap-4 text-label">
            <div className="flex flex-col items-stretch gap-2.5 md:flex-row md:flex-wrap md:items-center">
              <div className="w-full md:min-w-[180px] md:flex-1">
                <input
                  className="cap-input"
                  type="text"
                  name="q"
                  value={search}
                  onChange={(e) => onSearch(e.target.value)}
                  placeholder="Search by name, email, or plan..."
                  aria-label="Search payments"
                />
              </div>
              <div className="max-w-full overflow-x-auto">
                {/* Capsomer's segmented control, as its markup: its React
                    wrapper hides the legend with cap-sr-only, which lives in
                    Capsomer's base.css, which the app does not load, so the
                    legend would show where Recova shows none. */}
                <fieldset className="cap-seg">
                  <legend className="sr-only">Filter by status</legend>
                  <div className="cap-seg-options">
                    {STATUS_PILLS.map((pill) => (
                      <label key={pill.value}>
                        <input
                          type="radio"
                          name="status"
                          value={pill.value}
                          checked={filters.status === pill.value}
                          onChange={() => go({ status: pill.value })}
                        />{" "}
                        {pill.label} <span className="font-mono">{countFor(pillCounts, pill.value)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </div>

            <div className="flex flex-col items-stretch gap-2.5 md:flex-row md:flex-wrap md:items-center">
              <div className="cap-select-wrap">
                <select
                  className="cap-select"
                  name="time"
                  aria-label="Filter by date range"
                  value={filters.time}
                  onChange={(e) => go({ time: e.target.value === "all" ? "" : e.target.value })}
                >
                  {DATE_RANGES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cap-select-wrap">
                <select
                  className="cap-select"
                  name="category"
                  aria-label="Filter by decline category"
                  value={filters.declineCategory}
                  onChange={(e) => go({ category: e.target.value })}
                >
                  <option value="">All declines</option>
                  {Object.keys(DECLINE_CATEGORY_WORDS).map((c) => (
                    <option key={c} value={c}>
                      {declineWord(c)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cap-select-wrap">
                <select
                  className="cap-select"
                  name="sort"
                  aria-label="Filter by sort order"
                  value={filters.sort}
                  onChange={(e) => go({ sort: e.target.value === "newest" ? "" : e.target.value })}
                >
                  {SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <DualRangeSlider
                min={bounds.minCents}
                max={bounds.maxCents}
                valueMin={filters.amountMinCents}
                valueMax={filters.amountMaxCents}
                step={AMOUNT_SLIDER_STEP_CENTS}
                minName="amountMin"
                maxName="amountMax"
                onCommit={(nextMin, nextMax) =>
                  go({
                    amountMin: nextMin > bounds.minCents ? String(nextMin) : "",
                    amountMax: nextMax < bounds.maxCents ? String(nextMax) : "",
                  })
                }
              />
              <div className="flex flex-wrap items-center gap-3">
                <span className="whitespace-nowrap text-micro text-text-subtle">
                  {resultCount} result{resultCount !== 1 ? "s" : ""}
                </span>
                {hasActiveFilters ? (
                  <Link to={clearHref(filters, bounds)} className="cap-btn" data-variant="quiet" data-size="sm">
                    Clear filters
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        {/* The page size and the sort ride along when the form submits without
            script; with script every control navigates on change. */}
        {filters.pageSize !== PAYMENTS_DEFAULT_PAGE_SIZE ? (
          <input type="hidden" name="perPage" value={String(filters.pageSize)} />
        ) : null}
      </Form>

      {/* Recova's rows-per-page links, right-aligned between the panel and the
          table, as Capsomer's link chips. */}
      <nav aria-label="Rows per page" className="mb-2 mt-4 flex items-center justify-end gap-1.5">
        <span className="mr-1 text-micro text-text-tertiary" aria-hidden="true">
          Rows per page
        </span>
        <ul className="cap-chips m-0 list-none p-0">
          {PAYMENTS_PAGE_SIZE_OPTIONS.map((n) => (
            <li key={n}>
              <Link
                className="cap-chip"
                data-size="sm"
                to={hrefWith(filters, bounds, { perPage: n === PAYMENTS_DEFAULT_PAGE_SIZE ? "" : String(n) })}
                aria-current={filters.pageSize === n ? "true" : undefined}
              >
                {n === "all" ? "All" : n}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {rows.length === 0 ? (
        <Empty kind="no-match" title="No payments match your filters">
          Try adjusting your search or filters
        </Empty>
      ) : (
        <div className="cap-panel">
          <div className="cap-panel-body" data-flush="">
            <div className="cap-table-wrap" data-cap="table" role="region" aria-label="Payments" tabIndex={0}>
              <table className="cap-table">
                <thead>
                  <tr>
                    {/* Recova gates both boxes on !isDemo, so the demo has no
                        column at all. The 405 middleware is the boundary. */}
                    {!isDemo ? (
                      <th scope="col">
                        <label className="cap-check">
                          <input
                            type="checkbox"
                            checked={headerChecked}
                            onChange={() => setSelected(toggleAllVisible(selected, rows))}
                          />
                          <span className="sr-only">Select all payments</span>
                        </label>
                      </th>
                    ) : null}
                    <th scope="col">Customer</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Decline</th>
                    <th scope="col">Steps</th>
                    <th scope="col">Status</th>
                    <th scope="col">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const name = p.customerName ?? p.customerEmail;
                    const isSelected = selected.has(p.id);
                    return (
                      <tr key={p.id} data-state={isSelected ? "selected" : undefined}>
                        {!isDemo ? (
                          <td>
                            <label className="cap-check">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => setSelected(toggleOne(selected, p.id))}
                              />
                              <span className="sr-only">Select payment from {name}</span>
                            </label>
                          </td>
                        ) : null}
                        <th scope="row">
                          {/* Recova's whole row opens the payment: Capsomer's
                              stretched row link, under the box and the pills. */}
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Link className="cap-table-open" to={`${BASE}/${p.id}`}>
                              {name}
                            </Link>
                            {p.priorFailures > 0 ? <Pill tone="warn">{p.priorFailures + 1}x failure</Pill> : null}
                            {p.hasNote ? <Pill>note</Pill> : null}
                          </span>
                          {p.customerName ? (
                            <span className="mt-0.5 block text-micro font-normal text-text-subtle">
                              {p.customerEmail}
                            </span>
                          ) : null}
                          {p.planName ? (
                            <span className="mt-0.5 block text-micro font-normal text-text-subtle">{p.planName}</span>
                          ) : null}
                        </th>
                        <td>
                          <span className="whitespace-nowrap font-mono text-label text-brand-text">
                            {formatMoney(p.amountCents, p.currency)}
                          </span>
                        </td>
                        <td>
                          <Pill variant="outline">{declineWord(p.declineCategory)}</Pill>
                          {p.declineCode ? (
                            <span className="mt-0.5 block font-mono text-micro text-text-subtle">{p.declineCode}</span>
                          ) : null}
                        </td>
                        <td>
                          <span
                            className={`font-mono text-micro ${p.steps.completed > 0 ? "text-text" : "text-text-subtle"}`}
                          >
                            {p.steps.completed}/{p.steps.total}
                          </span>
                          {p.steps.next ? (
                            <span className="mt-0.5 block text-micro text-brand-text">Next: {p.steps.next}</span>
                          ) : null}
                        </td>
                        <td>
                          <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                            {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                          </Pill>
                        </td>
                        <td>
                          <span className="flex items-center justify-between gap-2">
                            <span className="text-micro text-text-subtle">
                              <span className="block whitespace-nowrap">{formatTimeAgo(p.detectedAt, nowMs)}</span>
                              <span className="mt-0.5 block whitespace-nowrap">{formatLongDate(p.detectedAt)}</span>
                            </span>
                            {/* Recova's View, shown on hover. The row link above
                                is the keyboard's way in, so this one is not a
                                second tab stop. */}
                            <Link
                              to={`${BASE}/${p.id}`}
                              tabIndex={-1}
                              aria-hidden="true"
                              className="whitespace-nowrap font-mono text-micro text-text-tertiary no-underline opacity-0 [tr:hover_&]:opacity-100"
                            >
                              View <ArrowRight className="inline-block" size={13} strokeWidth={1.5} aria-hidden />
                            </Link>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Recova's pager: the range on the left, Previous and Next on the
          right, each present and disabled when it leads nowhere. */}
      {result.totalCount > 0 ? (
        <div className="mt-4">
          <nav className="cap-pagination" aria-label="Payment pages">
            <p className="cap-pagination-status">
              {paymentsShowingText(result.page, result.pageSize, result.totalCount)}
            </p>
            <ul className="cap-pagination-list">
              <li>
                {result.page > 1 ? (
                  <Link className="cap-page" data-kind="prev" to={pageHref(filters, bounds, result.page - 1)} rel="prev">
                    Previous
                  </Link>
                ) : (
                  <a className="cap-page" data-kind="prev" role="link" aria-disabled="true">
                    Previous
                  </a>
                )}
              </li>
              <li>
                {result.page < result.totalPages ? (
                  <Link className="cap-page" data-kind="next" to={pageHref(filters, bounds, result.page + 1)} rel="next">
                    Next
                  </Link>
                ) : (
                  <a className="cap-page" data-kind="next" role="link" aria-disabled="true">
                    Next
                  </a>
                )}
              </li>
            </ul>
          </nav>
        </div>
      ) : null}

      {/* Recova's BulkActionBar on Capsomer's bulk bar, in the delivered page
          only while something is selected and never in the demo. The form
          carries `actionable`, so the set the button counts is the set that
          is submitted (approved 2026-08-13). Up to 25 a button submits at
          once; above 25 it asks first, naming every payment; above 100 it
          does nothing and says why (approved 2026-09-19). */}
      {!isDemo && selectionCount > 0 ? (
        <Form method="post" className="sticky bottom-6 z-[100] mt-6">
          {actionable.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <div className="cap-bulk" data-cap="bulk-bar" role="region" aria-label="Bulk actions">
            <p className="cap-bulk-count" role="status">
              {selectionCount} selected
            </p>
            <div className="cap-bulk-actions">
              {actionable.length > 0
                ? (Object.keys(BULK_INTENTS) as BulkActionIntent[]).map((intent) => {
                    const blocked = overCeiling || submitting;
                    return (
                      <button
                        key={intent}
                        type={needsConfirm || overCeiling ? "button" : "submit"}
                        name="intent"
                        value={intent}
                        className="cap-btn"
                        data-variant={BULK_VARIANTS[intent]}
                        aria-disabled={blocked ? "true" : undefined}
                        aria-busy={submittingIntent === intent ? "true" : undefined}
                        aria-describedby={overCeiling ? "bulk-ceiling" : undefined}
                        onClick={(e) => {
                          if (blocked) {
                            e.preventDefault();
                            return;
                          }
                          if (needsConfirm) {
                            setLastConfirm(intent);
                            setConfirmFor({ from: bulk, intent });
                          }
                        }}
                      >
                        {submittingIntent === intent
                          ? "Working..."
                          : intent === "trigger"
                            ? `${BULK_INTENTS[intent].label} (${actionable.length})`
                            : BULK_INTENTS[intent].label}
                      </button>
                    );
                  })
                : null}
            </div>
            {overCeiling ? (
              <p id="bulk-ceiling" className="m-0 text-label text-text-subtle">
                {actionable.length} payments selected. Bulk actions take at most {BULK_ACTION_MAX_PER_SUBMISSION} at a
                time, and nothing is trimmed to fit. Narrow the selection to {BULK_ACTION_MAX_PER_SUBMISSION} or fewer.
              </p>
            ) : null}
            <button
              type="button"
              className="cap-btn cap-bulk-clear"
              data-variant="quiet"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        </Form>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={`${BULK_INTENTS[confirming ?? lastConfirm].question} ${actionable.length} payments?`}
        lead={BULK_INTENTS[confirming ?? lastConfirm].consequence}
        body={actionable.map(confirmLine)}
        action={`${BULK_INTENTS[confirming ?? lastConfirm].label} for ${actionable.length} payments`}
        perform={() => performConfirmed(confirming ?? lastConfirm)}
        onClose={() => setConfirmFor(null)}
      />
    </div>
  );
}
