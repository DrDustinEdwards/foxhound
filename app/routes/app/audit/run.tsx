import { Link } from "react-router";

import {
  AuditDisputesSection,
  AuditHealthSection,
  AuditRecoverySection,
  AuditSummary,
} from "~/components/audit/sections";
import { getDb } from "~/db";
import { getAuditRun } from "~/lib/audit/persist.server";
import { toStoredAuditRun } from "~/lib/audit/render";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/run";

// Legacy's `/audit/results/[id]` (blob `a0dbf6ef`, 11,127 bytes), phase (e).
//
// LEGACY'S SHARE LINK IS NOT A SHARE LINK, and that is the walk's finding on the
// question the brief asked. Its page carries a "Copy link" button beside the
// heading, and the page it copies begins `if (!user) redirect('/audit')` and
// then filters `account_id`. So the link works for a teammate on the same
// account and refuses everyone else. Nothing about a stored run was ever
// publicly readable, and Foxhound keeps that: this loader reads through
// `getAuditRun`, which pins the account in the predicate. The copy button is not
// ported, because a control labelled Copy link that produces a link only your
// own account can open is an affordance that lies about what it does.
//
// EVERY FIGURE IS number OR null, NEVER COALESCED. Legacy maps this row with
// `?? 0` on every column, so a run whose disputes call failed renders as a
// merchant with no open disputes. 362 ruling 2 gave the engine a per-scope
// status, 364 stored it as the NULL, and the section components are where it has
// to survive or the other two were decoration.
//
// THE SECTIONS MOVED OUT IN PHASE (f), unchanged, to
// app/components/audit/sections.tsx. The live anonymous results page renders the
// same four, and legacy shares its own four the same way.
//
// THE "RUN NEW AUDIT" CONTROL ARRIVED WITH PHASE (f). Phase (e) shipped a
// sentence here instead of a button because the flow the button names did not
// exist yet (329's rule). It exists now, at /audit/connect, so the button is
// legacy's button pointing at legacy's destination.

export function meta() {
  return [{ title: "Audit run - Foxhound" }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const row = await getAuditRun(getDb(env), auth.membership.accountId, params.id);
  if (!row) throw new Response("Not Found", { status: 404 });
  return { run: toStoredAuditRun(row) };
}

function formatDate(value: Date): string {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function AuditRunPage({ loaderData }: Route.ComponentProps) {
  const { run } = loaderData;

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
      <section className="mb-5 rounded-xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="m-0 text-body font-semibold text-text">
              This audit was run on {formatDate(run.runAt)}.
            </h1>
            <p className="m-0 mt-1 text-label text-text-tertiary">
              It reflects the Stripe account at that point, over the {run.lookbackDays} days before
              it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/audit/dashboard"
              className="inline-block text-label text-text-tertiary no-underline hover:text-text"
            >
              Back to history
            </Link>
            <Link
              to="/audit/connect"
              className="inline-block rounded-md bg-brand px-5 py-2.5 text-label font-semibold text-on-brand no-underline hover:bg-brand-dark"
            >
              Run new audit
            </Link>
          </div>
        </div>
      </section>

      <AuditSummary summary={run.summary} />
      <AuditRecoverySection run={run} />
      <AuditDisputesSection run={run} />
      <AuditHealthSection run={run} />
    </div>
  );
}
