import { DISPUTE_EVIDENCE_ALLOWED_TYPES, DISPUTE_EVIDENCE_MAX_FILES, DISPUTE_EVIDENCE_MAX_SIZE_BYTES, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import * as Sentry from "@sentry/cloudflare";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { Form, Link, data, redirect, useFetcher, useNavigation } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/select.css";
import "capsomer/status.css";
// Capsomer's tokens and the teal family, which the components above read, as
// the disputes list and the payment pages load them.
import "~/site-header.css";

import { SYNC_DETAIL_COPY, SYNC_RESULT_MESSAGES, SyncDisputeLink } from "~/components/sync-dispute-link";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { disputeFeeCents } from "~/lib/billing/fees";
import type { DisputeState } from "~/lib/constants";
import { ACCEPT_APPROVED_MESSAGE, acceptDispute } from "~/lib/disputes/accept.server";
import { canApprove } from "~/lib/disputes/approval";
import {
  ACCEPT_CONFIRM_LINE,
  ACCEPT_UNAVAILABLE_APPROVED_LINE,
  BACK_LINK_DEMO,
  BACK_LINK_REAL,
  CUSTOMER_IP_FIELD,
  NARRATIVE_FIELD,
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_FIELD,
  SHIPPING_DATE_FIELD,
  SHIPPING_TRACKING_FIELD,
  UNSAVED_APPROVE_LINE,
  deadlineRemaining,
  disputeFeeTerms,
  draftAfter,
  draftDirty,
  evidenceFieldLabel,
  outcomeWord,
  splitEvidence,
} from "~/lib/disputes/detail";
import {
  EVIDENCE_DELETE_FORM_ID,
  EVIDENCE_FILE_FIELD,
  EVIDENCE_FILE_MESSAGES,
  EVIDENCE_FILE_REMOVE_CONFIRM,
  EVIDENCE_FILE_STATUS,
  EVIDENCE_FILES_LIMITS_LINE,
  EVIDENCE_FILES_UNAVAILABLE_LINE,
  EVIDENCE_UPLOAD_FORM_ID,
  evidenceFileHref,
  fileNameFromPath,
  precheckEvidenceFile,
  type EvidenceFileOutcome,
} from "~/lib/disputes/evidence-files";
import { deleteEvidenceFile, uploadEvidenceFile } from "~/lib/disputes/evidence-files.server";
import { getDisputeFindings } from "~/lib/disputes/findings.server";
import {
  daysUntilDeadline,
  deadlineClassName,
  deadlineUrgency,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import { importDisputeFromStripe } from "~/lib/disputes/manual-import.server";
import {
  approveAndSubmitDispute,
  getConnectionAccessToken,
  getDisputeDetail,
  readDisputeSettings,
  saveDisputeDraft,
} from "~/lib/disputes/queries.server";
import { buildDisputeTimeline } from "~/lib/disputes/timeline";
import { formatDateShort, formatTimestamp } from "~/lib/date-format";
import { formatMoney } from "~/lib/money-format";
import { FAILED_PAYMENT_STATUS_LABELS } from "~/lib/recovery/labels";
import { declineWord } from "~/lib/recovery/payments-list";

import type { Route } from "./+types/detail";

// /disputes/:id (J77, row S14): Recova's dispute page on Foxhound's engine.
// Recova is the spec, read whole at HEAD: app/(app)/disputes/[id]/page.tsx
// (a9452f59), DisputeDetailClient.tsx (3d56b55d), and components/disputes/
// DisputeActionBar (c73b381a), DisputeEvidenceSummary (96ba82d4),
// DisputeFileUploads (1286eb21), DisputeSyncForm (f0f1ee7d), formatters
// (81bf7f8b), timeline (04fbe976) and types (9ffb7b8e). In Recova's order: the
// back link, the header, the timeline, what Foxhound found, the staged
// evidence, the additional evidence, the sync form, and the approve card where
// Recova's action bar sits. Look is Capsomer's (Q10), teal (Q11).
//
// Not built, and why:
// - Recova's triage banner and Integrity layer banner: nothing in Foxhound
//   writes triage_* or a banded prediction (RULES.md 3.18).
// - Radar, AVS, CVV, 3D Secure, Smart Disputes, billing address, prior charge
//   history and subscription: no Foxhound code writes those dispute columns.
// Built by J07 (job_7a7c09269012):
// - Evidence files: Recova's DisputeFileUploads section between Staged evidence
//   and Additional evidence, over the EVIDENCE R2 bucket
//   (app/lib/disputes/evidence-files.server.ts) and the account-scoped view at
//   /disputes/:id/files/:fileId. Until Dustin binds the bucket the section says
//   uploads are not available yet, in the upload control's place.
// Built by J06 (job_4f4c9c2f5383):
// - Shipping fields: Recova shows them in Additional evidence when the account
//   ships physical goods, which /settings/disputes (S32) now writes. They save
//   with the draft as Stripe's shipping evidence fields.
// - Accept dispute: Recova's two-step "Accept dispute", "Yes, accept", "Cancel"
//   beside the submit control, closing the dispute at Stripe and resolving it
//   lost with no fee (app/lib/disputes/accept.server.ts), then back to the list
//   as Recova's router.push('/disputes/dashboard').
// - Auto-submit: never built (RULES.md 5.6).
// - Recova's sticky action bar: Foxhound's approve-and-submit card stands in
//   its place ("The dispute page has an approve-and-submit card", approved
//   2026-08-28).

export function meta() {
  return [{ title: "Dispute detail - Foxhound" }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const detail = await getDisputeDetail(db, accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  const [findings, settings] = await Promise.all([
    getDisputeFindings(db, accountId, detail.dispute.stripeCustomerId),
    readDisputeSettings(db, accountId),
  ]);
  return {
    ...detail,
    findings,
    shipsPhysical: settings.shipsPhysical,
    filesAvailable: Boolean(env.EVIDENCE),
    isDemo: auth.isDemo,
    nowMs: Date.now(),
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const detail = await getDisputeDetail(db, accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });

  // No post to this page is near one evidence file's size except an upload, so
  // a body far past it is refused before it is read into memory (J07).
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > DISPUTE_EVIDENCE_MAX_SIZE_BYTES + UPLOAD_BODY_SLACK_BYTES) {
    return fileResult("upload_file", "file_too_large", 413);
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save") {
    if (!canApprove(detail.dispute.state as DisputeState)) {
      return data(
        { error: "This dispute has already been submitted; evidence is locked.", intent: "save" as const },
        { status: 409 },
      );
    }
    // Once a merchant has approved, the evidence that approval attests is never
    // rewritten here, even while the state is still approvable (a submission in
    // flight, rejected by Stripe, or unconfirmed). saveDisputeDraft carries the
    // same guard inside each write, so a race past this read writes nothing.
    if (detail.approval) {
      return data(
        { error: "This dispute has been approved, so its evidence is locked.", intent: "save" as const },
        { status: 409 },
      );
    }
    const fields = [
      { fieldName: NARRATIVE_FIELD, fieldValue: form.get("narrative") },
      { fieldName: CUSTOMER_IP_FIELD, fieldValue: form.get("customer_ip") },
      // Present only when the shipping inputs are on the page (S32's setting).
      { fieldName: SHIPPING_TRACKING_FIELD, fieldValue: trimmed(form.get(SHIPPING_TRACKING_FIELD)) },
      { fieldName: SHIPPING_CARRIER_FIELD, fieldValue: carrier(form.get(SHIPPING_CARRIER_FIELD)) },
      { fieldName: SHIPPING_DATE_FIELD, fieldValue: trimmed(form.get(SHIPPING_DATE_FIELD)) },
    ]
      // A field the form did not carry is left as it is.
      .filter((f): f is { fieldName: string; fieldValue: string } => typeof f.fieldValue === "string")
      .map((f) => ({ fieldName: f.fieldName, fieldValue: f.fieldName === CUSTOMER_IP_FIELD ? f.fieldValue.trim() : f.fieldValue }));
    let written: boolean;
    try {
      written = await saveDisputeDraft(db, accountId, detail.dispute.id, detail.evidence, fields, new Date());
    } catch (err) {
      // Recova's line beside Save draft is "Could not save."; the whole error
      // goes to the log, never to the page.
      console.error("dispute draft save failed", err);
      return data({ error: "Could not save.", intent: "save" as const }, { status: 500 });
    }
    // A guarded write that changed nothing (an approval or another session's
    // save got there between this read and the write) is reported, never
    // "Saved." (RULES.md 3.9). The result is not ok, so the page keeps the
    // draft unsaved and Approve held.
    if (!written) {
      return data(
        {
          error: "Your draft was not saved: this dispute changed. Reload to see the current evidence.",
          intent: "save" as const,
        },
        { status: 409 },
      );
    }
    return data({ ok: true, intent: "save" as const });
  }

  if (intent === "upload_file" || intent === "delete_file") {
    // Recova's upload-evidence and delete-evidence (J07). The dispute was read
    // under the signed-in account above, so another account's dispute is
    // already a 404. With no bucket bound, the answer says so first.
    if (!env.EVIDENCE) return fileResult(intent, "uploads_unavailable");
    if (!canApprove(detail.dispute.state as DisputeState) || detail.approval) {
      return fileResult(intent, "evidence_locked");
    }
    const outcome =
      intent === "upload_file"
        ? await uploadEvidenceFile(db, env.EVIDENCE, {
            accountId,
            disputeId: detail.dispute.id,
            file: form.get("file"),
            now: new Date(),
          })
        : await deleteEvidenceFile(db, env.EVIDENCE, {
            accountId,
            disputeId: detail.dispute.id,
            evidenceId: String(form.get("evidence_id") ?? ""),
          });
    return fileResult(intent, outcome);
  }

  if (intent === "sync_dispute") {
    // Recova's DisputeSyncForm: the same manual import the disputes list runs,
    // on the signed-in account's own Stripe connection.
    const posted = form.get("stripe_dispute_id");
    try {
      const result = await importDisputeFromStripe(env, accountId, typeof posted === "string" ? posted : "", new Date());
      return data({ sync: SYNC_RESULT_MESSAGES[result.status] });
    } catch (err) {
      console.error("dispute sync failed", err);
      return data({ sync: { ok: false, message: "Could not import the dispute. Please try again." } }, { status: 500 });
    }
  }

  if (intent === "accept_confirm") {
    // Accept's first step without script: the page shows the confirmation.
    // With script the button opens it in place and never posts this.
    return data({ acceptConfirm: true as const, intent: "accept_confirm" as const });
  }

  if (intent === "accept") {
    // Recova's /api/disputes/accept: refuse a dispute that is no longer open,
    // close it at Stripe, then write the accepted state and its outcome.
    if (!canApprove(detail.dispute.state as DisputeState)) {
      return data({ error: "This dispute is already closed or submitted.", intent: "accept" as const }, { status: 409 });
    }
    // Not while an approval stands (PR 149 review): its submission is in
    // flight, rejected or unconfirmed, and a concession would race it.
    if (detail.approval) {
      return data({ error: ACCEPT_APPROVED_MESSAGE, intent: "accept" as const }, { status: 409 });
    }
    const token = detail.dispute.stripeConnectionId
      ? await getConnectionAccessToken(db, detail.dispute.stripeConnectionId)
      : null;
    if (!token) {
      return data({ error: "No connected Stripe account for this dispute.", intent: "accept" as const }, { status: 409 });
    }
    try {
      const result = await acceptDispute(env, {
        accountId,
        disputeId: detail.dispute.id,
        stripeDisputeId: detail.dispute.stripeDisputeId,
        state: detail.dispute.state,
        amountCents: detail.dispute.amountCents,
        currency: detail.dispute.currency,
        connectionAccessToken: token,
        acceptedAt: new Date(),
        hasApproval: Boolean(detail.approval),
      });
      if (result.status === "error") {
        return data({ error: result.message, intent: "accept" as const }, { status: 400 });
      }
    } catch (err) {
      console.error("dispute accept failed", err);
      Sentry.captureException(err, { extra: { scope: "dispute-accept", disputeId: detail.dispute.id } });
      return data(
        { error: "Accept failed. Check this dispute in Stripe before trying again.", intent: "accept" as const },
        { status: 500 },
      );
    }
    // Recova: router.push('/disputes/dashboard').
    return redirect(BACK_LINK_REAL.href);
  }

  if (intent === "approve") {
    // Re-check against a fresh read, never the form's own hidden state: this is
    // the schema-enforced gate (dispute_approvals is unique per dispute), the
    // app-level check here just fails fast with a readable message.
    if (!canApprove(detail.dispute.state as DisputeState)) {
      return data({ error: "This dispute has already been submitted.", intent: "approve" as const }, { status: 409 });
    }

    let resolvedToken: string | null = null;
    if (detail.dispute.stripeConnectionId) {
      resolvedToken = await getConnectionAccessToken(db, detail.dispute.stripeConnectionId);
    }
    if (!resolvedToken) {
      return data({ error: "No connected Stripe account for this dispute.", intent: "approve" as const }, { status: 409 });
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
        return data({ error: result.message, intent: "approve" as const }, { status: 400 });
      }
      return data({ ok: true, intent: "approve" as const });
    } catch (err) {
      // The throw can come before the Stripe call (the pending record, the
      // token) or after it (the confirmation write). In the second case Stripe
      // holds the submission while submitted_at did not land; the pending
      // approval record still exists, so billing safely under-counts until it
      // is reconciled, never over-bills. Either way the page cannot know which,
      // so it says so. The whole error goes to the log and to Sentry.
      console.error("dispute approve and submit failed", err);
      Sentry.captureException(err, {
        extra: { scope: "dispute-approve-and-submit", disputeId: detail.dispute.id },
      });
      return data(
        {
          error:
            "Something went wrong while submitting. Stripe may or may not have received the evidence, so check this dispute in Stripe before trying again.",
          intent: "approve" as const,
        },
        { status: 500 },
      );
    }
  }

  return data({ error: "Unknown action.", intent: null }, { status: 400 });
}

/** Room for the multipart framing around one evidence file. */
const UPLOAD_BODY_SLACK_BYTES = 64 * 1024;

/** A file path's answer: its named outcome, the merchant's line, and the
 *  outcome's status (J07). */
function fileResult(intent: "upload_file" | "delete_file", outcome: EvidenceFileOutcome, status?: number) {
  const message = EVIDENCE_FILE_MESSAGES[outcome];
  return data(
    message ? { intent, fileOutcome: outcome, error: message } : { intent, fileOutcome: outcome },
    { status: status ?? EVIDENCE_FILE_STATUS[outcome] },
  );
}

/** A posted text value, trimmed, or null when the form did not carry it. */
function trimmed(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" ? value.trim() : null;
}

/** The carrier select's value, held to Recova's list (blank is "Select"). */
function carrier(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  return (SHIPPING_CARRIERS as readonly string[]).includes(value) ? value : "";
}

export default function DisputeDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { dispute, evidence, approval, findings, shipsPhysical, filesAvailable, isDemo, nowMs } = loaderData;
  const navigation = useNavigation();
  const pressedIntent = navigation.formData?.get("intent") ?? null;
  const approving = navigation.state !== "idle" && pressedIntent === "approve";
  const accepting = navigation.state !== "idle" && pressedIntent === "accept";
  // Recova's acceptState: hidden until "Accept dispute", then the confirmation,
  // which stays open over a failed accept so its error sits beside it.
  const acceptFromAction =
    actionData !== undefined &&
    "intent" in actionData &&
    (actionData.intent === "accept_confirm" || actionData.intent === "accept");
  const [acceptOpen, setAcceptOpen] = useState(acceptFromAction);
  const [acceptCancelled, setAcceptCancelled] = useState(false);
  // A new accept result reopens the confirmation, adjusted during render (React's
  // "storing information from previous renders") rather than in an effect.
  const [seenActionData, setSeenActionData] = useState(actionData);
  if (seenActionData !== actionData) {
    setSeenActionData(actionData);
    if (acceptFromAction) setAcceptOpen(true);
  }
  const saveFetcher = useFetcher<typeof action>();
  const saving = saveFetcher.state !== "idle";
  // The save result: the fetcher's in a browser, or the action's after a
  // no-script post.
  const saveResult =
    saveFetcher.data ?? (actionData && "intent" in actionData && actionData.intent === "save" ? actionData : undefined);
  const approveError =
    actionData &&
    "error" in actionData &&
    actionData.intent !== "save" &&
    actionData.intent !== "upload_file" &&
    actionData.intent !== "delete_file"
      ? actionData.error
      : null;
  const syncResult = actionData && "sync" in actionData ? actionData.sync : undefined;

  const state = dispute.state as DisputeState;
  // Recova's gate: editable while the dispute awaits a response and nobody has
  // submitted, and never in the demo.
  const editable = !isDemo && canApprove(state);
  // The draft locks once an approval row exists (J77 review): the approval's
  // hash attests the saved evidence, so it is not edited after.
  const draftEditable = editable && !approval;
  const [draft, dispatchDraft] = useReducer(draftAfter, { edits: 0, submitted: 0, saved: 0 });
  const savedOk = saveFetcher.state === "idle" && saveFetcher.data !== undefined && "ok" in saveFetcher.data;
  useEffect(() => {
    if (savedOk) dispatchDraft({ type: "saved" });
  }, [savedOk, saveFetcher.data]);
  const dirty = draftDirty(draft);
  const resolved = isDisputeResolved(state);
  const outcome = outcomeWord(state);
  const fee = disputeFeeCents(dispute.amountCents, DISPUTE_FEE_CAP_CENTS);
  const days = daysUntilDeadline(dispute.evidenceDeadline, nowMs);
  const backLink = isDemo ? BACK_LINK_DEMO : BACK_LINK_REAL;
  const shippingEditable = draftEditable && shipsPhysical;
  const { structured, narrative, customerIp, shipping } = splitEvidence(evidence, draftEditable, shippingEditable);
  // The merchant's uploaded files have their own section (J07); "drafted" is
  // everything else, which is what Staged evidence speaks of.
  const files = evidence.filter((e) => e.fieldName === EVIDENCE_FILE_FIELD);
  const drafted = evidence.filter((e) => e.fieldName !== EVIDENCE_FILE_FIELD);
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
  });

  const saveControls = (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button
        type="submit"
        className="cap-btn"
        data-size="sm"
        aria-disabled={saving ? true : undefined}
        onClick={(e) => {
          if (saving) e.preventDefault();
        }}
      >
        {saving ? "Saving…" : "Save draft"}
      </button>
      <span role="status" className="text-micro">
        {saveResult && "ok" in saveResult ? (
          <Status tone="ok">Saved.</Status>
        ) : saveResult && "error" in saveResult ? (
          <Status tone="crit">{saveResult.error}</Status>
        ) : null}
      </span>
    </div>
  );

  return (
    <div className="mx-auto max-w-[960px] px-4 py-10 md:px-8">
      {/* Recova's main: max-w-[960px] mx-auto px-4 md:px-8 py-10. Its pb-28
          clears the sticky action bar, which Foxhound's approve card replaces. */}
      <Link
        to={backLink.href}
        className="mb-6 inline-flex min-h-6 items-center text-label text-text-tertiary no-underline hover:text-text"
      >
        {backLink.label}
      </Link>

      {/* 1. Recova's header: the amount large in the accent, the customer as the
          heading, the reason, and the days remaining or the outcome. */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-display font-bold leading-none text-brand-text">
            {formatMoney(dispute.amountCents, dispute.currency)}
          </div>
          <h1 className="m-0 mt-3 text-title font-medium text-text">{dispute.customerName || "Unknown customer"}</h1>
          <div className="mt-0.5 text-label text-text-subtle">{humanizeDisputeReason(dispute.reason)}</div>
        </div>
        <div className="text-right">
          {!resolved ? (
            <div className={`font-mono text-label ${deadlineClassName(deadlineUrgency(days))}`}>
              {deadlineRemaining(days)}
            </div>
          ) : null}
          {resolved && outcome ? <Pill tone={state === "resolved_won" ? "ok" : "crit"}>{outcome}</Pill> : null}
        </div>
      </header>

      {/* 3. Timeline. */}
      <div className="mb-6">
        <Panel title="Timeline">
          <ol className="m-0 list-none space-y-2 p-0">
            {timeline.map((item, i) => (
              <li key={i} className="flex items-baseline gap-4">
                <span className="w-[140px] shrink-0 font-mono text-micro text-text-subtle">
                  {item.at ? formatTimestamp(item.at) : ""}
                </span>
                <span className="text-label text-text">{item.label}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      {/* 4. Recova's DisputeEvidenceSummary, over what Foxhound writes. */}
      <div className="mb-6">
        <Panel title="What Foxhound found">
          <div className="text-label">
            {findings.fraudDecline ? (
              <p className="m-0 mb-3">
                <Status tone="warn">
                  Fraud decline on record ({findings.fraudDecline.code ?? "fraud category"})
                </Status>
              </p>
            ) : null}

            <div className="mb-4">
              <h3 className="m-0 mb-2 text-micro font-medium text-text-secondary">Customer context</h3>
              <dl className="m-0 space-y-1">
                {dispute.customerName ? <FieldRow label="Name" value={dispute.customerName} /> : null}
                {dispute.customerEmail ? <FieldRow label="Email" value={dispute.customerEmail} /> : null}
                {findings.disputeHistory ? (
                  <FieldRow
                    label="Dispute history"
                    value={`${findings.disputeHistory.won} won · ${findings.disputeHistory.lost} lost`}
                  />
                ) : null}
              </dl>
            </div>

            {findings.recovery && findings.recovery.emails.length > 0 ? (
              <div className="mb-4">
                <h3 className="m-0 mb-2 text-micro font-medium text-text-secondary">Recovery email history</h3>
                <ul className="m-0 list-none space-y-1 p-0">
                  {findings.recovery.emails.map((e) => (
                    <li key={e.id} className="text-text">
                      <span className="text-text-tertiary">{formatDateShort(e.executedAt)}</span> {e.label}
                      {e.openedCount !== null && e.openedCount > 0 ? (
                        <span className="text-text-subtle"> · opened {e.openedCount}x</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {findings.recovery ? (
              <div className="mt-3 border-t border-border-sub pt-3">
                <h3 className="m-0 mb-2 text-micro uppercase tracking-widest text-text-tertiary">Recovery context</h3>
                <div className="space-y-1 text-text-secondary">
                  <div>
                    Decline category: <span className="text-text">{declineWord(findings.recovery.declineCategory)}</span>
                  </div>
                  <div>
                    Steps attempted: <span className="text-text">{findings.recovery.stepsAttempted}</span>
                  </div>
                  <div>
                    Sequence outcome:{" "}
                    <span className="text-text">
                      {FAILED_PAYMENT_STATUS_LABELS[findings.recovery.status] ?? findings.recovery.status}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </Panel>
      </div>

      {/* 5 and 7. Staged evidence and Additional evidence share Recova's one
          draft: Save draft saves the narrative and the Customer IP together. */}
      <saveFetcher.Form
        method="post"
        onChange={(e) => {
          // The evidence file input sits in this markup but belongs to the
          // upload form; choosing a file is not a draft edit.
          if ((e.target as HTMLInputElement).form === e.currentTarget) dispatchDraft({ type: "edit" });
        }}
        onSubmit={() => dispatchDraft({ type: "submit" })}
      >
        <input type="hidden" name="intent" value="save" />
        <div className="mb-6">
          <Panel title="Staged evidence">
            <div className="text-label">
              {drafted.length === 0 ? (
                // Recova said "Evidence is being prepared". Foxhound drafts at
                // intake and drafts nothing when no record grounds it
                // (draftDisputeEvidence), so nothing is on the way.
                <p className="m-0 text-text-subtle">Foxhound found no records for this charge to draft evidence from.</p>
              ) : (
                <>
                  {structured.length > 0 ? (
                    <dl className="m-0 mb-4 space-y-2">
                      {structured.map((f) => (
                        <FieldRow key={f.id} label={evidenceFieldLabel(f.fieldName)} value={f.fieldValue} />
                      ))}
                    </dl>
                  ) : null}
                  {!isDemo ? (
                    <div>
                      <label
                        htmlFor="dispute_evidence_narrative"
                        className="mb-2 block text-micro font-medium uppercase tracking-wide text-text-tertiary"
                      >
                        Evidence narrative (editable)
                      </label>
                      <textarea
                        id="dispute_evidence_narrative"
                        name={draftEditable ? "narrative" : undefined}
                        className="cap-input"
                        defaultValue={narrative}
                        readOnly={!draftEditable}
                        rows={10}
                      />
                      {draftEditable ? saveControls : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </Panel>
        </div>

        {/* 6. Recova's Evidence files (J07). Its controls belong to the upload
            and remove forms below, through the form attribute. */}
        <div className="mb-6">
          <EvidenceFiles
            disputeId={dispute.id}
            files={files}
            editable={draftEditable}
            available={filesAvailable}
          />
        </div>

        {draftEditable ? (
          <div className="mb-6">
            <Panel title="Additional evidence (optional)">
              <div className="text-label">
                <label htmlFor="dispute_customer_ip" className="cap-field-label">
                  Customer IP
                </label>
                <div className="mt-1">
                  <input
                    id="dispute_customer_ip"
                    name="customer_ip"
                    type="text"
                    className="cap-input"
                    defaultValue={customerIp}
                    placeholder="e.g. 198.51.100.14"
                    aria-describedby="dispute_customer_ip_help"
                  />
                </div>
                <p id="dispute_customer_ip_help" className="m-0 mt-1 text-micro text-text-subtle">
                  Only add if you have the actual IP from your own logs. Do not guess. Saved with your draft and
                  included when you submit.
                </p>
                {shippingEditable ? (
                  <div className="mt-4">
                    {/* Recova's three shipping inputs, one row of three on desktop. */}
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <div className="cap-field">
                        <label htmlFor="dispute_tracking_number" className="cap-field-label">
                          Tracking number
                        </label>
                        <input
                          id="dispute_tracking_number"
                          name={SHIPPING_TRACKING_FIELD}
                          type="text"
                          className="cap-input font-mono"
                          defaultValue={shipping[SHIPPING_TRACKING_FIELD]}
                          aria-describedby="dispute_shipping_help"
                        />
                      </div>
                      <div className="cap-field">
                        <label htmlFor="dispute_carrier" className="cap-field-label">
                          Carrier
                        </label>
                        <div className="cap-select-wrap">
                          <select
                            id="dispute_carrier"
                            name={SHIPPING_CARRIER_FIELD}
                            className="cap-select"
                            defaultValue={shipping[SHIPPING_CARRIER_FIELD]}
                            aria-describedby="dispute_shipping_help"
                          >
                            <option value="">Select</option>
                            {SHIPPING_CARRIERS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="cap-field">
                        <label htmlFor="dispute_ship_date" className="cap-field-label">
                          Ship date
                        </label>
                        <input
                          id="dispute_ship_date"
                          name={SHIPPING_DATE_FIELD}
                          type="date"
                          className="cap-input"
                          defaultValue={shipping[SHIPPING_DATE_FIELD]}
                          aria-describedby="dispute_shipping_help"
                        />
                      </div>
                    </div>
                    <p id="dispute_shipping_help" className="m-0 mt-2 text-micro text-text-subtle">
                      Saved with your draft and included when you submit.
                    </p>
                  </div>
                ) : null}
                {/* With no staged evidence Recova had no Save draft at all; the
                    IP still needs one to be kept. */}
                {drafted.length === 0 ? saveControls : null}
              </div>
            </Panel>
          </div>
        ) : null}
      </saveFetcher.Form>
      {draftEditable && filesAvailable ? <EvidenceFileForms /> : null}

      {/* Recova's DisputeSyncForm, withheld from the demo as Recova's is. */}
      {!isDemo ? <SyncDisputeLink result={syncResult} copy={SYNC_DETAIL_COPY} /> : null}

      {/* 8. Where Recova's action bar sits: Foxhound's approve-and-submit card
          (approved 2026-08-28), and once submitted, its approval record and
          fee receipt. */}
      {editable ? (
        <div className="mt-6">
          <Panel title="Approve and submit">
            <div className="text-label">
              <p className="m-0 text-text-secondary">
                Submitting this evidence to Stripe approves a fee of{" "}
                <span className="font-mono text-text">{formatMoney(fee, dispute.currency)}</span> ({disputeFeeTerms()}) if
                Foxhound wins this dispute. Merchant-fought or lost disputes are never billed.
              </p>
              {approveError ? (
                <div className="mt-3">
                  <Banner tone="crit">{approveError}</Banner>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Form method="post">
                  <input type="hidden" name="intent" value="approve" />
                  <ApproveButton
                    label={`Approve and submit (fee ${formatMoney(fee, dispute.currency)})`}
                    approving={approving}
                    dirty={dirty}
                  />
                </Form>
                {approval ? (
                  <p className="m-0 text-text-secondary">{ACCEPT_UNAVAILABLE_APPROVED_LINE}</p>
                ) : (
                  <AcceptControl
                    open={acceptOpen}
                    accepting={accepting}
                    returnFocus={acceptCancelled}
                    onOpen={() => {
                      setAcceptCancelled(false);
                      setAcceptOpen(true);
                    }}
                    onCancel={() => {
                      setAcceptCancelled(true);
                      setAcceptOpen(false);
                    }}
                  />
                )}
              </div>
            </div>
          </Panel>
        </div>
      ) : approval || resolved ? (
        <div className="mt-6">
          <Panel title="Approval">
            <div className="text-label">
              <p className="m-0 text-text-secondary">
                {approval
                  ? `Approved by ${approval.approvedByEmail} on ${formatTimestamp(approval.approvedAt)}`
                  : "No approval record."}
              </p>
              {resolved ? (
                <p className="m-0 mt-2 text-text">
                  {state === "resolved_won"
                    ? dispute.resolvedFeeCents != null
                      ? `Won. Fee of ${formatMoney(dispute.resolvedFeeCents, dispute.resolvedFeeCurrency ?? dispute.currency)} billed at the next monthly run.`
                      : "Won. No fee: this dispute was not submitted through Foxhound."
                    : "Lost. Not billed."}
                </p>
              ) : null}
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Approve button (J77 review). Approve submits the SAVED draft, so while
 * the page holds unsaved edits it is held back, focusable, with the reason in
 * visible text beside it, never a silent drop of the merchant's edits.
 */
export function ApproveButton({ label, approving, dirty }: { label: string; approving: boolean; dirty: boolean }) {
  const held = approving || dirty;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        className="cap-btn"
        data-variant="primary"
        aria-disabled={held ? true : undefined}
        aria-describedby={dirty ? "dispute_approve_unsaved" : undefined}
        onClick={(e) => {
          if (held) e.preventDefault();
        }}
      >
        {approving ? "Submitting…" : label}
      </button>
      {dirty ? (
        <span id="dispute_approve_unsaved" className="text-label text-text-secondary">
          {UNSAVED_APPROVE_LINE}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Recova's Accept (DisputeActionBar.tsx): "Accept dispute", then in its place
 * the line, "Yes, accept" and "Cancel". The first button posts a harmless
 * intent so the confirmation also works without script; with script it opens
 * in place. Focus follows the swap so a keyboard user is never left on a button
 * that has gone: opening lands on Cancel (never on "Yes, accept", so a second
 * Enter cannot concede the dispute), and Cancel returns to "Accept dispute".
 */
function AcceptControl({
  open,
  accepting,
  returnFocus,
  onOpen,
  onCancel,
}: {
  open: boolean;
  accepting: boolean;
  returnFocus: boolean;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const lineId = useId();
  if (!open) {
    return (
      <Form method="post">
        <input type="hidden" name="intent" value="accept_confirm" />
        <button
          type="submit"
          className="cap-btn"
          autoFocus={returnFocus}
          onClick={(e) => {
            e.preventDefault();
            onOpen();
          }}
        >
          Accept dispute
        </button>
      </Form>
    );
  }
  return (
    <Form method="post" className="flex flex-wrap items-center gap-2" aria-label="Accept this dispute">
      <input type="hidden" name="intent" value="accept" />
      <span id={lineId} className="text-label text-text-secondary">
        {ACCEPT_CONFIRM_LINE}
      </span>
      <button
        type="submit"
        className="cap-btn"
        data-variant="danger"
        data-size="sm"
        aria-describedby={lineId}
        aria-disabled={accepting ? true : undefined}
        onClick={(e) => {
          if (accepting) e.preventDefault();
        }}
      >
        {accepting ? "Accepting…" : "Yes, accept"}
      </button>
      <button
        type="button"
        className="cap-btn"
        data-variant="quiet"
        data-size="sm"
        aria-describedby={lineId}
        autoFocus
        onClick={onCancel}
      >
        Cancel
      </button>
    </Form>
  );
}

/** Recova's Row (formatters.tsx): the label in a 140px column, the value
 *  beside it. Multi-line evidence keeps its line breaks. */
function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <dt className="w-[140px] shrink-0 text-text-tertiary">{label}</dt>
      <dd className="m-0 flex-1 whitespace-pre-line text-text">{value}</dd>
    </div>
  );
}

/** The fetcher keys the evidence file section and its forms share (J07). */
const UPLOAD_FETCHER_KEY = "dispute-evidence-upload";
const DELETE_FETCHER_KEY = "dispute-evidence-delete";

/**
 * The upload and remove forms (J07), rendered after the draft form because
 * forms cannot nest. The section's file input and Remove file buttons belong
 * to them through the form attribute, so they sit where Recova shows them.
 */
function EvidenceFileForms() {
  const upload = useFetcher<typeof action>({ key: UPLOAD_FETCHER_KEY });
  const remove = useFetcher<typeof action>({ key: DELETE_FETCHER_KEY });
  return (
    <>
      <upload.Form id={EVIDENCE_UPLOAD_FORM_ID} method="post" encType="multipart/form-data" hidden>
        <input type="hidden" name="intent" value="upload_file" />
      </upload.Form>
      <remove.Form id={EVIDENCE_DELETE_FORM_ID} method="post" hidden>
        <input type="hidden" name="intent" value="delete_file" />
      </remove.Form>
    </>
  );
}

/**
 * Recova's DisputeFileUploads (1286eb21): the title with the limits line, an
 * "Upload file" control while fewer than five files are on the dispute, the
 * files by name and date with "Remove file", or "No files uploaded.". Choosing
 * a file uploads it at once, as Recova's onChange did, after Recova's own
 * checks; without script the Upload button beside it posts the same form.
 * Read-only once approved or submitted, and in the demo. With no bucket bound,
 * the upload control's place says so.
 */
function EvidenceFiles({
  disputeId,
  files,
  editable,
  available,
}: {
  disputeId: string;
  files: { id: string; fieldValue: string; createdAt: Date }[];
  editable: boolean;
  available: boolean;
}) {
  const upload = useFetcher<typeof action>({ key: UPLOAD_FETCHER_KEY });
  const remove = useFetcher<typeof action>({ key: DELETE_FETCHER_KEY });
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [precheck, setPrecheck] = useState<EvidenceFileOutcome | null>(null);
  const uploading = upload.state !== "idle";
  const canChange = editable && available;

  // A finished upload clears the chosen file, as Recova's did.
  const uploadDone = upload.state === "idle" && upload.data !== undefined;
  useEffect(() => {
    if (uploadDone && inputRef.current) inputRef.current.value = "";
  }, [uploadDone, upload.data]);

  const resultError = (d: unknown) =>
    d && typeof d === "object" && "fileOutcome" in d && "error" in d ? String((d as { error: unknown }).error) : null;
  const error = precheck ? EVIDENCE_FILE_MESSAGES[precheck] : (resultError(upload.data) ?? resultError(remove.data));

  let control: React.ReactNode = null;
  if (editable && !available) {
    control = <span className="text-micro text-text-subtle">{EVIDENCE_FILES_UNAVAILABLE_LINE}</span>;
  } else if (canChange && files.length < DISPUTE_EVIDENCE_MAX_FILES) {
    control = (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex rounded-md has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-(--ring) has-[:focus-visible]:outline-solid">
          <label htmlFor={inputId} className="cap-btn" data-size="sm" aria-disabled={uploading ? true : undefined}>
            {uploading ? "Uploading…" : "Upload file"}
          </label>
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          name="file"
          accept={DISPUTE_EVIDENCE_ALLOWED_TYPES.join(",")}
          form={EVIDENCE_UPLOAD_FORM_ID}
          className="sr-only"
          disabled={uploading}
          onChange={(e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            const refused = precheckEvidenceFile(file, files.length);
            setPrecheck(refused);
            if (refused) return;
            if (input.form) void upload.submit(input.form, { method: "post", encType: "multipart/form-data" });
          }}
        />
        <noscript>
          <button type="submit" form={EVIDENCE_UPLOAD_FORM_ID} className="cap-btn" data-size="sm">
            Upload
          </button>
        </noscript>
      </span>
    );
  }

  return (
    <Panel title="Evidence files" description={EVIDENCE_FILES_LIMITS_LINE} actions={control}>
      <div className="text-label">
        <div role="status" className="text-micro">
          {error ? <Status tone="crit">{error}</Status> : null}
        </div>
        {files.length === 0 ? (
          <p className="m-0 text-micro text-text-subtle">No files uploaded.</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {files.map((f) => {
              const name = fileNameFromPath(f.fieldValue);
              return (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-3 border-b border-border-sub py-1.5 last:border-b-0"
                >
                  {available ? (
                    <a
                      href={evidenceFileHref(disputeId, f.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-label text-brand-text hover:opacity-80"
                    >
                      {name}
                    </a>
                  ) : (
                    <span className="text-label text-text">{name}</span>
                  )}
                  <span className="flex items-center gap-3">
                    <span className="text-micro text-text-subtle">{formatDateShort(f.createdAt)}</span>
                    {canChange ? (
                      <button
                        type="submit"
                        form={EVIDENCE_DELETE_FORM_ID}
                        name="evidence_id"
                        value={f.id}
                        className="cap-btn"
                        data-variant="quiet"
                        data-size="sm"
                        aria-label={`Remove file ${name}`}
                        onClick={(e) => {
                          setPrecheck(null);
                          if (!window.confirm(EVIDENCE_FILE_REMOVE_CONFIRM)) e.preventDefault();
                        }}
                      >
                        Remove file
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
