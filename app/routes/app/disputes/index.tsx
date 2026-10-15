import { Link } from "react-router";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Pill, type Tone as PillTone } from "capsomer/react/status";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the teal family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /help does.
import "~/site-header.css";

import { SyncDisputeLink, type SyncDisputeResult } from "~/components/sync-dispute-link";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { groupSumByCurrency, type CurrencyAmount } from "~/lib/billing/preview.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import type { DisputeState } from "~/lib/constants";
import {
  DISPUTE_STATE_LABELS,
  daysUntilDeadline,
  deadlineClassName,
  deadlineShort,
  deadlineUrgency,
  disputeStateTone,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import { importDisputeFromStripe } from "~/lib/disputes/manual-import.server";
import { getCustomerHealthScores, listDisputes } from "~/lib/disputes/queries.server";
import { computeDisputeStats } from "~/lib/disputes/stats";
import { healthScoreClassName } from "~/lib/intelligence/health-band";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import type { Tone } from "~/lib/recovery/labels";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/index";

// /disputes (J66, row S13): Recova's disputes dashboard on Foxhound's engine.
// Recova is the spec: app/(app)/disputes/dashboard/page.tsx (blob c97c3e93),
// DisputesDashboardView.tsx (3c1b7a98) and SyncDisputeLink.tsx (d2c2a744). In
// Recova's order: the "Dashboard" head, the stat cards (shown on the empty
// state too), then the empty card or the table, then the sync control, in a
// 1280px column. Look is Capsomer's (Q10), teal (Q11).
//
// Held for Dustin and NOT built (TASK-seven-walked-pages.md item 6): Recova's
// nine status labels (a; the column shows Foxhound's six states), the
// "Submitted by" and "Saved vs Smart Disputes" cards (b), and the Mode and Fee
// columns (c; Mode reflects an auto-submit Foxhound does not have). The
// Recovery cross-sell card is approved as not built (APPROVED-DIFFERENCES,
// 2026-09-19).
//
// The loader is read-only. The one write is the existing manual import action.

export function meta() {
  return [{ title: "Disputes - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);

  // Newest first, as Recova orders the list (created_at descending).
  const [disputes, intelligenceOn] = await Promise.all([
    listDisputes(db, accountId),
    isIntelligenceEntitled(db, accountId),
  ]);

  const parts = computeDisputeStats(
    disputes.map((d) => ({
      state: d.state,
      amountCents: d.amountCents,
      currency: d.currency,
      resolvedFeeCents: d.resolvedFeeCents,
      resolvedFeeCurrency: d.resolvedFeeCurrency,
      submittedAt: d.submittedAt,
    })),
  );
  const stats = {
    openCount: parts.openCount,
    atStake: groupSumByCurrency(parts.atStakeParts),
    feesOwed: groupSumByCurrency(parts.feesOwedParts),
    wonCount: parts.wonCount,
    lostCount: parts.lostCount,
    winRatePct: parts.winRatePct,
  };

  // Recova shows each customer's Intelligence health score beside the name, and
  // only when Intelligence is on. Null means "Intelligence is off", so the
  // page renders no score at all; an empty record means "on, nothing scored".
  const health = intelligenceOn
    ? await getCustomerHealthScores(
        db,
        accountId,
        disputes.map((d) => d.stripeCustomerId).filter((id): id is string => id !== null),
      )
    : null;

  // Withheld from the demo exactly as legacy withholds it: legacy's demo twin
  // renders DisputesDashboardView alone, and importing a real Stripe dispute
  // into the shared demo account is meaningless. The middleware's method gate
  // is still the boundary for a hand-crafted POST.
  return { disputes, stats, health, nowMs: Date.now(), isDemo: auth.isDemo };
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
const RESULT_MESSAGE: Record<string, SyncDisputeResult> = {
  imported: { ok: true, message: "Dispute imported." },
  // Not an error. Either this import already ran or the webhook got there
  // first; both mean the dispute is on the books exactly once.
  already_imported: { ok: true, message: "That dispute is already imported." },
  invalid_id: { ok: false, message: 'Stripe dispute IDs start with "dp_".' },
  not_connected: { ok: false, message: "Connect Stripe before importing a dispute." },
  not_found: { ok: false, message: "No dispute with that ID on your Stripe account." },
};

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);

  const form = await request.formData();
  const posted = form.get("stripe_dispute_id");
  const result = await importDisputeFromStripe(
    env,
    auth.membership.accountId,
    typeof posted === "string" ? posted : "",
    new Date(),
  );
  return { sync: RESULT_MESSAGE[result.status] };
}

/** Each currency's total on its own; none at all reads as zero. */
function amounts(rows: CurrencyAmount[]): string {
  if (rows.length === 0) return formatMoney(0, "usd");
  return rows.map((r) => formatMoney(r.cents, r.currency)).join(" · ");
}

/** Foxhound's three state tones on Capsomer's pill: won is ok, lost is
 *  critical, every state before resolution has no tone. */
const PILL_TONE: Record<Tone, PillTone | undefined> = {
  success: "ok",
  failure: "crit",
  neutral: undefined,
};

export default function Disputes({ loaderData, actionData }: Route.ComponentProps) {
  const { disputes, stats, health, nowMs, isDemo } = loaderData;

  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8 py-8 md:py-10">
      <div className="mb-8">
        <PageHead title="Dashboard" />
      </div>

      {/* Recova's grid, five across from md, kept so each card is Recova's
          width. Two of Recova's five cards are held for Dustin (TASK item 6
          (b)). Win rate is not Recova's: it follows Recova's cards because
          /features names it as evidence (see stats.ts), a question for Dustin. */}
      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Open disputes" value={String(stats.openCount)} />
        <StatCard label="At stake" value={amounts(stats.atStake)} />
        <StatCard label="Fees owed" value={amounts(stats.feesOwed)} />
        <StatCard
          label="Win rate"
          value={stats.winRatePct === null ? "-" : `${stats.winRatePct}%`}
          subtext={
            stats.winRatePct === null
              ? "No disputes resolved yet"
              : `${stats.wonCount} won of ${stats.wonCount + stats.lostCount} resolved`
          }
        />
      </div>

      {disputes.length === 0 ? (
        <Empty kind="nothing-yet" title="No disputes yet.">
          When a customer disputes a charge, Foxhound automatically builds your response.
        </Empty>
      ) : (
        <div className="cap-panel">
          <div className="cap-panel-body" data-flush="">
            <div className="cap-table-wrap" data-cap="table" role="region" aria-label="Disputes" tabIndex={0}>
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
                      <span className="sr-only">View</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {disputes.map((d) => {
                    const resolved = isDisputeResolved(d.state);
                    const days = daysUntilDeadline(d.evidenceDeadline, nowMs);
                    const state = d.state as DisputeState;
                    const name = d.customerName || "Unknown";
                    const score = health && d.stripeCustomerId ? health[d.stripeCustomerId] : undefined;
                    return (
                      <tr key={d.id} data-dispute={d.id}>
                        <td>
                          <div className="text-label text-text">
                            {name}
                            {score === undefined ? null : (
                              <span className={`ml-1.5 font-mono text-micro ${healthScoreClassName(score)}`}>
                                <span className="sr-only">Intelligence health score </span>
                                {score}
                              </span>
                            )}
                          </div>
                          <div className="text-micro text-text-subtle">{d.customerEmail || ""}</div>
                        </td>
                        <td data-num="">{formatMoney(d.amountCents, d.currency)}</td>
                        <td className="text-label text-text-secondary">{humanizeDisputeReason(d.reason)}</td>
                        <td>
                          <Pill tone={PILL_TONE[disputeStateTone(state)]}>
                            {DISPUTE_STATE_LABELS[state] ?? d.state}
                          </Pill>
                        </td>
                        <td
                          className={`font-mono text-label ${resolved ? "" : deadlineClassName(deadlineUrgency(days))}`}
                        >
                          {deadlineShort(days, resolved)}
                        </td>
                        <td>
                          <Link
                            to={`/disputes/${d.id}`}
                            className="inline-flex min-h-6 items-center text-label text-brand-text no-underline hover:text-brand-text-hover"
                          >
                            View<span className="sr-only"> the dispute from {name}</span>
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

      {/* Legacy renders SyncDisputeLink directly below DisputesDashboardView and
          OUTSIDE its empty-state branch, so it shows on both states. That is
          deliberate on legacy's part and kept here: an account with no disputes
          yet is exactly the one importing a dispute that predates the
          connection. */}
      {isDemo ? null : <SyncDisputeLink result={actionData?.sync} />}
    </div>
  );
}
