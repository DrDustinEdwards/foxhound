import type { ReactNode } from "react";
import { Link } from "react-router";
import { PageHead } from "capsomer/react/page-head";
import "capsomer/button.css";
import "capsomer/page-head.css";

import {
  AuditDisputesSection,
  AuditHealthSection,
  AuditRecoverySection,
  AuditSummary,
  showDisputesSection,
} from "~/components/audit/sections";
import { getDb } from "~/db";
import { readSavedRunLiveFigures } from "~/lib/audit/live-figures.server";
import { getAuditRun } from "~/lib/audit/persist.server";
import { toStoredAuditRun } from "~/lib/audit/render";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/run";

// J63 (job_66a3ffa02214), row U4: Recova's saved run, app/audit/results/[id]/
// page.tsx (blob a0dbf6ef, 11,127 bytes), at Recova's own path,
// /audit/results/:id. The old /audit/runs/:id answers one 301 here
// (app/routes/audit/runs-redirect.ts). Read whole at HEAD with
// components/audit/AuditResultsReveal.tsx (7ebadf8c).
//
// RECOVA IS THE SPEC for what is on the page and in what order: the banner
// (when the run was taken, what the data reflects, Back to history, Run new
// audit), then the AI summary, Revenue leaking now, Disputes unmanaged when
// there is a dispute signal, and Business snapshot, fading in one after
// another. The sections are the live page's (app/components/audit/
// sections.tsx), and the look is Capsomer 0.9.0's (Q10 to Q12).
//
// PRIVATE (RULES.md 4.14). The run is read through getAuditRun, which pins
// the account in the predicate, so another account's id is a 404. Recova's
// page is the same (`.eq('account_id', accountId)`). Recova's "Copy link"
// is not built (RULES.md 5.6): it copies a link only the same account can open.
//
// THE LIVE FIGURES ARE RECOVA'S THREE: failed payments in active recovery,
// the lifetime recovery rate, and the win rate on disputes Foxhound submitted,
// each read for this account now (app/lib/audit/live-figures.server.ts). The
// calls to action reflect today's account, as Recova's do, and every
// Foxhound account has Recovery and Disputes, so they are the signed-in ones.
//
// EVERY FIGURE IS number OR null, NEVER COALESCED. Recova maps this row with
// `?? 0` on every column, so a run whose disputes call failed renders as a
// merchant with no open disputes (365 binding 2).

export function meta() {
  return [{ title: "Audit run - Foxhound" }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const row = await getAuditRun(db, accountId, params.id);
  if (!row) throw new Response("Not Found", { status: 404 });
  const live = await readSavedRunLiveFigures(db, accountId, Date.now());
  return { run: toStoredAuditRun(row), ...live };
}

function formatDate(value: Date): string {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Recova's AuditResultsReveal: each section fades in over 200ms, 80ms after
 *  the one before. Done in CSS rather than after hydration, so the page reads
 *  whole without scripts, and the `fade-in` keyframes exist only when the
 *  reader has not asked for reduced motion (app/app.css). */
function Reveal({ children }: { children: ReactNode[] }) {
  return (
    <>
      {children.map((child, i) => (
        <div
          // The sections are fixed in number and order for one render.
          key={i}
          className="audit-reveal"
          style={{ animation: "fade-in 200ms ease-out both", animationDelay: `${i * 80}ms` }}
        >
          {child}
        </div>
      ))}
    </>
  );
}

export default function AuditRunPage({ loaderData }: Route.ComponentProps) {
  const { run, activeSequences, recoveryRatePct, foxhoundWinRate } = loaderData;

  const sections: ReactNode[] = [
    run.summary ? <AuditSummary key="summary" summary={run.summary} /> : null,
    <AuditRecoverySection key="recovery" run={run} ctaState="active" activeSequences={activeSequences} />,
    showDisputesSection(run) ? (
      <AuditDisputesSection key="disputes" run={run} ctaState="active" foxhoundWinRate={foxhoundWinRate} />
    ) : null,
    <AuditHealthSection key="health" run={run} when="stored" recoveryRatePct={recoveryRatePct} />,
  ].filter(Boolean);

  // Recova's column: max-w-[1280px] mx-auto px-4 md:px-8 py-10. The shell owns
  // the page's one <main>.
  return (
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
      <div className="mb-5">
        <PageHead
          title={`This audit was run on ${formatDate(run.runAt)}.`}
          lead="Data reflects your Stripe account at that point in time."
          actions={
            <>
              <Link to="/audit/dashboard" className="cap-btn" data-variant="link">
                Back to history
              </Link>
              <Link to="/audit/connect" className="cap-btn" data-variant="primary">
                Run new audit
              </Link>
            </>
          }
        />
      </div>

      <Reveal>{sections}</Reveal>
    </div>
  );
}
