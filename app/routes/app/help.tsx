import { relative } from "capsomer/behavior/time";
import { Table } from "capsomer/react/table";
import type { ReactNode } from "react";
import { routerRenderLink } from "capsomer/react/link";
import { Icon, iconChevronRight } from "capsomer/react/icons";
import { Row, RowList } from "capsomer/react/row-list";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Status, type Tone as StatusTone } from "capsomer/react/status";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/table.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family, which the components above read. The shell loads the same file through its header; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RECOVERY_RATE_CAUTION_MAX, RECOVERY_RATE_RED_MAX } from "~/lib/dashboard/recovery-rate";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import {
  getVisibleCronStatus,
  type CronDisplayStatus,
  type CronStatusRow,
} from "~/lib/help/platform-status.server";

import type { Route } from "./+types/help";
import { NOINDEX } from "~/lib/seo/meta";

// /help: the H1, then Common questions, Guides, Platform status and Contact, in a 720px column. The parts are Capsomer's with no Foxhound CSS over them: PageHead for the H1 and subtitle, a Panel titled by its link for each guide card and for the contact block (so every description shows in full; row-list's detail line would cut it), Panel around each status list, Capsomer's table for the job and connector rows, and Status for each cron's state as a glyph, a word and a color. The page renders no second <main> inside the shell's.

export function meta() {
  return [{ title: "Help - Foxhound" }, NOINDEX];
}

/** The six quick answers, each checked against what Foxhound actually does. Two differ from the obvious wording: (1) recovery is SILENT-RETRY-FIRST, so a soft or network decline leads with a quiet retry before the customer is emailed at all (app/lib/recovery/schedule.ts RECOVERY_SCHEDULES), which "the first email sends within an hour" would misdescribe; (6) there is no per-step body editor, so only the brand voice half of that answer is kept, including per-category tone (app/routes/app/settings/brand-voice.tsx). The recovery-rate bands are DESIGN.md's 0-20 red / 21-35 caution (orange) / 36+ green; the payments list labels a running sequence "Active" (app/lib/recovery/labels.ts); fraud schedules carry no retry step; and the payment detail renders a sent step's subject and body with per-step open and click counts. */
export const QUICK_ANSWERS = [
  {
    q: "Why hasn't my payment recovered yet?",
    a: `Recovery sequences run over ${RECOVERY_SEQUENCE_DAYS} days. For a soft or network decline Foxhound retries the card quietly first, before your customer is emailed at all, so a payment that would have gone through on its own never turns into a dunning email. An expired card or a suspected fraud block cannot be retried that way, so those lead with the email and its card-update link. Check the payment detail page to see exactly when the next step is scheduled.`,
  },
  {
    q: "How do I know if a sequence is running?",
    a: "Go to Recovery, then Payments, and find the payment. If the status shows Active, the sequence is running. The payment detail page shows every step, scheduled, sent, and pending, with exact timestamps.",
  },
  {
    q: "What does the recovery rate percentage mean?",
    a: `Recovery rate is the percentage of failed payments that were successfully recovered during the selected period. Up to ${RECOVERY_RATE_RED_MAX}% is low (shown in red), ${RECOVERY_RATE_RED_MAX + 1}-${RECOVERY_RATE_CAUTION_MAX}% is typical (amber), and above ${RECOVERY_RATE_CAUTION_MAX}% is strong (green). Early accounts with few data points will see more variance.`,
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

// Platform sits above the four product guides as a full-width card, the same hero layout the public docs index uses. Product order matches the docs index: Audit first because it is the lowest-friction surface. Slugs are Foxhound's own /docs routes.
const PLATFORM_GUIDE = {
  href: "/docs/platform",
  title: "Platform",
};

const PRODUCT_GUIDES = [
  { href: "/docs/audit", title: "Audit" },
  {
    href: "/docs/recovery",
    title: "Recovery",
  },
  { href: "/docs/disputes", title: "Disputes" },
  {
    href: "/docs/intelligence",
    title: "Intelligence",
  },
];

/** Foxhound's real MCP surface is ONE endpoint: workers/app.ts matches the single pathname `/mcp` and no `/mcp/admin` exists, so a second row would name an endpoint that is not there. The tool counts come from the registry in the loader. The note says what the endpoint is for, never an AI vendor's name (capsid/conventions.md). */
const MCP_CONNECTOR = { name: "Foxhound Merchant", url: "foxhoundapp.com/mcp" };

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const nowMs = Date.now();
  // Cron status is platform-wide, not per-account, so no account scope filter.
  const crons = await getVisibleCronStatus(getDb(env), nowMs);
  // Imported here, as /features does, so the MCP graph stays off every other page.
  const { MERCHANT_TOOL_NAMES, MERCHANT_WRITE_TOOL_NAMES } = await import("~/lib/mcp/tools.server");
  const writes = MERCHANT_WRITE_TOOL_NAMES.length;
  return {
    crons,
    nowMs,
    mcpNote: `${MERCHANT_TOOL_NAMES.length} tools, ${MERCHANT_TOOL_NAMES.length - writes} read and ${writes} write`,
  };
}

export default function Help({ loaderData }: Route.ComponentProps) {
  const { crons, nowMs, mcpNote } = loaderData;

  // A div, not a main: AdminShell owns the page's one main landmark. The 720px column and its padding are the page layout.
  return (
    <div className="fh-help">
      <div className="fh-help-head">
        <PageHead title="Help" />
      </div>

      {/* Section 1: Quick answers. Prose, so no shared component: a heading and
          its answer on the five text sizes. */}
      <section className="fh-help-section">
        <h2 className={SECTION_LABEL}>Common questions</h2>
        <div className="fh-help-faq">
          {QUICK_ANSWERS.map((item) => (
            <div key={item.q}>
              <h3 className="fh-help-question fh-body fh-medium fh-text">{item.q}</h3>
              <p className="fh-body fh-relaxed fh-soft">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Section 2: Docs by product, one row per guide. */}
      <section className="fh-help-section">
        <h2 className={SECTION_LABEL}>Guides</h2>
        <RowList label="Guides" gap="xs">
          {[PLATFORM_GUIDE, ...PRODUCT_GUIDES].map((guide) => (
            <Row
              key={guide.href}
              variant="outline"
              title={guide.title}
              href={guide.href}
              renderLink={routerRenderLink}
              meta={<Icon d={iconChevronRight} className="fh-icon-16" />}
            />
          ))}
        </RowList>
      </section>

      {/* Section 3: Platform status. Two Capsomer panels, each holding a
          Capsomer table in its named scroll region, flush to the panel's
          edges. Each cron's name is its row header, so a screen reader hears
          the job with its time and its status. */}
      <section className="fh-help-section">
        <h2 className={SECTION_LABEL}>Platform status</h2>

        <div className="fh-help-contact">
          <StatusTable
            title="Background jobs"
            headingId="help-background-jobs"
            columns={["Job", "Last succeeded", "Status"]}
          >
            {crons.map((cron) => (
              <tr key={cron.cronName}>
                <th scope="row">{cron.label}</th>
                <td data-label="Last succeeded">
                  {cron.lastSucceededAt
                    ? relative(cron.lastSucceededAt.getTime(), nowMs, "UTC")
                    : "never"}
                </td>
                <td data-label="Status">
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
          {[MCP_CONNECTOR].map((c) => (
            <tr key={c.url}>
              <th scope="row">
                {c.name}
                <span className="cap-table-aside">{c.url}</span>
              </th>
              <td data-label="Tools">{mcpNote}</td>
              <td data-label="Status">
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

      {/* Section 4: Contact. A Capsomer panel with the mailto link in its body. */}
      <section>
        <h2 className={SECTION_LABEL}>Contact</h2>
        <Panel title="Support" level={3}>
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </Panel>
      </section>
    </div>
  );
}

/** The micro uppercase section label, on the five text sizes. A page heading style, not a shared component. */
const SECTION_LABEL = "fh-help-label fh-tiny fh-medium fh-caps-wide fh-quiet";

/** The four cron states on Capsomer's status tones. Capsomer's Status says it as a glyph, a word and a color together: the word is the accessible text and color is never the only cue. Pending is Capsomer's neutral no-data tone, for a cron that has never run (a sentinel, not a level). */
const CRON_TONE: Record<CronDisplayStatus, { tone: StatusTone; word: string }> = {
  ok: { tone: "ok", word: "OK" },
  stale: { tone: "warn", word: "Stale" },
  error: { tone: "crit", word: "Error" },
  pending: { tone: "nodata", word: "Pending" },
};

/** A Capsomer Panel holding a Capsomer table, flush to the panel's edges, in a focusable scroll region named by the panel's heading (table.md). The column headers are for assistive tech only (sr-only; Capsomer's base.css, which defines cap-sr-only, is not loaded in the app): each cell still needs its column's name read out. */
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
      <Table caption={title} captionHidden labelledBy={headingId} reflow>
        <thead className="cap-sr-only">
          <tr>
            {columns.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </Table>
    </Panel>
  );
}

export type { CronStatusRow };
