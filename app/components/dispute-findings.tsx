import { plural } from "@drdustinedwards/site-helpers/text";
import { formatDate } from "capsomer/behavior/time";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { FAILED_PAYMENT_STATUS_LABELS } from "~/lib/recovery/labels";
import { declineWord } from "~/lib/recovery/payments-list";
import {
  humanCardCheck,
  humanSmartDisputes,
  radarWords,
  readPriorCharges,
  readSubscription,
} from "~/lib/disputes/triage";
import { FieldRow } from "~/components/dispute-detail-parts";
import type { loader } from "~/routes/app/disputes/detail";

type Loaded = Awaited<ReturnType<typeof loader>>;

export function DisputeFindings({
  dispute,
  findings,
}: {
  dispute: Loaded["dispute"];
  findings: Loaded["findings"];
}) {
  const priorCharges = readPriorCharges(dispute.priorChargesJson);
  const subscription = readSubscription(dispute.subscriptionJson);
  const radar = radarWords(dispute.radarRiskScore, dispute.radarRiskLevel);
  return (
    <div className="fh-dispute-section">
      <Panel title="What Foxhound found">
        <div className="fh-small">
          {findings.fraudDecline ? (
            <p className="fh-dispute-lede">
              <Status tone="warn">
                Fraud decline on record ({findings.fraudDecline.code ?? "fraud category"})
              </Status>
            </p>
          ) : null}

          <div className="fh-dispute-group">
            <h3 className="fh-dispute-group-title fh-tiny fh-medium fh-soft">Customer context</h3>
            <dl className="fh-dispute-facts">
              {dispute.customerName ? <FieldRow label="Name" value={dispute.customerName} /> : null}
              {dispute.customerEmail ? (
                <FieldRow label="Email" value={dispute.customerEmail} />
              ) : null}
              {dispute.billingAddress ? (
                <FieldRow label="Billing address" value={dispute.billingAddress} />
              ) : null}
              {dispute.avsResult ? (
                <FieldRow label="AVS" value={humanCardCheck(dispute.avsResult)} />
              ) : null}
              {dispute.cvvResult ? (
                <FieldRow label="CVV" value={humanCardCheck(dispute.cvvResult)} />
              ) : null}
              {radar ? <FieldRow label="Stripe Radar" value={radar} /> : null}
              {dispute.threeDSecure ? (
                <FieldRow label="3D Secure" value={dispute.threeDSecure} />
              ) : null}
              {dispute.smartDisputesStatus ? (
                <FieldRow
                  label="Smart Disputes"
                  value={humanSmartDisputes(dispute.smartDisputesStatus)}
                />
              ) : null}
              {findings.disputeHistory ? (
                <FieldRow
                  label="Dispute history"
                  value={`${findings.disputeHistory.won} won · ${findings.disputeHistory.lost} lost`}
                />
              ) : null}
            </dl>
          </div>

          {dispute.priorChargesCount !== null && dispute.priorChargesCount > 0 ? (
            <div className="fh-dispute-group">
              <h3 className="fh-dispute-group-title fh-tiny fh-medium fh-soft">
                Prior charge history
              </h3>
              <p className="fh-dispute-group-title fh-text">
                {plural(dispute.priorChargesCount, "prior successful charge")} totaling{" "}
                {formatMoney(dispute.priorChargesTotal ?? 0, dispute.currency)}
              </p>
              {priorCharges.length > 0 ? (
                <table className="fh-dispute-charges fh-tiny">
                  <thead>
                    <tr className="fh-quiet">
                      <th className="fh-dispute-cell fh-left fh-medium">Date</th>
                      <th className="fh-dispute-cell fh-right fh-medium">Amount</th>
                      <th className="fh-dispute-cell-pad fh-left fh-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priorCharges.slice(0, 5).map((c, i) => (
                      <tr key={i} className="fh-dispute-charge">
                        <td className="fh-dispute-cell fh-quiet">{c.date.slice(0, 10)}</td>
                        <td className="fh-dispute-cell fh-right fh-mono">
                          {formatMoney(c.amount, c.currency)}
                        </td>
                        <td className="fh-dispute-cell-pad fh-quiet">{c.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : null}

          {findings.recovery && findings.recovery.emails.length > 0 ? (
            <div className="fh-dispute-group">
              <h3 className="fh-dispute-group-title fh-tiny fh-medium fh-soft">
                Recovery email history
              </h3>
              <ul className="fh-dispute-facts">
                {findings.recovery.emails.map((e) => (
                  <li key={e.id} className="fh-text">
                    <span className="fh-quiet">
                      {formatDate(e.executedAt, { style: "medium" }) ?? ""}
                    </span>{" "}
                    {e.label}
                    {e.openedCount !== null && e.openedCount > 0 ? (
                      <span className="fh-faint"> · opened {e.openedCount}x</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {findings.recovery ? (
            <div className="fh-dispute-context">
              <h3 className="fh-dispute-group-title fh-tiny fh-quiet fh-caps-wide">
                Recovery context
              </h3>
              <div className="fh-dispute-facts fh-soft">
                <div>
                  Decline category:{" "}
                  <span className="fh-text">{declineWord(findings.recovery.declineCategory)}</span>
                </div>
                <div>
                  Steps attempted:{" "}
                  <span className="fh-text">{findings.recovery.stepsAttempted}</span>
                </div>
                <div>
                  Sequence outcome:{" "}
                  <span className="fh-text">
                    {FAILED_PAYMENT_STATUS_LABELS[findings.recovery.status] ??
                      findings.recovery.status}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {subscription ? (
            <div className="fh-dispute-more">
              <h3 className="fh-dispute-group-title fh-tiny fh-medium fh-soft">Subscription</h3>
              <dl className="fh-dispute-facts">
                <FieldRow label="Status" value={subscription.status} />
                {subscription.start_date ? (
                  <FieldRow
                    label="Started"
                    value={formatDate(new Date(subscription.start_date), { style: "medium" }) ?? ""}
                  />
                ) : null}
                {subscription.canceled_at ? (
                  <FieldRow
                    label="Canceled"
                    value={
                      formatDate(new Date(subscription.canceled_at), { style: "medium" }) ?? ""
                    }
                  />
                ) : null}
              </dl>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
