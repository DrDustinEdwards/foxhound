// Pure presentation helpers for the Intelligence customer directory, separate from the query (views.server.ts) so
// the formatting rules are unit-testable.

import { capitalize } from "@drdustinedwards/site-helpers/text";
import { formatDate } from "capsomer/behavior/time";
import { DAY_MS } from "~/lib/constants";

/** "today" / "yesterday" / "Nd ago" (under 30 days) / "1mo ago" (30 to 59 days) / "Nmo ago". Lowercase. */
export function formatRelativeLastSeen(date: Date | null, now: Date): string {
  if (!date) return "-";
  const days = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}

export function capitalizeTier(tier: string | null): string {
  return tier ? capitalize(tier) : "-";
}

interface RecoverySignalsShape {
  activeRecoveryId?: string | null;
}

/** True when the JSON blob (demo seeder or live sync) indicates a recovery is in progress. */
export function hasActiveRecoverySignal(recoverySignals: unknown): boolean {
  if (!recoverySignals || typeof recoverySignals !== "object") return false;
  const activeRecoveryId = (recoverySignals as RecoverySignalsShape).activeRecoveryId;
  return typeof activeRecoveryId === "string" && activeRecoveryId.length > 0;
}

interface DisputeSignalsShape {
  openDisputesCount?: number;
  wonCount?: number;
  lostCount?: number;
}

export function hasDisputeHistorySignal(disputeSignals: unknown): boolean {
  if (!disputeSignals || typeof disputeSignals !== "object") return false;
  const s = disputeSignals as DisputeSignalsShape;
  return (s.openDisputesCount ?? 0) > 0 || (s.wonCount ?? 0) > 0 || (s.lostCount ?? 0) > 0;
}

export type PlanPillTone = "info" | "nodata";

/** Plan tier as a sentence-case outline pill: starter and hobby in the no-data tone's muted text, growth in the
 *  info tone's blue, scale, pro and anything else with no tone (the strongest text color). An unknown tier is
 *  capitalized, never shown raw. */
export function planTierPill(tier: string | null): { label: string; tone?: PlanPillTone } {
  // current_plan_tier is free text, so "Growth" and " pro " normalize.
  const key = tier?.trim().toLowerCase() ?? null;
  switch (key) {
    case "growth":
      return { label: "Growth", tone: "info" };
    case "scale":
      return { label: "Scale" };
    case "pro":
      return { label: "Pro" };
    default:
      return { label: capitalizeTier(key), tone: "nodata" };
  }
}

/** "Scheduled to cancel on Jan 5, 2026" / "Scheduled to change on ...", from customer_context's
 *  scheduled_change_kind and _at. Null when nothing is scheduled or the date has passed and the next sync has not
 *  caught up, so a stale plan never reads as upcoming. */
export function scheduledChangeLabel(
  kind: string | null,
  at: Date | null,
  now: Date,
): string | null {
  if ((kind !== "cancel" && kind !== "change") || !at || at.getTime() <= now.getTime()) return null;
  return `Scheduled to ${kind} on ${formatDate(at, { style: "medium" }) ?? ""}`;
}
