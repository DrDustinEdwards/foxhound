import { formatCount } from "@drdustinedwards/site-helpers/text";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { Icon, iconChevronRight } from "capsomer/react/icons";
import { routerRenderLink } from "capsomer/react/link";
import { PageHead } from "capsomer/react/page-head";
import { Row, RowList } from "capsomer/react/row-list";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import "capsomer/page-head.css";
import "capsomer/row-list.css";
import "capsomer/stat-tile.css";
// Capsomer's tokens and the amber family, which the components above read. The shell loads the same file through its header; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import { disputes, failedPayments, getDb, stripeConnections } from "~/db";
import { countRows } from "~/db/scope";
import { activeConnectionWhere } from "~/lib/stripe/connections.server";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

import type { Route } from "./+types/hub";
import { noindexMeta } from "~/lib/seo/meta";

// The settings hub: nine entries over a sub-nav layout (see SETTINGS_HUB_ENTRIES). The title and its line are Capsomer's PageHead, the three figures its StatTiles, and every entry its Row. The phone shows one list, the desktop three figures over a two-column grid (Capsomer's RowList is one column, so the grid is two columns of one-row lists).
// Two descriptions are deliberately not the obvious ones, because the obvious ones would be untrue: Email's does not promise a sender domain (not built) and My account's does not promise an appearance control.
// THE STAT CARDS' QUERIES USE FOXHOUND'S OWN VOCABULARY: `failed_payments.status = 'active'` and disputes `state NOT IN RESOLVED_DISPUTE_STATES`; copying another schema's literals would count zero forever.

export const meta = noindexMeta("Settings - Foxhound");

export interface SettingsHubEntry {
  to: string;
  label: string;
}

/** The entries, in order: Features is combined into Email, Alerts into Notifications, and Intelligence (no working control) is removed. */
export const SETTINGS_HUB_ENTRIES: SettingsHubEntry[] = [
  { to: "/settings/stripe", label: "Stripe connections" },
  {
    to: "/settings/email",
    label: "Email",
  },
  { to: "/settings/brand-voice", label: "Brand voice" },
  { to: "/settings/disputes", label: "Disputes" },
  { to: "/settings/audit", label: "Audit" },
  {
    to: "/settings/notifications",
    label: "Notifications and alerts",
  },
  { to: "/settings/team", label: "Team" },
  { to: "/settings/api-keys", label: "API keys" },
  { to: "/settings/account", label: "My account" },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);

  const [connections, activeSequences, openDisputes] = await Promise.all([
    db
      .select({ stripeUserId: stripeConnections.stripeUserId })
      .from(stripeConnections)
      .where(activeConnectionWhere(accountId)),
    countRows(
      db,
      failedPayments,
      and(
        eq(failedPayments.accountId, accountId),
        isNull(failedPayments.deletedAt),
        eq(failedPayments.status, "active"),
      ),
    ),
    countRows(
      db,
      disputes,
      and(
        eq(disputes.accountId, accountId),
        notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
      ),
    ),
  ]);

  return {
    connectionCount: connections.length,
    firstStripeUserId: connections[0]?.stripeUserId ?? null,
    activeSequences,
    openDisputes,
  };
}

/** One entry as a Capsomer row: the label is the row's one link, with a chevron in the meta column. */
function EntryRow({ entry }: { entry: SettingsHubEntry }) {
  return (
    <Row
      variant="outline"
      title={entry.label}
      href={entry.to}
      renderLink={routerRenderLink}
      meta={<Icon d={iconChevronRight} className="fh-icon-16" />}
    />
  );
}

export default function SettingsHub({ loaderData }: Route.ComponentProps) {
  const { connectionCount, firstStripeUserId, activeSequences, openDisputes } = loaderData;

  const stripeValue =
    connectionCount > 0
      ? connectionCount === 1
        ? "1 connected"
        : `${connectionCount} connected`
      : "Not connected";
  const stripeSub =
    connectionCount > 0 ? (firstStripeUserId ?? "Connected") : "Connect Stripe to start recovering";

  return (
    <>
      <div className="fh-phone-only">
        <h1 className="fh-hub-title fh-title fh-semibold fh-text">Settings</h1>
        <nav aria-label="Settings sections">
          <RowList label="Settings sections" gap="xs">
            {SETTINGS_HUB_ENTRIES.map((entry) => (
              <EntryRow key={entry.to} entry={entry} />
            ))}
          </RowList>
        </nav>
      </div>

      {/* Desktop: the overview. */}
      <div className="fh-wide-only">
        <div className="fh-hub-block">
          <PageHead title="Settings" />
        </div>

        <div className="fh-hub-block">
          <StatTiles label="Settings overview">
            <StatTile
              href="/settings/stripe"
              renderLink={routerRenderLink}
              label="Stripe"
              figure={stripeValue}
              detail={stripeSub}
            />
            <StatTile
              href="/recovery/dashboard"
              renderLink={routerRenderLink}
              label="Active sequences"
              figure={formatCount(activeSequences)}
              detail="Payments being recovered"
            />
            <StatTile
              href="/disputes/dashboard"
              renderLink={routerRenderLink}
              label="Open disputes"
              figure={formatCount(openDisputes)}
              detail={openDisputes > 0 ? `${openDisputes} need response` : "None open"}
            />
          </StatTiles>
        </div>

        <ul role="list" aria-label="Configuration" className="fh-hub-grid">
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
