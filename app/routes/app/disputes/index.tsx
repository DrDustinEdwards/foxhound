import { Link } from "react-router";

import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import type { DisputeState } from "~/lib/constants";
import { DISPUTE_STATE_LABELS, disputeStateTone, isDisputeResolved } from "~/lib/disputes/labels";
import { listDisputes } from "~/lib/disputes/queries.server";
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

  return { disputes: sorted };
}

export default function Disputes({ loaderData }: Route.ComponentProps) {
  const { disputes } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Disputes</h1>

      {disputes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No disputes yet. Every chargeback Foxhound is asked to fight will show up here for
          review before anything is submitted.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
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
              {disputes.map((d) => (
                <tr key={d.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <Link to={`/disputes/${d.id}`} className="text-text hover:text-amber">
                      {d.customerName ?? d.customerEmail ?? d.stripeChargeId}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-text">{formatMoney(d.amountCents, d.currency)}</td>
                  <td className="px-4 py-3 text-text-tertiary">{d.reason}</td>
                  <td className="px-4 py-3">
                    <Badge tone={disputeStateTone(d.state as DisputeState)}>
                      {DISPUTE_STATE_LABELS[d.state as DisputeState] ?? d.state}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {d.evidenceDeadline ? d.evidenceDeadline.toLocaleDateString() : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
