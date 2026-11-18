import { formatCount } from "@drdustinedwards/site-helpers/text";
import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import { Icon, iconChevronRight } from "capsomer/react/icons";
import { routerRenderLink } from "capsomer/react/link";
import { PageHead } from "capsomer/react/page-head";
import { Row, RowList } from "capsomer/react/row-list";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import "capsomer/page-head.css";
import "capsomer/row-list.css";
import "capsomer/stat-tile.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/email does.
import "~/site-header.css";

import { disputes, failedPayments, getDb, stripeConnections } from "~/db";
import { activeConnectionWhere } from "~/lib/stripe/connections.server";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

import type { Route } from "./+types/hub";
import { NOINDEX } from "~/lib/seo/meta";

// S24, the settings hub. Ported from Recova's settings/page.tsx (blob
// `55b1445a`, 6,911 bytes).
//
// 336 BINDING 2 IS WHY THIS EXISTS. Foxhound's /settings was a stack of inline
// cards; Recova's is a hub of twelve links over a sub-nav layout, and the prime
// directive makes that the spec. Ruling 57's deferral of the split is
// superseded.
//
// NINE ENTRIES: Recova's twelve less three combined into others (see
// SETTINGS_HUB_ENTRIES). `/settings/disputes` (S32) arrived with J06, with
// Recova's description "Auto-submit, product description".
//
// TWO DESCRIPTIONS ARE NOT RECOVA'S, because Recova's were untrue (RULES.md
// 1.2). Email's "Sender name, reply-to, domain" promises a sender domain, which
// is deliberately not built; My account's "Profile, appearance,
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
// LOOK FROM CAPSOMER (2026-10-14). The title and its line are
// Capsomer's PageHead, the three figures its StatTiles, and every entry its
// Row, so the sizes are Capsomer's five and the accent amber. Recova's content,
// order and arrangement stay: the phone's one list, the desktop's three
// figures over a two-column grid. Capsomer's RowList is one column, so the
// desktop grid is Recova's two columns of one-row lists; the per-site layer
// (or a RowList column count) is where that belongs, named in the J40 PR.

export function meta() {
  return [{ title: "Settings - Foxhound" }, NOINDEX];
}

export interface SettingsHubEntry {
  to: string;
  label: string;
}

/** Recova's twelve, in Recova's order, less three combined into others
 *  (Dustin, 2026-10-29): Features into Email, Alerts into Notifications, and
 *  Intelligence, which had no working control, removed. */
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

  const [connections, activeRows, disputeRows] = await Promise.all([
    db
      .select({ stripeUserId: stripeConnections.stripeUserId })
      .from(stripeConnections)
      .where(activeConnectionWhere(accountId)),
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

/** One entry as a Capsomer row: the label is the row's one link, with Recova's
 *  chevron in the meta column. */
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
      {/* Phone: the section list. The sub-nav aside is hidden below md, so
          this is the only navigation on a phone, which is Recova's shape. */}
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
