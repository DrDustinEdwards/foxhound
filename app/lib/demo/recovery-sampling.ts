import { DAY_MS, HOUR_MS } from "~/lib/constants";
import type { DeclineCategory } from "~/lib/constants";
import { pick, seededFloat, seededInt, type DemoCustomer } from "./customer-base";

// Decline-code sampling (weighted, real Stripe codes -> classifyDecline so the
// seeded code/category pair can never drift out of sync with decline.ts). Every
// code list here is a subset of decline.ts's own set for that category, so
// classifyDecline(code) always lands back on the category it was sampled for -
// both here (the weighted day-walk roll) and via sampleDeclineCodeFor- Category
// (the scripted narrative's category is already fixed by the event, so the code
// must be sampled FROM that category, never independently).

const SOFT_CODES = ["insufficient_funds", "do_not_honor", "generic_decline"] as const;
const EXPIRED_CODES = ["expired_card"] as const;
const NETWORK_CODES = ["processing_error", "issuer_not_available", "try_again_later"] as const;
const FRAUD_CODES = ["fraudulent", "lost_card", "stolen_card"] as const;
const REVOKED_CODES = ["revocation_of_authorization"] as const;
// Not present in any of decline.ts's category sets, so classifyDecline fails
// closed to "unknown" - this is the only way to seed an "unknown" row without
// lying about a code that actually belongs to a known category.
const UNKNOWN_CODES = ["unrecognized_decline"] as const;

const CODES_BY_CATEGORY: Record<DeclineCategory, readonly string[]> = {
  soft: SOFT_CODES,
  network: NETWORK_CODES,
  expired: EXPIRED_CODES,
  fraud: FRAUD_CODES,
  revoked: REVOKED_CODES,
  unknown: UNKNOWN_CODES,
};

export function sampleDeclineCodeForCategory(seed: string, category: DeclineCategory): string {
  return pick(`${seed}:code`, CODES_BY_CATEGORY[category]);
}

// The category mix for a day-walk failure. Foxhound's engine classifies six,
// and RECOVERY_SCHEDULES, DECLINE_CATEGORY_LABELS, and /recovery/sequence all
// ship a section for each, so leaving revoked and unknown at zero left two
// panels reading "No data yet" on every demo visit: the fail-closed classifier
// and the revoked hard-stop, two deliberate engine behaviors, had no visible
// evidence anywhere.
const CATEGORY_WEIGHTS: { category: DeclineCategory; upTo: number }[] = [
  { category: "soft", upTo: 46 },
  { category: "expired", upTo: 64 },
  { category: "network", upTo: 82 },
  { category: "fraud", upTo: 92 },
  { category: "revoked", upTo: 96 },
  { category: "unknown", upTo: 100 },
];

export function sampleDeclineCode(seed: string): string {
  const r = seededInt(`${seed}:cat`, 100);
  const hit = CATEGORY_WEIGHTS.find((w) => r < w.upTo) ?? CATEGORY_WEIGHTS[0];
  return sampleDeclineCodeForCategory(seed, hit.category);
}

// Day-walk distribution (which day, how many failures, which customer)

export function classifyDayIntensity(d: Date): "high" | "medium" | "low" {
  const dom = d.getUTCDate();
  if ((dom >= 1 && dom <= 5) || (dom >= 14 && dom <= 18)) return "high";
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return "low";
  return "medium";
}

export function failuresForDay(intensity: "high" | "medium" | "low", seed: string): number {
  if (intensity === "high") return seededInt(`${seed}:n`, 4);
  if (intensity === "medium") return seededInt(`${seed}:n`, 2);
  return seededInt(`${seed}:n`, 1);
}

function anchorProximityWeight(c: DemoCustomer, day: Date): number {
  const dom = day.getUTCDate();
  const raw = Math.abs(dom - c.billingAnchorDay);
  const dist = Math.min(raw, 28 - raw);
  if (dist === 0) return 10;
  if (dist === 1) return 5;
  if (dist === 2) return 2;
  if (dist <= 4) return 0.5;
  return 0.05;
}

export function pickCustomerForDay(
  eligible: DemoCustomer[],
  day: Date,
  seed: string,
  recentByCustomer: Map<string, Date[]>,
): DemoCustomer | null {
  const dayMs = day.getTime();
  const fiveDaysMs = 5 * DAY_MS;
  const weighted: Array<{ c: DemoCustomer; w: number }> = [];
  for (const c of eligible) {
    if (c.customerSince.getTime() > dayMs) continue;
    if (c.status === "churned" && c.churnedAt && c.churnedAt.getTime() <= dayMs) continue;
    const recents = recentByCustomer.get(c.stripeCustomerId) ?? [];
    if (recents.some((r) => Math.abs(r.getTime() - dayMs) < fiveDaysMs)) continue;
    let w = anchorProximityWeight(c, day);
    if (c.status === "at_risk") w *= 1.6;
    if (c.status === "paused") w *= 0.2;
    if (w <= 0) continue;
    weighted.push({ c, w });
  }
  if (weighted.length === 0) return null;
  const totalW = weighted.reduce((s, x) => s + x.w, 0);
  const target = seededFloat(`${seed}:pick`) * totalW;
  let acc = 0;
  for (const x of weighted) {
    acc += x.w;
    if (acc >= target) return x.c;
  }
  return weighted[weighted.length - 1].c;
}

export function randomBusinessHour(day: Date, seed: string): Date {
  const d = new Date(day);
  d.setUTCHours(
    9 + seededInt(`${seed}:hr`, 9),
    seededInt(`${seed}:min`, 60),
    seededInt(`${seed}:sec`, 60),
    0,
  );
  return d;
}

// Outcome sampling: how a failure resolves, reusing the real schedule so the
// causing step is always a step the real engine would actually have run.

export type ResolvedOutcome =
  | { kind: "recovered"; recoveredAt: Date; causeMode: "retry" | "click" | "baseline" }
  | { kind: "active" }
  | { kind: "failed_unrecovered" };

const RECOVERY_PROB: Record<DeclineCategory, number> = {
  soft: 0.5,
  network: 0.4,
  expired: 0.25,
  fraud: 0.05,
  revoked: 0.1,
  unknown: 0.15,
};

function sampleRecoveryDelayDays(category: DeclineCategory, seed: string): number {
  if (category === "soft" || category === "network") return 1 + seededInt(`${seed}:delay`, 3);
  if (category === "expired") return 7 + seededInt(`${seed}:delay`, 8);
  return 14 + seededInt(`${seed}:delay`, 17);
}

/**
 * The last scheduled step's offset for a category, so a failure old enough to
 * have exhausted its whole schedule (with no recovery) is terminal.
 */
function scheduleSpanHours(schedule: { offsetHours: number }[]): number {
  return schedule[schedule.length - 1]?.offsetHours ?? 0;
}

export function resolveOutcome(
  category: DeclineCategory,
  detectedAt: Date,
  now: Date,
  schedule: { offsetHours: number }[],
  seed: string,
): ResolvedOutcome {
  const ageMs = now.getTime() - detectedAt.getTime();
  const willRecover = seededFloat(`${seed}:rec`) < RECOVERY_PROB[category];
  if (willRecover) {
    const delayDays = sampleRecoveryDelayDays(category, seed);
    const recoveredAt = new Date(detectedAt.getTime() + delayDays * DAY_MS);
    if (recoveredAt.getTime() <= now.getTime()) {
      const retryable = category === "soft" || category === "network";
      const r = seededInt(`${seed}:mode`, 100);
      const causeMode: "retry" | "click" | "baseline" = retryable
        ? r < 60
          ? "retry"
          : r < 85
            ? "click"
            : "baseline"
        : r < 70
          ? "click"
          : "baseline";
      return { kind: "recovered", recoveredAt, causeMode };
    }
    return { kind: "active" };
  }
  return ageMs > scheduleSpanHours(schedule) * HOUR_MS
    ? { kind: "failed_unrecovered" }
    : { kind: "active" };
}
