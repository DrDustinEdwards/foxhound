// Pure presentation helpers for the Intelligence customer directory
// (TASK-foxhound-intelligence-customer-directory.md). Kept separate from the
// query (views.server.ts) and the route component so the formatting rules
// are unit-testable without a DB or a render tree.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Recova's lastSeenLabel (lib/intelligence-display.ts, blob 379635a7) word
 *  for word: "today" / "yesterday" / "Nd ago" (under 30 days) / "1mo ago"
 *  (30 to 59 days) / "Nmo ago". Lowercase, as Recova's are. */
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

/** Capsomer status tones a plan pill may carry. */
export type PlanPillTone = "info" | "nodata";

/** Recova's planTierBadge (app/(app)/intelligence/customers/page.tsx, blob
 *  0413f035): starter, growth, scale, pro and hobby in sentence case, each in
 *  a rounded outline pill with one of three colours. Recova's colours were
 *  subtle (starter, hobby, anything else), blue (growth) and the old warm
 *  accent (scale, pro). With teal throughout (Q11), the ranks map onto
 *  Capsomer's outline pill: the no-data tone's muted text, the info tone's
 *  blue, and no tone at all, which is the strongest text colour. An unknown
 *  tier is capitalised, where Recova showed the raw value (RULES 1.5). */
export function planTierPill(tier: string | null): { label: string; tone?: PlanPillTone } {
  // current_plan_tier is free text (SCHEMA.md), so "Growth" and " pro " are
  // Recova's tiers too.
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
