import { Link } from "react-router";

import { Badge } from "~/components/badge";
import { SyncDisputeLink, type SyncDisputeResult } from "~/components/sync-dispute-link";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import type { DisputeState } from "~/lib/constants";
import { formatDateShort } from "~/lib/date-format";
import {
  DISPUTE_STATE_LABELS,
  daysUntilDeadline,
  deadlineClassName,
  deadlineLabel,
  deadlineUrgency,
  disputeStateTone,
  humanizeDisputeReason,
  isDisputeResolved,
} from "~/lib/disputes/labels";
import { importDisputeFromStripe } from "~/lib/disputes/manual-import.server";
import { listDisputes } from "~/lib/disputes/queries.server";
import { computeDisputeStats } from "~/lib/disputes/stats";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Disputes - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const disputes = await listDisputes(db, auth.membership.accountId);

  // Needs-action disputes surface first (nearest deadline), resolved ones last.
  const sorted = [...disputes].sort((a, b) => {
    const aResolved = isDisputeResolved(a.state);
    const bResolved = isDisputeResolved(b.state);
    if (aResolved !== bResolved) return aResolved ? 1 : -1;
    if (aResolved) return (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0);
    const aDeadline = a.evidenceDeadline?.getTime() ?? Infinity;
    const bDeadline = b.evidenceDeadline?.getTime() ?? Infinity;
    return aDeadline - bDeadline;
  });

  const stats = computeDisputeStats(
    disputes.map((d) => ({
      state: d.state,
      amountCents: d.amountCents,
      resolvedFeeCents: d.resolvedFeeCents,
      submittedAt: d.submittedAt,
    })),
  );

  // One currency for the header aggregates. Disputes are per-currency and the
  // fee cap applies in the dispute's own minor units, so mixing them in a single
  // total would be wrong; the first row's currency is the account's in practice
  // and the per-row cells always render their own.
  const currency = disputes[0]?.currency ?? "usd";

  // Withheld from the demo exactly as legacy withholds it: legacy's demo twin
  // renders DisputesDashboardView alone, and importing a real Stripe dispute
  // into the shared demo account is meaningless. The middleware's method gate
  // is still the boundary for a hand-crafted POST.
  return { disputes: sorted, stats, currency, nowMs: Date.now(), isDemo: auth.isDemo };
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

export default function Disputes({ loaderData, actionData }: Route.ComponentProps) {
  const { disputes, stats, currency, nowMs, isDemo } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Disputes</h1>

      {disputes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No disputes yet. Every chargeback Foxhound is asked to fight will show up here for
          review before anything is submitted.
        </p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Needs action" value={String(stats.needsActionCount)} />
            <StatCard label="At stake" value={formatMoney(stats.atStakeCents, currency)} />
            <StatCard
              label="Win rate"
              value={stats.winRatePct === null ? "-" : `${stats.winRatePct}%`}
              subtext={
                stats.winRatePct === null
                  ? "No disputes resolved yet"
                  : `${stats.wonCount} won of ${stats.wonCount + stats.lostCount} resolved`
              }
            />
            {/* 20% of won disputes capped at $500, and only on disputes Foxhound
                submitted (PRICING.md rev 3). A win the merchant fought carries no
                fee, which is why this can read $0 beside a non-zero win count. */}
            <StatCard
              label="Fees owed"
              value={formatMoney(stats.feesOwedCents, currency)}
              subtext="20% of wins we submitted, capped at $500"
            />
          </div>

          <div className="mt-6 overflow-x-auto rounded-[12px] border border-border bg-surface">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-3 font-normal">Customer</th>
                  <th className="px-4 py-3 font-normal">Amount</th>
                  <th className="px-4 py-3 font-normal">Reason</th>
                  <th className="px-4 py-3 font-normal">State</th>
                  <th className="px-4 py-3 font-normal">Deadline</th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((d) => {
                  const resolved = isDisputeResolved(d.state);
                  const daysLeft = daysUntilDeadline(d.evidenceDeadline, nowMs);
                  const urgency = deadlineUrgency(daysLeft);
                  return (
                    <tr key={d.id} className="border-b border-border-sub last:border-0">
                      <td className="px-4 py-3">
                        <Link to={`/disputes/${d.id}`} className="text-text hover:text-amber">
                          {d.customerName ?? d.customerEmail ?? d.stripeChargeId}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-text">
                        {formatMoney(d.amountCents, d.currency)}
                      </td>
                      <td className="px-4 py-3 text-text-tertiary">
                        {humanizeDisputeReason(d.reason)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={disputeStateTone(d.state as DisputeState)}>
                          {DISPUTE_STATE_LABELS[d.state as DisputeState] ?? d.state}
                        </Badge>
                      </td>
                      {/* A resolved dispute's deadline is history, so it renders
                          plainly with no urgency tone: nothing is owed. */}
                      <td className="px-4 py-3">
                        {d.evidenceDeadline === null ? (
                          <span className="text-text-tertiary">-</span>
                        ) : resolved ? (
                          <span className="text-text-tertiary">
                            {formatDateShort(d.evidenceDeadline)}
                          </span>
                        ) : (
                          <span className={deadlineClassName(urgency)}>
                            {formatDateShort(d.evidenceDeadline)}
                            <span className="ml-2 text-micro">{deadlineLabel(daysLeft)}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
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
