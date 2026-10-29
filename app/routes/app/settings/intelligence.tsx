import type { ReactNode } from "react";
import { Link } from "react-router";
import { PageHead } from "capsomer/react/page-head";
import { Status } from "capsomer/react/status";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/features does.
import "~/site-header.css";

import { SettingsBackLink } from "~/components/settings-back-link";
import { ALERT_METRIC_LABELS } from "~/lib/settings/alert-metrics";

// S35, /settings/intelligence (J69, job_c7d73b4f3c1c).
//
// RECOVA IS THE SPEC, read whole at HEAD:
//   app/(app)/settings/intelligence/page.tsx               blob d9800b0f  2,122 bytes
//   app/(app)/settings/components/IntelligenceSection.tsx  blob ec9ed981  5,000 bytes
//   app/api/settings/intelligence-preferences/route.ts     blob 7527dd4d  2,884 bytes
//
// RECOVA HAD NO READER EITHER (J69 review, 2026-10-15). Across the whole
// recova repo and recova-mcp, intelligence_notification_preferences appears
// only in the page's select and the PATCH route's upsert (plus docs); no
// supabase migration names it, so no trigger reads it. The cron that once read
// it, /api/cron/weekly-intelligence-pulse, is gone: vercel.json at HEAD has no
// such cron, app/api/cron/ has no such directory, docs/context.md:207 says it
// was "removed from vercel.json", and docs/features-complete.md:518 marks it
// "DEPRECATED no-op" (docs/features.md:202 still lists it, stale). Recova's
// alerts did send, but through lib/alert-evaluation.ts:285-306, 419, from each
// alert's own channel and the account's notification_email and
// slack_webhook_url (the /settings/alerts surface, S28), never from these
// preferences. So Recova's five toggles were controls with no reader too, and
// there is no Recova source to port for them.
//
// RECOVA'S FIVE CONTROLS ARE NOT BUILT, because nothing in Foxhound reads them
// (RULES.md 3.18, 2.7). They are the weekly MRR and health summary by email
// and by Slack, the per-customer health score threshold, and health alerts by
// email and by Slack, all in intelligence_notification_preferences. Foxhound's
// schema has that table; only account deletion touches it. Foxhound sends no
// weekly Intelligence email or Slack post (the narrative is nightly and stays
// on the dashboard and Reports), and its alert evaluator records breaches in
// alert_history without sending anything (app/lib/intelligence/alerts.ts).
// A switch here would save a choice nothing honors, so the page names each
// delivery as not built, where Recova had its checkbox, and points at the
// nearest thing that is built. With no control there is nothing to save, so
// there is no SaveBar and no action. The day a reader exists, the control goes
// here.
//
// ONE LINE OF RECOVA'S COPY IS MADE TRUE (RULES.md 1.2). Its lead,
// "Control which Intelligence outputs are delivered to you, and where they
// go.", promises controls this page cannot have yet, so it loses "Control".
// Recova's inactive notice ("Enable from billing") is gone: Intelligence is free
// on every account (Dustin, 2026-10-29), so the page is always the active one.
//
// LOOK FROM CAPSOMER (Q10, Q11, 2026-10-14): PageHead, a Panel's card and
// Status, amber throughout. Recova's arrangement stays: the phone-only back
// link, the title and its line, then one card. Capsomer 0.9.0 has no
// "not built" row (a label and help on the left, a state on the right), so
// the rows are the same markup /settings/features uses for its toggle rows,
// with Status where the toggle was; named in the J69 PR for the per-site layer.

export function meta() {
  return [{ title: "Intelligence settings - Foxhound" }];
}

// Underlined at rest, not only on hover, because these links sit inside
// sentences and color alone does not set them apart (WCAG 1.4.1; axe
// link-in-text-block caught it on the rendered page).
const linkClass = "text-brand-text underline underline-offset-2 hover:text-text";

/** One of Recova's deliveries: its name and what is built instead on the left,
 *  where Recova put the checkbox's label, and the state on the right. */
function DeliveryRow({
  label,
  first,
  children,
}: {
  label: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={`flex items-start justify-between gap-4 py-4${first ? "" : " border-t border-border"}`}>
      <div>
        <p className="mb-0.5 text-label text-text">{label}</p>
        <p className="text-micro text-text-subtle">{children}</p>
      </div>
      <span className="shrink-0">
        <Status tone="nodata">Not built</Status>
      </span>
    </li>
  );
}

export default function IntelligenceSettings() {
  return (
    <>
      <SettingsBackLink />
      {/* Recova's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead title="Intelligence" lead="Which Intelligence outputs are delivered to you, and where they go." />
      </div>

      <section className="cap-panel">
        <div className="cap-panel-body">
          <p className="text-label text-text-secondary">
            Foxhound does not deliver Intelligence outputs to you yet, so there is nothing to set here.
          </p>
          <ul className="mt-2">
            <DeliveryRow first label="Weekly MRR and health summary, by email or Slack">
              The nightly narrative is on the{" "}
              <Link to="/intelligence/dashboard" className={linkClass}>
                Intelligence dashboard
              </Link>
              , and each month keeps its own under{" "}
              <Link to="/intelligence/reports" className={linkClass}>
                Reports
              </Link>
              .
            </DeliveryRow>
            <DeliveryRow label="Alert when a customer's health score drops below a threshold, by email or Slack">
              <Link to="/settings/alerts" className={linkClass}>
                Settings and Alerts
              </Link>{" "}
              can alert on {ALERT_METRIC_LABELS.health_score_avg}, across your scored customers. Foxhound records each breach on that page and emails it to your notification address; it does not post alerts to Slack.
            </DeliveryRow>
          </ul>
        </div>
      </section>
    </>
  );
}
