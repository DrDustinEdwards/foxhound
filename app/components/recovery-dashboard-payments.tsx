import { Table } from "capsomer/react/table";
import { relative, toMs } from "capsomer/behavior/time";
import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row } from "capsomer/react/row-list";
import { Pill } from "capsomer/react/status";
import type { RecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import {
  declineLabel,
  formatDetectedDate,
  type PaymentStepSummary,
} from "~/lib/dashboard/recovery-dashboard";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { priorFailureCount } from "~/lib/recovery/prior-failures";
import { FAILED_PAYMENT_STATUS_LABELS, failedPaymentStatusTone } from "~/lib/recovery/labels";
import { PILL_TONE } from "~/lib/recovery/payment-detail";

export function PaymentsTable({
  w,
  steps,
  nowMs,
}: {
  w: RecoveryDashboardWindow;
  steps: Record<string, PaymentStepSummary>;
  nowMs: number;
}) {
  const payments = w.recentPayments;
  return (
    <Panel
      title="Failed payments"
      flush
      actions={
        <span className="fh-recpanel-legend fh-small">
          {/* Recova counted "active" among the eight rows on show; this is
              every payment in recovery now, which is what the word claims. */}
          <span className="fh-faint">
            {w.totalFailedCount} total · {w.activePaymentsCount} active
          </span>
          <Link to="/recovery/payments" className="fh-brand">
            View all
          </Link>
        </span>
      }
    >
      {payments.length === 0 ? (
        <Empty kind="nothing-yet" title="No failed payments yet" flush />
      ) : (
        <>
          {/* Recova's phone layout: one card per payment. */}
          <ul className="fh-phone-list cap-rows" role="list">
            {payments.map((p) => (
              <Row
                variant="outline"
                key={p.id}
                title={p.customerName ?? p.customerEmail}
                detail={
                  <span className="cap-cluster" data-gap="3">
                    <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                    <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                      {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                    </Pill>
                  </span>
                }
                meta={
                  <span className="fh-mono fh-small fh-text">
                    {formatMoney(p.amountCents, p.currency)}
                  </span>
                }
                actions={
                  <Link
                    to={`/recovery/payments/${p.id}`}
                    aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                    className="fh-tiny fh-brand"
                  >
                    View
                  </Link>
                }
              />
            ))}
          </ul>

          <div className="fh-wide-list">
            <Table caption="Failed payments" captionHidden reflow="medium">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Decline</th>
                  <th scope="col">Steps</th>
                  <th scope="col">Status</th>
                  <th scope="col">Detected</th>
                  <th scope="col">
                    <span className="cap-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const prior = priorFailureCount(w.previousFailureCounts[p.stripeCustomerId]);
                  const s = steps[p.id] ?? { completed: 0, total: 0, next: null };
                  return (
                    <tr key={p.id}>
                      <th scope="row">
                        <span className="cap-cluster" data-gap="3">
                          <span className="fh-medium fh-text">
                            {p.customerName ?? p.customerEmail}
                          </span>
                          {prior > 0 ? <Pill tone="warn">{prior + 1}x failure</Pill> : null}
                        </span>
                        {p.customerName ? (
                          <span className="fh-line fh-tiny fh-regular fh-faint">
                            {p.customerEmail}
                          </span>
                        ) : null}
                        {p.planName ? (
                          <span className="fh-line fh-tiny fh-regular fh-faint">{p.planName}</span>
                        ) : null}
                      </th>
                      <td data-label="Amount" className="fh-nowrap fh-mono">
                        {formatMoney(p.amountCents, p.currency)}
                      </td>
                      <td data-label="Decline">
                        <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                        {p.declineCode ? (
                          <span className="fh-line fh-mono fh-tiny fh-faint">{p.declineCode}</span>
                        ) : null}
                      </td>
                      <td data-label="Steps">
                        <span
                          className={`fh-mono fh-tiny ${s.completed > 0 ? "fh-text" : "fh-faint"}`}
                        >
                          {s.completed}/{s.total}
                        </span>
                        {s.next ? (
                          <span className="fh-line fh-tiny fh-brand">Next: {s.next}</span>
                        ) : null}
                      </td>
                      <td data-label="Status">
                        <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                          {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                        </Pill>
                      </td>
                      <td data-label="Detected" className="fh-nowrap fh-tiny fh-faint">
                        <span className="fh-line">
                          {relative(toMs(p.detectedAt), nowMs, "UTC", { granularity: "day" })}
                        </span>
                        <span className="fh-line">{formatDetectedDate(p.detectedAt)}</span>
                      </td>
                      <td data-label="Actions">
                        <Link
                          to={`/recovery/payments/${p.id}`}
                          aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                          className="fh-nowrap fh-tiny fh-brand"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </Panel>
  );
}
