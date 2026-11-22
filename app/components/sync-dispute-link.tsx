import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { Status } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/status.css";

// Renders below the disputes dashboard view, not inside it, so it shows on the empty state as well as the populated one (where a merchant importing a pre-connection dispute is most likely to be looking). A quiet text link that swaps itself for a bordered card: the "Stripe dispute ID" label, one input, the submit and a Cancel, the result as a Capsomer status in a live region (announced, never color alone), and an explanatory line. Cancel clears the result and a successful import clears the input.
// It is a real form posting to the disputes route's own action, so it works with JavaScript disabled, React Router revalidates the list on its own, and the action sits inside the app-shell tree, so the demo firewall (appShellMiddleware's demoBlocksMethod) refuses it with no new rule.
// It is not wrapped in ReadOnlyForm because it never renders for a demo visitor: the disputes route withholds it. A hand-crafted POST still meets demoBlocksMethod.

export interface SyncDisputeResult {
  ok: boolean;
  message: string;
}

/** The import's outcomes in words, shared by the two routes that host the control (/disputes and /disputes/:id). */
export const SYNC_RESULT_MESSAGES: Record<string, SyncDisputeResult> = {
  imported: { ok: true, message: "Dispute imported." },
  // Not an error. Either this import already ran or the webhook got there
  // first; both mean the dispute is on the books exactly once.
  already_imported: { ok: true, message: "That dispute is already imported." },
  invalid_id: { ok: false, message: 'Stripe dispute IDs start with "dp_".' },
  disputes_disabled: {
    ok: false,
    message: "Turn on Disputes in Settings before importing a dispute.",
  },
  not_connected: { ok: false, message: "Connect Stripe before importing a dispute." },
  not_found: { ok: false, message: "No dispute with that ID on your Stripe account." },
};

/** Two routes host this control (under the disputes list, and on the dispute page, where the words differ and there is no explanatory line). The words are props; the control is one. */
const SYNC_LIST_COPY = {
  linkLabel: "Sync dispute from Stripe",
};
export const SYNC_DETAIL_COPY = { linkLabel: "Sync a different dispute from Stripe" };

export function SyncDisputeLink({
  result,
  copy = SYNC_LIST_COPY,
}: {
  result?: SyncDisputeResult;
  copy?: { linkLabel: string };
}) {
  // Reopened when the last submit came back with something to say, so an error
  // is never reported behind a collapsed link.
  const [open, setOpen] = useState(Boolean(result));
  // The result being shown; Cancel clears it, and the next submit's result replaces it.
  const [shown, setShown] = useState<SyncDisputeResult | undefined>(result);
  const [disputeId, setDisputeId] = useState("");
  const navigation = useNavigation();
  const syncing = navigation.state === "submitting";

  // A new result from the action: show it, keep the card open, and clear the
  // input after a successful import. Adjusted during render, not in an effect.
  const [lastResult, setLastResult] = useState(result);
  if (result !== lastResult) {
    setLastResult(result);
    setShown(result);
    if (result) setOpen(true);
    if (result?.ok) setDisputeId("");
  }

  if (!open) {
    return (
      <div className="fh-sync fh-center">
        <Button variant="link" size="xs" onClick={() => setOpen(true)}>
          {copy.linkLabel}
        </Button>
      </div>
    );
  }

  return (
    <div className="fh-sync fh-center">
      <Form method="post" className="fh-sync-card cap-panel fh-left">
        {/* The card's text at the label size, Recova's small type in this card
            (RULES 5.2). The field label has no size of its own and would
            otherwise inherit the body size, since Capsomer's base.css is not
            loaded in the app. */}
        <div className="cap-panel-body fh-small">
          <input type="hidden" name="intent" value="sync_dispute" />
          <label htmlFor="sync_dispute_id" className="cap-field-label">
            Stripe dispute ID
          </label>
          <div className="fh-sync-row">
            <div className="cap-grow">
              <input
                className="cap-input"
                id="sync_dispute_id"
                name="stripe_dispute_id"
                type="text"
                placeholder="dp_..."
                value={disputeId}
                onChange={(e) => setDisputeId(e.target.value)}
                disabled={syncing}
                required
              />
            </div>
            <Button type="submit" variant="primary" pending={syncing}>
              {syncing ? "Syncing..." : "Import dispute"}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setOpen(false);
                setShown(undefined);
              }}
            >
              Cancel
            </Button>
          </div>
          <div role="status" className="fh-sync-note fh-tiny">
            {shown ? <Status tone={shown.ok ? "ok" : "crit"}>{shown.message}</Status> : null}
          </div>
        </div>
      </Form>
    </div>
  );
}
