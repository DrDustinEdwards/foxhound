import { plural } from "@drdustinedwards/site-helpers/text";
import { formatDate } from "capsomer/behavior/time";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/select.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family, which the components above read, as
// the disputes list and the payment pages load them.
import "~/site-header.css";
import { DISPUTE_FEE_CAP_CENTS, type DisputeState } from "~/lib/constants";
import { useEffect, useReducer } from "react";
import { Form, useFetcher, useNavigation, useSearchParams } from "react-router";
import { InlineConfirm } from "capsomer/react/inline-confirm";
import "capsomer/inline-confirm.css";
import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import { SYNC_DETAIL_COPY, SyncDisputeLink } from "~/components/sync-dispute-link";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { MEMBER_ROLE } from "~/lib/auth";
import { authContext } from "~/lib/auth/context";
import { disputeFeeCents } from "~/lib/billing/fees";
import { canApprove } from "~/lib/disputes/approval";
import {
  ACCEPT_UNAVAILABLE_APPROVED_LINE,
  BACK_LINK_DEMO,
  BACK_LINK_REAL,
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_FIELD,
  SHIPPING_DATE_FIELD,
  SHIPPING_TRACKING_FIELD,
  deadlineRemaining,
  disputeFeeTerms,
  draftAfter,
  draftDirty,
  evidenceFieldLabel,
  outcomeWord,
  splitEvidence,
  ACCEPT_CONFIRM_LINE,
} from "~/lib/disputes/detail";
import { EVIDENCE_FILE_FIELD } from "~/lib/disputes/evidence-files";
import { getDisputeFindings } from "~/lib/disputes/findings.server";
import {
  humanCardCheck,
  humanSmartDisputes,
  radarWords,
  readPriorCharges,
  readSubscription,
} from "~/lib/disputes/triage";
import {
  daysUntilDeadline,
  deadlineClassName,
  deadlineUrgency,
  humanizeDisputeReason,
  isDisputeResolved,
  isInquiryStatus,
} from "~/lib/disputes/labels";
import { getDisputeDetail, readDisputeSettings } from "~/lib/disputes/queries.server";
import { buildDisputeTimeline } from "~/lib/disputes/timeline";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { FAILED_PAYMENT_STATUS_LABELS } from "~/lib/recovery/labels";
import { declineWord } from "~/lib/recovery/payments-list";
import { recommendOneCustomer } from "~/lib/intelligence/recommendations.server";
import { RecommendationBanner } from "~/components/recommendation-banner";
import type { Route } from "./+types/detail";
import { disputeDetailAction } from "./detail.action.server";
import {
  ApproveButton,
  FieldRow,
  EvidenceFileForms,
  EvidenceFiles,
} from "../../../components/dispute-detail-parts";
import { NOINDEX } from "~/lib/seo/meta";

// /disputes/:id: Recova's dispute page on Foxhound's engine.
// Recova is the spec, read whole at HEAD: app/(app)/disputes/[id]/page.tsx
// (a9452f59), DisputeDetailClient.tsx (3d56b55d), and components/disputes/
// DisputeActionBar (c73b381a), DisputeEvidenceSummary (96ba82d4),
// DisputeFileUploads (1286eb21), DisputeSyncForm (f0f1ee7d), formatters
// (81bf7f8b), timeline (04fbe976) and types (9ffb7b8e). In Recova's order: the
// back link, the header, the timeline, what Foxhound found, the staged
// evidence, the additional evidence, the sync form, and the approve card where
// Recova's action bar sits. Look is Capsomer's, amber.
//
// Built with the recommendations port:
// - Recova's IntegrityLayerBanner after the triage banner, worked out when the
//   page loads (recommendOneCustomer), as Recova's score-ssr did.
// Built with the dispute context port (app/lib/disputes/triage.ts):
// - Recova's triage banner under the header, and in What Foxhound found the
//   billing address, AVS, CVV, Stripe Radar, 3D Secure, Smart Disputes, prior
//   charge history and subscription, all read from Stripe at intake.
// Built by J07:
// - Evidence files: Recova's DisputeFileUploads section between Staged evidence
//   and Additional evidence, over the EVIDENCE R2 bucket
//   (app/lib/disputes/evidence-files.server.ts) and the account-scoped view at
//   /disputes/:id/files/:fileId. Until Dustin binds the bucket the section says
//   uploads are not available yet, in the upload control's place.
// Built by J06:
// - Shipping fields: Recova shows them in Additional evidence when the account
//   ships physical goods, which /settings/disputes (S32) now writes. They save
//   with the draft as Stripe's shipping evidence fields.
// - Accept dispute: Recova's two-step "Accept dispute", "Yes, accept", "Cancel"
//   beside the submit control, closing the dispute at Stripe and resolving it
//   lost with no fee (app/lib/disputes/accept.server.ts), then back to the list
//   as Recova's router.push('/disputes/dashboard').
// - Auto-submit: not on this page. It is the disputes cron's job for accounts
//   that turned it on (app/lib/cron/dispute-auto-submit.ts), through the same
//   approveAndSubmitDispute this page's Approve and submit uses.
// - Recova's sticky action bar: Foxhound's approve-and-submit card stands in
//   its place ("The dispute page has an approve-and-submit card", approved
//   2026-08-28).

export function meta() {
  return [{ title: "Dispute detail - Foxhound" }, NOINDEX];
}

// The page bar's name (app-shell.tsx). Recova had no page bar, so it is the
// route's own title, not the Disputes row's "Disputes overview".
export const handle = { page: "Dispute detail" };

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const detail = await getDisputeDetail(db, accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  const nowMs = Date.now();
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
    // Approve and accept are the owner's (detail.action.server.ts).
    isOwner: auth.membership.role === MEMBER_ROLE.OWNER,
    nowMs,
    // Recova's IntegrityLayerBanner reads the customer's recommendation. A
    // read failure leaves the banner out rather than failing the page.
    prediction: await recommendOneCustomer(
      db,
      accountId,
      detail.dispute.stripeCustomerId,
      nowMs,
    ).catch(() => null),
  };
}

/** Approve, accept, evidence and sync posts; see detail.action.server.ts. */
export async function action(args: Route.ActionArgs) {
  return disputeDetailAction(args);
}

export default function DisputeDetail({ loaderData, actionData }: Route.ComponentProps) {
  const {
    dispute,
    evidence,
    approval,
    funds,
    findings,
    shipsPhysical,
    filesAvailable,
    isDemo,
    isOwner,
    nowMs,
    prediction,
  } = loaderData;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const pressedIntent = navigation.formData?.get("intent") ?? null;
  const approving = navigation.state !== "idle" && pressedIntent === "approve";
  const accepting = navigation.state !== "idle" && pressedIntent === "accept";
  // Recova's acceptState: hidden until "Accept dispute", then the confirmation,
  // which stays open over a failed accept so its error sits beside it. Without
  // script the first step is a link to ?confirm=accept.
  const acceptOpen =
    searchParams.get("confirm") === "accept" ||
    (actionData !== undefined && "intent" in actionData && actionData.intent === "accept");
  const saveFetcher = useFetcher<typeof action>();
  const saving = saveFetcher.state !== "idle";
  // The save result: the fetcher's in a browser, or the action's after a
  // no-script post.
  const saveResult =
    saveFetcher.data ??
    (actionData && "intent" in actionData && actionData.intent === "save" ? actionData : undefined);
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
  // The draft locks once an approval row exists: the approval's
  // hash attests the saved evidence, so it is not edited after.
  const draftEditable = editable && !approval;
  const [draft, dispatchDraft] = useReducer(draftAfter, { edits: 0, submitted: 0, saved: 0 });
  const savedOk =
    saveFetcher.state === "idle" && saveFetcher.data !== undefined && "ok" in saveFetcher.data;
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
  const { structured, narrative, customerIp, shipping } = splitEvidence(
    evidence,
    draftEditable,
    shippingEditable,
  );
  // The merchant's uploaded files have their own section; "drafted" is
  // everything else, which is what Staged evidence speaks of.
  const files = evidence.filter((e) => e.fieldName === EVIDENCE_FILE_FIELD);
  const priorCharges = readPriorCharges(dispute.priorChargesJson);
  const subscription = readSubscription(dispute.subscriptionJson);
  const radar = radarWords(dispute.radarRiskScore, dispute.radarRiskLevel);
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
    status: dispute.status,
    funds,
  });

  const saveControls = (
    <div className="cap-cluster fh-dispute-actions" data-gap="4">
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
      <span role="status" className="fh-tiny">
        {saveResult && "ok" in saveResult ? (
          <Status tone="ok">Saved.</Status>
        ) : saveResult && "error" in saveResult ? (
          <Status tone="crit">{saveResult.error}</Status>
        ) : null}
      </span>
    </div>
  );

  return (
    <div className="fh-dispute">
      {/* Recova's main: max-w-[960px] mx-auto px-4 md:px-8 py-10. Its pb-28
          clears the sticky action bar, which Foxhound's approve card replaces. */}
      <Link to={backLink.href} className="fh-dispute-back fh-small fh-quiet">
        {backLink.label}
      </Link>

      {/* 1. Recova's header: the amount large in the accent, the customer as the
          heading, the reason, and the days remaining or the outcome. */}
      <header className="fh-dispute-header">
        <div>
          <div className="fh-mono fh-display fh-bold fh-tight fh-brand">
            {formatMoney(dispute.amountCents, dispute.currency)}
          </div>
          <h1 className="fh-dispute-title fh-title fh-medium fh-text">
            {dispute.customerName || "Unknown customer"}
          </h1>
          <div className="fh-dispute-reason fh-small fh-faint">
            {humanizeDisputeReason(dispute.reason)}
          </div>
        </div>
        <div className="fh-right">
          {/* An inquiry is not a chargeback; Recova did not tell them apart. */}
          {!resolved && isInquiryStatus(dispute.status) ? (
            <div className="fh-dispute-status">
              <Pill>Inquiry</Pill>
            </div>
          ) : null}
          {!resolved ? (
            <div className={`fh-mono fh-small ${deadlineClassName(deadlineUrgency(days))}`}>
              {deadlineRemaining(days)}
            </div>
          ) : null}
          {resolved && outcome ? (
            <Pill
              tone={
                state === "resolved_won" ? "ok" : state === "resolved_lost" ? "crit" : undefined
              }
            >
              {outcome}
            </Pill>
          ) : null}
        </div>
      </header>

      {/* 2. Recova's triage banner: fight in green, accept in the accent. */}
      {dispute.triageRecommendation ? (
        <div className="fh-dispute-section">
          <Banner
            tone={dispute.triageRecommendation === "fight" ? "ok" : "warn"}
            title={
              dispute.triageRecommendation === "fight"
                ? "Foxhound recommends fighting this dispute"
                : "Foxhound recommends accepting this dispute"
            }
            // body, not children: children sit inside Capsomer's p.cap-banner-text,
            // and a p inside a p is invalid HTML (React error 418 on every dispute page).
            body={
              <>
                {dispute.triageReasoning ? (
                  <p className="fh-dispute-status fh-small fh-text">{dispute.triageReasoning}</p>
                ) : null}
                {typeof dispute.triageConfidence === "number" ? (
                  <p className="fh-tiny fh-quiet">Confidence: {dispute.triageConfidence}%</p>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}

      {/* Recova's IntegrityLayerBanner: the customer's context, after the
          dispute's own triage (DisputeDetailClient.tsx 143). */}
      <RecommendationBanner prediction={prediction} surface="dispute" nowMs={nowMs} />

      {/* 3. Timeline. */}
      <div className="fh-dispute-section">
        <Panel title="Timeline">
          <ol className="fh-dispute-timeline">
            {timeline.map((item, i) => (
              <li key={i} className="fh-dispute-event">
                <span className="fh-dispute-fact-label fh-mono fh-tiny fh-faint">
                  {item.at ? (formatDate(item.at, { style: "medium", time: true }) ?? "") : ""}
                </span>
                <span className="fh-small fh-text">{item.label}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      {/* 4. Recova's DisputeEvidenceSummary, over what Foxhound writes. */}
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
                {dispute.customerName ? (
                  <FieldRow label="Name" value={dispute.customerName} />
                ) : null}
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
                    <span className="fh-text">
                      {declineWord(findings.recovery.declineCategory)}
                    </span>
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
                      value={
                        formatDate(new Date(subscription.start_date), { style: "medium" }) ?? ""
                      }
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

      {/* 5 and 7. Staged evidence and Additional evidence share Recova's one
          draft: Save draft saves the narrative and the Customer IP together. */}
      <saveFetcher.Form
        method="post"
        onChange={(e) => {
          // The evidence file input sits in this markup but belongs to the
          // upload form; choosing a file is not a draft edit.
          if ((e.target as unknown as HTMLInputElement).form === e.currentTarget)
            dispatchDraft({ type: "edit" });
        }}
        onSubmit={() => dispatchDraft({ type: "submit" })}
      >
        <input type="hidden" name="intent" value="save" />
        <div className="fh-dispute-section">
          <Panel title="Staged evidence">
            <div className="fh-small">
              {drafted.length === 0 ? (
                // Recova said "Evidence is being prepared". Foxhound drafts at
                // intake and drafts nothing when no record grounds it
                // (draftDisputeEvidence), so nothing is on the way.
                <p className="fh-faint">
                  Foxhound found no records for this charge to draft evidence from.
                </p>
              ) : (
                <>
                  {structured.length > 0 ? (
                    <dl className="fh-dispute-evidence">
                      {structured.map((f) => (
                        <FieldRow
                          key={f.id}
                          label={evidenceFieldLabel(f.fieldName)}
                          value={f.fieldValue}
                        />
                      ))}
                    </dl>
                  ) : null}
                  {!isDemo ? (
                    <div>
                      <label
                        htmlFor="dispute_evidence_narrative"
                        className="fh-dispute-group-title fh-line fh-tiny fh-medium fh-quiet fh-caps"
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

        {/* 6. Recova's Evidence files. Its controls belong to the upload
            and remove forms below, through the form attribute. */}
        <div className="fh-dispute-section">
          <EvidenceFiles
            disputeId={dispute.id}
            files={files}
            editable={draftEditable}
            available={filesAvailable}
          />
        </div>

        {draftEditable ? (
          <div className="fh-dispute-section">
            <Panel title="Additional evidence (optional)">
              <div className="fh-small">
                <label htmlFor="dispute_customer_ip" className="cap-field-label">
                  Customer IP
                </label>
                <div className="fh-dispute-input">
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
                <p id="dispute_customer_ip_help" className="fh-dispute-input fh-tiny fh-faint">
                  Only add if you have the actual IP from your own logs. Do not guess. Saved with
                  your draft and included when you submit.
                </p>
                {shippingEditable ? (
                  <div className="fh-dispute-more">
                    {/* Recova's three shipping inputs, one row of three on desktop. */}
                    <div className="fh-dispute-fields">
                      <div className="cap-field">
                        <label htmlFor="dispute_tracking_number" className="cap-field-label">
                          Tracking number
                        </label>
                        <input
                          id="dispute_tracking_number"
                          name={SHIPPING_TRACKING_FIELD}
                          type="text"
                          className="cap-input fh-mono"
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
                    <p id="dispute_shipping_help" className="fh-dispute-help-text fh-tiny fh-faint">
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
        <div className="fh-dispute-submit">
          <Panel title="Approve and submit">
            <div className="fh-small">
              <p className="fh-soft">
                Submitting this evidence to Stripe approves a fee of{" "}
                <span className="fh-mono fh-text">{formatMoney(fee, dispute.currency)}</span> (
                {disputeFeeTerms()}) if Foxhound wins this dispute. Merchant-fought or lost disputes
                are never billed.
              </p>
              {approveError ? (
                <div className="fh-dispute-gap">
                  <Banner tone="crit">{approveError}</Banner>
                </div>
              ) : null}
              {!isOwner ? (
                <p className="fh-dispute-more fh-soft">
                  Only the account owner can approve or accept a dispute.
                </p>
              ) : (
                <div className="cap-cluster fh-dispute-more" data-gap="4">
                  <Form method="post">
                    <input type="hidden" name="intent" value="approve" />
                    <ApproveButton
                      label={`Approve and submit (fee ${formatMoney(fee, dispute.currency)})`}
                      approving={approving}
                      dirty={dirty}
                    />
                  </Form>
                  {approval ? (
                    <p className="fh-soft">{ACCEPT_UNAVAILABLE_APPROVED_LINE}</p>
                  ) : (
                    // Recova's Accept (DisputeActionBar.tsx): "Accept dispute", then in
                    // its place the line, "Yes, accept" and "Cancel". Opening lands on
                    // Cancel, so a second Enter cannot concede the dispute.
                    <InlineConfirm
                      form={Form}
                      size="default"
                      label="Accept dispute"
                      question={ACCEPT_CONFIRM_LINE}
                      confirmLabel="Yes, accept"
                      openHref="?confirm=accept"
                      closeHref="?"
                      defaultOpen={acceptOpen}
                      pending={accepting}
                      pendingLabel="Accepting…"
                    >
                      <input type="hidden" name="intent" value="accept" />
                    </InlineConfirm>
                  )}
                </div>
              )}
            </div>
          </Panel>
        </div>
      ) : approval || resolved ? (
        <div className="fh-dispute-submit">
          <Panel title="Approval">
            <div className="fh-small">
              <p className="fh-soft">
                {approval
                  ? `Approved by ${approval.approvedByEmail} on ${formatDate(approval.approvedAt, { style: "medium", time: true }) ?? ""}`
                  : "No approval record."}
              </p>
              {resolved ? (
                <p className="fh-dispute-help-text fh-text">
                  {state === "resolved_won"
                    ? dispute.resolvedFeeCents != null
                      ? `Won. Fee of ${formatMoney(dispute.resolvedFeeCents, dispute.resolvedFeeCurrency ?? dispute.currency)} billed at the next monthly run.`
                      : dispute.submittedAt != null
                        ? "Won. The fee is not priced yet, so it is not billed until it is."
                        : "Won. No fee: this dispute was not submitted through Foxhound."
                    : state === "inquiry_closed"
                      ? "Inquiry closed. Not billed."
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
