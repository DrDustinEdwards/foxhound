import { useState } from "react";
import { Form, useNavigation, useSubmit } from "react-router";
import { Banner } from "capsomer/react/banner";
import { ConfirmDialog, ConfirmPage } from "capsomer/react/confirm-dialog";
import { Panel } from "capsomer/react/panel";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/confirm-dialog.css";

import { formatDateShort } from "~/lib/date-format";
import {
  EARLY_FRAUD_WARNINGS_ANCHOR,
  fraudTypeWords,
  warningCustomerLabel,
} from "~/lib/disputes/fraud-warnings";
import { formatMoney } from "~/lib/money-format";

// The disputes dashboard's "Early fraud warnings" section: the open warnings,
// each with Refund this charge and Dismiss. Look is the disputes table's own
// (Capsomer's panel and table), amber.
//
// REFUND IS ONE-WAY, so it confirms first, the way Accept dispute does on the
// dispute page: with script, Capsomer's confirm dialog; without, the button
// posts `refund_warning_confirm` and the action answers with the same
// confirmation as Capsomer's confirm page. Dismiss only hides the warning in
// Foxhound, so it acts at once. In the demo both show, disabled with their
// reason (Capsomer's button), and the shell's 405 stays the real boundary.

export interface WarningView {
  id: string;
  stripeChargeId: string;
  stripeCustomerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  fraudType: string;
  amountCents: number;
  currency: string;
  createdAt: Date | string;
}

const DEMO_REASON_ID = "efw-demo-reason";

export type WarningActionResult = { ok: boolean; message: string };

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function refundBody(w: WarningView): string[] {
  return [
    `Stripe refunds the full ${formatMoney(w.amountCents, w.currency)} charge ${w.stripeChargeId} to ${warningCustomerLabel(w)}, marked as fraudulent.`,
    "A refund cannot be undone. Foxhound charges no fee for it.",
  ];
}

export function EarlyFraudWarnings({
  warnings,
  result,
  confirmId,
  readOnly,
}: {
  warnings: WarningView[];
  result: WarningActionResult | undefined;
  /** The warning a no-script Refund asked to confirm. */
  confirmId: string | null;
  readOnly: boolean;
}) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [confirming, setConfirming] = useState<WarningView | null>(null);
  const [lastConfirm, setLastConfirm] = useState<WarningView | null>(null);
  const [dismissedResult, setDismissedResult] = useState<WarningActionResult | undefined>(undefined);
  const pageConfirm = confirmId ? warnings.find((w) => w.id === confirmId) ?? null : null;
  const shown = confirming ?? lastConfirm;

  return (
    <section id={EARLY_FRAUD_WARNINGS_ANCHOR} className="mt-8 scroll-mt-24" aria-labelledby="efw-heading">
      {result && result !== dismissedResult ? (
        <div className="mb-4">
          <Banner tone={result.ok ? "ok" : "crit"} onDismiss={() => setDismissedResult(result)}>
            {result.message}
          </Banner>
        </div>
      ) : null}

      {pageConfirm ? (
        <div className="mb-4">
          <ConfirmPage
            hidden={{ intent: "refund_warning", warning_id: pageConfirm.id }}
            title={`Refund ${formatMoney(pageConfirm.amountCents, pageConfirm.currency)} to ${warningCustomerLabel(pageConfirm)}?`}
            body={refundBody(pageConfirm)}
            action_label="Refund this charge"
            cancelHref={`/disputes/dashboard#${EARLY_FRAUD_WARNINGS_ANCHOR}`}
            headingLevel="h2"
          />
        </div>
      ) : null}

      <Panel
        title={<span id="efw-heading">Early fraud warnings</span>}
        count={warnings.length}
        description="Card issuers send these before a fraud dispute. Refunding the charge first avoids the dispute fee and keeps the dispute off your dispute rate."
        flush
      >
        {warnings.length === 0 ? (
          <p className="m-0 px-4 py-6 text-label text-text-secondary">No open early fraud warnings.</p>
        ) : (
          <div className="cap-table-wrap" data-cap="table" role="region" aria-label="Early fraud warnings" tabIndex={0}>
            <table className="cap-table">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" data-num="">
                    Amount
                  </th>
                  <th scope="col">Fraud type</th>
                  <th scope="col">Date</th>
                  <th scope="col">Charge</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {warnings.map((w) => {
                  const label = warningCustomerLabel(w);
                  return (
                    <tr key={w.id} data-warning={w.id}>
                      <td>
                        <div className="text-label text-text">{label}</div>
                        {w.customerName && w.customerEmail ? (
                          <div className="text-micro text-text-subtle">{w.customerEmail}</div>
                        ) : null}
                      </td>
                      <td data-num="">{formatMoney(w.amountCents, w.currency)}</td>
                      <td className="text-label text-text-secondary">{fraudTypeWords(w.fraudType)}</td>
                      <td className="font-mono text-label">{formatDateShort(toDate(w.createdAt))}</td>
                      <td className="font-mono text-micro text-text-secondary">{w.stripeChargeId}</td>
                      <td>
                        {readOnly ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              className="cap-btn"
                              data-variant="danger"
                              data-size="sm"
                              aria-disabled="true"
                              aria-describedby={DEMO_REASON_ID}
                            >
                              Refund this charge<span className="sr-only"> from {label}</span>
                            </button>
                            <button
                              type="button"
                              className="cap-btn"
                              data-variant="quiet"
                              data-size="sm"
                              aria-disabled="true"
                              aria-describedby={DEMO_REASON_ID}
                            >
                              Dismiss<span className="sr-only"> the warning for {label}</span>
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Form method="post">
                              <input type="hidden" name="intent" value="refund_warning_confirm" />
                              <input type="hidden" name="warning_id" value={w.id} />
                              <button
                                type="submit"
                                className="cap-btn"
                                data-variant="danger"
                                data-size="sm"
                                onClick={(e) => {
                                  e.preventDefault();
                                  setConfirming(w);
                                  setLastConfirm(w);
                                }}
                              >
                                Refund this charge<span className="sr-only"> from {label}</span>
                              </button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="dismiss_warning" />
                              <input type="hidden" name="warning_id" value={w.id} />
                              <button
                                type="submit"
                                className="cap-btn"
                                data-variant="quiet"
                                data-size="sm"
                                aria-disabled={busy ? true : undefined}
                                onClick={(e) => {
                                  if (busy) e.preventDefault();
                                }}
                              >
                                Dismiss<span className="sr-only"> the warning for {label}</span>
                              </button>
                            </Form>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {readOnly && warnings.length > 0 ? (
          <p className="m-0 px-4 pb-4">
            <span className="cap-btn-reason" id={DEMO_REASON_ID}>
              The demo is read-only, so Refund and Dismiss do nothing here.
            </span>
          </p>
        ) : null}
      </Panel>

      {shown ? (
        <ConfirmDialog
          open={confirming !== null}
          title={`Refund ${formatMoney(shown.amountCents, shown.currency)} to ${warningCustomerLabel(shown)}?`}
          body={refundBody(shown)}
          action="Refund this charge"
          perform={async () => {
            const form = new FormData();
            form.append("intent", "refund_warning");
            form.append("warning_id", shown.id);
            await submit(form, { method: "post" });
          }}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}
