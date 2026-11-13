import { data } from "react-router";
import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Pagination } from "capsomer/react/pagination";
import { Pill, type Tone as PillTone } from "capsomer/react/status";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/pagination.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /help does.
import "~/site-header.css";

import { EarlyFraudWarnings } from "~/components/early-fraud-warnings";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { SYNC_RESULT_MESSAGES, SyncDisputeLink } from "~/components/sync-dispute-link";
import { StaticStatTile, StatTiles } from "capsomer/react/stat-tile";
import "capsomer/stat-tile.css";
import { getDb } from "~/db";
import { groupSumByCurrency } from "~/lib/money/totals";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { MEMBER_ROLE } from "~/lib/auth";
import { authContext } from "~/lib/auth/context";
import {
  daysUntilDeadline,
  deadlineClassName,
  deadlineShort,
  deadlineUrgency,
  disputeListStatus,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import { getDisputeFeesOwed } from "~/lib/disputes/fees-owed.server";
import {
  isWarningIntent,
  listEarlyFraudWarnings,
  runWarningAction,
} from "~/lib/disputes/fraud-warnings.server";
import { importDisputeFromStripe } from "~/lib/disputes/manual-import.server";
import {
  disputeStatGroups,
  getCustomerHealthScores,
  getDisputesWithEvidence,
  listDisputesPage,
} from "~/lib/disputes/queries.server";
import { computeDisputeStatsFromGroups, winRateCard } from "~/lib/disputes/stats";
import { healthScoreClassName } from "~/lib/intelligence/health-band";
import type { Tone } from "~/lib/recovery/labels";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { formatAmounts } from "~/lib/money/totals";

import type { Route } from "./+types/index";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /disputes: Recova's disputes dashboard on Foxhound's engine.
// Recova is the spec: app/(app)/disputes/dashboard/page.tsx (blob c97c3e93),
// DisputesDashboardView.tsx (3c1b7a98) and SyncDisputeLink.tsx (d2c2a744). In
// Recova's order: the "Dashboard" head, the stat cards (shown on the empty
// state too), then the empty card or the table, then the sync control, in a
// 1280px column. Look is Capsomer's, amber.
//
// Dustin answered PR #75's five questions "yes ro all" (2026-10-15,
// cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6): the status column uses
// Recova's words where one is true (disputeListStatus); the cards are Recova's
// with "Submitted by Foxhound" and without "Saved vs Smart Disputes"; Mode
// stays out for good; Win rate stays; "Fees owed" counts only fees still owed.
// The Fee column is not built. The Recovery cross-sell card is approved as not
// built (APPROVED-DIFFERENCES, 2026-09-19).
//
// The loader is read-only, billing records included. The writes are the
// existing manual import action and the early fraud warning section's Refund
// and Dismiss (app/lib/disputes/fraud-warnings.server.ts). That section is not
// Recova's: Dustin approved building it on 2026-10-29. It shows only for an
// account that has had a warning, below the disputes table.

export function meta() {
  return [{ title: "Disputes - Foxhound" }, NOINDEX];
}

/** Rows per page of the disputes table, the payments list's default. */
const DISPUTES_PAGE_SIZE = 25;

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);

  // The cards count every dispute in SQL; the table reads one page, newest
  // first, as Recova orders the list (created_at descending).
  const nowMs = Date.now();
  const asked = Number(new URL(request.url).searchParams.get("page") ?? "1");
  const requestedPage = Number.isInteger(asked) && asked > 0 ? asked : 1;
  const [groups, feesOwed, warnings] = await Promise.all([
    disputeStatGroups(db, accountId),
    getDisputeFeesOwed(db, accountId, nowMs),
    listEarlyFraudWarnings(db, accountId),
  ]);
  const total = groups.reduce((n, g) => n + g.count, 0);
  const pageCount = Math.max(1, Math.ceil(total / DISPUTES_PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const { rows: disputes } = await listDisputesPage(db, accountId, page, DISPUTES_PAGE_SIZE);

  const parts = computeDisputeStatsFromGroups(groups);
  const stats = {
    openCount: parts.openCount,
    atStake: groupSumByCurrency(parts.atStakeParts),
    submittedByFoxhoundCount: parts.submittedByFoxhoundCount,
    feesOwed: groupSumByCurrency(feesOwed),
    wonCount: parts.wonCount,
    lostCount: parts.lostCount,
    winRatePct: parts.winRatePct,
  };

  // Recova shows each customer's Intelligence health score beside the name
  // when Intelligence is on, which it now always is (free, Dustin 2026-10-29).
  const health = await getCustomerHealthScores(
    db,
    accountId,
    disputes.map((d) => d.stripeCustomerId).filter((id): id is string => id !== null),
  );

  // "Evidence ready" is said only of a dispute whose draft holds evidence, so
  // only the states that label depends on are looked up.
  const withEvidence = [
    ...(await getDisputesWithEvidence(
      db,
      accountId,
      disputes
        .filter((d) => d.state === "pending_review" || d.state === "approved")
        .map((d) => d.id),
    )),
  ];

  // Withheld from the demo exactly as legacy withholds it: legacy's demo twin
  // renders DisputesDashboardView alone, and importing a real Stripe dispute
  // into the shared demo account is meaningless. The middleware's method gate
  // is still the boundary for a hand-crafted POST.
  return {
    disputes,
    pagination: { page, pageCount, total, perPage: DISPUTES_PAGE_SIZE },
    stats,
    health,
    withEvidence,
    nowMs,
    isDemo: auth.isDemo,
    isOwner: auth.membership.role === MEMBER_ROLE.OWNER,
    warnings: warnings.any ? warnings.open : null,
  };
}

// Manual dispute import (ruling 400 halt ruling 1). The endpoint is this
// route's own action rather than legacy's /api/disputes/sync, which is class
// (a) internals and the pattern rulings 315 and 355 already set for this repo.
//
// IT IS DEMO-BLOCKED WITHOUT A LINE OF ITS OWN. This route nests under the app
// shell, so appShellMiddleware runs first and demoBlocksMethod refuses every
// non-GET with the read-only 405 before the action is reached. Putting the
// endpoint at /api/* would have moved it OUTSIDE that firewall and required a
// second copy of the rule.
//
// Account scoping is likewise not re-derived here: authContext is the one
// chokepoint that turns a session into an account for the whole shell, and the
// import acts on that account's own Stripe connection.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);

  const form = await readForm(request, BODY_MAX_BYTES);
  const intent = String(form.get("intent") ?? "");
  if (isWarningIntent(intent)) {
    // A refund cannot be undone, so only the account owner makes one.
    if (intent !== "dismiss_warning" && auth.membership.role !== MEMBER_ROLE.OWNER) {
      return data(
        { efw: { ok: false, message: "Only the account owner can do this." } },
        { status: 403 },
      );
    }
    const result = await runWarningAction(
      env,
      auth.membership.accountId,
      intent,
      String(form.get("warning_id") ?? ""),
    );
    return data(result.data, { status: result.status });
  }
  const posted = form.get("stripe_dispute_id");
  try {
    const result = await importDisputeFromStripe(
      env,
      auth.membership.accountId,
      typeof posted === "string" ? posted : "",
      new Date(),
    );
    return { sync: SYNC_RESULT_MESSAGES[result.status] };
  } catch (err) {
    // A transient Stripe or D1 failure throws (resolveDisputedRecovery's
    // contract) and writes nothing, the same answer the detail page gives.
    logEvent("dispute_sync_failed", { error: errorMessage(err) }, { level: "error" });
    return data(
      { sync: { ok: false, message: "Could not import the dispute. Please try again." } },
      { status: 500 },
    );
  }
}

/** The status tones on Capsomer's pill: won is ok, lost is critical, every
 *  other status has no tone (Capsomer has no blue for Recova's in-progress
 *  states, and the brand accent is amber). */
const PILL_TONE: Record<Tone, PillTone | undefined> = {
  success: "ok",
  failure: "crit",
  neutral: undefined,
};

function WinRateTile({ stats }: { stats: Parameters<typeof winRateCard>[0] }) {
  const { value, subtext } = winRateCard(stats);
  return <StaticStatTile size="lg" label="Win rate" figure={value} detail={subtext} />;
}

export default function Disputes({ loaderData, actionData }: Route.ComponentProps) {
  const { disputes, pagination, stats, health, withEvidence, nowMs, isDemo, isOwner, warnings } =
    loaderData;
  const hasEvidence = new Set(withEvidence);

  return (
    <div className="cap-admin-page gap-0 px-4 md:px-8 py-8 md:py-10" data-width="page">
      <div className="mb-8">
        <PageHead title="Dashboard" />
      </div>

      {/* Recova's grid, five across from md, in Recova's order. Win rate takes
          the place of Recova's "Saved vs Smart Disputes", which is not built
          (Dustin, PR #75 questions 2 and 4; see stats.ts). */}
      <div className="mb-8 [--tiles-columns:repeat(2,minmax(0,1fr))] md:[--tiles-columns:repeat(5,minmax(0,1fr))]">
        <StatTiles layout="grid" label="Dispute figures">
          <StaticStatTile size="lg" label="Open disputes" figure={String(stats.openCount)} />
          <StaticStatTile size="lg" label="At stake" figure={formatAmounts(stats.atStake)} />
          <StaticStatTile
            size="lg"
            label="Submitted by Foxhound"
            figure={String(stats.submittedByFoxhoundCount)}
          />
          <StaticStatTile size="lg" label="Fees owed" figure={formatAmounts(stats.feesOwed)} />
          <WinRateTile stats={stats} />
        </StatTiles>
      </div>

      {pagination.total === 0 ? (
        <Empty kind="nothing-yet" title="No disputes yet.">
          When a customer disputes a charge, Foxhound automatically builds your response.
        </Empty>
      ) : (
        <div className="cap-panel">
          <div className="cap-panel-body" data-flush="">
            <div
              className="cap-table-wrap"
              data-reflow="medium"
              data-cap="table"
              role="region"
              aria-label="Disputes"
              tabIndex={0}
            >
              <table className="cap-table">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col" data-num="">
                      Amount
                    </th>
                    <th scope="col">Reason</th>
                    <th scope="col">Foxhound status</th>
                    <th scope="col">Deadline</th>
                    <th scope="col">
                      <span className="cap-sr-only">View</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {disputes.map((d) => {
                    const resolved = isDisputeResolved(d.state);
                    const days = daysUntilDeadline(d.evidenceDeadline, nowMs);
                    const status = disputeListStatus({
                      state: d.state,
                      submittedBy: d.submittedBy,
                      hasEvidence: hasEvidence.has(d.id),
                      stripeStatus: d.status,
                    });
                    const name = d.customerName || "Unknown";
                    const score = d.stripeCustomerId ? health[d.stripeCustomerId] : undefined;
                    return (
                      <tr key={d.id} data-dispute={d.id}>
                        <td>
                          <div className="fh-small fh-text">
                            {name}
                            {score === undefined ? null : (
                              <span
                                className={`ml-1.5 fh-mono fh-tiny ${healthScoreClassName(score)}`}
                              >
                                <span className="cap-sr-only">Intelligence health score </span>
                                {score}
                              </span>
                            )}
                          </div>
                          <div className="fh-tiny fh-faint">{d.customerEmail || ""}</div>
                        </td>
                        <td data-label="Amount" data-num="">
                          {formatMoney(d.amountCents, d.currency)}
                        </td>
                        <td data-label="Reason" className="fh-small fh-soft">
                          {humanizeDisputeReason(d.reason)}
                        </td>
                        <td data-label="Foxhound status">
                          <Pill tone={PILL_TONE[status.tone]}>{status.label}</Pill>
                        </td>
                        <td
                          data-label="Deadline"
                          className={`fh-mono fh-small ${resolved ? "" : deadlineClassName(deadlineUrgency(days))}`}
                        >
                          {deadlineShort(days, resolved)}
                        </td>
                        <td data-label="View">
                          <Link
                            to={`/disputes/${d.id}`}
                            className="inline-flex min-h-6 items-center fh-small fh-brand no-underline hover:text-brand-text-hover"
                          >
                            View<span className="cap-sr-only"> the dispute from {name}</span>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {pagination.pageCount > 1 ? (
        <div className="mt-4">
          <Pagination
            page={pagination.page}
            pageCount={pagination.pageCount}
            total={pagination.total}
            perPage={pagination.perPage}
            noun="disputes"
            hrefFor={(n) => (n > 1 ? `/disputes/dashboard?page=${n}` : "/disputes/dashboard")}
            label="Dispute pages"
          />
        </div>
      ) : null}

      {/* Legacy renders SyncDisputeLink directly below DisputesDashboardView and
          OUTSIDE its empty-state branch, so it shows on both states. That is
          deliberate on legacy's part and kept here: an account with no disputes
          yet is exactly the one importing a dispute that predates the
          connection. */}
      {warnings ? (
        <EarlyFraudWarnings
          warnings={warnings}
          result={actionData && "efw" in actionData ? actionData.efw : undefined}
          confirmId={actionData && "efwConfirm" in actionData ? actionData.efwConfirm : null}
          readOnly={isDemo}
          canRefund={isOwner}
        />
      ) : null}

      {isDemo ? null : (
        <SyncDisputeLink
          result={actionData && "sync" in actionData ? actionData.sync : undefined}
        />
      )}
    </div>
  );
}
