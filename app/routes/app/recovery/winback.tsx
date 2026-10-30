import { Badge, type BadgeTone } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatMoney } from "~/lib/money-format";
import { listWinbackSequences } from "~/lib/recovery/queries.server";
import { WINBACK_STATUS } from "~/lib/recovery/winback";

import type { Route } from "./+types/winback";
import { NOINDEX } from "~/lib/seo/meta";

export function meta() {
  return [{ title: "Win-back - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const sequences = await listWinbackSequences(db, auth.membership.accountId);
  return { sequences };
}

const STATUS_LABEL: Record<string, string> = {
  [WINBACK_STATUS.ACTIVE]: "Active",
  [WINBACK_STATUS.REACTIVATED]: "Reactivated",
  [WINBACK_STATUS.EXHAUSTED]: "Exhausted",
  [WINBACK_STATUS.RESOLVED]: "Resolved",
};

// Purple is reserved for win-back attribution (DESIGN.md): a reactivated
// sequence is the one place outside Stripe Connect UI that color appears.
function statusTone(status: string): BadgeTone {
  return status === WINBACK_STATUS.REACTIVATED ? "purple" : "neutral";
}

export default function Winback({ loaderData }: Route.ComponentProps) {
  const { sequences } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Win-back</h1>

      {sequences.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No cancellations yet. Foxhound reaches out to every customer who cancels, and lists them
          here.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">Customer</th>
                <th className="px-4 py-3 font-normal">Plan</th>
                <th className="px-4 py-3 font-normal">Canceled</th>
                <th className="px-4 py-3 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((seq) => (
                <tr key={seq.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <p className="text-text">{seq.customerName ?? seq.customerEmail}</p>
                    <p className="text-micro text-text-subtle">{seq.customerEmail}</p>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {seq.planName ?? "-"}
                    {seq.amountCents != null && seq.currency ? (
                      <span className="ml-2 font-mono text-text">
                        {formatMoney(seq.amountCents, seq.currency)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">{seq.createdAt.toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <Badge tone={statusTone(seq.status)}>{STATUS_LABEL[seq.status] ?? seq.status}</Badge>
                      {seq.status === WINBACK_STATUS.REACTIVATED && seq.reactivatedAt ? (
                        <span className="text-micro text-text-subtle">
                          Won back {seq.reactivatedAt.toLocaleDateString()}
                        </span>
                      ) : null}
                    </div>
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
