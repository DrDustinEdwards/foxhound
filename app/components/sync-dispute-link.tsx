import { useState } from "react";
import { Form, useNavigation } from "react-router";

// Legacy's SyncDisputeLink (app/(app)/disputes/dashboard/SyncDisputeLink.tsx),
// ported. It renders directly below DisputesDashboardView on legacy's
// authenticated dashboard page and is NOT inside that shared view, so it shows
// on the empty state as well as the populated one, which is the state a
// merchant importing a pre-connection dispute is most likely to be looking at.
//
// Legacy's shape kept: a quiet text link that swaps itself for a bordered card
// with one mono input, a teal (brand) submit and a Cancel, plus the explanatory line
// underneath. Legacy's raw type values are mapped onto Foxhound's app scale
// rather than ported literally (179/187 freeze the type scale in both
// directions); every other class string is legacy's.
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
  const navigation = useNavigation();
  const syncing = navigation.state === "submitting";

  if (!open) {
    return (
      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="cursor-pointer border-none bg-transparent text-micro text-text-tertiary underline-offset-2 hover:text-text hover:underline"
        >
          Sync dispute from Stripe
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 text-center">
      <Form
        method="post"
        className="mx-auto max-w-md rounded-[12px] border border-border bg-surface px-5 py-4 text-left"
      >
        <input type="hidden" name="intent" value="sync_dispute" />
        <label
          htmlFor="sync_dispute_id"
          className="mb-2 block text-micro font-medium uppercase tracking-[0.06em] text-text-tertiary"
        >
          Stripe dispute ID
        </label>
        <div className="flex items-center gap-2">
          <input
            id="sync_dispute_id"
            name="stripe_dispute_id"
            type="text"
            placeholder="dp_..."
            disabled={syncing}
            required
            className="flex-1 rounded-[8px] border border-border-i bg-bg px-3 py-2 font-mono text-label text-text"
          />
          <button
            type="submit"
            disabled={syncing}
            className="rounded-md bg-brand px-4 py-2 text-label font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-60"
          >
            {syncing ? "Syncing..." : "Import dispute"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="cursor-pointer border-none bg-transparent text-micro text-text-tertiary hover:text-text"
          >
            Cancel
          </button>
        </div>
        {result ? (
          <div className={`mt-2 text-micro ${result.ok ? "text-green" : "text-red"}`}>
            {result.message}
          </div>
        ) : null}
        <div className="mt-2 text-micro text-text-subtle">
          Use this for disputes that came in before you connected to Foxhound.
        </div>
      </Form>
    </div>
  );
}
