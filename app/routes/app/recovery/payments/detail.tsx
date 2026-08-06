import { data, useNavigation } from "react-router";

import { Badge } from "~/components/badge";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatRelativeTime } from "~/lib/dashboard/recovery-window";
import { formatMoney } from "~/lib/money-format";
import {
  ATTRIBUTION_KIND_LABELS,
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  RECOVERY_LIFECYCLE_LABELS,
  failedPaymentStatusTone,
  formatStepResult,
  formatStepType,
  recoveryLifecycleStatus,
  recoveryLifecycleTone,
  stepResultTone,
} from "~/lib/recovery/labels";
import { isEmailStep, isRetryStep } from "~/lib/recovery/schedule";
import { getFailedPaymentDetail } from "~/lib/recovery/queries.server";
import type { AttributionKind } from "~/lib/constants";

import type { Route } from "./+types/detail";

export function meta() {
  return [{ title: "Payment detail - Foxhound" }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const detail = await getFailedPaymentDetail(db, auth.membership.accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return { ...detail, nowMs: Date.now() };
}

// Manual per-payment actions (cancel, retry now, resend, note, mark
// recovered, override the next email): not built yet for anyone, demo or
// real account, not only refused in demo. Honest "not available yet" rather
// than a half-wired action that fakes success for a real merchant. See
// TASK-foxhound-recovery-manual-actions.md (Capsid, recova namespace) for the
// real implementation, which the account_id-scoped read above already makes
// safe to build against.
const MANUAL_ACTIONS_NOT_AVAILABLE_MESSAGE = "This action isn't available yet.";

export async function action({ context, params }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  // Scoped read even though it is discarded: proves the id belongs to this
  // account before responding, the same 404-on-mismatch contract every other
  // action in this tree honors, so a wired-up follow-up can lean on this
  // shape without re-deriving it.
  const detail = await getFailedPaymentDetail(db, auth.membership.accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return data({ error: MANUAL_ACTIONS_NOT_AVAILABLE_MESSAGE }, { status: 400 });
}

const MANUAL_ACTIONS = [
  { intent: "cancel", label: "Cancel subscription" },
  { intent: "retry_now", label: "Retry now" },
  { intent: "resend", label: "Resend last email" },
  { intent: "note", label: "Add a note" },
  { intent: "mark_recovered", label: "Mark recovered" },
  { intent: "override_next_email", label: "Override next email" },
] as const;

export default function PaymentDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { failedPayment, steps, recovery, nowMs } = loaderData;
  const attributionKind = recovery?.attributionKind as AttributionKind | undefined;
  const creditedStep =
    recovery?.recoveredByStepId != null
      ? steps.find((s) => s.id === recovery.recoveredByStepId)
      : undefined;
  const busy = useNavigation().state !== "idle";

  const executedSteps = steps.filter((s) => s.executedAt !== null);
  const emailSteps = executedSteps.filter((s) => isEmailStep(s.stepType));
  const openedEmails = emailSteps.filter((s) => s.openedAt);
  const clickedEmails = emailSteps.filter((s) => s.clickedAt);

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-10">
      {/* Ruling 147 f1-f3, legacy
      app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx:
      max-w-[1000px] mx-auto px-8 py-10. NOTE 147 recorded this as "half
      legacy's width" too; also WRONG. Legacy is 1000px against max-w-3xl's
      768px, so 232px narrower, not 512. And legacy's px-8 here is FLAT, with
      no responsive step at all, unlike every 1280px page. */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-title font-medium text-text">
              {failedPayment.customerName ?? failedPayment.customerEmail}
            </h1>
            <p className="mt-1 text-label text-text-tertiary">{failedPayment.customerEmail}</p>
          </div>
          <p className="font-mono text-title text-text">
            {formatMoney(failedPayment.amountCents, failedPayment.currency)}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone={failedPaymentStatusTone(failedPayment.status)}>
            {FAILED_PAYMENT_STATUS_LABELS[failedPayment.status] ?? failedPayment.status}
          </Badge>
          <Badge tone="neutral">
            {DECLINE_CATEGORY_LABELS[failedPayment.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
              failedPayment.declineCategory}
          </Badge>
          {failedPayment.declineCode ? (
            <span className="font-mono text-micro text-text-subtle">{failedPayment.declineCode}</span>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Amount" value={formatMoney(failedPayment.amountCents, failedPayment.currency)} />
        <StatCard
          label="Decline"
          value={
            DECLINE_CATEGORY_LABELS[failedPayment.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
            failedPayment.declineCategory
          }
        />
        <StatCard
          label="Detected"
          value={formatRelativeTime(failedPayment.detectedAt, nowMs) ?? "-"}
          subtext={failedPayment.detectedAt.toLocaleDateString()}
        />
        <StatCard
          label="Customer age"
          value={failedPayment.customerAgeDays != null ? `${failedPayment.customerAgeDays}d` : "-"}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Decline details</p>
          <dl className="mt-3 flex flex-col gap-2">
            <DetailRow
              label="Category"
              value={
                DECLINE_CATEGORY_LABELS[failedPayment.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
                failedPayment.declineCategory
              }
            />
            {failedPayment.declineCode ? <DetailRow label="Code" value={failedPayment.declineCode} mono /> : null}
            <DetailRow label="Invoice ID" value={failedPayment.stripeInvoiceId} mono />
            <DetailRow label="Customer ID" value={failedPayment.stripeCustomerId} mono />
            {failedPayment.customerSince ? (
              <DetailRow
                label="Customer since"
                value={failedPayment.customerSince.toLocaleDateString("en-US", { month: "short", year: "numeric" })}
              />
            ) : null}
            {failedPayment.resolvedAt ? (
              <DetailRow
                label={failedPayment.status === "recovered" ? "Recovered" : "Resolved"}
                value={failedPayment.resolvedAt.toLocaleDateString()}
              />
            ) : null}
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Email engagement</p>
          {emailSteps.length === 0 ? (
            <p className="mt-3 text-label text-text-tertiary">No emails sent yet.</p>
          ) : (
            <dl className="mt-3 flex flex-col gap-2">
              <DetailRow label="Emails sent" value={String(emailSteps.length)} />
              <DetailRow label="Opened" value={`${openedEmails.length} of ${emailSteps.length}`} />
              <DetailRow label="Clicked" value={`${clickedEmails.length} of ${emailSteps.length}`} />
              {recovery ? <DetailRow label="Recovery method" value={ATTRIBUTION_KIND_LABELS[attributionKind ?? "stripe_baseline"]} /> : null}
            </dl>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Outcome</p>
        {recovery ? (
          <div className="mt-2 flex flex-col gap-2">
            {/* The real lifecycle state, read from refunded_at/disputed_at, never
                from attribution_kind: a refunded or disputed recovery must never
                read as a clean win regardless of how it was attributed. Billability
                itself is not asserted here at all, that is the 5d ledger's job off
                app/db/billable.ts. */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={recoveryLifecycleTone(recovery)}>
                {RECOVERY_LIFECYCLE_LABELS[recoveryLifecycleStatus(recovery)]}
              </Badge>
            </div>
            {attributionKind ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                  Attribution
                </span>
                <Badge tone="neutral">
                  {ATTRIBUTION_KIND_LABELS[attributionKind]}
                  {attributionKind === "stripe_baseline" ? " - FREE" : ""}
                </Badge>
                {creditedStep ? (
                  <span className="text-label text-text-tertiary">
                    Credited to {formatStepType(creditedStep.stepType)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-label text-text-tertiary">Still in recovery, no outcome yet.</p>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recovery timeline</p>
          {steps.length > 0 ? (
            <p className="text-label text-text-tertiary">
              {executedSteps.length} of {steps.length} steps executed
            </p>
          ) : null}
        </div>
        {steps.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No steps scheduled.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-3">
            {steps.map((step) => {
              const channel = isRetryStep(step.stepType)
                ? "Silent"
                : step.stepType === "card_update"
                  ? "Customer action"
                  : "Customer email";
              return (
                <li
                  key={step.id}
                  className="flex items-center justify-between gap-4 border-b border-border-sub pb-3 last:border-0 last:pb-0"
                >
                  <div>
                    <p className="text-body text-text">
                      {step.stepNumber ?? "-"}. {formatStepType(step.stepType)}
                      <span className="ml-2 text-micro uppercase tracking-wide text-text-subtle">
                        {channel}
                      </span>
                    </p>
                    <p className="text-label text-text-tertiary">
                      {step.executedAt
                        ? `Ran ${step.executedAt.toLocaleString()}`
                        : `Scheduled for ${step.scheduledAt.toLocaleString()}`}
                    </p>
                  </div>
                  <Badge tone={stepResultTone(step.result)}>
                    {step.result ? formatStepResult(step.result) : "Pending"}
                  </Badge>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Manual actions</p>
        {actionData && "error" in actionData ? (
          <p className="mt-2 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text" role="alert">
            {actionData.error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {MANUAL_ACTIONS.map((a) => (
            <DemoGuardedForm key={a.intent} method="post">
              <input type="hidden" name="intent" value={a.intent} />
              <button
                type="submit"
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-label text-text-secondary hover:border-border-i disabled:opacity-60"
              >
                {a.label}
              </button>
            </DemoGuardedForm>
          ))}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-sub pb-2 last:border-0 last:pb-0">
      <dt className="shrink-0 text-micro text-text-tertiary">{label}</dt>
      <dd className={`truncate text-label text-text ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
