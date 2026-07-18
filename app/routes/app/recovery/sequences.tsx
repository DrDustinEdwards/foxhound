import { Link } from "react-router";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { DECLINE_CATEGORY_LABELS, formatStepType } from "~/lib/recovery/labels";
import { listActiveFailedPayments, listStepsForFailedPayments } from "~/lib/recovery/queries.server";
import { summarizeSequence } from "~/lib/recovery/sequence-summary";

import type { Route } from "./+types/sequences";

export function meta() {
  return [{ title: "Sequences - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const active = await listActiveFailedPayments(db, accountId);
  const steps = await listStepsForFailedPayments(db, accountId, active.map((f) => f.id));

  const sequences = active.map((failedPayment) => {
    const ownSteps = steps.filter((s) => s.failedPaymentId === failedPayment.id);
    return { failedPayment, summary: summarizeSequence(ownSteps) };
  });

  return { sequences };
}

export default function RecoverySequences({ loaderData }: Route.ComponentProps) {
  const { sequences } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Sequences</h1>

      {sequences.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No sequences in progress. Every failed payment currently being recovered will show up
          here with its next scheduled step.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">Customer</th>
                <th className="px-4 py-3 font-normal">Decline</th>
                <th className="px-4 py-3 font-normal">Progress</th>
                <th className="px-4 py-3 font-normal">Next step</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map(({ failedPayment, summary }) => (
                <tr key={failedPayment.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      to={`/recovery/payments/${failedPayment.id}`}
                      className="text-text hover:text-amber"
                    >
                      {failedPayment.customerName ?? failedPayment.customerEmail}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {DECLINE_CATEGORY_LABELS[
                      failedPayment.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS
                    ] ?? failedPayment.declineCategory}
                  </td>
                  <td className="px-4 py-3 font-mono text-text">
                    {summary.completedCount} of {summary.totalCount}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {summary.nextStep
                      ? `${formatStepType(summary.nextStep.stepType)} · ${summary.nextStep.scheduledAt.toLocaleDateString()}`
                      : "Complete"}
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
