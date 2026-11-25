import { formatDate } from "capsomer/behavior/time";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/select.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family, which the components above read, as the disputes list and the payment pages load them.
import "~/site-header.css";
import { type DisputeState } from "~/lib/constants";
import { useDraftDirty } from "capsomer/react/form-hooks";
import { useFetcher, useNavigation, useSearchParams } from "react-router";
import "capsomer/inline-confirm.css";
import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import { SYNC_DETAIL_COPY, SyncDisputeLink } from "~/components/sync-dispute-link";
import { MEMBER_ROLE } from "~/lib/auth";
import { accountScope } from "~/lib/auth/context";
import { canApproveDispute } from "~/lib/disputes/approval";
import {
  BACK_LINK_DEMO,
  BACK_LINK_REAL,
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_FIELD,
  SHIPPING_DATE_FIELD,
  SHIPPING_TRACKING_FIELD,
  deadlineRemaining,
  evidenceFieldLabel,
  outcomeWord,
  splitEvidence,
} from "~/lib/disputes/detail";
import { EVIDENCE_FILE_FIELD } from "~/lib/disputes/evidence-files";
import { getDisputeFindings } from "~/lib/disputes/findings.server";
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
import { recommendOneCustomer } from "~/lib/intelligence/recommendations.server";
import { RecommendationBanner } from "~/components/recommendation-banner";
import type { Route } from "./+types/detail";
import { disputeDetailAction } from "./detail.action.server";
import {
  FieldRow,
  EvidenceFileForms,
  EvidenceFiles,
} from "../../../components/dispute-detail-parts";
import { DisputeApproval } from "~/components/dispute-approval";
import { DisputeFindings } from "~/components/dispute-findings";
import { NOINDEX } from "~/lib/seo/meta";

// /disputes/:id: the back link, the header, the timeline, what Foxhound found, the staged evidence, the additional evidence, the sync form, and the approve card. A recommendation banner after the triage banner is worked out when the page loads (recommendOneCustomer). The triage banner and What Foxhound found (billing address, AVS, CVV, Stripe Radar, 3D Secure, Smart Disputes, prior charge history and subscription) are read from Stripe at intake (app/lib/disputes/triage.ts). Evidence files sit between Staged and Additional evidence, over the EVIDENCE R2 bucket (app/lib/disputes/evidence-files.server.ts) and the account-scoped view at /disputes/:id/files/:fileId; until the bucket is bound the upload control's place says so. Shipping fields show in Additional evidence when the account ships physical goods (/settings/disputes) and save with the draft as Stripe's shipping evidence fields. Accept dispute is a two-step "Accept dispute", "Yes, accept", "Cancel", closing the dispute at Stripe and resolving it lost with no fee (app/lib/disputes/accept.server.ts), then back to the list. Auto-submit is not on this page: it is the disputes cron's job (app/lib/cron/dispute-auto-submit.ts), through the same approveAndSubmitDispute as Approve and submit. The approve-and-submit card stands in place of a sticky action bar.

export function meta() {
  return [{ title: "Dispute detail - Foxhound" }, NOINDEX];
}

// The page bar's name (app-shell.tsx): the route's own title, not the Disputes row's "Disputes overview".
export const handle = { page: "Dispute detail" };

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env, auth, db, accountId } = accountScope(context);
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
    // A read failure leaves the recommendation banner out rather than failing the page.
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
  // Hidden until "Accept dispute", then the confirmation, which stays open over a failed accept so its error sits beside it. Without script the first step is a link to ?confirm=accept.
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
  // Editable while the dispute awaits a response and nobody has submitted, and never in the demo.
  const editable = !isDemo && canApproveDispute(state);
  // The draft locks once an approval row exists: the approval's
  // hash attests the saved evidence, so it is not edited after.
  const draftEditable = editable && !approval;
  const savedOk =
    saveFetcher.state === "idle" && saveFetcher.data !== undefined && "ok" in saveFetcher.data;
  const {
    dirty,
    edit: draftEdited,
    submit: draftSubmitted,
  } = useDraftDirty(savedOk ? saveFetcher.data : undefined);
  const resolved = isDisputeResolved(state);
  const outcome = outcomeWord(state);
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
      <DisputeFindings dispute={dispute} findings={findings} />

      {/* 5 and 7. Staged evidence and Additional evidence share Recova's one
          draft: Save draft saves the narrative and the Customer IP together. */}
      <saveFetcher.Form
        method="post"
        onChange={(e) => {
          // The evidence file input sits in this markup but belongs to the
          // upload form; choosing a file is not a draft edit.
          if ((e.target as unknown as HTMLInputElement).form === e.currentTarget) draftEdited();
        }}
        onSubmit={() => draftSubmitted()}
      >
        <input type="hidden" name="intent" value="save" />
        <div className="fh-dispute-section">
          <Panel title="Staged evidence">
            <div className="fh-small">
              {drafted.length === 0 ? (
                // Foxhound drafts at intake and drafts nothing when no record grounds it (draftDisputeEvidence), so no evidence is "being prepared".
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
                        Evidence narrative
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
                  From your own logs only.
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
                        />
                      </div>
                    </div>
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
      <DisputeApproval
        dispute={dispute}
        approval={approval}
        state={state}
        editable={editable}
        resolved={resolved}
        isOwner={isOwner}
        approveError={approveError}
        approving={approving}
        accepting={accepting}
        acceptOpen={acceptOpen}
        dirty={dirty}
      />
    </div>
  );
}
