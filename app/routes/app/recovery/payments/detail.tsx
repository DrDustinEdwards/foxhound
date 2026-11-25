import { Icon, iconArrowRight, iconCheck, iconShield } from "capsomer/react/icons";
import { relative, toMs } from "capsomer/behavior/time";
import { useId } from "react";

import { data, useFetcher, useNavigation, useRouteLoaderData } from "react-router";
import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import { CopyButton } from "capsomer/react/copy";
import { Pill } from "capsomer/react/status";
import { useShownFor } from "capsomer/react/hooks";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/copy.css";
import "capsomer/disclosure.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/link.css";
import "~/site-header.css";

import { accountScope } from "~/lib/auth/context";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { FAILED_PAYMENT_STATUS_LABELS, failedPaymentStatusTone } from "~/lib/recovery/labels";
import {
  ACTION_LABELS,
  ACTION_SUCCESS_CLEAR_MS,
  ACTIONS_VISIBLE_STATUS,
  BACK_LINK_DEMO,
  BACK_LINK_REAL,
  MANUAL_ACTIONS,
  NOTE_SAVED_CLEAR_MS,
  isNotice,
  PILL_TONE,
  actionSuccessNotice,
  isDetailActionIntent,
  recoveredViaWords,
  visibleActionResult,
} from "~/lib/recovery/payment-detail";
import { paymentStepLabel } from "~/lib/recovery/payments-list.server";
import { lastResendableEmailStep, nextPendingStep } from "~/lib/recovery/step-state";
import { getFailedPaymentDetail } from "~/lib/recovery/queries.server";
import { dispatchManualAction, moneyWriteCommit } from "~/lib/recovery/manual-actions.server";
import { resendDepsFor, triggerDepsFor } from "~/lib/recovery/manual-action-deps.server";
import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";
import { recommendOneCustomer } from "~/lib/intelligence/recommendations.server";
import { RecommendationBanner } from "~/components/recommendation-banner";
import type { AttributionKind } from "~/lib/constants";
import type { loader as appShellLoader } from "~/layouts/app-shell";

import type { Route } from "./+types/detail";
import {
  PaymentActionBar,
  PaymentFactPanels,
  PaymentTiles,
  OutcomePanel,
} from "~/components/payment-detail-parts";
import { RecoveryTimeline } from "~/components/payment-timeline";
import { noindexMeta } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

export const meta = noindexMeta("Payment detail - Foxhound");

export async function loader({ context, params }: Route.LoaderArgs) {
  const { auth, db } = accountScope(context);
  const detail = await getFailedPaymentDetail(db, auth.membership.accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  const category = detail.failedPayment.declineCategory;
  // The two action gates, computed from the same selectors the server dispatcher gates on (step-state.ts), so the buttons offered and the POSTs accepted cannot drift. The trigger button names the step it will fire (paymentStepLabel).
  const next = nextPendingStep(detail.steps);
  const nextStepLabel = next ? paymentStepLabel(category, next.stepType) : null;
  const canResend = lastResendableEmailStep(detail.steps) !== null;
  // Sanitize SERVER-SIDE through the helper the sequences preview uses and send ONLY the sanitized body. The timeline is ordered by scheduled time, so a resend, which has no step number, sits last.
  const steps = [...detail.steps]
    .sort(
      (a, b) =>
        a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
        (a.stepNumber ?? 0) - (b.stepNumber ?? 0),
    )
    .map(({ aiBodyHtml, ...step }) => ({
      ...step,
      label: paymentStepLabel(category, step.stepType),
      previewHtml: aiBodyHtml ? sanitizeEmailPreviewHtml(aiBodyHtml) : null,
    }));
  const nowMs = Date.now();
  // A read failure leaves the recommendation banner out rather than failing the page.
  const prediction = await recommendOneCustomer(
    db,
    auth.membership.accountId,
    detail.failedPayment.stripeCustomerId,
    nowMs,
  ).catch(() => null);
  return { ...detail, steps, nextStepLabel, canResend, nowMs, prediction };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const { env, auth, db } = accountScope(context);
  const form = await readForm(request, BODY_MAX_BYTES);
  const intent = form.get("intent");

  // The dispatcher owns scoping and preconditions (manual-actions.server.ts); accountId is the session's, never the form's.
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
    // The whole error goes to the log, never to the page.
    console.error("payment detail action failed", err);
    const error = isDetailActionIntent(intent)
      ? `${ACTION_LABELS[intent]} failed`
      : intent === "note"
        ? "Failed to save note"
        : "Action failed";
    return data({ error, intent: typeof intent === "string" ? intent : null }, { status: 500 });
  }

  if (outcome.ok) {
    if (outcome.intent === "note")
      return data({ notice: "Note saved", intent: "note" }, { status: 200 });
    return data(
      {
        notice: actionSuccessNotice(
          outcome.intent,
          outcome.intent === "trigger"
            ? { action: outcome.action, result: outcome.result }
            : undefined,
        ),
        intent: outcome.intent,
      },
      { status: 200 },
    );
  }

  // Each reason the dispatcher can return has a case below, and the default is a typed exhaustiveness check, so a NEW reason is a compile error here instead of a string a merchant reads.
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
      // Executing a step is processing, so a paused or braked account refuses here exactly as the cron would skip it.
      return data({ error: "Recovery processing is paused for this account." }, { status: 409 });
    case "customer_unsubscribed":
      return data({ error: "Customer has unsubscribed from emails" }, { status: 409 });
    case "live_sends_disabled":
      // Honest rather than a silent success, because nothing was mailed (the live-send flag is off).
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
      return data(
        { error: `Step failed${outcome.result ? `: ${outcome.result}` : ""}` },
        { status: 502 },
      );
    case "already_resolved":
      // Same status code as a plain success, but an honest sentence: telling the merchant a resolved payment was just acted on would be untrue.
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
          error:
            outcome.intent === "note"
              ? "Failed to save note"
              : outcome.intent === "mark_recovered"
                ? "Could not mark this payment recovered. Please try again."
                : "Could not stop recovery. Please try again.",
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
    prediction,
  } = loaderData;
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  const isDemo = Boolean(shell?.isDemo);
  const backLink = isDemo ? BACK_LINK_DEMO : BACK_LINK_REAL;
  const demoReasonId = useId();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const pressedIntent = navigation.formData?.get("intent") ?? null;

  const [shownActionData] = useShownFor(actionData, ACTION_SUCCESS_CLEAR_MS, isNotice);
  const actionResult = visibleActionResult({
    actionData: shownActionData,
    pendingIntent: pressedIntent,
  });

  const noteFetcher = useFetcher<typeof action>();
  const noteSaving = noteFetcher.state !== "idle";
  const noteResult = noteFetcher.data;
  const [shownNote] = useShownFor(noteResult, NOTE_SAVED_CLEAR_MS, isNotice);
  const noteSaved = Boolean(shownNote && isNotice(shownNote));
  const noteError = noteResult && "error" in noteResult;

  const actionsVisible = failedPayment.status === ACTIONS_VISIBLE_STATUS;
  const visibleActions = MANUAL_ACTIONS.filter(
    (a) => a.needs === null || (a.needs === "nextStep" ? nextStepLabel !== null : canResend),
  ).map((a) => ({
    ...a,
    label: a.intent === "trigger" ? `Trigger ${nextStepLabel} now` : a.label,
  }));

  return (
    <div className="fh-payment">
      {/* Recova's width and padding, PaymentDetailClient.tsx 227:
          max-w-[1000px] mx-auto px-8 py-10, flat at every width. */}

      {/* Recova's back link and bare header, PaymentDetailClient.tsx 230-271:
          no box, the name with the open-dispute badge, the email line, and the
          status pill top right. */}
      <header className="fh-payment-header">
        <Link to={backLink.href} className="fh-payment-back fh-small fh-faint">
          &larr; {backLink.label}
        </Link>
        <div className="fh-payment-top">
          <div className="cap-shrink">
            <div className="cap-cluster fh-payment-badges" data-gap="3">
              <h1 className="fh-title fh-medium fh-text">
                {failedPayment.customerName ?? failedPayment.customerEmail}
              </h1>
              {/* The open-dispute badge, gated on the live dispute predicate
                  alone. */}
              {openDisputes.length > 0 ? (
                <Pill variant="outline" href={`/disputes/${openDisputes[0].id}`}>
                  <Icon d={iconShield} className="fh-icon-12 fh-icon-fine" />
                  {openDisputes.length === 1
                    ? "1 open dispute"
                    : `${openDisputes.length} open disputes`}
                  <Icon d={iconArrowRight} className="fh-icon-12 fh-icon-fine" />
                </Pill>
              ) : null}
            </div>
            <div className="cap-cluster fh-small fh-faint" data-gap="4">
              {/* The email shows here only when a name took the heading. */}
              {failedPayment.customerName ? <span>{failedPayment.customerEmail}</span> : null}
              <CopyButton text={failedPayment.customerEmail} size="xs">
                Copy email
              </CopyButton>
              {failedPayment.planName ? <span>&middot; {failedPayment.planName}</span> : null}
            </div>
          </div>
          <Pill tone={PILL_TONE[failedPaymentStatusTone(failedPayment.status)]}>
            {FAILED_PAYMENT_STATUS_LABELS[failedPayment.status] ?? failedPayment.status}
          </Pill>
        </div>
      </header>

      {/* Recova's IntegrityLayerBanner, PaymentDetailClient.tsx 274. */}
      <RecommendationBanner prediction={prediction} surface="recovery" nowMs={nowMs} />

      {/* Recova's action result banner, PaymentDetailClient.tsx 277-287. */}
      {actionResult ? (
        <div className="fh-payment-block">
          <Banner tone={actionResult.tone}>{actionResult.message}</Banner>
        </div>
      ) : null}

      {/* Recova's action buttons, PaymentDetailClient.tsx 289-327: only while
          the payment is active; in the demo the same buttons,
          disabled and titled as Recova's are. */}
      <PaymentActionBar
        isDemo={isDemo}
        actionsVisible={actionsVisible}
        visibleActions={visibleActions}
        busy={busy}
        pressedIntent={pressedIntent}
        demoReasonId={demoReasonId}
        failedPayment={failedPayment}
      />

      {/* Recova's four info cards, PaymentDetailClient.tsx 362-368. Capsomer has
          no plain stat card (its tile is always a link), so each is a small
          Panel, as on the payments list. */}
      <PaymentTiles
        failedPayment={failedPayment}
        estimatedLtvCents={estimatedLtvCents}
        nowMs={nowMs}
      />

      {/* Recova's Decline details and Email engagement cards, 371-421. */}
      <PaymentFactPanels
        failedPayment={failedPayment}
        steps={steps}
        recovery={recovery}
        previousFailures={previousFailures}
        nowMs={nowMs}
      />

      {/* The Outcome card has no Recova counterpart and stays beside Recova's
          success banner, distinct from every other card (approved 2026-08-10).
          It is the receipt for the attribution fee. */}
      <OutcomePanel recovery={recovery} steps={steps} />

      {/* Recova's recovery timeline, PaymentDetailClient.tsx 423-571. */}
      <RecoveryTimeline steps={steps} nowMs={nowMs} />

      {/* Recova's internal notes, 573-597, hidden in the demo as Recova hides
          it. Saved in place through a fetcher, so the page does not move. */}
      {!isDemo ? (
        <div className="fh-payment-block">
          <Panel title="Internal notes">
            <noteFetcher.Form method="post">
              <input type="hidden" name="intent" value="note" />
              <textarea
                name="note"
                className="cap-input"
                aria-label="Internal notes for this payment"
                defaultValue={failedPayment.notes ?? ""}
                placeholder="Add a note"
                rows={3}
              />
              <div className="cap-cluster fh-payment-pull-gap" data-gap="4">
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
                <span role="status" className="fh-tiny">
                  {noteSaved ? (
                    <span className="fh-payment-saved fh-green">
                      Saved <Icon d={iconCheck} className="fh-icon-12 fh-icon-fine" />
                    </span>
                  ) : noteError ? (
                    <span className="fh-error">Could not save note. Please try again.</span>
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
            <span className="fh-mono fh-title fh-bold">
              {formatMoney(recovery.amountCents, recovery.currency)}
            </span>
          }
        >
          {formatMoney(recovery.amountCents, recovery.currency)} recovered via{" "}
          {recoveredViaWords((recovery.attributionKind as AttributionKind) ?? "stripe_baseline")}{" "}
          &middot; {relative(toMs(recovery.recoveredAt), nowMs, "UTC")}
          {/* Only once Stripe's balance transaction has been read. Billing stays
              on the gross amount above. */}
          {recovery.netAmountCents != null && recovery.netCurrency ? (
            <span className="fh-payment-tile-note fh-line fh-small fh-soft">
              Net after Stripe fees {formatMoney(recovery.netAmountCents, recovery.netCurrency)}
            </span>
          ) : null}
        </Banner>
      ) : null}
    </div>
  );
}
