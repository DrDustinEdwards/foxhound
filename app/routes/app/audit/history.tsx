import { Link } from "react-router";

import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { listAuditRuns } from "~/lib/audit/persist.server";
import { formatCents } from "~/lib/audit/render";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/history";

// Legacy's `/audit/dashboard` (blob `988c190a`, 9,206 bytes), phase (e).
//
// TWO THINGS LEGACY PUTS HERE ARE DELIBERATELY ABSENT.
//
// ITS SETTINGS SECTION IS S30, AND FOXHOUND ALREADY BUILT IT. Legacy renders
// `AuditSettingsForm` (blob `9016a436`) inline, writing `audit_lookback_days`
// and `audit_auto_run`. Foxhound writes both at /settings/audit, built in
// session 30 and ruled at 315. A second form on this page would be a second
// writer for one pair of columns, which is 336 binding 3's defect, so this page
// LINKS to the one that exists.
//
// ITS "RUN NEW AUDIT" BUTTON ARRIVED WITH PHASE (f). This page shipped in (e)
// with a sentence instead, because the route the button names, `/audit/connect`,
// did not exist yet and 329 ruled that a control which cannot do the right thing
// must do nothing rather than the wrong thing. `/audit/connect` is built now, so
// both states carry legacy's button at legacy's destination: "Run first audit"
// on the empty state, "Run new audit" in the populated header.
//
// THE DESTINATION IS THE ANONYMOUS FLOW, AND THAT IS LEGACY'S SHAPE, not an
// oversight. Legacy's signed-in merchant re-authorizes through the same
// `/audit/connect` a stranger uses; the results page then notices the session
// and files the run. Foxhound does the same, with the account check phase (f)
// added on top of it.

export function meta() {
  return [{ title: "Audit history - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const runs = await listAuditRuns(getDb(env), auth.membership.accountId, 10);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      runAt: run.runAt,
      currency: run.currency ?? "usd",
      failedInvoicesCents: run.failedInvoicesCents,
      openDisputesCents: run.openDisputesCents,
      mrrCents: run.mrrCents,
      summary: run.aiSummary,
    })),
  };
}

function formatDate(value: Date): string {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A stored figure, or legacy's own dash when the scope was not read. Legacy
 *  prints a zero here; a zero that means unknown is what 362 ruling 2 forbids. */
function Cell({ cents, currency }: { cents: number | null; currency: string }) {
  if (cents === null) {
    return (
      <span className="text-text-tertiary" title="Could not be read on this run">
        Not read
      </span>
    );
  }
  return <span className="text-text">{formatCents(cents, currency)}</span>;
}

export default function AuditHistory({ loaderData }: Route.ComponentProps) {
  const { runs } = loaderData;
  const last = runs[0];

  if (runs.length === 0) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
        <div className="rounded-xl border border-border bg-surface p-8 text-center md:p-12">
          <h1 className="m-0 mb-2 text-title font-semibold text-text">No audit runs yet</h1>
          <p className="m-0 mb-2 text-label text-text-secondary">
            Run a full diagnostic of your Stripe account.
          </p>
          <p className="m-0 text-caption text-text-tertiary">
            Free, on demand, takes 30 seconds. It reads only.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/audit/connect"
              className="inline-block rounded-md bg-brand px-5 py-2.5 text-label font-semibold text-on-brand no-underline hover:bg-brand-dark"
            >
              Run first audit
            </Link>
            <Link
              to="/settings/audit"
              className="inline-block rounded-md border border-border bg-surface px-5 py-2.5 text-label font-semibold text-text no-underline hover:border-brand"
            >
              Audit settings
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="m-0 text-title font-semibold text-text">Audit history</h1>
          <p className="m-0 mt-1 font-mono text-micro text-text-tertiary">
            Last run {formatDate(last.runAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/settings/audit"
            className="inline-block rounded-md border border-border bg-surface px-5 py-2.5 text-label font-semibold text-text no-underline hover:border-brand"
          >
            Audit settings
          </Link>
          <Link
            to="/audit/connect"
            className="inline-block rounded-md bg-brand px-5 py-2.5 text-label font-semibold text-on-brand no-underline hover:bg-brand-dark"
          >
            Run new audit
          </Link>
        </div>
      </div>

      {last.summary ? (
        <section className="mb-5 rounded-xl border border-border border-l-2 border-l-brand bg-surface p-6">
          <div className="mb-3 font-mono text-micro font-medium uppercase tracking-widest text-brand-text">
            AI Summary
          </div>
          <p className="m-0 text-item-title leading-relaxed text-text">{last.summary}</p>
        </section>
      ) : null}

      <section className="mb-5 rounded-xl border border-border bg-surface p-6">
        <h2 className="m-0 mb-5 text-body font-semibold text-text">History</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-label">
            <thead>
              <tr className="text-left text-text-tertiary">
                <th className="py-2 font-mono text-micro font-medium uppercase tracking-widest">
                  Date
                </th>
                <th className="py-2 text-right font-mono text-micro font-medium uppercase tracking-widest">
                  Failed
                </th>
                <th className="py-2 text-right font-mono text-micro font-medium uppercase tracking-widest">
                  Disputes
                </th>
                <th className="py-2 text-right font-mono text-micro font-medium uppercase tracking-widest">
                  MRR
                </th>
                <th
                  className="py-2 text-right font-mono text-micro font-medium uppercase tracking-widest"
                  aria-label="View"
                />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-border-sub">
                  <td className="py-3 text-text">{formatDate(run.runAt)}</td>
                  <td className="py-3 text-right font-mono">
                    <Cell cents={run.failedInvoicesCents} currency={run.currency} />
                  </td>
                  <td className="py-3 text-right font-mono">
                    <Cell cents={run.openDisputesCents} currency={run.currency} />
                  </td>
                  <td className="py-3 text-right font-mono">
                    <Cell cents={run.mrrCents} currency={run.currency} />
                  </td>
                  <td className="py-3 text-right">
                    <Link
                      to={`/audit/runs/${run.id}`}
                      className="text-label text-brand-text no-underline hover:opacity-80"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
