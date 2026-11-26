import { Table } from "capsomer/react/table";
import { relative, toMs } from "capsomer/behavior/time";
import { Icon, iconArrowRight, iconTrendingUp } from "capsomer/react/icons";
import { Form } from "react-router";
import type { Filters } from "~/lib/recovery/payments-page";
import type { AmountBounds } from "~/lib/recovery/queries.server";
import { Link } from "capsomer/react/link";
import { dismissBanner } from "capsomer/behavior/banner";
import { Banner } from "capsomer/react/banner";
import { Glyph, Pill } from "capsomer/react/status";
import { toggleAllVisible, toggleOne } from "capsomer/behavior/bulk-bar";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { formatDetectedDate } from "~/lib/dashboard/recovery-dashboard";
import { FAILED_PAYMENT_STATUS_LABELS, failedPaymentStatusTone } from "~/lib/recovery/labels";
import { declineWord, bulkResultLine } from "~/lib/recovery/payments-list";
import {
  failedIds,
  isBulkRefusal,
  orderForDisplay,
  type BulkActionRefusal,
  type BulkActionResult,
  type BulkActionIntent,
} from "~/lib/recovery/bulk-results";
import { BULK_ACTION_MAX_PER_SUBMISSION } from "~/lib/constants";
import {
  BULK_INTENTS,
  BULK_REASON_LABELS,
  BULK_VARIANTS,
  bulkCopy,
} from "~/lib/recovery/bulk-copy";
import { PILL_TONE } from "~/lib/recovery/payment-detail";
import { BASE, pageHref } from "~/lib/recovery/payments-page";
import type { loader } from "~/routes/app/recovery/payments/index";

type PaymentRow = Awaited<ReturnType<typeof loader>>["result"]["payments"][number];

export function BulkResultBanner({
  shownBulk,
  rowLabel,
  dismissBulk,
}: {
  shownBulk: BulkActionResult | BulkActionRefusal;
  rowLabel: (id: string) => string;
  dismissBulk: () => void;
}) {
  return (
    <div className="fh-payments-bulk">
      {isBulkRefusal(shownBulk) ? (
        <Banner tone="crit" onDismiss={dismissBulk}>
          {shownBulk.refused === "empty"
            ? "Nothing was selected, so nothing was changed."
            : shownBulk.refused === "unknown_intent"
              ? "That is not an action this page performs. Nothing was changed."
              : `${shownBulk.submitted} payments is more than the limit of ${shownBulk.ceiling} per submission. Nothing was changed and nothing was trimmed to fit. Narrow the selection and try again.`}
        </Banner>
      ) : (
        <div
          className="cap-banner"
          data-cap="banner"
          data-tone={failedIds(shownBulk.results).length === 0 ? "ok" : "crit"}
          role={failedIds(shownBulk.results).length === 0 ? "status" : "alert"}
        >
          <Glyph name={failedIds(shownBulk.results).length === 0 ? "ok" : "crit"} />
          <div className="cap-banner-body">
            <p className="cap-banner-title">
              {bulkResultLine(shownBulk.intent, shownBulk.results)}
            </p>
            <div className="cap-banner-text">
              <ul className="cap-stack fh-small" data-gap="2">
                {orderForDisplay(shownBulk.results).map((r) => (
                  <li key={r.id}>
                    <span className="fh-bold">
                      {r.ok
                        ? (bulkCopy(shownBulk.intent)?.didLabel ?? "Applied")
                        : (bulkCopy(shownBulk.intent)?.didNotLabel ?? "Not applied")}
                    </span>
                    <span className="fh-payments-gap">{rowLabel(r.id)}</span>
                    {r.reason ? (
                      <span className="fh-payments-gap">{BULK_REASON_LABELS[r.reason]}</span>
                    ) : null}
                    {/* The dispatcher's own detail, carried rather than folded. */}
                    {r.detail ? <span className="fh-payments-gap fh-mono">{r.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            {failedIds(shownBulk.results).length > 0 ? (
              <p className="cap-banner-text">
                The payments that did not take it are still selected, so the next attempt is exactly
                those.
              </p>
            ) : null}
          </div>
          <div className="cap-banner-actions">
            <button
              type="button"
              className="cap-btn"
              data-variant="quiet"
              data-cap-part="dismiss"
              onClick={(e) => {
                // Capsomer's Dismiss: focus goes to the page's main region when it was inside, never to <body>.
                const banner = e.currentTarget.closest<HTMLElement>("[data-cap='banner']");
                if (banner) dismissBanner(banner);
                dismissBulk();
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PaymentsTable({
  rows,
  isDemo,
  selected,
  setSelected,
  headerChecked,
  nowMs,
}: {
  rows: PaymentRow[];
  isDemo: boolean;
  selected: ReadonlySet<string>;
  setSelected: (ids: ReadonlySet<string>) => void;
  headerChecked: boolean;
  nowMs: number;
}) {
  return (
    <div className="cap-panel">
      <div className="cap-panel-body" data-flush="">
        <Table caption="Payments" captionHidden reflow="medium">
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
                    <span className="cap-sr-only">Select all payments</span>
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
                        <span className="cap-sr-only">Select payment from {name}</span>
                      </label>
                    </td>
                  ) : null}
                  <th scope="row">
                    <span className="fh-payments-name">
                      <Link className="cap-table-open" to={`${BASE}/${p.id}`}>
                        {name}
                      </Link>
                      {p.outreach ? (
                        <Icon
                          d={iconTrendingUp}
                          className="fh-icon-12 fh-icon-fine fh-accent"
                          label="Intelligence: personal outreach recommended"
                        />
                      ) : null}
                      {p.priorFailures > 0 ? (
                        <Pill tone="warn">{p.priorFailures + 1}x failure</Pill>
                      ) : null}
                      {p.hasNote ? <Pill>note</Pill> : null}
                    </span>
                    {p.customerName ? (
                      <span className="fh-payments-sub fh-line fh-tiny fh-regular fh-break fh-faint">
                        {p.customerEmail}
                      </span>
                    ) : null}
                    {p.planName ? (
                      <span className="fh-payments-sub fh-line fh-tiny fh-regular fh-faint">
                        {p.planName}
                      </span>
                    ) : null}
                  </th>
                  <td data-label="Amount">
                    <span className="fh-nowrap fh-mono fh-small fh-brand">
                      {formatMoney(p.amountCents, p.currency)}
                    </span>
                  </td>
                  <td data-label="Decline">
                    <Pill variant="outline">{declineWord(p.declineCategory)}</Pill>
                    {p.declineCode ? (
                      <span className="fh-payments-sub fh-line fh-mono fh-tiny fh-break fh-faint">
                        {p.declineCode}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Steps">
                    <span
                      className={`fh-mono fh-tiny ${p.steps.completed > 0 ? "fh-text" : "fh-faint"}`}
                    >
                      {p.steps.completed}/{p.steps.total}
                    </span>
                    {p.steps.next ? (
                      <span className="fh-payments-sub fh-line fh-tiny fh-brand">
                        Next: {p.steps.next}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Status">
                    <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                      {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                    </Pill>
                  </td>
                  <td data-label="Detected">
                    <span className="fh-payments-amount">
                      <span className="fh-tiny fh-faint">
                        <span className="fh-line fh-nowrap">
                          {relative(toMs(p.detectedAt), nowMs, "UTC")}
                        </span>
                        <span className="fh-payments-sub fh-line fh-nowrap">
                          {formatDetectedDate(p.detectedAt)}
                        </span>
                      </span>
                      <Link
                        to={`${BASE}/${p.id}`}
                        tabIndex={-1}
                        aria-hidden="true"
                        className="fh-payments-open fh-nowrap fh-mono fh-tiny fh-quiet"
                      >
                        View{" "}
                        <Icon
                          d={iconArrowRight}
                          className="fh-icon-13 fh-icon-fine fh-inline-icon"
                        />
                      </Link>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

export function PaymentsPager({
  page,
  totalPages,
  showing,
  filters,
  bounds,
}: {
  page: number;
  totalPages: number;
  showing: string;
  filters: Filters;
  bounds: AmountBounds;
}) {
  return (
    <div className="fh-payments-pager">
      <nav className="cap-pagination" aria-label="Payment pages">
        <p className="cap-pagination-status">{showing}</p>
        <ul className="cap-pagination-list">
          <li>
            {page > 1 ? (
              <Link
                className="cap-page"
                data-kind="prev"
                to={pageHref(filters, bounds, page - 1)}
                rel="prev"
              >
                Previous
              </Link>
            ) : (
              // oxlint-disable-next-line jsx-a11y/anchor-is-valid -- a disabled page link: no href, role="link" and aria-disabled keep it announced as a link
              <a className="cap-page" data-kind="prev" role="link" aria-disabled="true">
                Previous
              </a>
            )}
          </li>
          <li>
            {page < totalPages ? (
              <Link
                className="cap-page"
                data-kind="next"
                to={pageHref(filters, bounds, page + 1)}
                rel="next"
              >
                Next
              </Link>
            ) : (
              // oxlint-disable-next-line jsx-a11y/anchor-is-valid -- a disabled page link: no href, role="link" and aria-disabled keep it announced as a link
              <a className="cap-page" data-kind="next" role="link" aria-disabled="true">
                Next
              </a>
            )}
          </li>
        </ul>
      </nav>
    </div>
  );
}

export function BulkBar({
  actionable,
  selectionCount,
  overCeiling,
  needsConfirm,
  submitting,
  submittingIntent,
  onAsk,
  onClear,
}: {
  actionable: string[];
  selectionCount: number;
  overCeiling: boolean;
  needsConfirm: boolean;
  submitting: boolean;
  submittingIntent: string;
  onAsk: (intent: BulkActionIntent) => void;
  onClear: () => void;
}) {
  return (
    <Form method="post" className="fh-payments-bar">
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
                      if (needsConfirm) onAsk(intent);
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
          <p id="bulk-ceiling" className="fh-small fh-faint">
            {actionable.length} payments selected. Bulk actions take at most{" "}
            {BULK_ACTION_MAX_PER_SUBMISSION} at a time, and nothing is trimmed to fit. Narrow the
            selection to {BULK_ACTION_MAX_PER_SUBMISSION} or fewer.
          </p>
        ) : null}
        <button
          type="button"
          className="cap-btn cap-bulk-clear"
          data-variant="quiet"
          onClick={() => onClear()}
        >
          Clear
        </button>
      </div>
    </Form>
  );
}
