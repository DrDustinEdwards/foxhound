import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";

import { disputes, failedPayments, getDb, stripeConnections } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

import type { Route } from "./+types/hub";

// S24, the settings hub. Ported from legacy's settings/page.tsx (blob
// `55b1445a`, 6,911 bytes).
//
// 336 BINDING 2 IS WHY THIS EXISTS. Foxhound's /settings was a stack of inline
// cards; legacy's is a hub of twelve links over a sub-nav layout, and the prime
// directive makes that the spec. Ruling 57's deferral of the split is
// superseded.
//
// TEN ENTRIES, NOT TWELVE. `/settings/disputes` (S32) and
// `/settings/intelligence` (S35) do not exist here, and a hub entry to a 404 is
// a false promise, so both are omitted and recorded PORTABLE AFTER their row.
// The other ten all resolve.
//
// THE STAT CARDS' QUERIES ARE FOXHOUND'S OWN VOCABULARY, not legacy's strings.
// Legacy counts `failed_payments.status = 'pending'` and disputes
// `status NOT IN (won,lost,accepted)`; Foxhound's equivalents are `status =
// 'active'` and `state NOT IN RESOLVED_DISPUTE_STATES`. The COUNTS mean the same
// thing, which is what the card promises; copying legacy's literals would count
// zero forever.

export function meta() {
  return [{ title: "Settings - Foxhound" }];
}

export interface SettingsHubEntry {
  to: string;
  label: string;
  description: string;
}

/** Legacy's twelve, minus the two whose targets do not exist. Order is
 *  legacy's. */
export const SETTINGS_HUB_ENTRIES: SettingsHubEntry[] = [
  { to: "/settings/stripe", label: "Stripe connections", description: "Connected accounts" },
  { to: "/settings/email", label: "Email", description: "Sender name, reply-to, domain" },
  { to: "/settings/brand-voice", label: "Brand voice", description: "Per-category AI tone" },
  { to: "/settings/features", label: "Features", description: "Win-back, expiring cards" },
  { to: "/settings/audit", label: "Audit", description: "Lookback period, auto-run" },
  { to: "/settings/notifications", label: "Notifications", description: "Email, Slack, digest" },
  { to: "/settings/alerts", label: "Alerts", description: "Metric thresholds" },
  { to: "/settings/team", label: "Team", description: "Members, invite, roles" },
  { to: "/settings/api-keys", label: "API keys", description: "MCP server credentials" },
  { to: "/settings/account", label: "My account", description: "Profile, appearance, sign out" },
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

function StatCard({
  label,
  value,
  sub,
  to,
  dim,
}: {
  label: string;
  value: string;
  sub: string;
  to: string;
  dim?: boolean;
}) {
  return (
    <Link
      to={to}
      className="block rounded-lg border border-border bg-surface p-5 no-underline transition-colors hover:border-brand"
    >
      <div className="mb-2 font-mono text-micro uppercase tracking-widest text-text-tertiary">
        {label}
      </div>
      <div
        className={`font-mono text-h2 font-semibold leading-none [font-variant-numeric:tabular-nums] ${
          dim ? "text-text-tertiary" : "text-text"
        }`}
      >
        {value}
      </div>
      <div className="mt-2 truncate text-caption text-text-tertiary">{sub}</div>
    </Link>
  );
}

function EntryRow({ entry }: { entry: SettingsHubEntry }) {
  return (
    <Link
      to={entry.to}
      className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 no-underline transition-colors hover:border-brand"
    >
      <div>
        <p className="text-label font-medium text-text">{entry.label}</p>
        <p className="mt-0.5 text-caption text-text-tertiary">{entry.description}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" strokeWidth={2} aria-hidden />
    </Link>
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
    connectionCount > 0
      ? (firstStripeUserId ?? "Connected")
      : "Connect Stripe to start recovering";

  return (
    <>
      {/* Mobile: the section list. The sub-nav aside is hidden below md, so
          this is the only navigation on a phone, which is legacy's shape. */}
      <div className="md:hidden">
        <h1 className="mb-6 text-title font-semibold text-text">Settings</h1>
        <nav aria-label="Settings sections">
          <ul className="divide-y divide-border-sub overflow-hidden rounded-xl border border-border-sub bg-surface">
            {SETTINGS_HUB_ENTRIES.map((entry) => (
              <li key={entry.to}>
                <Link
                  to={entry.to}
                  className="flex items-center justify-between px-4 py-4 no-underline transition-colors duration-150 hover:bg-surface-2"
                >
                  <div>
                    <p className="text-label font-medium text-text">{entry.label}</p>
                    <p className="mt-0.5 text-caption text-text-tertiary">{entry.description}</p>
                  </div>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-text-tertiary"
                    strokeWidth={2}
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/* Desktop: the overview. */}
      <div className="hidden md:block">
        <h1 className="mb-1 text-title font-semibold text-text">Settings</h1>
        <p className="mb-6 text-label text-text-tertiary">
          Your account, integrations, and recovery configuration.
        </p>

        <div className="mb-6 grid grid-cols-3 gap-3">
          <StatCard
            label="Stripe"
            value={stripeValue}
            sub={stripeSub}
            to="/settings/stripe"
            dim={connectionCount === 0}
          />
          <StatCard
            label="Active sequences"
            value={activeSequences.toLocaleString()}
            sub="Payments being recovered"
            to="/recovery/payments"
          />
          <StatCard
            label="Open disputes"
            value={openDisputes.toLocaleString()}
            sub={openDisputes > 0 ? `${openDisputes} need response` : "None open"}
            to="/disputes/dashboard"
          />
        </div>

        <p className="mb-3 font-mono text-micro uppercase tracking-widest text-text-tertiary">
          Configuration
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SETTINGS_HUB_ENTRIES.map((entry) => (
            <EntryRow key={entry.to} entry={entry} />
          ))}
        </div>
      </div>
    </>
  );
}
