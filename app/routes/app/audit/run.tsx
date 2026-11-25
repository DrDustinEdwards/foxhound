import { formatDate } from "capsomer/behavior/time";
import type { ReactNode } from "react";
import { CopyButton } from "capsomer/react/copy";
import { ButtonLink } from "capsomer/react/link";
import { PageHead } from "capsomer/react/page-head";
import "capsomer/button.css";
import "capsomer/copy.css";
import "capsomer/page-head.css";

import {
  AuditHealthSection,
  AuditRecoverySection,
  AuditSummary,
} from "~/components/audit/sections";
import { AuditDisputesSection, showDisputesSection } from "~/components/audit/disputes-section";
import { readSavedRunLiveFigures } from "~/lib/audit/live-figures.server";
import { getAuditRun } from "~/lib/audit/persist.server";
import { toStoredAuditRun } from "~/lib/audit/render";
import { accountScope } from "~/lib/auth/context";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/run";
import { noindexMeta } from "~/lib/seo/meta";

// /audit/results/:id, a saved run. The page: the banner (when the run was taken, what the data reflects, Back to history, Run new audit), then the AI summary, Revenue leaking now, Disputes unmanaged when there is a dispute signal, and Business snapshot, fading in one after another. The sections are the live page's (app/components/audit/sections.tsx).
// PRIVATE: the run is read through getAuditRun, which pins the account in the predicate, so another account's id is a 404. "Copy link" opens only for members of the same account, so it is for sharing within a team.
// THE LIVE FIGURES are failed payments in active recovery, the lifetime recovery rate, and the win rate on disputes Foxhound submitted, each read for this account now (app/lib/audit/live-figures.server.ts); every Foxhound account has Recovery and Disputes, so the calls to action are the signed-in ones.
// EVERY FIGURE IS number OR null, NEVER COALESCED: `?? 0` would render a run whose disputes call failed as a merchant with no open disputes.

export const meta = noindexMeta("Audit run - Foxhound");

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env, db, accountId } = accountScope(context);
  const row = await getAuditRun(db, accountId, params.id);
  if (!row) throw new Response("Not Found", { status: 404 });
  // THE RUN IS THE PAGE; THE LIVE FIGURES ARE EXTRAS. A failed read of them is logged whole and the run renders without them, rather than a saved run the merchant cannot open.
  let live: {
    activeSequences: number | null;
    recoveryRatePct: number | null;
    foxhoundWinRate: number | null;
  } = {
    activeSequences: null,
    recoveryRatePct: null,
    foxhoundWinRate: null,
  };
  try {
    live = await readSavedRunLiveFigures(db, accountId, Date.now());
  } catch (err) {
    console.error(`audit run ${params.id}: live figures could not be read`, err);
  }
  return { run: toStoredAuditRun(row), url: `${siteUrl(env)}/audit/results/${row.id}`, ...live };
}

/** Each section fades in as it scrolls into view, Capsomer's reveal (capsomer/reveal.css, CSS only), so the page reads whole without scripts. */
function Reveal({ children }: { children: ReactNode[] }) {
  return (
    <>
      {children.map((child, i) => (
        // The sections are fixed in number and order for one render.
        <div key={i} className="cap-reveal">
          {child}
        </div>
      ))}
    </>
  );
}

export default function AuditRunPage({ loaderData }: Route.ComponentProps) {
  const { run, url, activeSequences, recoveryRatePct, foxhoundWinRate } = loaderData;

  const sections: ReactNode[] = [
    run.summary ? <AuditSummary key="summary" summary={run.summary} /> : null,
    <AuditRecoverySection
      key="recovery"
      run={run}
      ctaState="active"
      activeSequences={activeSequences}
    />,
    showDisputesSection(run) ? (
      <AuditDisputesSection
        key="disputes"
        run={run}
        ctaState="active"
        foxhoundWinRate={foxhoundWinRate}
      />
    ) : null,
    <AuditHealthSection key="health" run={run} recoveryRatePct={recoveryRatePct} />,
  ].filter(Boolean);

  // max-w-[1280px] mx-auto px-4 md:px-8 py-10. The shell owns the page's one <main>.
  return (
    <div className="fh-auditd-page cap-admin-page" data-width="page">
      <div className="fh-auditd-block">
        <PageHead
          title={`This audit was run on ${formatDate(run.runAt, { style: "medium" }) ?? ""}.`}
          actions={
            <>
              <ButtonLink to="/audit/dashboard" variant="link">
                Back to history
              </ButtonLink>
              <CopyButton text={url}>Copy link</CopyButton>
              <ButtonLink to="/audit/connect" variant="primary">
                Run new audit
              </ButtonLink>
            </>
          }
        />
      </div>

      <Reveal>{sections}</Reveal>
    </div>
  );
}
