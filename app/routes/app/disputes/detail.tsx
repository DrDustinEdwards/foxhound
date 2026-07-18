import { data, Form, useActionData, useNavigation } from "react-router";

import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { disputeFeeCents } from "~/lib/billing/fees";
import type { DisputeState } from "~/lib/constants";
import { buildApprovalBatch, canApprove, hashEvidence } from "~/lib/disputes/approval";
import { DISPUTE_STATE_LABELS, disputeStateTone, isDisputeResolved } from "~/lib/disputes/labels";
import { getDisputeDetail, saveDisputeEvidence } from "~/lib/disputes/queries.server";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/detail";

export function meta() {
  return [{ title: "Dispute detail - Foxhound" }];
}

function humanizeFieldName(fieldName: string): string {
  return fieldName
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const detail = await getDisputeDetail(db, auth.membership.accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return detail;
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
    const evidenceVersionHash = await hashEvidence(detail.evidence);
    const batch = buildApprovalBatch(db, {
      disputeId: detail.dispute.id,
      accountId,
      approvedByUserId: auth.userId,
      approvedByEmail: auth.email,
      evidenceVersionHash,
      approvedAt: new Date(),
    });
    await db.batch(batch);
    return data({ ok: true, intent: "approve" as const });
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
  const fee = disputeFeeCents(dispute.amountCents);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-title font-medium text-text">
              {dispute.customerName ?? dispute.customerEmail ?? dispute.stripeChargeId}
            </h1>
            <p className="mt-1 text-label text-text-tertiary">{dispute.reason}</p>
          </div>
          <p className="font-mono text-title text-text">{formatMoney(dispute.amountCents, dispute.currency)}</p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone={disputeStateTone(state)}>{DISPUTE_STATE_LABELS[state] ?? state}</Badge>
          {dispute.evidenceDeadline ? (
            <span className="font-mono text-micro text-text-subtle">
              Evidence due {dispute.evidenceDeadline.toLocaleDateString()}
            </span>
          ) : null}
        </div>
      </div>

      {actionData && "error" in actionData ? (
        <p className="mt-4 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text" role="alert">
          {actionData.error}
        </p>
      ) : null}

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Evidence draft</p>
        {evidence.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No evidence recorded yet.</p>
        ) : (
          <Form method="post" className="mt-3 flex flex-col gap-4">
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
          </Form>
        )}
      </div>

      {editable ? (
        <div className="mt-6 rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
            Approve and submit
          </p>
          <p className="mt-2 text-body text-text-tertiary">
            Submitting this evidence to Stripe approves a fee of{" "}
            <span className="font-mono text-text">{formatMoney(fee, dispute.currency)}</span> (20% of
            the disputed amount, capped at $500) if Foxhound wins this dispute. Merchant-fought or
            lost disputes are never billed.
          </p>
          <Form method="post" className="mt-4">
            <input type="hidden" name="intent" value="approve" />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-amber px-4 py-2 text-body font-medium text-on-amber disabled:opacity-60"
            >
              {busy ? "Submitting..." : `Approve and submit (fee ${formatMoney(fee, dispute.currency)})`}
            </button>
          </Form>
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-border bg-surface p-4">
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
              {state === "resolved_won" && dispute.resolvedFeeCents != null ? (
                <>
                  Won. Fee of{" "}
                  {formatMoney(dispute.resolvedFeeCents, dispute.resolvedFeeCurrency ?? dispute.currency)}{" "}
                  billed at the next monthly run.
                </>
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
