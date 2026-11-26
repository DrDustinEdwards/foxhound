import { pageEnvelope, statusText } from "capsomer/behavior/pagination";
import { useState } from "react";
import { data, useNavigation, useRouteLoaderData, useSubmit } from "react-router";
import { ButtonLink } from "capsomer/react/link";
import { useShownFor } from "capsomer/react/hooks";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import "capsomer/banner.css";
import "capsomer/bulk-bar.css";
import "capsomer/button.css";
import "capsomer/chips.css";
import "capsomer/confirm-dialog.css";
import "capsomer/dialog.css";
import "capsomer/empty.css";
import "capsomer/field.css";
import "capsomer/filter-bar.css";
import "capsomer/page-head.css";
import "capsomer/pagination.css";
import "capsomer/panel.css";
import "capsomer/range-slider.css";
import "capsomer/segmented.css";
import "capsomer/select.css";
import "capsomer/status.css";
import "capsomer/table.css";
import "~/site-header.css";

import { personalOutreachCustomerIds } from "~/lib/intelligence/recommendations.server";
import { accountScope } from "~/lib/auth/context";
import { formatDetectedDate, paymentStepSummary } from "~/lib/dashboard/recovery-dashboard";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import {
  getGlobalPaymentStatusCounts,
  listFilteredFailedPayments,
  listPaymentSummaryRows,
  readPaymentFilters,
  tallyStatusCounts,
} from "~/lib/recovery/queries.server";
import { listStepsForFailedPayments } from "~/lib/recovery/step-queries.server";
import { countFailuresByCustomer } from "~/lib/recovery/dashboard-queries.server";
import { BULK_RESULT_DISMISS_MS, bulkResultClearsItself } from "~/lib/recovery/payments-list";
import { paymentStepLabel } from "~/lib/recovery/payments-list.server";
import { showingCountFor } from "~/lib/recovery/payments-stats";
import { recoveryRateClassNameOrNull } from "~/lib/dashboard/recovery-rate";
import { allVisibleSelected, visibleSelection } from "capsomer/behavior/bulk-bar";
import type { loader as appShellLoader } from "~/layouts/app-shell";
import { runBulkAction } from "~/lib/recovery/bulk-actions.server";
import {
  actionableSelection,
  failedIds,
  isBulkRefusal,
  type BulkActionIntent,
} from "~/lib/recovery/bulk-results";
import { moneyWriteCommit } from "~/lib/recovery/manual-actions.server";
import { resendDepsFor, triggerDepsFor } from "~/lib/recovery/manual-action-deps.server";
import { BULK_ACTION_CONFIRM_THRESHOLD, BULK_ACTION_MAX_PER_SUBMISSION } from "~/lib/constants";
import { priorFailureCount } from "~/lib/recovery/prior-failures";

import type { Route } from "./+types/index";
import {
  BulkBar,
  BulkResultBanner,
  PaymentsPager,
  PaymentsTable,
} from "~/components/payments-list-parts";
import { exportHref } from "~/lib/recovery/payments-page";
import { BULK_INTENTS } from "~/lib/recovery/bulk-copy";
import { PaymentsFilters } from "~/components/payments-filters";
import { noindexMeta } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import { percent } from "capsomer/behavior/meter";

// /recovery/payments. No Foxhound class sits on a Capsomer element: mono figures, sizes and spacing go on elements of the page's own inside or around them. Bulk actions submit exactly what the button counts and only rows on screen can be selected; they report per payment and keep the failures selected, and ask above 25 and refuse above 100.
// Every filter is in the URL and runs in the loader. Script applies a filter on change; without script the form still submits on Enter.

export const meta = noindexMeta("Payments - Foxhound");

export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, accountId } = accountScope(context);
  const nowMs = Date.now();

  const { input, filters, time, bounds, amountMinParsed, amountMaxParsed } =
    await readPaymentFilters(db, accountId, new URL(request.url).searchParams, nowMs);

  const [result, globalCounts, summaryRows] = await Promise.all([
    listFilteredFailedPayments(db, accountId, filters),
    getGlobalPaymentStatusCounts(db, accountId),
    listPaymentSummaryRows(db, accountId, input),
  ]);

  const customerIds = [...new Set(result.payments.map((p) => p.stripeCustomerId))];
  const [previousFailureCounts, stepRows, outreachIds] = await Promise.all([
    countFailuresByCustomer(db, accountId, customerIds),
    listStepsForFailedPayments(
      db,
      accountId,
      result.payments.map((p) => p.id),
    ),
    // The visible customers Intelligence flagged for personal outreach. A read failure leaves the marks off, not the page.
    personalOutreachCustomerIds(db, accountId, customerIds).catch(() => [] as string[]),
  ]);
  const outreach = new Set(outreachIds);

  // Only what the page shows reaches the browser: no Stripe ids, and a note as whether there is one, since the row shows a "note" chip and not the note.
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
    outreach: outreach.has(p.stripeCustomerId),
    priorFailures: priorFailureCount(previousFailureCounts[p.stripeCustomerId]),
    steps: paymentStepSummary(
      stepRows.filter((s) => s.failedPaymentId === p.id),
      (stepType) => paymentStepLabel(p.declineCategory, stepType),
    ),
  }));

  // The status counts respect every filter but status itself.
  const pillCounts = tallyStatusCounts(summaryRows.map((r) => r.status));
  const globalRecoveryRatePct =
    globalCounts.all > 0 ? percent(globalCounts.recovered, globalCounts.all) : null;

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
    bounds,
    nowMs,
    filters: {
      search: filters.search ?? "",
      status: filters.status ?? "",
      declineCategory: filters.declineCategory ?? "",
      time,
      sort: filters.sort,
      pageSize: filters.pageSize,
      amountMinCents: amountMinParsed ?? bounds.minCents,
      amountMaxCents: amountMaxParsed ?? bounds.maxCents,
    },
  };
}

/** The bulk POST target. Nothing the browser sends is trusted: every id is re-derived through dispatchManualAction's own account-scoped read and per-intent preconditions, one payment and one key at a time, so an unowned id answers not_found exactly as it would singly. A submission over the ceiling is refused whole. */
export async function action({ context, request }: Route.ActionArgs) {
  const { env, auth, db } = accountScope(context);
  const form = await readForm(request, BODY_MAX_BYTES);
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

export default function RecoveryPayments({ loaderData, actionData }: Route.ComponentProps) {
  const { result, globalCounts, globalRecoveryRatePct, pillCounts, bounds, nowMs, filters } =
    loaderData;
  const submit = useSubmit();

  // Selection is client-only and per page. Every read goes through the pure helpers, so the effective selection is the stored set intersected with what is on screen.
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  const isDemo = Boolean(shell?.isDemo);
  const [sel, setSel] = useState<{ ids: ReadonlySet<string>; from: unknown }>(() => ({
    ids: new Set<string>(),
    from: undefined,
  }));
  const rows = result.payments;
  const shown = pageEnvelope(result.page, result.pageSize, result.totalCount);
  const showing = statusText(shown.page, shown.perPage, shown.total, "payments");

  // Failures stay selected: when a response lands the selection becomes exactly the ids that failed, until it is edited again. The dismissal and the confirmation are tagged with the response they belong to, so each new response starts fresh with no effect.
  const navigation = useNavigation();
  const submitting = navigation.formMethod === "POST";
  const submittingIntent = submitting ? String(navigation.formData?.get("intent") ?? "") : "";
  const bulk = actionData?.bulk;
  const applied = bulk && !isBulkRefusal(bulk) ? bulk : null;
  const selected: ReadonlySet<string> =
    sel.from !== bulk && applied ? new Set(failedIds(applied.results)) : sel.ids;
  const setSelected = (ids: ReadonlySet<string>) => setSel({ ids, from: bulk });

  // Only an all-succeeded result clears itself (after 3 seconds); one with a failure or a refusal waits to be dismissed (WCAG 2.2.1). The failures stay selected.
  const [shownBulk, dismissBulk] = useShownFor(
    bulk,
    BULK_RESULT_DISMISS_MS,
    bulkResultClearsItself,
  );
  const [confirmFor, setConfirmFor] = useState<{ from: unknown; intent: BulkActionIntent } | null>(
    null,
  );
  const confirming = confirmFor !== null && confirmFor.from === bulk ? confirmFor.intent : null;
  const [lastConfirm, setLastConfirm] = useState<BulkActionIntent>("trigger");

  const selectionCount = visibleSelection(selected, rows).length;
  const actionable = actionableSelection(selected, rows);
  const headerChecked = allVisibleSelected(selected, rows);

  // The client half of the limits; the server refuses over the ceiling too, because a hand-made POST never sees this line.
  const overCeiling = actionable.length > BULK_ACTION_MAX_PER_SUBMISSION;
  const needsConfirm = actionable.length > BULK_ACTION_CONFIRM_THRESHOLD;
  const rowLabel = (id: string) => {
    const r = rows.find((p) => p.id === id);
    return r ? (r.customerName ?? r.customerEmail) : id;
  };
  const confirmLine = (id: string) => {
    const r = rows.find((p) => p.id === id);
    return r
      ? `${r.customerName ?? r.customerEmail}, ${formatMoney(r.amountCents, r.currency)}, detected ${formatDetectedDate(r.detectedAt)}`
      : id;
  };

  async function performConfirmed(intent: BulkActionIntent) {
    const form = new FormData();
    for (const id of actionable) form.append("ids", id);
    form.append("intent", intent);
    await submit(form, { method: "post" });
  }

  const cards: { label: string; value: string; className?: string }[] = [
    { label: "Showing", value: String(showingCountFor(globalCounts, filters.status)) },
    { label: "Active", value: String(globalCounts.active), className: "fh-brand" },
    { label: "Recovered", value: String(globalCounts.recovered), className: "fh-green" },
    { label: "Canceled", value: String(globalCounts.cancelled), className: "fh-quiet" },
    {
      label: "Recovery rate",
      value: globalRecoveryRatePct === null ? "-" : `${globalRecoveryRatePct}%`,
      className: recoveryRateClassNameOrNull(globalRecoveryRatePct),
    },
  ];

  return (
    <div className="fh-payments cap-admin-page" data-width="page">
      <div className="fh-payments-head">
        <PageHead
          title="Payments"
          actions={
            <ButtonLink to={exportHref(filters, bounds, result.page)} reloadDocument>
              Export CSV
            </ButtonLink>
          }
        />
      </div>

      <div role="group" aria-label="Payment counts" className="fh-payments-tiles">
        {cards.map((card) => (
          <Panel key={card.label} size="sm" title={card.label}>
            <p className={`fh-mono fh-title fh-bold cap-num ${card.className ?? "fh-text"}`}>
              {card.value}
            </p>
          </Panel>
        ))}
      </div>

      {shownBulk ? (
        <BulkResultBanner shownBulk={shownBulk} rowLabel={rowLabel} dismissBulk={dismissBulk} />
      ) : null}

      <PaymentsFilters
        filters={filters}
        bounds={bounds}
        pillCounts={pillCounts}
        resultCount={result.totalCount}
      />

      {rows.length === 0 ? (
        <Empty kind="no-match" title="No payments match your filters" />
      ) : (
        <PaymentsTable
          rows={rows}
          isDemo={isDemo}
          selected={selected}
          setSelected={setSelected}
          headerChecked={headerChecked}
          nowMs={nowMs}
        />
      )}

      {result.totalCount > 0 ? (
        <PaymentsPager
          page={result.page}
          totalPages={result.totalPages}
          showing={showing}
          filters={filters}
          bounds={bounds}
        />
      ) : null}

      {!isDemo && selectionCount > 0 ? (
        <BulkBar
          actionable={actionable}
          selectionCount={selectionCount}
          overCeiling={overCeiling}
          needsConfirm={needsConfirm}
          submitting={submitting}
          submittingIntent={submittingIntent}
          onAsk={(intent) => {
            setLastConfirm(intent);
            setConfirmFor({ from: bulk, intent });
          }}
          onClear={() => setSelected(new Set())}
        />
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
