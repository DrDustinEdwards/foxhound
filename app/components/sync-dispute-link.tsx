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
// field label and input, a primary button (teal, Q11) and a quiet Cancel, and
// the result as a Capsomer status in a live region, so it is announced and is
// never colour alone. Like legacy, Cancel clears the result and a successful
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

export function SyncDisputeLink({ result }: { result?: SyncDisputeResult }) {
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
          Sync dispute from Stripe
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-8 text-center">
      <Form method="post" className="cap-panel mx-auto max-w-md text-left">
        <div className="cap-panel-body">
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
          <div className="mt-2 text-micro text-text-subtle">
            Use this for disputes that came in before you connected to Foxhound.
          </div>
        </div>
      </Form>
    </div>
  );
}
