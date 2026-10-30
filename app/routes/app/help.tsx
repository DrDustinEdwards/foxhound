import type { ReactNode } from "react";
import { Link } from "react-router";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Status, type Tone as StatusTone } from "capsomer/react/status";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/table.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as the legal pages do.
import "~/site-header.css";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatTimeAgo } from "~/lib/date-format";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import {
  getVisibleCronStatus,
  type CronDisplayStatus,
  type CronStatusRow,
} from "~/lib/help/platform-status.server";

import type { Route } from "./+types/help";
import { NOINDEX } from "~/lib/seo/meta";

// /help, ported toward legacy app/(app)/help/page.tsx (row S23).
//
// Ruling 399 re-measured the 394 walk's claims against that REAL file, after
// 398 found the walk had compared against app/recovery/demo/help/page.tsx. Four
// of the walk's S23 items were false and are NOT actioned here: the H1 is
// "Help" on both sides, the container matches, there is no green reassurance
// banner on the real page, and there is no card-geometry divergence. What the
// walk could not see, because the demo twin does not render them, is what this
// commit builds: the Guides section, the Platform status section, the MCP
// connectors table, and the mailto contact block. Common questions goes from
// five differently-titled prose cards to legacy's six question-and-answer
// pairs.
//
// LEGACY'S SECTION ORDER IS KEPT: Common questions, Guides, Platform status,
// Contact. Legacy's raw type values are mapped onto Foxhound's app scale rather
// than ported literally, because 179/187 freeze the type scale in both
// directions; every other class string is legacy's (154).
//
// LOOK FROM CAPSOMER (J13, Dustin's Q10 ruling of 2026-10-14). Content,
// sections, order and the 720px column stay legacy's; the parts are now
// Capsomer 0.9.0's, in the amber family the shell sets, with no Foxhound CSS
// over any of them: PageHead for the H1 and subtitle, a Panel titled by its
// link for each guide card and for the contact block (so every description
// shows in full; row-list's detail line would cut it), Panel around each
// status list, Capsomer's table for the job and connector rows, and Status for each
// cron's state as a glyph, a word and a color. The page also stops rendering
// a second <main> inside the shell's (ruling 146). Where Capsomer's defaults
// differ from legacy's look (radius, hover, type, the status word), the
// difference waits for Capsomer's per-site style layer and is listed with J13.

export function meta() {
  return [{ title: "Help - Foxhound" }, NOINDEX];
}

/**
 * Legacy's six QUICK_ANSWERS, checked one at a time against what Foxhound
 * actually does. Four are legacy's verbatim. TWO ARE REWRITTEN, both class (c)
 * truthfulness, and each names what made legacy's answer false here:
 *
 *   Q1 legacy: "The first email sends within an hour of the failure." False of
 *   Foxhound. Ruling 80 made recovery SILENT-RETRY-FIRST: a soft or network
 *   decline leads with a quiet retry before the customer is emailed at all
 *   (app/lib/recovery/schedule.ts RECOVERY_SCHEDULES). Telling a merchant an
 *   email goes out in the first hour would misdescribe the product's main
 *   selling point.
 *
 *   Q6 legacy: "On any pending email step in a payment timeline, you can also
 *   edit the body directly before it sends." False of Foxhound, and
 *   deliberately so: ruling 304 records Dustin declining to reproduce legacy's
 *   custom-body editor, whose own save path 404s in legacy (row S8). The brand
 *   voice half of the answer IS true and is kept, including per-category tone,
 *   which app/routes/app/settings/brand-voice.tsx renders.
 *
 * The other four were verified rather than assumed: the recovery-rate bands are
 * DESIGN.md's 0-20 red / 21-35 caution (orange) / 36+ green; the payments list really does
 * label a running sequence "Active" (app/lib/recovery/labels.ts); fraud
 * schedules really do carry no retry step; and the payment detail really does
 * render a sent step's subject and body with per-step open and click counts.
 */
export const QUICK_ANSWERS = [
  {
    q: "Why hasn't my payment recovered yet?",
    a: "Recovery sequences run over 30 days. For a soft or network decline Foxhound retries the card quietly first, before your customer is emailed at all, so a payment that would have gone through on its own never turns into a dunning email. An expired card or a suspected fraud block cannot be retried that way, so those lead with the email and its card-update link. Check the payment detail page to see exactly when the next step is scheduled.",
  },
  {
    q: "How do I know if a sequence is running?",
    a: "Go to Recovery, then Payments, and find the payment. If the status shows Active, the sequence is running. The payment detail page shows every step, scheduled, sent, and pending, with exact timestamps.",
  },
  {
    q: "What does the recovery rate percentage mean?",
    a: "Recovery rate is the percentage of failed payments that were successfully recovered during the selected period. Below 21% is low (shown in red), 21-35% is typical (orange), and above 36% is strong (green). Early accounts with few data points will see more variance.",
  },
  {
    q: "Why did a sequence stop before all steps ran?",
    a: "Sequences stop automatically when a payment recovers, remaining steps cancel immediately. They also stop if you use Stop recovery on the payment, if the subscription is canceled, or if the decline is classified as fraud (fraud sequences have no retry steps).",
  },
  {
    q: "How do I see what email was sent to a customer?",
    a: "Go to Recovery, then Payments, click the payment, and open any completed email step in the timeline. The full subject line and email body are shown. Open and click counts are tracked per step.",
  },
  {
    q: "Can I change what the recovery emails say?",
    a: "Yes. Go to Settings, then Brand voice, to change the tone for all emails or per decline category. Foxhound writes each email in that voice when the step sends.",
  },
];

// Platform sits above the four product guides as a full-width card, the same
// hero layout the public docs index uses, so merchants see the same shape on
// both surfaces. Product order matches the docs index: Audit first because it
// is the lowest-friction surface.
//
// Slugs are Foxhound's own /docs routes; the descriptions are legacy's, which
// are terser than the docs index's own and are what legacy's help page renders.
// ONE IS CORRECTED: legacy says the audit has "four scopes" and Foxhound's
// engine has SIX (app/lib/audit/engine.ts). Class (c).
const PLATFORM_GUIDE = {
  href: "/docs/platform",
  title: "Platform",
  desc: "Connecting Stripe, settings, team management, and billing",
};

const PRODUCT_GUIDES = [
  { href: "/docs/audit", title: "Audit", desc: "Free Stripe diagnostic, six scopes" },
  {
    href: "/docs/recovery",
    title: "Recovery",
    desc: "Sequences, payments, dashboard, troubleshooting",
  },
  { href: "/docs/disputes", title: "Disputes", desc: "Evidence building, triage, submission" },
  {
    href: "/docs/intelligence",
    title: "Intelligence",
    desc: "Health scores, churn risk, MRR trends",
  },
];

/**
 * Foxhound's real MCP surface, which is ONE endpoint.
 *
 * Legacy lists two connectors, merchant and admin. Foxhound serves only the
 * merchant one: workers/app.ts matches the single pathname `/mcp` and no
 * `/mcp/admin` exists, so a second row would name an endpoint that is not
 * there. The tool count is ruling 383's measured 23 (15 reads, 8 writes).
 *
 * Legacy's note reads "For Claude.ai". Foxhound never names an AI vendor in
 * user-facing copy (capsid/conventions.md), so the note says what the endpoint
 * is for instead of who makes the client.
 */
const MCP_CONNECTORS = [
  {
    name: "Foxhound Merchant",
    url: "foxhoundapp.com/mcp",
    note: "23 tools, 15 read and 8 write",
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const nowMs = Date.now();
  // Cron status is platform-wide, not per-account, so no account scope filter.
  const crons = await getVisibleCronStatus(getDb(env), nowMs);
  return { crons, nowMs };
}

export default function Help({ loaderData }: Route.ComponentProps) {
  const { crons, nowMs } = loaderData;

  // A div, not a main: the shell's AdminShell owns the page's one main
  // landmark (ruling 146), and every other app page renders inside it the same
  // way. The 720px column and its padding are legacy's page layout.
  return (
    <div className="mx-auto max-w-[720px] px-5 py-10 sm:px-8">
      <div className="mb-8">
        <PageHead title="Help" lead="Quick answers, guides, and platform status." />
      </div>

      {/* Section 1: Quick answers. Prose, so no shared component: a heading and
          its answer on the five text sizes. */}
      <section className="mb-12">
        <h2 className={SECTION_LABEL}>Common questions</h2>
        <div className="space-y-6">
          {QUICK_ANSWERS.map((item) => (
            <div key={item.q}>
              <h3 className="mb-1 text-body font-medium text-text">{item.q}</h3>
              <p className="text-body leading-relaxed text-text-secondary">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Section 2: Docs by product. Each guide is a Capsomer Panel whose h3
          title is the guide link, with the description in the body, the same
          pattern as Contact. Not a row-list row: its detail line never wraps
          and cut legacy's descriptions short, and Recova is the spec for
          content. Legacy's arrangement (Platform full width, the four products
          two to a row from sm) is the page's own grid, one panel per cell, and
          no Capsomer class is restyled. */}
      <section className="mb-12">
        <h2 className={SECTION_LABEL}>Guides</h2>
        <div className="flex flex-col gap-3">
          <GuideCard guide={PLATFORM_GUIDE} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PRODUCT_GUIDES.map((guide) => (
              <GuideCard key={guide.href} guide={guide} />
            ))}
          </div>
        </div>
      </section>

      {/* Section 3: Platform status. Two Capsomer panels, each holding a
          Capsomer table in its named scroll region, flush to the panel's
          edges. Each cron's name is its row header, so a screen reader hears
          the job with its time and its status. */}
      <section className="mb-12">
        <h2 className={SECTION_LABEL}>Platform status</h2>

        <div className="mb-4">
          <StatusTable
            title="Background jobs"
            headingId="help-background-jobs"
            columns={["Job", "Last succeeded", "Status"]}
          >
            {crons.map((cron) => (
              <tr key={cron.cronName}>
                <th scope="row">{cron.label}</th>
                <td>{formatTimeAgo(cron.lastSucceededAt, nowMs)}</td>
                <td>
                  <Status tone={CRON_TONE[cron.status].tone}>{CRON_TONE[cron.status].word}</Status>
                </td>
              </tr>
            ))}
          </StatusTable>
        </div>

        <StatusTable
          title="MCP connectors"
          headingId="help-mcp-connectors"
          columns={["Connector", "Tools", "Status"]}
        >
          {MCP_CONNECTORS.map((c) => (
            <tr key={c.url}>
              <th scope="row">
                {c.name}
                <span className="cap-table-aside">{c.url}</span>
              </th>
              <td>{c.note}</td>
              <td>
                {/* Legacy's green dot says nothing a reader needs (the row
                    existing is the news), so it stays decorative: Capsomer's
                    ok Status with no word, hidden from assistive tech. */}
                <span aria-hidden="true">
                  <Status tone="ok">{null}</Status>
                </span>
              </td>
            </tr>
          ))}
        </StatusTable>
      </section>

      {/* Section 4: Contact. A Capsomer panel titled by the mailto link, the
          sentence in its body. */}
      <section>
        <h2 className={SECTION_LABEL}>Contact</h2>
        <Panel
          title={<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>}
          level={3}
        >
          Email for billing questions, account issues, or anything not covered in the guides.
          Responses within 24 hours on business days.
        </Panel>
      </section>
    </div>
  );
}

/** Legacy's micro uppercase section label, on the five text sizes. A page
 *  heading style, not a shared component, so it stays the page's own. */
const SECTION_LABEL = "mb-6 text-micro font-medium uppercase tracking-widest text-text-tertiary";

/**
 * Legacy's four cron states on Capsomer's status tones. Legacy drew a colored
 * dot only, and the old port put the state in an aria-label on a div, which is
 * prohibited on a generic element and so was never reliably read. Capsomer's
 * Status says it as a glyph, a word and a color together: the word is the
 * accessible text and color is never the only cue. Pending is Capsomer's no
 * data tone, the neutral one, which is legacy's own reading of a cron that has
 * never run (a sentinel, not a level).
 */
const CRON_TONE: Record<CronDisplayStatus, { tone: StatusTone; word: string }> = {
  ok: { tone: "ok", word: "OK" },
  stale: { tone: "warn", word: "Stale" },
  error: { tone: "crit", word: "Error" },
  pending: { tone: "nodata", word: "Pending" },
};

/**
 * A Capsomer Panel holding a Capsomer table, flush to the panel's edges, in a
 * focusable scroll region named by the panel's heading (table.md). The column
 * headers are for assistive tech only (sr-only; Capsomer's base.css, which defines cap-sr-only, is not loaded in the app): legacy's lists show no
 * header row, but each cell still needs its column's name read out.
 */
function StatusTable({
  title,
  headingId,
  columns,
  children,
}: {
  title: string;
  headingId: string;
  columns: [string, string, string];
  children: ReactNode;
}) {
  return (
    <Panel title={title} level={3} headingId={headingId} flush>
      <div
        className="cap-table-wrap"
        data-cap="table"
        role="region"
        aria-labelledby={headingId}
        tabIndex={0}
      >
        <table className="cap-table">
          <thead className="sr-only">
            <tr>
              {columns.map((name) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </Panel>
  );
}

/** One guide card: a Capsomer Panel titled by the guide's link (a React
 *  Router Link, so it is a client-side navigation), the description in the
 *  body, where it wraps and always shows in full. */
function GuideCard({ guide }: { guide: { href: string; title: string; desc: string } }) {
  return (
    <Panel title={<Link to={guide.href}>{guide.title}</Link>} level={3}>
      {guide.desc}
    </Panel>
  );
}

export type { CronStatusRow };
