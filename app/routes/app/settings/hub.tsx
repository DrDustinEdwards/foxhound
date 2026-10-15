import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { PageHead } from "capsomer/react/page-head";
import { Row, RowList, type RowLinkProps } from "capsomer/react/row-list";
import { StatTile, StatTiles, type StatTileLinkProps } from "capsomer/react/stat-tile";
import "capsomer/page-head.css";
import "capsomer/row-list.css";
import "capsomer/stat-tile.css";
// Capsomer's tokens and the teal family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/email does.
import "~/site-header.css";

import { disputes, failedPayments, getDb, stripeConnections } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

import type { Route } from "./+types/hub";

// S24, the settings hub. Ported from Recova's settings/page.tsx (blob
// `55b1445a`, 6,911 bytes).
//
// 336 BINDING 2 IS WHY THIS EXISTS. Foxhound's /settings was a stack of inline
// cards; Recova's is a hub of twelve links over a sub-nav layout, and the prime
// directive makes that the spec. Ruling 57's deferral of the split is
// superseded.
//
// TEN ENTRIES, NOT TWELVE. `/settings/disputes` (S32) and
// `/settings/intelligence` (S35) do not exist here, and a hub entry to a 404 is
// a false promise (RULES.md 2.7), so both are omitted and recorded PORTABLE
// AFTER their row. The other ten all resolve.
//
// TWO DESCRIPTIONS ARE NOT RECOVA'S, because Recova's were untrue (RULES.md
// 1.2). Email's "Sender name, reply-to, domain" promises a sender domain, which
// is deliberately not built (RULES.md 5.6); My account's "Profile, appearance,
// sign out" promises an appearance control neither Recova's account page nor
// Foxhound's has (parity/S-CLOSEOUT.md, reversal 5).
//
// THE STAT CARDS' QUERIES ARE FOXHOUND'S OWN VOCABULARY, not Recova's strings.
// Recova counts `failed_payments.status = 'pending'` and disputes
// `status NOT IN (won,lost,accepted)`; Foxhound's equivalents are `status =
// 'active'` and `state NOT IN RESOLVED_DISPUTE_STATES`. The COUNTS mean the same
// thing, which is what the card promises; copying Recova's literals would count
// zero forever.
//
// LOOK FROM CAPSOMER (J40; Q10, Q11, 2026-10-14). The title and its line are
// Capsomer's PageHead, the three figures its StatTiles, and every entry its
// Row, so the sizes are Capsomer's five and the accent teal. Recova's content,
// order and arrangement stay: the phone's one list, the desktop's three
// figures over a two-column grid. Capsomer's RowList is one column, so the
// desktop grid is Recova's two columns of one-row lists; the per-site layer
// (or a RowList column count) is where that belongs, named in the J40 PR.

export function meta() {
  return [{ title: "Settings - Foxhound" }];
}

export interface SettingsHubEntry {
  to: string;
  label: string;
  description: string;
}

/** Recova's twelve, minus the two whose targets do not exist. Order is
 *  Recova's. */
export const SETTINGS_HUB_ENTRIES: SettingsHubEntry[] = [
  { to: "/settings/stripe", label: "Stripe connections", description: "Connected accounts" },
  { to: "/settings/email", label: "Email", description: "Sender name, reply-to" },
  { to: "/settings/brand-voice", label: "Brand voice", description: "Per-category AI tone" },
  { to: "/settings/features", label: "Features", description: "Win-back, expiring cards" },
  { to: "/settings/audit", label: "Audit", description: "Lookback period, auto-run" },
  { to: "/settings/notifications", label: "Notifications", description: "Email, Slack, digest" },
  { to: "/settings/alerts", label: "Alerts", description: "Metric thresholds" },
  { to: "/settings/team", label: "Team", description: "Members, invite, roles" },
  { to: "/settings/api-keys", label: "API keys", description: "MCP server credentials" },
  { to: "/settings/account", label: "My account", description: "Profile, sign out" },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);

  const [connections, activeRows, disputeRows] = await Promise.all([
    db
      .select({ stripeUserId: stripeConnections.stripeUserId })
      .from(stripeConnections)
      .where(
        and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)),
      ),
    db
      .select({ n: count() })
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.accountId, accountId),
          isNull(failedPayments.deletedAt),
          eq(failedPayments.status, "active"),
        ),
      ),
    db
      .select({ n: count() })
      .from(disputes)
      .where(
        and(
          eq(disputes.accountId, accountId),
          notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
        ),
      ),
  ]);

  return {
    connectionCount: connections.length,
    firstStripeUserId: connections[0]?.stripeUserId ?? null,
    activeSequences: activeRows[0]?.n ?? 0,
    openDisputes: disputeRows[0]?.n ?? 0,
  };
}

const rowLink = ({ href, children, ...rest }: RowLinkProps) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);

// A Capsomer tile is a link; each figure opens the page behind it, as Recova's did.
const tileLink = ({ href, children, ...rest }: StatTileLinkProps) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);

/** One entry as a Capsomer row: the label is the row's one link, the
 *  description its detail, and Recova's chevron in the meta column. */
function EntryRow({ entry }: { entry: SettingsHubEntry }) {
  return (
    <Row
      variant="outline"
      title={entry.label}
      href={entry.to}
      renderLink={rowLink}
      detail={entry.description}
      meta={<ChevronRight className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />}
    />
  );
}

const CONFIG_HEADING_ID = "settings-configuration-heading";

export default function SettingsHub({ loaderData }: Route.ComponentProps) {
  const { connectionCount, firstStripeUserId, activeSequences, openDisputes } = loaderData;

  const stripeValue =
    connectionCount > 0
      ? connectionCount === 1
        ? "1 connected"
        : `${connectionCount} connected`
      : "Not connected";
  const stripeSub =
    connectionCount > 0
      ? (firstStripeUserId ?? "Connected")
      : "Connect Stripe to start recovering";

  return (
    <>
      {/* Phone: the section list. The sub-nav aside is hidden below md, so
          this is the only navigation on a phone, which is Recova's shape. */}
      <div className="md:hidden">
        <h1 className="mb-6 text-title font-semibold text-text">Settings</h1>
        <nav aria-label="Settings sections">
          <RowList label="Settings sections" gap="xs">
            {SETTINGS_HUB_ENTRIES.map((entry) => (
              <EntryRow key={entry.to} entry={entry} />
            ))}
          </RowList>
        </nav>
      </div>

      {/* Desktop: the overview. */}
      <div className="hidden md:block">
        <div className="mb-6">
          <PageHead title="Settings" lead="Your account, integrations, and recovery configuration." />
        </div>

        <div className="mb-6">
          <StatTiles label="Settings overview">
            <StatTile
              href="/settings/stripe"
              renderLink={tileLink}
              label="Stripe"
              figure={stripeValue}
              detail={stripeSub}
            />
            <StatTile
              href="/recovery/dashboard"
              renderLink={tileLink}
              label="Active sequences"
              figure={activeSequences.toLocaleString()}
              detail="Payments being recovered"
            />
            <StatTile
              href="/disputes/dashboard"
              renderLink={tileLink}
              label="Open disputes"
              figure={openDisputes.toLocaleString()}
              detail={openDisputes > 0 ? `${openDisputes} need response` : "None open"}
            />
          </StatTiles>
        </div>

        {/* Recova's "Configuration" is a plain paragraph over the grid; here it
            is the heading that names the grid (RULES.md 1.5). */}
        <h2
          id={CONFIG_HEADING_ID}
          className="mb-3 font-mono text-micro font-normal uppercase tracking-widest text-text-tertiary"
        >
          Configuration
        </h2>
        <ul role="list" aria-labelledby={CONFIG_HEADING_ID} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SETTINGS_HUB_ENTRIES.map((entry) => (
            <li key={entry.to}>
              <RowList>
                <EntryRow entry={entry} />
              </RowList>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
