import { useEffect, useId, useState } from "react";

import { ArrowRight, ArrowUpRight, Check, ChevronDown, Circle, Mail, RotateCcw, Shield } from "lucide-react";

import { Form, Link, data, useFetcher, useNavigation, useRouteLoaderData } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/status.css";
// Capsomer's tokens and the teal family, which the components above read, as
// the payments list and /disputes load them.
import "~/site-header.css";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatDateMonthDay, formatDateShort, formatRelativeFuture, formatTimeAgo } from "~/lib/date-format";
import { formatMoney } from "~/lib/money-format";
import {
  ATTRIBUTION_KIND_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  RECOVERY_LIFECYCLE_LABELS,
  clickSuspectLabel,
  failedPaymentStatusTone,
  recoveryLifecycleStatus,
  recoveryLifecycleTone,
  stepResultTone,
  type Tone,
} from "~/lib/recovery/labels";
import {
  ACTION_LABELS,
  PILL_TONE,
  actionSuccessNotice,
  declineValueClass,
  isDetailActionIntent,
  recoveredViaWords,
  statusValueClass,
  stepResultWords,
  visibleActionResult,
} from "~/lib/recovery/payment-detail";
import { declineWord } from "~/lib/recovery/payments-list";
import { paymentStepLabel } from "~/lib/recovery/payments-list.server";
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
  const category = detail.failedPayment.declineCategory;
  // The two action gates, computed HERE from the same selectors the server
  // dispatcher gates on (step-state.ts), over the same step order it reads, so
  // the buttons offered and the POSTs accepted cannot drift. The trigger button
  // names the step it will fire, as Recova's does ("Trigger Day 3 email now"),
  // in the engine's own words for the payment's schedule (J75's
  // paymentStepLabel).
  const next = nextPendingStep(detail.steps);
  const nextStepLabel = next ? paymentStepLabel(category, next.stepType) : null;
  const canResend = lastResendableEmailStep(detail.steps) !== null;
  // Ruling 256: sanitize SERVER-SIDE, through the helper the sequences preview
  // already uses, and send ONLY the sanitized body, so no unsanitized HTML is
  // part of the response at all. Recova orders its timeline by scheduled time
  // (page.tsx 6034a8ba, `.order('scheduled_at', { ascending: true })`), so a
  // resend, which has no step number, sits last rather than first.
  const steps = [...detail.steps]
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || (a.stepNumber ?? 0) - (b.stepNumber ?? 0))
    .map(({ aiBodyHtml, ...step }) => ({
      ...step,
      label: paymentStepLabel(category, step.stepType),
      previewHtml: aiBodyHtml ? sanitizeEmailPreviewHtml(aiBodyHtml) : null,
    }));
  return { ...detail, steps, nextStepLabel, canResend, nowMs: Date.now() };
}

// Manual per-payment actions: all five are wired (272), each committing through
// the per-account money-write DO (262 decision four). Mark as recovered enters
// through the spine's own buildRecoveryBatch and is never a second writer of
// recovered_payments. This route only reports what the dispatcher decided.

/** Recova's 2000ms hold on a success message (PaymentDetailClient.tsx 167,
 *  `setTimeout(() => { setActionResult(null); router.refresh() }, 2000)`). An
 *  error stays until the next action, as Recova's does. */
export const ACTION_SUCCESS_CLEAR_MS = 2000;

/** Recova's 2000ms hold on "Saved" beside Save note (PaymentDetailClient.tsx 189). */
export const NOTE_SAVED_CLEAR_MS = 2000;

export async function action({ context, params, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const form = await request.formData();
  const intent = form.get("intent");

  // The shared dispatcher owns account scoping, ownership and the per-intent
  // preconditions (app/lib/recovery/manual-actions.server.ts). accountId comes
  // from the session, never from the form.
  let outcome: Awaited<ReturnType<typeof dispatchManualAction>>;
  try {
    outcome = await dispatchManualAction({
      db,
      accountId: auth.membership.accountId,
      failedPaymentId: params.id,
      intent,
      note: form.get("note"),
      commit: moneyWriteCommit(env),
      trigger: triggerDepsFor(env, db),
      resend: resendDepsFor(env),
    });
  } catch (err) {
    // Recova's client answers a failed request with "<label> failed"
    // (PaymentDetailClient.tsx 169). The whole error goes to the log, never to
    // the page.
    console.error("payment detail action failed", err);
    const error = isDetailActionIntent(intent)
      ? `${ACTION_LABELS[intent]} failed`
      : intent === "note"
        ? "Failed to save note"
        : "Action failed";
    return data({ error, intent: typeof intent === "string" ? intent : null }, { status: 500 });
  }

  if (outcome.ok) {
    if (outcome.intent === "note") return data({ notice: "Note saved", intent: "note" }, { status: 200 });
    return data(
      {
        notice: actionSuccessNotice(
          outcome.intent,
          outcome.intent === "trigger" ? { action: outcome.action, result: outcome.result } : undefined,
        ),
        intent: outcome.intent,
      },
      { status: 200 },
    );
  }

  // Legacy's own status codes and strings, per intent, from
  // parity/S7-PHASE2-SCOPE.md section 1.7. Every reason the dispatcher can
  // return has a case below, and the default is a typed exhaustiveness check,
  // so a NEW reason is a compile error here instead of a string a merchant reads.
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
      // cron would skip it (approved 2026-08-14).
      return data({ error: "Recovery processing is paused for this account." }, { status: 409 });
    case "customer_unsubscribed":
      return data({ error: "Customer has unsubscribed from emails" }, { status: 409 });
    case "live_sends_disabled":
      // No legacy counterpart: legacy has no send switch. Honest rather than a
      // silent success, because nothing was mailed (268).
      return data({ error: "Live email sending is switched off for this account." }, { status: 409 });
    case "resend_failed":
      return data({ error: `Failed to resend${outcome.detail ? `: ${outcome.detail}` : ""}` }, { status: 500 });
    case "resend_logged_failed":
      // The mail IS gone; only the timeline row failed. Reporting a plain failure
      // would contradict the customer's inbox and invite a second send.
      return data(
        { error: "The email was resent, but recording it on the timeline failed. Do not resend again." },
        { status: 500 },
      );
    case "send_retrying":
      return data({ error: "Email send failed temporarily; it will retry automatically" }, { status: 503 });
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
          intent: outcome.intent,
        },
        { status: 200 },
      );
    case "write_failed":
      return data(
        {
          error: outcome.intent === "note" ? "Failed to save note" : "Could not stop recovery. Please try again.",
          intent: outcome.intent,
        },
        { status: 500 },
      );
    case "unknown_intent":
      // Reachable only by a hand-crafted POST: the rendered forms all submit one
      // of the five intents.
      return data({ error: "Unrecognized action." }, { status: 400 });
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// Legacy's action set, in legacy's order, read from PaymentDetailClient.tsx at
// 7f54aa45: trigger the next step, mark recovered, stop the sequence, resend the
// last email. "Stop recovery" is the ratified substitution for "Cancel
// recovery" (approved 2026-08-10); do not restore legacy's wording. The trigger
// button names its step when it renders ("Trigger Day 3 email now"); this label
// is its fallback only.
export const MANUAL_ACTIONS = [
  { intent: "trigger", label: "Trigger next step now", variant: "primary", needs: "nextStep" },
  { intent: "mark_recovered", label: "Mark as recovered", variant: "default", needs: null },
  { intent: "cancel", label: "Stop recovery", variant: "danger", needs: null },
  { intent: "resend", label: "Resend last email", variant: "default", needs: "lastEmail" },
] as const;

// Ruling 250: NO action buttons render in a terminal state. Legacy's own gate is
// `payment.status === 'active'`.
export const ACTIONS_VISIBLE_STATUS = "active";

/** Legacy's own 2000ms hold on the "Copied" confirmation (PaymentDetailClient.tsx
 *  221 at blob 7f54aa45). */
export const COPIED_RESET_MS = 2000;

/** The Copy email button's words: "Copy email", then Recova's copied state
 *  for COPIED_RESET_MS (PaymentDetailClient.tsx 248-253, green "Copied" with a
 *  tick), as Capsomer's ok status: its tick glyph and word in the ok colour. */
export function CopyEmailLabel({ copied }: { copied: boolean }) {
  if (!copied) return <>Copy email</>;
  return <Status tone="ok">Copied</Status>;
}

/** Legacy's back link, PaymentDetailClient.tsx 130-132. */
export const BACK_LINK_REAL = { href: "/recovery/dashboard", label: "Back to dashboard" };
export const BACK_LINK_DEMO = { href: "/recovery/payments", label: "Back to payments" };

/** Recova's demo title on every control that needs a Stripe account. */
const DEMO_DISABLED_REASON = "Connect Stripe to use this";

export default function PaymentDetail({ loaderData, actionData }: Route.ComponentProps) {
  const {
    failedPayment,
    steps,
    recovery,
    previousFailures,
    estimatedLtvCents,
    openDisputes,
    nextStepLabel,
    canResend,
    nowMs,
  } = loaderData;
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  const isDemo = Boolean(shell?.isDemo);
  const backLink = isDemo ? BACK_LINK_DEMO : BACK_LINK_REAL;
  const [copied, setCopied] = useState(false);
  const demoReasonId = useId();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const pressedIntent = navigation.formData?.get("intent") ?? null;

  // Recova's action result: a success clears after 2000ms, an error stays until the next press.
  const notice = actionData && "notice" in actionData ? actionData.notice : null;
  const [clearedNoticeFor, setClearedNoticeFor] = useState<unknown>(null);
  // Pressing an action clears the last result at once, as Recova's does.
  const actionResult = visibleActionResult({ actionData, clearedFor: clearedNoticeFor, pendingIntent: pressedIntent });
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setClearedNoticeFor(actionData), ACTION_SUCCESS_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [actionData, notice]);

  // Recova saves a note in place (PaymentDetailClient.tsx saveNote): "Saving..."
  // on the button, then "Saved" beside it for 2000ms, or its error line.
  const noteFetcher = useFetcher<typeof action>();
  const noteSaving = noteFetcher.state !== "idle";
  const noteResult = noteFetcher.data;
  const [savedClearedFor, setSavedClearedFor] = useState<unknown>(null);
  const noteSaved = Boolean(noteResult && "notice" in noteResult && savedClearedFor !== noteResult);
  useEffect(() => {
    if (!noteResult || !("notice" in noteResult)) return;
    const timer = setTimeout(() => setSavedClearedFor(noteResult), NOTE_SAVED_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [noteResult]);
  const noteError = noteResult && "error" in noteResult;

  function copyEmail() {
    void navigator.clipboard?.writeText(failedPayment.customerEmail);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }

  const attributionKind = recovery?.attributionKind as AttributionKind | undefined;
  const creditedStep =
    recovery?.recoveredByStepId != null ? steps.find((s) => s.id === recovery.recoveredByStepId) : undefined;

  const executedSteps = steps.filter((s) => s.executedAt !== null);
  const emailSteps = executedSteps.filter((s) => isEmailStep(s.stepType));
  const openedEmails = emailSteps.filter((s) => s.openedAt);
  const clickedEmails = emailSteps.filter((s) => s.clickedAt);

  const actionsVisible = failedPayment.status === ACTIONS_VISIBLE_STATUS;
  const visibleActions = MANUAL_ACTIONS.filter(
    (a) => a.needs === null || (a.needs === "nextStep" ? nextStepLabel !== null : canResend),
  ).map((a) => ({ ...a, label: a.intent === "trigger" ? `Trigger ${nextStepLabel} now` : a.label }));

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-10">
      {/* Recova's width and padding, PaymentDetailClient.tsx 227:
          max-w-[1000px] mx-auto px-8 py-10, flat at every width. */}

      {/* Recova's back link and bare header, PaymentDetailClient.tsx 230-271:
          no box, the name with the open-dispute badge, the email line, and the
          status pill top right. */}
      <header className="mb-7">
        <Link
          to={backLink.href}
          className="mb-4 inline-flex min-h-6 items-center text-label text-text-subtle no-underline transition-opacity hover:opacity-80"
        >
          &larr; {backLink.label}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h1 className="m-0 text-title font-medium text-text">
                {failedPayment.customerName ?? failedPayment.customerEmail}
              </h1>
              {/* The open-dispute badge, gated on the live dispute predicate
                  alone (ruling 304). */}
              {openDisputes.length > 0 ? (
                <Pill variant="outline" href={`/disputes/${openDisputes[0].id}`}>
                  <Shield className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                  {openDisputes.length === 1 ? "1 open dispute" : `${openDisputes.length} open disputes`}
                  <ArrowRight className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                </Pill>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-label text-text-subtle">
              {/* The email shows here only when a name took the heading. */}
              {failedPayment.customerName ? <span>{failedPayment.customerEmail}</span> : null}
              <span className="text-micro">
                <button type="button" className="cap-link-btn" onClick={copyEmail}>
                  <CopyEmailLabel copied={copied} />
                </button>
              </span>
              <span className="sr-only" role="status">
                {copied ? "Email copied" : ""}
              </span>
              {failedPayment.planName ? <span>&middot; {failedPayment.planName}</span> : null}
            </div>
          </div>
          <Pill tone={PILL_TONE[failedPaymentStatusTone(failedPayment.status)]}>
            {FAILED_PAYMENT_STATUS_LABELS[failedPayment.status] ?? failedPayment.status}
          </Pill>
        </div>
      </header>

      {/* Recova's IntegrityLayerBanner sits here. Nothing in Foxhound writes the
          banded prediction it reads, so it is not built (RULES.md 3.18). */}

      {/* Recova's action result banner, PaymentDetailClient.tsx 277-287. */}
      {actionResult ? (
        <div className="mb-5">
          <Banner tone={actionResult.tone}>{actionResult.message}</Banner>
        </div>
      ) : null}

      {/* Recova's action buttons, PaymentDetailClient.tsx 289-327: only while
          the payment is active (ruling 250); in the demo the same buttons,
          disabled and titled as Recova's are. */}
      {actionsVisible && !isDemo ? (
        <div className="mb-6 flex flex-wrap gap-2.5">
          {visibleActions.map((a) => {
            const pressed = pressedIntent === a.intent;
            return (
              <Form key={a.intent} method="post">
                <input type="hidden" name="intent" value={a.intent} />
                <button
                  type="submit"
                  className="cap-btn"
                  data-variant={a.variant === "default" ? undefined : a.variant}
                  aria-disabled={busy ? true : undefined}
                  onClick={(e) => {
                    if (busy) e.preventDefault();
                  }}
                >
                  {pressed ? "Working..." : a.label}
                </button>
              </Form>
            );
          })}
        </div>
      ) : null}
      {actionsVisible && isDemo ? (
        <div className="mb-6 flex flex-wrap gap-2.5">
          {visibleActions.map((a) => (
            <button
              key={a.intent}
              type="button"
              className="cap-btn"
              data-variant={a.variant === "default" ? undefined : a.variant}
              aria-disabled="true"
              aria-describedby={demoReasonId}
              title={DEMO_DISABLED_REASON}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* Recova's two Stripe links, PaymentDetailClient.tsx 329-360. */}
      <div className="mb-6 flex flex-wrap gap-2.5">
        {isDemo ? (
          <>
            <button
              type="button"
              className="cap-btn"
              data-size="sm"
              aria-disabled="true"
              aria-describedby={demoReasonId}
              title={DEMO_DISABLED_REASON}
            >
              View invoice in Stripe
            </button>
            <button
              type="button"
              className="cap-btn"
              data-size="sm"
              aria-disabled="true"
              aria-describedby={demoReasonId}
              title={DEMO_DISABLED_REASON}
            >
              View customer in Stripe
            </button>
          </>
        ) : (
          <>
            <a
              className="cap-btn"
              data-size="sm"
              href={`https://dashboard.stripe.com/invoices/${failedPayment.stripeInvoiceId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View invoice in Stripe
              <ArrowUpRight data-icon="end" size={12} strokeWidth={1.5} aria-hidden="true" />
            </a>
            <a
              className="cap-btn"
              data-size="sm"
              href={`https://dashboard.stripe.com/customers/${failedPayment.stripeCustomerId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View customer in Stripe
              <ArrowUpRight data-icon="end" size={12} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </>
        )}
      </div>
      {isDemo ? (
        // Capsomer's disabled buttons keep focus and say why in visible text
        // (button.md); Recova's say it only in a title.
        <p className="-mt-4 mb-6">
          <span className="cap-btn-reason" id={demoReasonId}>
            {DEMO_DISABLED_REASON}
          </span>
        </p>
      ) : null}

      {/* Recova's four info cards, PaymentDetailClient.tsx 362-368. Capsomer has
          no plain stat card (its tile is always a link), so each is a small
          Panel, as on the payments list. */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Panel size="sm" title="Amount">
          <p className="m-0 font-mono text-title font-bold tabular-nums text-brand-text">
            {formatMoney(failedPayment.amountCents, failedPayment.currency)}
          </p>
        </Panel>
        <Panel size="sm" title="Decline">
          <p className={`m-0 text-title font-bold ${declineValueClass(failedPayment.declineCategory)}`}>
            {declineWord(failedPayment.declineCategory)}
          </p>
        </Panel>
        <Panel size="sm" title="Detected">
          <p className="m-0 text-title font-bold text-text">{formatTimeAgo(failedPayment.detectedAt, nowMs)}</p>
          <p className="m-0 mt-1 text-micro text-text-subtle">{formatDateMonthDay(failedPayment.detectedAt)}</p>
        </Panel>
        <Panel size="sm" title="Customer age">
          <p className="m-0 font-mono text-title font-bold tabular-nums text-text">
            {failedPayment.customerAgeDays != null ? `${failedPayment.customerAgeDays}d` : "-"}
          </p>
          {/* Recova shows no subtext below two recovered payments. */}
          {estimatedLtvCents != null ? (
            <p className="m-0 mt-1 text-micro text-text-subtle">
              ~{formatMoney(Math.round(estimatedLtvCents), failedPayment.currency)} est. LTV
            </p>
          ) : null}
        </Panel>
      </div>

      {/* Recova's Decline details and Email engagement cards, 371-421. */}
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Panel title="Decline details">
          <dl className="m-0">
            <DetailRow
              label="Category"
              value={declineWord(failedPayment.declineCategory)}
              valueClass={declineValueClass(failedPayment.declineCategory)}
            />
            {failedPayment.declineCode ? <DetailRow label="Code" value={failedPayment.declineCode} mono /> : null}
            <DetailRow label="Invoice ID" value={failedPayment.stripeInvoiceId} mono small />
            <DetailRow label="Customer ID" value={failedPayment.stripeCustomerId} mono small />
            {failedPayment.customerSince ? (
              <DetailRow
                label="Customer since"
                value={failedPayment.customerSince.toLocaleDateString("en-US", {
                  month: "short",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              />
            ) : null}
            {failedPayment.resolvedAt ? (
              <DetailRow
                label={failedPayment.status === "recovered" ? "Recovered" : "Resolved"}
                value={formatDateShort(failedPayment.resolvedAt)}
              />
            ) : null}
          </dl>
        </Panel>

        <Panel title="Email engagement">
          {emailSteps.length === 0 ? (
            <p className="m-0 text-label text-text-subtle">No emails sent yet</p>
          ) : (
            <dl className="m-0">
              <DetailRow label="Emails sent" value={String(emailSteps.length)} />
              <DetailRow
                label="Opened"
                value={`${openedEmails.length} of ${emailSteps.length}`}
                valueClass={openedEmails.length > 0 ? "text-green" : "text-text-subtle"}
              />
              <DetailRow
                label="Clicked"
                value={`${clickedEmails.length} of ${emailSteps.length}`}
                valueClass={clickedEmails.length > 0 ? "text-green" : "text-text-subtle"}
              />
              {recovery ? (
                <DetailRow
                  label="Recovery method"
                  value={ATTRIBUTION_KIND_LABELS[attributionKind ?? "stripe_baseline"]}
                  valueClass="text-green"
                />
              ) : null}
            </dl>
          )}

          {previousFailures.length > 0 ? (
            <>
              <p className="m-0 mt-4 mb-3 border-t border-border pt-4 text-micro font-medium text-text-subtle">
                Previous failures ({previousFailures.length})
              </p>
              <ul className="m-0 list-none p-0">
                {previousFailures.map((p) => (
                  <li key={p.id}>
                    <a
                      href={`/recovery/payments/${p.id}`}
                      className="flex items-center justify-between border-b border-border-sub py-1.5 no-underline"
                    >
                      <span className="text-micro text-text-subtle">{formatTimeAgo(p.detectedAt, nowMs)}</span>
                      <span className="flex items-center gap-2">
                        <Pill variant="outline">{declineWord(p.declineCategory)}</Pill>
                        <span className={`font-mono text-micro ${statusValueClass(p.status)}`}>
                          {formatMoney(p.amountCents, p.currency)}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Panel>
      </div>

      {/* The Outcome card has no Recova counterpart and stays beside Recova's
          success banner, distinct from every other card (approved 2026-08-10).
          It is the receipt for the attribution fee. */}
      <div className="mb-5 rounded-lg border border-brand bg-brand-bg p-4">
        <h2 className="m-0 font-mono text-micro uppercase tracking-wide text-brand-text">Outcome</h2>
        {recovery ? (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={PILL_TONE[recoveryLifecycleTone(recovery)]}>
                {RECOVERY_LIFECYCLE_LABELS[recoveryLifecycleStatus(recovery)]}
              </Pill>
            </div>
            {attributionKind ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-micro uppercase tracking-wide text-text-secondary">Attribution</span>
                <Pill variant="outline">
                  {ATTRIBUTION_KIND_LABELS[attributionKind]}
                  {attributionKind === "stripe_baseline" ? " - FREE" : ""}
                </Pill>
                {creditedStep ? (
                  <span className="text-label text-text-secondary">Credited to {creditedStep.label}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="m-0 mt-2 text-label text-text-secondary">Still in recovery, no outcome yet.</p>
        )}
      </div>

      {/* Recova's recovery timeline, PaymentDetailClient.tsx 423-571. */}
      <div className="mb-5">
        <Panel title="Recovery timeline" src={`${executedSteps.length} of ${steps.length} steps executed`} flush>
          {steps.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="m-0 text-label text-text-subtle">No recovery steps scheduled</p>
            </div>
          ) : (
            <ol className="m-0 list-none p-0 py-2">
              {steps.map((step) => {
                const executed = step.executedAt !== null;
                const pending = !executed && step.result === null;
                const email = isEmailStep(step.stepType);
                // Recova's gate for the per-step engagement row (540): an
                // executed email step that did not fail to send.
                const showEngagement = executed && email && step.result !== "email_failed";
                const showExpander = executed && step.previewHtml !== null;
                const expanded = expandedStepId === step.id;
                return (
                  <li key={step.id} className="flex gap-4 border-b border-border px-6 py-4 last:border-0">
                    <StepGlyph executed={executed} isEmail={email} tone={stepResultTone(step.result)} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="text-label font-medium text-text">{step.label}</span>
                          <Pill tone={PILL_TONE[stepResultTone(step.result)]}>
                            {stepResultWords(step.result, executed)}
                          </Pill>
                        </div>
                        <span className="whitespace-nowrap font-mono text-micro text-text-subtle">
                          {executed
                            ? formatTimeAgo(step.executedAt, nowMs)
                            : pending
                              ? formatRelativeFuture(step.scheduledAt, nowMs)
                              : ""}
                        </span>
                      </div>
                      {email && step.aiSubject ? (
                        <p className="m-0 mb-1 text-micro text-text-subtle">&quot;{step.aiSubject}&quot;</p>
                      ) : null}
                      <p className="m-0 text-micro text-text-subtle">
                        {executed
                          ? `Executed ${formatDateShort(step.executedAt)}`
                          : `Scheduled ${formatDateShort(step.scheduledAt)}`}
                      </p>

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
                                {step.openedAt ? `Opened ${formatTimeAgo(step.openedAt, nowMs)}` : "Not opened"}
                              </span>
                              {/* A suspect click is shown as what it is (377(4)):
                                  something fetched the link, and it is not billed. */}
                              <span
                                className={`inline-flex items-center gap-1 text-micro ${
                                  step.clickedAt && !step.clickSuspectReason ? "text-green" : "text-text-subtle"
                                }`}
                              >
                                {step.clickedAt && !step.clickSuspectReason ? (
                                  <Check className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                                ) : (
                                  <Circle className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                                )}
                                {step.clickedAt
                                  ? step.clickSuspectReason
                                    ? `Clicked ${formatTimeAgo(step.clickedAt, nowMs)}, not counted (${clickSuspectLabel(step.clickSuspectReason)})`
                                    : `Clicked ${formatTimeAgo(step.clickedAt, nowMs)}`
                                  : "Not clicked"}
                              </span>
                            </>
                          ) : null}
                          {showExpander ? (
                            <span className="text-micro">
                              <button
                                type="button"
                                className="cap-link-btn"
                                aria-expanded={expanded}
                                onClick={() => setExpandedStepId(expanded ? null : step.id)}
                              >
                                {expanded ? "Hide email" : "View email"}
                                <ChevronDown
                                  className={`ml-1 h-3 w-3 ${expanded ? "rotate-180" : ""}`}
                                  strokeWidth={1.5}
                                  aria-hidden="true"
                                />
                              </button>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {step.previewHtml && expanded ? (
                        <div
                          className="mt-3 rounded-lg border border-border bg-bg p-4 text-label text-text"
                          // Sanitized in the loader by sanitizeEmailPreviewHtml;
                          // the raw body is never sent to the browser.
                          dangerouslySetInnerHTML={{ __html: step.previewHtml }}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>

      {/* Recova's internal notes, 573-597, hidden in the demo as Recova hides
          it. Saved in place through a fetcher, so the page does not move. */}
      {!isDemo ? (
        <div className="mb-5">
          <Panel title="Internal notes">
            <noteFetcher.Form method="post">
              <input type="hidden" name="intent" value="note" />
              <textarea
                name="note"
                className="cap-input"
                aria-label="Internal notes for this payment"
                defaultValue={failedPayment.notes ?? ""}
                placeholder="Add a note about this payment or customer..."
                rows={3}
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  className="cap-btn"
                  data-variant="primary"
                  aria-disabled={noteSaving ? true : undefined}
                  onClick={(e) => {
                    if (noteSaving) e.preventDefault();
                  }}
                >
                  {noteSaving ? "Saving..." : "Save note"}
                </button>
                <span role="status" className="text-micro">
                  {noteSaved ? (
                    <span className="inline-flex items-center gap-1 text-green">
                      Saved <Check className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                    </span>
                  ) : noteError ? (
                    <span className="text-error-text">Could not save note. Please try again.</span>
                  ) : null}
                </span>
              </div>
            </noteFetcher.Form>
          </Panel>
        </div>
      ) : null}

      {/* Recova's recovery success banner, 599-612, last on the page: only when
          the status is recovered AND a recovery row exists. */}
      {failedPayment.status === "recovered" && recovery ? (
        <Banner
          tone="ok"
          title="Payment recovered"
          actions={
            <span className="font-mono text-title font-bold">
              {formatMoney(recovery.amountCents, recovery.currency)}
            </span>
          }
        >
          {formatMoney(recovery.amountCents, recovery.currency)} recovered via{" "}
          {recoveredViaWords((recovery.attributionKind as AttributionKind) ?? "stripe_baseline")} &middot;{" "}
          {formatTimeAgo(recovery.recoveredAt, nowMs)}
        </Banner>
      ) : null}
    </div>
  );
}

/**
 * Recova's timeline node, PaymentDetailClient.tsx 452-463: a 32px round node with
 * an envelope on an email step and a repeat glyph on a retry, tinted by the
 * result once executed and grey while pending. The glyphs are drawn icons, not
 * Recova's text symbols (approved 2026-08-15). The node reads the same tone as
 * the result chip beside it, so the two always agree. Capsomer has no timeline
 * node; this is the page's own until it does.
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
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${skin}`}>
      <Glyph className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

/** Recova's Row, PaymentDetailClient.tsx 676-693: the label left, the value right
 *  and cut to 200px, ids small and mono. */
function DetailRow({
  label,
  value,
  mono,
  small,
  valueClass,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border-sub py-2 last:border-0">
      <dt className="shrink-0 text-micro text-text-subtle">{label}</dt>
      <dd
        className={`m-0 ml-3 max-w-[200px] truncate text-right ${small ? "text-micro" : "text-label"} ${
          mono ? "font-mono" : ""
        } ${valueClass ?? "text-text"}`}
      >
        {value}
      </dd>
    </div>
  );
}
