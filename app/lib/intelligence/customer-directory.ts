// Pure presentation helpers for the Intelligence customer directory
// (TASK-foxhound-intelligence-customer-directory.md). Kept separate from the
// query (views.server.ts) and the route component so the formatting rules
// are unit-testable without a DB or a render tree.

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Today" / "Yesterday" / "Nd ago" (under 30 days) / "1mo ago" / "Nmo ago". */
export function formatRelativeLastSeen(date: Date | null, now: Date): string {
  if (!date) return "-";
  const days = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}

export function capitalizeTier(tier: string | null): string {
  if (!tier) return "-";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

interface RecoverySignalsShape {
  activeRecoveryId?: string | null;
}

/** True when the JSON blob (whatever shape it came from - the demo seeder or
 *  the live intelligence sync) indicates a recovery is currently in progress. */
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

/** True when the customer has ever been party to a dispute (open, won, or lost). */
export function hasDisputeHistorySignal(disputeSignals: unknown): boolean {
  if (!disputeSignals || typeof disputeSignals !== "object") return false;
  const s = disputeSignals as DisputeSignalsShape;
  return (s.openDisputesCount ?? 0) > 0 || (s.wonCount ?? 0) > 0 || (s.lostCount ?? 0) > 0;
}

/** Stub for the J30 red run; built in the next commit. */
export function planTierPill(tier: string | null): { label: string; tone?: "info" | "nodata" } {
  return { label: tier === null ? "" : "" };
}
