import { formatDate } from "capsomer/behavior/time";
import { Form } from "react-router";
import { InlineConfirm } from "capsomer/react/inline-confirm";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import {
  ACCEPT_CONFIRM_LINE,
  ACCEPT_UNAVAILABLE_APPROVED_LINE,
  disputeFeeTerms,
} from "~/lib/disputes/detail";
import { ApproveButton } from "~/components/dispute-detail-parts";
import type { loader } from "~/routes/app/disputes/detail";

type Loaded = Awaited<ReturnType<typeof loader>>;

export function DisputeApproval({
  dispute,
  approval,
  state,
  editable,
  resolved,
  isOwner,
  approveError,
  approving,
  accepting,
  acceptOpen,
  dirty,
}: {
  dispute: Loaded["dispute"];
  approval: Loaded["approval"];
  state: string;
  editable: boolean;
  resolved: boolean;
  isOwner: boolean;
  approveError: string | null | undefined;
  approving: boolean;
  accepting: boolean;
  acceptOpen: boolean;
  dirty: boolean;
}) {
  return editable ? (
    <div className="fh-dispute-submit">
      <Panel title="Approve and submit">
        <div className="fh-small">
          <p className="fh-soft">
            Submitting this evidence to Stripe approves a fee ({disputeFeeTerms()}, converted at
            Stripe's rate) if Foxhound wins this dispute. Merchant-fought or lost disputes are never
            billed.
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
                <ApproveButton label="Approve and submit" approving={approving} dirty={dirty} />
              </Form>
              {approval ? (
                <p className="fh-soft">{ACCEPT_UNAVAILABLE_APPROVED_LINE}</p>
              ) : (
                // "Accept dispute", then in its place the line, "Yes, accept" and "Cancel". Opening lands on Cancel, so a second Enter cannot concede the dispute.
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
  ) : null;
}
