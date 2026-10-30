// The dispute detail page's action (routes/app/disputes/detail.tsx split):
// approve, accept, evidence fields and files, sync and notes, each gated on the
// signed-in account owning the dispute.

import { DISPUTE_EVIDENCE_MAX_SIZE_BYTES, type DisputeState } from "~/lib/constants";
import * as Sentry from "@sentry/cloudflare";
import { readCappedBytes } from "@dustinedwards/site-runtime/body";
import { data, redirect } from "react-router";
import { SYNC_RESULT_MESSAGES } from "~/components/sync-dispute-link";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { MEMBER_ROLE } from "~/lib/auth";
import { authContext } from "~/lib/auth/context";
import { ACCEPT_APPROVED_MESSAGE, acceptDispute } from "~/lib/disputes/accept.server";
import { canApprove } from "~/lib/disputes/approval";
import {
  BACK_LINK_REAL,
  CUSTOMER_IP_FIELD,
  NARRATIVE_FIELD,
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_FIELD,
  SHIPPING_DATE_FIELD,
  SHIPPING_TRACKING_FIELD,
} from "~/lib/disputes/detail";
import {
  EVIDENCE_FILE_MESSAGES,
  EVIDENCE_FILE_STATUS,
  type EvidenceFileOutcome,
} from "~/lib/disputes/evidence-files";
import { deleteEvidenceFile, uploadEvidenceFile } from "~/lib/disputes/evidence-files.server";
import { importDisputeFromStripe } from "~/lib/disputes/manual-import.server";
import {
  approveAndSubmitDispute,
  getConnectionAccessToken,
  getDisputeDetail,
  saveDisputeDraft,
} from "~/lib/disputes/queries.server";
import type { Route } from "./+types/detail";

export async function disputeDetailAction({ context, params, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const detail = await getDisputeDetail(db, accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });

  // No post to this page is near one evidence file's size except an upload, so
  // a body far past it is refused before it is held in memory (J07). The
  // declared Content-Length can be absent or understated, so the body is read
  // to the ceiling as it arrives and only then parsed.
  const ceiling = DISPUTE_EVIDENCE_MAX_SIZE_BYTES + UPLOAD_BODY_SLACK_BYTES;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  const body = declaredLength > ceiling ? null : await readCappedBytes(request, ceiling);
  if (body === null) return fileResult("upload_file", "file_too_large", 413);

  // readCappedBytes joins the chunks into a fresh ArrayBuffer-backed array.
  const form = await new Response(body as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData();
  const intent = String(form.get("intent") ?? "");

  // Approving submits evidence to Stripe and accepting concedes the dispute;
  // neither can be undone, so only the account owner does either.
  if ((intent === "approve" || intent === "accept") && auth.membership.role !== MEMBER_ROLE.OWNER) {
    return data({ error: "Only the account owner can do this.", intent }, { status: 403 });
  }

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
    // "Saved.". The result is not ok, so the page keeps the
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
    // Recova's upload-evidence and delete-evidence. The dispute was read
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
          standingOptInAt: null,
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
 *  outcome's status. */
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
