import { redirect } from "react-router";
import { ButtonLink } from "capsomer/react/link";
import { PageHead } from "capsomer/react/page-head";
import { Time } from "capsomer/react/time";
import { Panel } from "capsomer/react/panel";
import "capsomer/button.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";

import {
  AuditDisputesSection,
  AuditHealthSection,
  AuditRecoverySection,
  AuditSummary,
  showDisputesSection,
  type CtaState,
} from "~/components/audit/sections";
import { getDb } from "~/db";
import { saveAuditRun } from "~/lib/audit/persist.server";
import { toAuditRunView } from "~/lib/audit/render";
import { runFullAudit } from "~/lib/audit/run.server";
import { getSession, resolveActiveMembership } from "~/lib/auth";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { AUDIT_LOOKBACK_DAYS } from "~/lib/constants";
import { AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import { readAccountAuditSettings } from "~/lib/settings/audit-settings.server";
import { findLiveAttachment } from "~/lib/stripe/connections.server";
import { readAuditGrantCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/results";
import "~/audit-tool.css";

// The live run. THE ENGINE RUNS AT RENDER: the loader calls `runAudit` on EVERY load from the OAuth cookie, never reading back a stored row, so a reload inside the cookie's five minutes re-runs five Stripe reads and one AI call. Treating `audit_runs` as a cache would change behavior; the shareable-by-id page is the only reader of a stored run.
// AN ANONYMOUS RUN LEAVES BEHIND NOTHING: no account, no membership, no connection row, no outcome, no billing line; its only anonymous write is an AI-cost row with a null account id. This route creates no billable path (PRICING rev 3 keeps the audit free).
// PERSISTENCE NEEDS ONE CHECK: a run is stored only when a signed-in account resolves AND the audited Stripe account is live on the caller's ACTIVE account, so a merchant auditing somebody else's Stripe account never files that account's MRR, disputes and failed invoices into their own history; the page says plainly when it did not store.

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

export function meta() {
  return [
    { title: "Your Stripe audit - Foxhound" },
    // A token-gated render of somebody's live financials. Never indexable.
    { name: "robots", content: "noindex" },
  ];
}

/** Why a completed run was not written to history. Null means it was. */
type NotSavedReason = "anonymous" | "not_your_account";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);

  const grant = await readAuditGrantCookie(env, request);
  const queryAccountId = url.searchParams.get("account");
  // No cookie or no account id means the five-minute grant is gone, and the only way back is a fresh authorization.
  if (!grant || !queryAccountId) {
    throw redirect("/audit/connect?error=session_expired");
  }
  // THE ACCOUNT IS THE ONE STRIPE NAMED, NEVER THE QUERY'S. The visitor can edit `?account=`, while the token reads whichever account granted it; editing the id would file one account's numbers under another's id in the caller's history. The query is checked against the sealed id. A mismatch is refused like a stale link, naming no account and no holder.
  if (queryAccountId !== grant.stripeAccountId) {
    throw redirect("/audit/connect?error=invalid_state");
  }
  const { accessToken, stripeAccountId } = grant;

  const db = getDb(env);
  const session = await getSession(env, request);
  const membership = session
    ? await resolveActiveMembership(db, session.user.id, session.session.activeAccountId ?? null)
    : null;

  // The lookback is `accounts.audit_lookback_days` for a signed-in visitor, 90 for everyone else, read through readAuditSettings rather than a second inline `?? 90`.
  const lookbackDays = membership
    ? (await readAccountAuditSettings(db, membership.accountId)).lookbackDays
    : AUDIT_LOOKBACK_DAYS;

  const ranAt = new Date();
  const { result, summary } = await runFullAudit(
    env,
    accessToken,
    stripeAccountId,
    lookbackDays,
    ranAt,
  );

  let notSaved: NotSavedReason | null = "anonymous";

  if (membership) {
    // Is the audited Stripe account the one this account actually holds? Asked through the SAME predicate both connect branches use, with the caller's held set narrowed to the active account, so "held by caller" means "live on the account this run would be filed under".
    const attachment = await findLiveAttachment(db, stripeAccountId, [membership.accountId]);
    if (attachment.status === "held_by_caller") {
      await saveAuditRun(env, result, {
        accountId: membership.accountId,
        isAuthenticated: true,
        summary: summary.summary,
        now: ranAt,
      });
      notSaved = null;
    } else {
      notSaved = "not_your_account";
    }
  }

  return {
    run: toAuditRunView(result, summary.summary),
    notSaved,
    signedIn: Boolean(membership),
  };
}

function WhatsNext({ signedIn, notSaved }: { signedIn: boolean; notSaved: NotSavedReason | null }) {
  if (signedIn) {
    return (
      <Panel title="What's next">
        {notSaved === null ? (
          <>
            <ButtonLink to="/audit/dashboard">View audit history</ButtonLink>
          </>
        ) : (
          // The refusal, said out loud: a run that quietly did not save is the same shape of lie as a zero that means unknown.
          <p className="fh-small fh-soft">
            This run was not saved to your audit history, because the Stripe account you just
            authorized is not the one connected to your Foxhound account. The numbers above are
            correct for the account you authorized.
          </p>
        )}
      </Panel>
    );
  }

  // The unauthenticated branch. The target is /signup, the only anonymous entrance to the onboarding grant that stays. The fee is Foxhound's constant.
  return (
    <Panel title="What's next">
      <div className="fh-center">
        {/* The label wraps between its two sentences, never inside one. */}
        <ButtonLink to="/signup" variant="primary" wrap>
          <span className="fh-nowrap">Start recovering this revenue.</span>{" "}
          <span className="fh-nowrap">Free until we do.</span>
        </ButtonLink>
        <p className="fh-results-text-2 fh-small fh-soft">
          Connect Stripe permanently. Foxhound runs automatically. You pay {RECOVERY_FEE_PERCENT}%
          of what we recover. Nothing until then.
        </p>
        <p className="fh-results-text-3 fh-tiny fh-faint">
          These results are from a {AUDIT_GRANT_MINUTES}-minute session. Create an account to save
          them.
        </p>
      </div>
    </Panel>
  );
}

export default function AuditResults({ loaderData }: Route.ComponentProps) {
  const { run, notSaved, signedIn } = loaderData;
  const ctaState: CtaState = signedIn ? "active" : "unauthenticated";

  // Capsomer's page class sets the width and gutters; the text stays Foxhound's 16px (--fs-page, app.css). The page sits under the marketing shell, which is not a Capsomer family, so it names the amber family itself, as the legal pages do.
  return (
    <div className="fh-results-block fh-cap cap-page" data-cap-site="foxhound" data-family="amber">
      <div className="fh-results-block-2">
        <div className="fh-results-block-3 fh-mono fh-tiny fh-faint fh-caps-wide">
          Stripe Account Diagnostic &middot; <Time at={run.runAt} tip />
        </div>
        <PageHead title={`Analyzed last ${run.lookbackDays} days of payment history`} />
      </div>

      <AuditSummary summary={run.summary} />
      <AuditRecoverySection run={run} ctaState={ctaState} />
      {showDisputesSection(run) ? <AuditDisputesSection run={run} ctaState={ctaState} /> : null}
      <AuditHealthSection run={run} />

      <WhatsNext signedIn={signedIn} notSaved={notSaved} />
    </div>
  );
}
