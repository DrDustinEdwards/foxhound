import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { Status } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/status.css";

// Legacy's SyncDisputeLink (app/(app)/disputes/dashboard/SyncDisputeLink.tsx),
// ported. It renders directly below DisputesDashboardView on legacy's
// authenticated dashboard page and is NOT inside that shared view, so it shows
// on the empty state as well as the populated one, which is the state a
// merchant importing a pre-connection dispute is most likely to be looking at.
//
// Legacy's shape kept: a quiet text link that swaps itself for a bordered card
// with the "Stripe dispute ID" label, one input, the submit and a Cancel in a
// row, the result, and the explanatory line underneath. Since J66 the parts are
// Capsomer's (Q10): a link button, the card as a body-only panel, Capsomer's
// field label and input, a primary button (amber) and a quiet Cancel, and
// the result as a Capsomer status in a live region, so it is announced and is
// never color alone. Like legacy, Cancel clears the result and a successful
// import clears the input.
//
// THE TRANSPORT IS FOXHOUND'S, class (a) internals. Legacy is a client
// component that fetches JSON at /api/disputes/sync and then calls
// router.refresh(). Here it is a real form posting to the disputes route's own
// action, which is the pattern rulings 315 and 355 already established for this
// repo (S30's write path is its own route action; S38 records the whole shared
// legacy POST replaced by per-route actions). Three things follow from it that
// the fetch version does not get: the control works with JavaScript disabled,
// React Router revalidates the list on its own so there is no refresh call to
// forget, and the action sits INSIDE the app-shell tree, so the existing demo
// firewall (appShellMiddleware's demoBlocksMethod) refuses it with no new rule
// written here.
//
// IT IS NOT WRAPPED IN DemoGuardedForm, and the reason is that it never renders
// for a demo visitor at all: the disputes route withholds it (see that file),
// matching legacy, whose demo twin renders DisputesDashboardView alone and no
// import control. DemoGuardedForm exists to intercept a click that would
// otherwise leave the browser, and there is no click to intercept here. The
// boundary is unchanged either way: a hand-crafted POST still meets
// appShellMiddleware's demoBlocksMethod.

export interface SyncDisputeResult {
  ok: boolean;
  message: string;
}

/** The import's outcomes in words, shared by the two routes that host the
 *  control (/disputes and /disputes/:id). Recova's own success line is
 *  "Dispute imported." on both. */
export const SYNC_RESULT_MESSAGES: Record<string, SyncDisputeResult> = {
  imported: { ok: true, message: "Dispute imported." },
  // Not an error. Either this import already ran or the webhook got there
  // first; both mean the dispute is on the books exactly once.
  already_imported: { ok: true, message: "That dispute is already imported." },
  invalid_id: { ok: false, message: 'Stripe dispute IDs start with "dp_".' },
  disputes_disabled: { ok: false, message: "Turn on Disputes in Settings before importing a dispute." },
  not_connected: { ok: false, message: "Connect Stripe before importing a dispute." },
  not_found: { ok: false, message: "No dispute with that ID on your Stripe account." },
};

/** Recova has two of these: SyncDisputeLink under the disputes list, and
 *  DisputeSyncForm (blob f0f1ee7d) on the dispute page, which reads "Sync a
 *  different dispute from Stripe" and has no explanatory line. The words are
 *  props; the control is one. */
const SYNC_LIST_COPY = {
  linkLabel: "Sync dispute from Stripe",
  note: "Use this for disputes that came in before you connected to Foxhound.",
};
export const SYNC_DETAIL_COPY = { linkLabel: "Sync a different dispute from Stripe", note: null };

export function SyncDisputeLink({
  result,
  copy = SYNC_LIST_COPY,
}: {
  result?: SyncDisputeResult;
  copy?: { linkLabel: string; note: string | null };
}) {
  // Reopened when the last submit came back with something to say, so an error
  // is never reported behind a collapsed link.
  const [open, setOpen] = useState(Boolean(result));
  // The result being shown; Cancel clears it, as legacy's Cancel resets its
  // status, and the next submit's result replaces it.
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
      <div className="mt-8 text-center">
        <Button variant="link" size="xs" onClick={() => setOpen(true)}>
          {copy.linkLabel}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-8 text-center">
      <Form method="post" className="cap-panel mx-auto max-w-md text-left">
        {/* The card's text at the label size, Recova's small type in this card
            (RULES 5.2). The field label has no size of its own and would
            otherwise inherit the body size, since Capsomer's base.css is not
            loaded in the app. */}
        <div className="cap-panel-body text-label">
          <input type="hidden" name="intent" value="sync_dispute" />
          <label htmlFor="sync_dispute_id" className="cap-field-label">
            Stripe dispute ID
          </label>
          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">
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
          <div role="status" className="mt-2 text-micro">
            {shown ? <Status tone={shown.ok ? "ok" : "crit"}>{shown.message}</Status> : null}
          </div>
          {copy.note ? <div className="mt-2 text-micro text-text-subtle">{copy.note}</div> : null}
        </div>
      </Form>
    </div>
  );
}
