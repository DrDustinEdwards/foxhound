import { useState } from "react";

import { ArrowRight, ArrowUpRight, Check, ChevronDown, Circle, Mail, RotateCcw, Shield } from "lucide-react";

import { Link, data, useNavigation, useRouteLoaderData } from "react-router";

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
  type Tone,
} from "~/lib/recovery/labels";
import { isEmailStep } from "~/lib/recovery/schedule";
import { lastResendableEmailStep, nextPendingStep } from "~/lib/recovery/step-state";
import { getFailedPaymentDetail } from "~/lib/recovery/queries.server";
import {
  dispatchManualAction,
  moneyWriteCommit,
  resendDepsFor,
  triggerDepsFor,
} from "~/lib/recovery/manual-actions.server";
import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";
import type { AttributionKind } from "~/lib/constants";
import type { loader as appShellLoader } from "~/layouts/app-shell";

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
  // Ruling 256: sanitize SERVER-SIDE, before aiBodyHtml is ever part of a
  // response, through the helper the sequences preview already uses. Legacy
  // sanitized client-side with DOMPurify on the same allowlist and shipped the
  // raw string in its SSR payload; doing it here means no unsanitized body ever
  // reaches the browser, which is class (a) under ruling 93 and honors Dustin's
  // ratified intent more strictly than mirroring legacy's mechanism would.
  const steps = detail.steps.map((step) => ({
    ...step,
    previewHtml: step.aiBodyHtml ? sanitizeEmailPreviewHtml(step.aiBodyHtml) : null,
  }));
  return { ...detail, steps, nowMs: Date.now() };
}

// Manual per-payment actions: ALL FIVE ARE WIRED (272), each committing through
// the per-account money-write DO per 262 decision four. The notes save and Stop
// recovery landed at `2c8cf51` (265), Trigger next step now at `7047a8f` (267),
// Resend last email at `3d47a28` (269), and Mark as recovered at `74ad6df` (271),
// the last entering through the spine's own buildRecoveryBatch and never a second
// writer of recovered_payments. This block used to say none of them was built for
// anyone, which was true until 265 and stale for every session after it, and the
// MANUAL_ACTIONS_NOT_AVAILABLE_MESSAGE it introduced is gone with it: nothing
// could reach that string once the switch below grew a case for every reason.

/** Legacy's client never reads a success body, so it says only "Step triggered
 *  successful" for every outcome. Foxhound's banner is the visible surface, and
 *  a retry that DECLINED is not the same news as one that paid, so the stored
 *  result is reported rather than flattened into one word. */
function triggerNotice(action: "retry" | "email", result: string): string {
  if (action === "email") return "Next step triggered: the email was sent.";
  if (result === "retry_succeeded") return "Next step triggered: the retry succeeded.";
  if (result === "retry_card_declined") return "Next step triggered: the card was declined.";
  return `Next step triggered: the retry did not succeed (${result}).`;
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const form = await request.formData();
  // The shared dispatcher owns account scoping, ownership and the per-intent
  // preconditions (app/lib/recovery/manual-actions.server.ts). accountId comes
  // from the session, never from the form. Every mutation it performs rides the
  // per-account money-write DO through this commit binding (262 decision four).
  const outcome = await dispatchManualAction({
    db,
    accountId: auth.membership.accountId,
    failedPaymentId: params.id,
    intent: form.get("intent"),
    note: form.get("note"),
    commit: moneyWriteCommit(env),
    trigger: triggerDepsFor(env, db),
    resend: resendDepsFor(env),
  });

  if (outcome.ok) {
    if (outcome.intent === "trigger") {
      return data({ notice: triggerNotice(outcome.action, outcome.result) }, { status: 200 });
    }
    if (outcome.intent === "resend") {
      return data({ notice: `Email resent: "${outcome.subject}"` }, { status: 200 });
    }
    if (outcome.intent === "mark_recovered") {
      return data({ notice: "Marked as recovered." }, { status: 200 });
    }
    return data(
      { notice: outcome.intent === "note" ? "Note saved." : "Recovery stopped." },
      { status: 200 },
    );
  }

  // Legacy's own status codes and strings, per intent, from
  // parity/S7-PHASE2-SCOPE.md section 1.7. Every reason the dispatcher can
  // return has a case below, and the default is a typed exhaustiveness check
  // rather than a message, so a NEW reason is a compile error here instead of a
  // string a merchant reads.
  switch (outcome.reason) {
    case "not_found":
      throw new Response("Not Found", { status: 404 });
    case "not_active":
      return data({ error: "Payment is not active" }, { status: 400 });
    case "no_pending_step":
      return data({ error: "No pending steps" }, { status: 400 });
    case "no_email_to_resend":
      return data({ error: "No email to resend" }, { status: 400 });
    case "unknown_step_type":
      return data({ error: "Unknown step type" }, { status: 400 });
    case "processing_paused":
      // No legacy counterpart: legacy has no emergency brake. Executing a step
      // is processing, so a paused or braked account refuses here exactly as the
      // cron would skip it, rather than charging a card the brake was engaged to
      // protect.
      return data(
        { error: "Recovery processing is paused for this account." },
        { status: 409 },
      );
    case "customer_unsubscribed":
      return data({ error: "Customer has unsubscribed from emails" }, { status: 409 });
    case "live_sends_disabled":
      // No legacy counterpart: legacy has no send switch. Honest rather than a
      // silent success, because nothing was mailed (268).
      return data(
        { error: "Live email sending is switched off for this account." },
        { status: 409 },
      );
    case "resend_failed":
      return data(
        { error: `Failed to resend${outcome.detail ? `: ${outcome.detail}` : ""}` },
        { status: 500 },
      );
    case "resend_logged_failed":
      // The mail IS gone; only the timeline row failed. Reporting a plain failure
      // would contradict the customer's inbox and invite a second send.
      return data(
        {
          error:
            "The email was resent, but recording it on the timeline failed. Do not resend again.",
        },
        { status: 500 },
      );
    case "send_retrying":
      return data(
        { error: "Email send failed temporarily; it will retry automatically" },
        { status: 503 },
      );
    case "step_failed":
      return data({ error: `Step failed${outcome.result ? `: ${outcome.result}` : ""}` }, { status: 502 });
    case "already_resolved":
      // Legacy answers 200 `{ success: true, alreadyResolved: true }` and its
      // client then reports plain success, which tells the merchant something
      // untrue. Same status code, honest sentence: class (c).
      return data(
        {
          notice:
            outcome.intent === "cancel"
              ? "This payment was already resolved, so nothing was stopped."
              : "This payment was already recorded as recovered.",
        },
        { status: 200 },
      );
    case "write_failed":
      return data(
        {
          error:
            outcome.intent === "note"
              ? "Failed to save note"
              : "Could not stop recovery. Please try again.",
        },
        { status: 500 },
      );
    case "unknown_intent":
      // REACHABLE, and the only reason the old default ever really served: the
      // rendered forms all submit one of the five intents, so this answers a
      // hand-crafted POST. The message it used to give, "This action isn't
      // available yet", promised a feature to someone asking for one that does
      // not exist, which is the opposite of honest.
      return data({ error: "Unrecognized action." }, { status: 400 });
    default: {
      // Statically UNREACHABLE: every reason ManualActionOutcome can carry has a
      // case above, so `outcome` narrows to never here and this assignment is
      // what enforces it. Adding a reason without a case becomes a COMPILE
      // error rather than a string a merchant reads. 288's no-dead-conditional
      // rule, moved from a runtime branch into the type system.
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// Legacy's action set, in legacy's order, read from
// app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx at 7f54aa45: trigger
// the next step, mark recovered, stop the sequence, resend the last email. Four,
// not the six this route used to render.
//
// "Stop recovery" is the ONE ratified substitution (ruling 251, PRIME DIRECTIVE
// item 3, 2026-08-10). It replaces BOTH legacy's "Cancel recovery" and this
// file's own "Cancel subscription". The old label was a defect: it promised to
// end the customer's subscription when the action only ends the dunning
// sequence. Do not "restore" legacy's wording here.
//
// `conditional` marks the two legacy renders only when its precondition holds:
// trigger needs a pending step, resend needs a sent email to resend.
export const MANUAL_ACTIONS = [
  { intent: "trigger", label: "Trigger next step now", variant: "primary", needs: "nextStep" },
  { intent: "mark_recovered", label: "Mark as recovered", variant: "default", needs: null },
  { intent: "cancel", label: "Stop recovery", variant: "danger", needs: null },
  { intent: "resend", label: "Resend last email", variant: "default", needs: "lastEmail" },
] as const;

// Ruling 250, from Dustin's capture of legacy at status Failed_unrecovered: NO
// action buttons render in a terminal state. Legacy's own gate is
// `payment.status === 'active'` (PaymentDetailClient.tsx), and Foxhound shares
// that vocabulary exactly (labels.ts: active / recovered / failed_unrecovered),
// so the condition ports one to one rather than being inferred from the capture.
export const ACTIONS_VISIBLE_STATUS = "active";

/** Legacy's own 2000ms hold on the "Copied" confirmation (PaymentDetailClient.tsx
 *  221 at blob 7f54aa45). Named rather than inlined so the value is greppable. */
export const COPIED_RESET_MS = 2000;

/** Legacy's back link, PaymentDetailClient.tsx 130-132. Legacy's real target is
 *  `/recovery/dashboard`; Foxhound's recovery dashboard is the `/recovery` index
 *  (app/routes.ts), and S5 carries the URL revert as its own open item, so this
 *  points at the URL that exists today. In demo legacy returns to the payments
 *  list, which Foxhound serves at the same path for demo and real alike. */
export const BACK_LINK_REAL = { href: "/recovery", label: "Back to dashboard" };
export const BACK_LINK_DEMO = { href: "/recovery/payments", label: "Back to payments" };

export default function PaymentDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { failedPayment, steps, recovery, previousFailures, estimatedLtvCents, openDisputes, nowMs } =
    loaderData;
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  // Read off the app-shell loader, the way DemoGuardedForm and the payments
  // list already do, so the demo variants below cost no query. Legacy gates its
  // own Stripe links and back link on the same flag.
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  const isDemo = Boolean(shell?.isDemo);
  const backLink = isDemo ? BACK_LINK_DEMO : BACK_LINK_REAL;
  const [copied, setCopied] = useState(false);

  // Legacy's copyEmail, PaymentDetailClient.tsx 218-222 at blob 7f54aa45:
  // clipboard write, flip to a green confirmation, revert after 2000ms.
  function copyEmail() {
    void navigator.clipboard?.writeText(failedPayment.customerEmail);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }
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

  // Legacy's two preconditions, read from PaymentDetailClient.tsx at 7f54aa45.
  // These are the SAME selectors the server dispatcher gates on, imported from
  // one place so the buttons that render and the POSTs the server accepts cannot
  // drift apart.
  const nextStep = nextPendingStep(steps);
  const lastEmailStep = lastResendableEmailStep(steps);
  const actionsVisible = failedPayment.status === ACTIONS_VISIBLE_STATUS;
  const visibleActions = MANUAL_ACTIONS.filter(
    (a) => a.needs === null || (a.needs === "nextStep" ? nextStep !== null : lastEmailStep !== null),
  );

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-10">
      {/* Ruling 147 f1-f3, legacy
      app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx:
      max-w-[1000px] mx-auto px-8 py-10. NOTE 147 recorded this as "half
      legacy's width" too; also WRONG. Legacy is 1000px against max-w-3xl's
      768px, so 232px narrower, not 512. And legacy's px-8 here is FLAT, with
      no responsive step at all, unlike every 1280px page. */}

      {/* Legacy's back link, PaymentDetailClient.tsx 231-233 at blob 7f54aa45:
          above the header, its own line, subtle and small, with a leading arrow.
          Legacy uses a bare <a>; this uses RR8's Link so an in-app navigation
          stays client-side, which is the stack-native mechanism and invisible to
          the user (class (a) under 93). */}
      <Link
        to={backLink.href}
        className="mb-4 inline-block text-label text-text-subtle no-underline transition-opacity hover:opacity-80"
      >
        &larr; {backLink.label}
      </Link>

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            {/* Legacy pairs the title and the open-dispute badge in one wrapping
                flex row (PaymentDetailClient.tsx 236-252 at blob 7f54aa45). */}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title font-medium text-text">
                {failedPayment.customerName ?? failedPayment.customerEmail}
              </h1>
              {/* Legacy's open-dispute badge, 243-251. Legacy gated it on
                  `disputesActive && openDisputes.length > 0`; the entitlement
                  half read account_products, which 298 dropped as vestigial, so
                  304 rules the badge renders on the DISPUTE PREDICATE ALONE.
                  That predicate is real: the loader derives "open" from
                  RESOLVED_DISPUTE_STATES, the constant isDisputeResolved reads.
                  Purple is legacy's own choice here and fits DESIGN's reservation
                  rather than bending it: a dispute IS a Stripe object, which is
                  what purple is reserved for. Foxhound has a real
                  `purple-border` token, so legacy's `border-purple/40` opacity
                  hack is not reproduced.
                  DEMO: this needs no demo branch. Legacy hid it in demo only
                  because its entitlement gate was false there; the demo seeds
                  real disputes, so rendering the truth IS legacy's behaviour. */}
              {openDisputes.length > 0 ? (
                <Link
                  to={`/disputes/${openDisputes[0].id}`}
                  className="group inline-flex items-center gap-1 rounded border border-purple-border bg-purple-bg px-2 py-0.5 text-micro text-purple no-underline hover:opacity-80"
                >
                  <Shield className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                  {openDisputes.length === 1 ? "1 open dispute" : `${openDisputes.length} open disputes`}{" "}
                  <ArrowRight
                    className="inline-block transition-transform group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </Link>
              ) : null}
            </div>
            {/* Legacy's email line carries the Copy email control beside it
                (PaymentDetailClient.tsx 253-262 at blob 7f54aa45): a borderless
                text button that flips to a green confirmation for 2000ms.
                Legacy's confirmation glyph is a literal U+2713; this uses
                lucide's Check for the reason stated on the timeline glyph
                below. */}
            <div className="mt-1 flex flex-wrap items-center gap-3">
              {/* Legacy shows this sub-line ONLY when a customer name exists
                  (PaymentDetailClient.tsx 254-256 at blob 7f54aa45), because the
                  h1 above already falls back to the email: rendering it
                  unconditionally printed the same address twice on every
                  nameless payment. Straight parity repair. */}
              {failedPayment.customerName ? (
                <p className="text-label text-text-tertiary">{failedPayment.customerEmail}</p>
              ) : null}
              <button
                type="button"
                onClick={copyEmail}
                className={`inline-flex items-center gap-1 text-micro ${
                  copied ? "text-green" : "text-text-subtle hover:text-text"
                }`}
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" /> Copied
                  </>
                ) : (
                  "Copy email"
                )}
              </button>
              {/* Legacy's plan name, PaymentDetailClient.tsx 263 at blob
                  7f54aa45: a middot then the plan, only when present, and AFTER
                  the Copy email control in legacy's own order. The column has
                  been on failed_payments all along (schema.ts:244) and
                  getFailedPaymentDetail selects whole rows, so this needed no
                  loader field at all, one fewer than the scope doc estimated. */}
              {failedPayment.planName ? (
                <p className="text-label text-text-tertiary">
                  &middot; {failedPayment.planName}
                </p>
              ) : null}
            </div>
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

      {/* SECTION ORDER IS LEGACY'S (304, closing 295 Q1). Read from blob
          7f54aa45: back and header, then the action RESULT banner, then the
          action BUTTONS, then the Stripe links, info cards, details and
          engagement, timeline, internal notes, and the success banner last.
          Both blocks below used to sit at the bottom of this page. The Outcome
          card keeps its slot because legacy has no counterpart to move it to,
          and the success banner was already last. */}
      {/* Action feedback sits OUTSIDE the actions card on purpose. It used to
          live inside it, which was fine while every intent was refused: the
          status could not change, so the card was always still there to render
          the message. Now a successful Stop recovery moves the payment to a
          terminal status, the card correctly stops rendering, and a message
          nested inside it would vanish on the very submit it exists to report.
          One block, ungated, serving the notes form and the action row alike. */}
      {actionData && "error" in actionData ? (
        <p
          className="mt-6 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text"
          role="alert"
        >
          {actionData.error}
        </p>
      ) : null}
      {actionData && "notice" in actionData ? (
        <p
          className="mt-6 rounded-md border border-green bg-green-bg px-3 py-2 text-label text-green"
          role="status"
        >
          {actionData.notice}
        </p>
      ) : null}

      {/* Ruling 250: the action row is STATE-CONDITIONAL. Dustin's capture of
          legacy at Failed_unrecovered shows NO action buttons at all, and
          legacy's own gate is `payment.status === 'active'`, so a terminal
          payment renders nothing here rather than a row of dead controls.
          Every intent behind these buttons is WIRED (272); the gate is legacy's
          own, not a stand-in for an unbuilt engine. */}
      {actionsVisible ? (
        <div className="mt-6 rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Manual actions</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {visibleActions.map((a) => (
              <DemoGuardedForm key={a.intent} method="post">
                <input type="hidden" name="intent" value={a.intent} />
                <button
                  type="submit"
                  disabled={busy}
                  className={`rounded-md border px-3 py-1.5 text-label disabled:opacity-60 ${
                    a.variant === "primary"
                      ? "border-amber bg-amber font-semibold text-on-amber hover:bg-amber-dark"
                      : a.variant === "danger"
                        ? "border-border text-error-text hover:border-red"
                        : "border-border text-text-secondary hover:border-border-i"
                  }`}
                >
                  {a.label}
                </button>
              </DemoGuardedForm>
            ))}
          </div>
        </div>
      ) : null}

      {/* Legacy's two Stripe deep links, PaymentDetailClient.tsx 329-360 at blob
          7f54aa45, in legacy's own slot: after the header block and immediately
          BEFORE the info cards. Legacy renders these links AND the invoice and
          customer ids as rows inside Decline details (378-379), so the rows below
          are legacy's too and stay. In demo legacy swaps both for disabled
          buttons titled "Connect Stripe to use this", because a demo account has
          no Stripe objects to open. */}
      <div className="mt-6 flex flex-wrap gap-2.5">
        {isDemo ? (
          <>
            <button
              type="button"
              disabled
              title="Connect Stripe to use this"
              className="cursor-not-allowed rounded-md border border-border-sub px-3 py-1.5 text-micro text-text-subtle opacity-50"
            >
              View invoice in Stripe
            </button>
            <button
              type="button"
              disabled
              title="Connect Stripe to use this"
              className="cursor-not-allowed rounded-md border border-border-sub px-3 py-1.5 text-micro text-text-subtle opacity-50"
            >
              View customer in Stripe
            </button>
          </>
        ) : (
          <>
            <a
              href={`https://dashboard.stripe.com/invoices/${failedPayment.stripeInvoiceId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group rounded-md border border-border px-3 py-1.5 text-micro text-text-subtle no-underline transition-colors hover:border-text-tertiary"
            >
              View invoice in Stripe{" "}
              <ArrowUpRight
                className="inline-block transition-transform group-hover:-translate-y-px group-hover:translate-x-px"
                size={12}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </a>
            <a
              href={`https://dashboard.stripe.com/customers/${failedPayment.stripeCustomerId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group rounded-md border border-border px-3 py-1.5 text-micro text-text-subtle no-underline transition-colors hover:border-text-tertiary"
            >
              View customer in Stripe{" "}
              <ArrowUpRight
                className="inline-block transition-transform group-hover:-translate-y-px group-hover:translate-x-px"
                size={12}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </a>
          </>
        )}
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
          // Legacy renders NO subtext below two recovered payments, so an absent
          // subtext here is legacy's own behaviour rather than a missing element.
          subtext={
            estimatedLtvCents != null
              ? `~${formatMoney(Math.round(estimatedLtvCents), failedPayment.currency)} est. LTV`
              : undefined
          }
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

          {/* Legacy's "Previous failures (N)" block sits inside this same card,
              under a top rule, one row per prior failure linking to its detail
              page (PaymentDetailClient.tsx at 7f54aa45). */}
          {previousFailures.length > 0 ? (
            <>
              <p className="mt-4 border-t border-border pt-4 text-micro font-medium text-text-subtle">
                Previous failures ({previousFailures.length})
              </p>
              <ul className="mt-1 flex flex-col">
                {previousFailures.map((p) => (
                  <li key={p.id}>
                    <a
                      href={`/recovery/payments/${p.id}`}
                      className="flex items-center justify-between border-b border-border-sub py-1.5 no-underline"
                    >
                      <span className="text-micro text-text-subtle">
                        {formatRelativeTime(p.detectedAt, nowMs) ?? "-"}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge tone="neutral">
                          {DECLINE_CATEGORY_LABELS[p.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
                            p.declineCategory}
                        </Badge>
                        <span className="font-mono text-micro text-text">
                          {formatMoney(p.amountCents, p.currency)}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {/* Ruling 251, Dustin's distinction requirement in his words: "it needs to
          be more distinguished from everything else". This card is the receipt
          for the 20 percent attribution fee, so it must not share the standard
          card treatment. Distinction is carried by the amber accent border and
          the tinted amber surface, the two tokens DESIGN.md already reserves for
          the brand accent, rather than by a new token or a size change: every
          other card on this page is `border-border bg-surface`, so the accent
          alone separates it at a glance without inventing anything. Flagged for
          Dustin's review on the demo. */}
      <div className="mt-6 rounded-lg border border-amber bg-amber-bg p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-amber-text">Outcome</p>
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
              // Legacy's own gate for the per-step engagement indicators
              // (PaymentDetailClient.tsx 540 at blob 7f54aa45): an executed EMAIL
              // step whose result is not email_failed, because a mail that never
              // sent cannot have been opened or clicked.
              const showEngagement =
                step.executedAt !== null &&
                isEmailStep(step.stepType) &&
                step.result !== "email_failed";
              const showExpander = step.executedAt !== null && step.previewHtml !== null;
              // Ruling 251: the per-step channel label is REMOVED. Legacy carries
              // no such tag; its glyph and chip treatment is the spec, and removal
              // is the zero-ratification path.
              return (
                <li
                  key={step.id}
                  className="border-b border-border-sub pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex gap-4">
                    <StepGlyph
                      executed={step.executedAt !== null}
                      isEmail={isEmailStep(step.stepType)}
                      tone={stepResultTone(step.result)}
                    />
                    <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
                    <div>
                      <p className="text-body text-text">
                        {step.stepNumber ?? "-"}. {formatStepType(step.stepType)}
                      </p>
                      {step.aiSubject ? (
                        <p className="text-micro text-text-subtle">&quot;{step.aiSubject}&quot;</p>
                      ) : null}
                      <p className="text-label text-text-tertiary">
                        {step.executedAt
                          ? `Ran ${step.executedAt.toLocaleString()}`
                          : `Scheduled for ${step.scheduledAt.toLocaleString()}`}
                      </p>
                    </div>
                    <Badge tone={stepResultTone(step.result)}>
                      {step.result ? formatStepResult(step.result) : "Pending"}
                    </Badge>
                    </div>
                  </div>

                  {/* Legacy's engagement row, PaymentDetailClient.tsx 540-557 at
                      blob 7f54aa45: the per-step opened and clicked indicators
                      and the View email control share ONE row, which is why the
                      expander moves inside it rather than keeping its own div.
                      Its gate and its ruling 250 treatment are unchanged, and its
                      body is still the loader-sanitized previewHtml (ruling 256).
                      Glyphs are lucide Check and Circle for the reason StepGlyph
                      states; legacy uses the literal U+2713 and U+25CB.
                      NOT this item and deliberately untouched: the AGGREGATE
                      Opened and Clicked rows in the Email engagement card above. */}
                  {showEngagement || showExpander ? (
                    <div className="mt-2 flex flex-wrap items-center gap-4">
                      {showEngagement ? (
                        <>
                          <span
                            className={`inline-flex items-center gap-1 text-micro ${
                              step.openedAt ? "text-green" : "text-text-subtle"
                            }`}
                          >
                            {step.openedAt ? (
                              <Check className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                            ) : (
                              <Circle className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                            )}
                            {step.openedAt
                              ? `Opened ${formatRelativeTime(step.openedAt, nowMs) ?? ""}`.trim()
                              : "Not opened"}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 text-micro ${
                              step.clickedAt ? "text-green" : "text-text-subtle"
                            }`}
                          >
                            {step.clickedAt ? (
                              <Check className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                            ) : (
                              <Circle className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                            )}
                            {step.clickedAt
                              ? `Clicked ${formatRelativeTime(step.clickedAt, nowMs) ?? ""}`.trim()
                              : "Not clicked"}
                          </span>
                        </>
                      ) : null}
                      {showExpander ? (
                        <button
                        type="button"
                        onClick={() => setExpandedStepId(expandedStepId === step.id ? null : step.id)}
                        aria-expanded={expandedStepId === step.id}
                        className="text-micro text-text-subtle hover:text-text"
                      >
                        {expandedStepId === step.id ? "Hide email" : "View email"}{" "}
                        <ChevronDown
                          className={`inline-block h-3 w-3 transition-transform ${
                            expandedStepId === step.id ? "rotate-180" : ""
                          }`}
                          strokeWidth={1.5}
                          aria-hidden="true"
                        />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {/* The expanded body sits BELOW legacy's row, as it does in
                      legacy (559-563), not inside it. */}
                  {step.previewHtml && expandedStepId === step.id ? (
                    <div
                      className="mt-2 rounded-lg border border-border bg-bg p-4 text-label text-text"
                      // Sanitized in the loader by sanitizeEmailPreviewHtml, the
                      // same helper and allowlist the sequences preview uses.
                      // Never render step.aiBodyHtml directly here.
                      dangerouslySetInnerHTML={{ __html: step.previewHtml }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>


      {/* Legacy's INTERNAL NOTES card, treatment per 250's capture: a textarea
          with placeholder copy and an amber Save note button. The column
          (failed_payments.notes) already exists. SAVING is WIRED as of Session B
          (262 decision four): the form posts the `note` intent, the dispatcher
          scopes it to this account, and the update commits through the
          per-account money-write DO. */}
      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Internal notes</p>
        <DemoGuardedForm method="post">
          <input type="hidden" name="intent" value="note" />
          <textarea
            name="note"
            aria-label="Internal notes for this payment"
            defaultValue={failedPayment.notes ?? ""}
            placeholder="Add a note about this payment or customer..."
            rows={3}
            className="mt-3 w-full resize-y rounded-lg border border-border-i bg-bg px-3.5 py-2.5 text-label text-text"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 rounded-md border border-amber bg-amber px-4 py-2 text-label font-semibold text-on-amber hover:bg-amber-dark disabled:opacity-60"
          >
            Save note
          </button>
        </DemoGuardedForm>
      </div>


      {/* Legacy's recovery success banner, PaymentDetailClient.tsx 599-612 at
          blob 7f54aa45. Legacy's gate is BOTH halves, a recovered status AND a
          recovered_payments row, so a status flip without a row renders nothing,
          and the amount appears twice, once in the sentence and once large and
          mono on the right.
          PLACEMENT: legacy's banner is the LAST element on the page and this
          is the last element here. That open ordering question is now CLOSED by
          304: the action row moved up to legacy's slot and this banner stayed
          exactly where it was, which is why last was the stable placement to
          take before the ruling landed.
          The method reads through ATTRIBUTION_KIND_LABELS, the same table the
          Email engagement card above already uses for "Recovery method", rather
          than legacy's recovery_method vocabulary, which Foxhound does not carry.
          Type scale is FROZEN in both directions under 187, so this uses the
          page's existing steps rather than legacy's rem values. */}
      {failedPayment.status === "recovered" && recovery ? (
        <div className="mt-6 flex items-center justify-between gap-4 rounded-lg border border-green bg-green-bg p-4">
          <div>
            <p className="text-body font-medium text-green">Payment recovered</p>
            <p className="mt-1 text-label text-text-subtle">
              {formatMoney(recovery.amountCents, recovery.currency)} recovered via{" "}
              {ATTRIBUTION_KIND_LABELS[(recovery.attributionKind as AttributionKind) ?? "stripe_baseline"]}
              {formatRelativeTime(recovery.recoveredAt, nowMs)
                ? ` - ${formatRelativeTime(recovery.recoveredAt, nowMs)}`
                : ""}
            </p>
          </div>
          <p className="font-mono text-title font-bold text-green">
            {formatMoney(recovery.amountCents, recovery.currency)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Legacy's timeline node, PaymentDetailClient.tsx 452-463 at blob 7f54aa45: a
 * 32px round node holding an envelope on an email step and a repeat glyph on a
 * retry, tinted by the step's result once executed and grey while pending.
 *
 * TWO MECHANISM DIVERGENCES, both stated rather than silent.
 *
 * ONE, THE COLOUR SOURCE. Legacy derives this node AND the result chip beside it
 * from ONE value, `getStepResultColor(step.result)`, so the two always agree.
 * That map keys on `email_sent_ai` and `email_sent_fallback`, which Foxhound has
 * NEVER written: a grep over app/ and test/ returns zero for both, while Foxhound
 * writes `email_sent`. Porting the map verbatim would leave every real email
 * step's node grey beside a green chip, breaking the very agreement legacy's
 * shape exists to hold. So the node reads `stepResultTone`, the SAME source the
 * chip reads. That is 292's semantic-port rule: the port targets the capability,
 * node and chip agree, not the storage, legacy's string literals.
 *
 * TWO, THE GLYPH. Legacy renders the literal characters U+2709 and U+21BA.
 * capsid/conventions.md bans emoji in UI and makes lucide-react the icon default,
 * and U+2709 carries an emoji presentation variant on common platforms, so these
 * are lucide's Mail and RotateCcw in the same node at the same size. Raised for
 * ratification; the rendered result is the same two symbols.
 *
 * Legacy's executed background is its result colour at 13 percent alpha, and
 * green-bg and red-bg ARE those tinted tokens, so success and failure are exact.
 * Neutral-executed has no tinted counterpart and uses surface2, the one
 * approximation here, named rather than passed off as a match.
 */
function StepGlyph({ executed, isEmail, tone }: { executed: boolean; isEmail: boolean; tone: Tone }) {
  const skin = !executed
    ? "border-border bg-border text-text-tertiary"
    : tone === "success"
      ? "border-green bg-green-bg text-green"
      : tone === "failure"
        ? "border-red bg-red-bg text-error-text"
        : "border-border-sub bg-surface2 text-text-subtle";
  const Glyph = isEmail ? Mail : RotateCcw;
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${skin}`}
    >
      <Glyph className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
    </span>
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
