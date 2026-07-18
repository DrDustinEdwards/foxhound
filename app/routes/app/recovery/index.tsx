import { Link } from "react-router";

import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import { formatMoney } from "~/lib/money-format";
import { isCardExpiringSoon } from "~/lib/recovery/expiring-card";
import {
  listActiveFailedPayments,
  listExpiringCardAlerts,
  listWinbackSequences,
} from "~/lib/recovery/queries.server";
import { WINBACK_STATUS } from "~/lib/recovery/winback";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Recovery - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const now = new Date();

  const [stats, active, winback, expiring] = await Promise.all([
    getRecoveryStats(db, accountId, now.getTime()),
    listActiveFailedPayments(db, accountId),
    listWinbackSequences(db, accountId),
    listExpiringCardAlerts(db, accountId),
  ]);

  return {
    stats,
    activeSequencesCount: active.length,
    winbackActiveCount: winback.filter((w) => w.status === WINBACK_STATUS.ACTIVE).length,
    expiringSoonCount: expiring.filter((e) => isCardExpiringSoon(e.expiresYear, e.expiresMonth, now))
      .length,
  };
}

function LinkCard({
  to,
  title,
  description,
  count,
}: {
  to: string;
  title: string;
  description: string;
  count: number;
}) {
  return (
    <Link
      to={to}
      className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 hover:border-border-i"
    >
      <div className="flex items-center justify-between">
        <p className="text-body font-medium text-text">{title}</p>
        <p className="font-mono text-title text-text">{count}</p>
      </div>
      <p className="text-label text-text-tertiary">{description}</p>
    </Link>
  );
}

export default function RecoveryOverview({ loaderData }: Route.ComponentProps) {
  const { stats, activeSequencesCount, winbackActiveCount, expiringSoonCount } = loaderData;
  const revenue = stats.revenueRecovered[0] ?? null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Recovery</h1>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Revenue recovered"
          value={revenue ? formatMoney(revenue.cents, revenue.currency) : "$0.00"}
        />
        <StatCard label="Recovered payments" value={String(stats.recoveredCount)} />
        <StatCard
          label="Failed payments"
          value={String(stats.activeFailedCount)}
          subtext="Currently in recovery"
        />
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <LinkCard
          to="/recovery/payments"
          title="Payments"
          description="Every failed payment Foxhound has detected."
          count={stats.totalFailedCount}
        />
        <LinkCard
          to="/recovery/sequences"
          title="Sequences"
          description="Recovery sequences in progress."
          count={activeSequencesCount}
        />
        <LinkCard
          to="/recovery/winback"
          title="Win-back"
          description="Active win-back outreach."
          count={winbackActiveCount}
        />
        <LinkCard
          to="/recovery/expiring-cards"
          title="Expiring cards"
          description="Cards expiring soon, before they fail."
          count={expiringSoonCount}
        />
      </section>
    </div>
  );
}
