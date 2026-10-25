import { Link, redirect } from "react-router";
import { PageHead } from "capsomer/react/page-head";
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
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { AUDIT_LOOKBACK_DAYS } from "~/lib/constants";
import { readAccountAuditSettings } from "~/lib/settings/audit-settings.server";
import { findLiveAttachment } from "~/lib/stripe/connections.server";
import { readAuditGrantCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/results";

// Legacy's `app/audit/results/page.tsx` (blob `9aad7745`, 8,818 bytes), phase (f).
// The live run: the door phase (e) built two rooms behind.
//
// THE ENGINE RUNS AT RENDER, WHICH IS LEGACY'S SHAPE AND NOT AN OVERSIGHT.
// Legacy's page is `force-dynamic` and calls `runAudit` on EVERY load from the
// OAuth cookie, never reading back the row it may have just written
// (ENGINE-AUDIT binding 3). A loader is the same thing, so a reload inside the
// cookie's five minutes re-runs five Stripe reads and one AI call. Recorded
// rather than optimised: treating `audit_runs` as a cache would change behaviour,
// and the shareable-by-id page is the only reader of a stored run on either side.
//
// WHAT AN ANONYMOUS RUN LEAVES BEHIND: NOTHING. No account, no membership, no
// connection row, no outcome, no billing line. Legacy is identical; its only
// anonymous write is an AI-cost row with a null account id, which Foxhound's
// gateway factory already records the same way. PRICING rev 3 keeps the audit
// free and this route creates no billable path.
//
// PERSISTENCE IS LEGACY'S CONDITION PLUS ONE CHECK. Legacy stores a run whenever
// a signed-in account resolves, without ever asking whether the Stripe account
// in the cookie belongs to that Foxhound account. A merchant who audits somebody
// else's Stripe account therefore gets that account's MRR, disputes and failed
// invoices filed permanently into their own history, with nothing on either
// surface saying so. Foxhound stores the run only when the audited Stripe
// account is live on the caller's ACTIVE account, and says plainly when it did
// not. Same class as 356 binding 2 and 330 binding 2, both of which refuse
// rather than mis-file, and ruled for this case by Dustin in session 71.

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
  // Legacy's guard, verbatim in effect: no cookie or no account id means the
  // five-minute grant is gone, and the only way back is a fresh authorization.
  if (!grant || !queryAccountId) {
    throw redirect("/audit/connect?error=session_expired");
  }
  // THE ACCOUNT IS THE ONE STRIPE NAMED, NEVER THE QUERY'S. Legacy trusts
  // `?account=`, which the visitor can edit, while the token reads whichever
  // account granted it; editing the id would file one account's numbers under
  // another's id in the caller's history (RULES.md 4.14). The query is kept for
  // legacy's URL and checked against the sealed id. A mismatch is refused like
  // a stale link, naming no account and no holder.
  if (queryAccountId !== grant.stripeAccountId) {
    throw redirect("/audit/connect?error=invalid_state");
  }
  const { accessToken, stripeAccountId } = grant;

  const db = getDb(env);
  const session = await getSession(env, request);
  const membership = session
    ? await resolveActiveMembership(db, session.user.id, session.session.activeAccountId ?? null)
    : null;

  // Legacy reads `accounts.audit_lookback_days` for a signed-in visitor and
  // falls back to 90 for everyone else. THE COLUMN HAD NO READER IN FOXHOUND
  // before this route, which is what the walk recorded; it has one now, and it
  // goes through readAuditSettings rather than a second inline `?? 90`.
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
    // Is the audited Stripe account the one this account actually holds? Asked
    // through the SAME predicate both connect branches use (356 binding 2), with
    // the caller's held set narrowed to the active account, so "held by caller"
    // here means "live on the account this run would be filed under".
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

function formatRanAt(value: Date): string {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function WhatsNext({
  signedIn,
  notSaved,
}: {
  signedIn: boolean;
  notSaved: NotSavedReason | null;
}) {
  if (signedIn) {
    return (
      <Panel title="What's next">
        {notSaved === null ? (
          <>
            <p className="m-0 mb-4 text-label text-text-secondary">
              This run is saved to your audit history. Trends show up after the second run.
            </p>
            <Link to="/audit/dashboard" className="cap-btn">
              View audit history
            </Link>
          </>
        ) : (
          // The refusal, said out loud (RULES.md 4.14). A run that quietly did
          // not save is the same shape of lie as a zero that means unknown.
          <p className="m-0 text-label text-text-secondary">
            This run was not saved to your audit history, because the Stripe account you just
            authorized is not the one connected to your Foxhound account. The numbers above are
            correct for the account you authorized.
          </p>
        )}
      </Panel>
    );
  }

  // Recova's unauthenticated branch, its copy and its order. The target is
  // /signup, Recova's own, and the only anonymous entrance to the read-write
  // onboarding grant (362 ruling 1). The fee is Foxhound's constant.
  return (
    <Panel title="What's next">
      <div className="text-center">
        {/* Capsomer's button never wraps, so this 48-character label ran past
            the panel's edge on a phone. The label wraps between its two
            sentences, never inside one, and py-2 gives two lines room; on a
            wide screen it is one line and the button keeps its height. */}
        <Link to="/signup" className="cap-btn py-2" data-variant="primary">
          <span className="whitespace-normal">
            <span className="whitespace-nowrap">Start recovering this revenue.</span>{" "}
            <span className="whitespace-nowrap">Free until we do.</span>
          </span>
        </Link>
        <p className="m-0 mt-2 text-label text-text-secondary">
          Connect Stripe permanently. Foxhound runs automatically. You pay {RECOVERY_FEE_PERCENT}% of
          what we recover. Nothing until then.
        </p>
        <p className="m-0 mt-1 text-micro text-text-subtle">
          These results are from a read-only session. Create an account to save them.
        </p>
      </div>
    </Panel>
  );
}

export default function AuditResults({ loaderData }: Route.ComponentProps) {
  const { run, notSaved, signedIn } = loaderData;
  const ctaState: CtaState = signedIn ? "active" : "unauthenticated";

  // Recova's column: max-w-[1280px] mx-auto px-4 md:px-8 py-10. The page sits
  // under the marketing shell, which is not a Capsomer family, so it names the
  // amber family itself, as the legal pages do (J51).
  return (
    <div className="fh-cap mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8" data-cap-site="foxhound" data-family="amber">
      <div className="mb-6">
        <div className="mb-2 font-mono text-micro uppercase tracking-widest text-text-subtle">
          Stripe Account Diagnostic
        </div>
        <PageHead
          title={`Analyzed last ${run.lookbackDays} days of payment history`}
          lead={
            <span className="font-mono text-micro text-text-subtle">
              Subscription health and disputes reflect current account state.
              <br />
              Run at {formatRanAt(run.runAt)}
            </span>
          }
        />
      </div>

      <AuditSummary summary={run.summary} />
      <AuditRecoverySection run={run} ctaState={ctaState} />
      {showDisputesSection(run) ? <AuditDisputesSection run={run} ctaState={ctaState} /> : null}
      <AuditHealthSection run={run} when="live" />

      <WhatsNext signedIn={signedIn} notSaved={notSaved} />
    </div>
  );
}
