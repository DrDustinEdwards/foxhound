import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import * as Sentry from "@sentry/cloudflare";
import { data, useActionData, useNavigation } from "react-router";

import { Badge } from "~/components/badge";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { disputeFeeCents } from "~/lib/billing/fees";
import type { DisputeState } from "~/lib/constants";
import { canApprove } from "~/lib/disputes/approval";
import {
  DISPUTE_STATE_LABELS,
  daysUntilDeadline,
  deadlineClassName,
  deadlineLabel,
  deadlineUrgency,
  disputeStateTone,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import {
  approveAndSubmitDispute,
  getConnectionAccessToken,
  getDisputeDetail,
  saveDisputeEvidence,
} from "~/lib/disputes/queries.server";
import { formatMoney } from "~/lib/money-format";
import { formatDateShort, formatTimestamp } from "~/lib/date-format";
import { buildDisputeTimeline } from "~/lib/disputes/timeline";

import type { Route } from "./+types/detail";

export function meta() {
  return [{ title: "Dispute detail - Foxhound" }];
}

// Stripe's evidence field names, as a merchant should read them. A generic
// per-word Title Case pass produced "Customer Purchase Ip" and
// "Customer Email Address"; these are the labels legacy used, which read as
// sentence case with the initialisms kept upper.
const EVIDENCE_FIELD_LABELS: Record<string, string> = {
  billing_address: "Billing address",
  cancellation_policy_disclosure: "Cancellation policy disclosure",
  customer_communication: "Customer communication",
  customer_email_address: "Customer email",
  customer_name: "Customer name",
  customer_purchase_ip: "Purchase IP",
  duplicate_charge_explanation: "Duplicate charge explanation",
  product_description: "Product description",
  refund_policy_disclosure: "Refund policy disclosure",
  service_date: "Service date",
  service_documentation: "Service documentation",
  shipping_address: "Shipping address",
  shipping_carrier: "Shipping carrier",
  shipping_date: "Ship date",
  shipping_tracking_number: "Tracking number",
  subscription_information: "Subscription",
  uncategorized_text: "Additional notes",
};

function humanizeFieldName(fieldName: string): string {
  const mapped = EVIDENCE_FIELD_LABELS[fieldName];
  if (mapped) return mapped;
  const spaced = fieldName.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const detail = await getDisputeDetail(db, auth.membership.accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return { ...detail, nowMs: Date.now() };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const detail = await getDisputeDetail(db, accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save") {
    if (!canApprove(detail.dispute.state as DisputeState)) {
      return data({ error: "This dispute has already been submitted; evidence is locked." }, { status: 400 });
    }
    const edits = detail.evidence.map((field) => ({
      id: field.id,
      fieldValue: String(form.get(`field-${field.id}`) ?? field.fieldValue),
    }));
    await saveDisputeEvidence(db, accountId, detail.dispute.id, edits);
    return data({ ok: true, intent: "save" as const });
  }

  if (intent === "approve") {
    // Re-check against a fresh read, never the form's own hidden state: this is
    // the schema-enforced gate (dispute_approvals is unique per dispute), the
    // app-level check here just fails fast with a readable message.
    if (!canApprove(detail.dispute.state as DisputeState)) {
      return data({ error: "This dispute has already been submitted." }, { status: 400 });
    }

    let resolvedToken: string | null = null;
    if (detail.dispute.stripeConnectionId) {
      resolvedToken = await getConnectionAccessToken(db, detail.dispute.stripeConnectionId);
    }
    if (!resolvedToken) {
      return data({ error: "No connected Stripe account for this dispute." }, { status: 400 });
    }

    try {
      // Ordering (approveAndSubmitDispute, wrapping approveAndSubmit): a
      // durable pending-approval record is written BEFORE the Stripe call, and
      // the `submitted` marker (submitted_at, which billing keys off) is
      // written only AFTER Stripe accepts. So the record and the submission
      // can never diverge (dispute-intake review MEDIUM), and billing counts
      // this dispute only if Stripe genuinely took it. The submitted package
      // is what the merchant approved: the currently-saved evidence (their
      // edits, not the raw AI draft).
      const result = await approveAndSubmitDispute(
        db,
        env,
        {
          disputeId: detail.dispute.id,
          accountId,
          stripeDisputeId: detail.dispute.stripeDisputeId,
          connectionAccessToken: resolvedToken,
          approvedByUserId: auth.userId,
          approvedByEmail: auth.email,
          approvedAt: new Date(),
        },
        detail.evidence,
      );
      if (result.status === "error") {
        return data({ error: result.message }, { status: 400 });
      }
      return data({ ok: true, intent: "approve" as const });
    } catch (err) {
      // A post-Stripe confirmation write failed: Stripe holds the submission but
      // our submitted_at did not land. The pending approval record still exists,
      // so there is no "submission with no record" (review MEDIUM); billing
      // safely under-counts (no submitted_at) until reconciled, never over-bills.
      // Surface loudly rather than swallow.
      Sentry.captureException(err, {
        extra: { scope: "dispute-approve-and-submit", disputeId: detail.dispute.id },
      });
      throw err;
    }
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function DisputeDetail({ loaderData }: Route.ComponentProps) {
  const { dispute, evidence, approval } = loaderData;
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const state = dispute.state as DisputeState;
  const editable = canApprove(state);
  const resolved = isDisputeResolved(state);
  const fee = disputeFeeCents(dispute.amountCents, DISPUTE_FEE_CAP_CENTS);
  const daysLeft = daysUntilDeadline(dispute.evidenceDeadline, loaderData.nowMs);
  const timeline = buildDisputeTimeline({
    createdAt: dispute.createdAt,
    amountCents: dispute.amountCents,
    currency: dispute.currency,
    reason: dispute.reason,
    aiGeneratedAt: dispute.aiGeneratedAt,
    stagedAt: dispute.stagedAt,
    submittedAt: dispute.submittedAt,
    submittedBy: dispute.submittedBy,
    outcomeNotifiedAt: dispute.outcomeNotifiedAt,
    resolvedAt: dispute.resolvedAt,
    state: dispute.state,
    resolvedFeeCents: dispute.resolvedFeeCents,
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="rounded-[12px] border border-border bg-surface px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-title font-medium text-text">
              {dispute.customerName ?? dispute.customerEmail ?? dispute.stripeChargeId}
            </h1>
            <p className="mt-1 text-label text-text-tertiary">
              {humanizeDisputeReason(dispute.reason)}
            </p>
          </div>
          <p className="font-mono text-title text-text">{formatMoney(dispute.amountCents, dispute.currency)}</p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone={disputeStateTone(state)}>{DISPUTE_STATE_LABELS[state] ?? state}</Badge>
          {dispute.evidenceDeadline ? (
            <span className="font-mono text-micro text-text-subtle">
              Evidence due {formatDateShort(dispute.evidenceDeadline)}
            </span>
          ) : null}
          {/* How long is left, toned by urgency. Suppressed once resolved: the
              deadline is history then and nothing is owed. */}
          {!resolved && daysLeft !== null ? (
            <span className={`font-mono text-micro ${deadlineClassName(deadlineUrgency(daysLeft))}`}>
              {deadlineLabel(daysLeft)}
            </span>
          ) : null}
        </div>
      </div>

      <section className="mt-6 rounded-[12px] border border-border bg-surface px-5 py-4">
        <h2 className="m-0 font-mono text-micro uppercase tracking-wide text-text-tertiary">Timeline</h2>
        <ol className="m-0 mt-3 list-none space-y-2 p-0">
          {timeline.map((item, i) => (
            <li key={i} className="flex gap-3 text-label">
              <span className="w-[9.5rem] shrink-0 font-mono text-micro text-text-subtle">
                {item.at ? formatTimestamp(item.at) : ""}
              </span>
              <span className="text-text-secondary">{item.label}</span>
            </li>
          ))}
        </ol>
      </section>

      {actionData && "error" in actionData ? (
        <p className="mt-4 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text" role="alert">
          {actionData.error}
        </p>
      ) : null}

      <div className="mt-6 rounded-[12px] border border-border bg-surface px-5 py-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Evidence draft</p>
        {evidence.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No evidence recorded yet.</p>
        ) : (
          <DemoGuardedForm method="post" className="mt-3 flex flex-col gap-4">
            <input type="hidden" name="intent" value="save" />
            {evidence.map((field) => (
              <label key={field.id} className="flex flex-col gap-1.5">
                <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                  {humanizeFieldName(field.fieldName)}
                </span>
                <textarea
                  name={`field-${field.id}`}
                  defaultValue={field.fieldValue}
                  readOnly={!editable}
                  rows={4}
                  className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text disabled:opacity-60 focus-visible:border-amber"
                  disabled={!editable}
                />
              </label>
            ))}
            {editable ? (
              <div>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-amber px-4 py-2 text-body font-medium text-on-amber disabled:opacity-60"
                >
                  {busy ? "Saving..." : "Save changes"}
                </button>
              </div>
            ) : null}
          </DemoGuardedForm>
        )}
      </div>

      {editable ? (
        <div className="mt-6 rounded-[12px] border border-border bg-surface px-5 py-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
            Approve and submit
          </p>
          <p className="mt-2 text-body text-text-tertiary">
            Submitting this evidence to Stripe approves a fee of{" "}
            <span className="font-mono text-text">{formatMoney(fee, dispute.currency)}</span> (20% of
            the disputed amount, capped at $500) if Foxhound wins this dispute. Merchant-fought or
            lost disputes are never billed.
          </p>
          <DemoGuardedForm method="post" className="mt-4">
            <input type="hidden" name="intent" value="approve" />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-amber px-4 py-2 text-body font-medium text-on-amber disabled:opacity-60"
            >
              {busy ? "Submitting..." : `Approve and submit (fee ${formatMoney(fee, dispute.currency)})`}
            </button>
          </DemoGuardedForm>
        </div>
      ) : (
        <div className="mt-6 rounded-[12px] border border-border bg-surface px-5 py-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Approval</p>
          {approval ? (
            <p className="mt-2 text-label text-text-tertiary">
              Approved by {approval.approvedByEmail} on {approval.approvedAt.toLocaleString()}
            </p>
          ) : (
            <p className="mt-2 text-label text-text-tertiary">No approval record.</p>
          )}
          {resolved ? (
            <p className="mt-2 text-body text-text">
              {state === "resolved_won" ? (
                dispute.resolvedFeeCents != null ? (
                  <>
                    Won. Fee of{" "}
                    {formatMoney(dispute.resolvedFeeCents, dispute.resolvedFeeCurrency ?? dispute.currency)}{" "}
                    billed at the next monthly run.
                  </>
                ) : (
                  "Won. No fee: this dispute was not submitted through Foxhound."
                )
              ) : (
                "Lost. Not billed."
              )}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
