// The Intelligence customer directory (views.server.ts split): the paged,
// filtered customer list and the tier options its filter offers.

import { and, asc, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import { customerContext, type Db } from "~/db";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { WATCH_CEILING, type HealthScoreBand } from "./health-band";

// ============================================================================
// Customer directory (TASK-foxhound-intelligence-customer-directory.md):
// every scored customer, not just the at-risk few the Overview page's table
// links to. Every filter and the sort live in SQL - never a client-side
// filter over the full account, however small the demo happens to be today.
// ============================================================================

export type CustomerDirectorySort = "health_asc" | "mrr_desc";

export interface CustomerDirectoryFilters {
  search: string | null;
  tier: string | null;
  healthBand: HealthScoreBand | null;
  sort: CustomerDirectorySort;
  page: number;
}

interface CustomerDirectoryRow {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  currentPlanTier: string | null;
  mrrContributionCents: number;
  currency: string;
  healthScore: number | null;
  lastSeenAt: Date | null;
  recoverySignals: unknown;
  disputeSignals: unknown;
  recommendedAction: string | null;
  scheduledChangeKind: string | null;
  scheduledChangeAt: Date | null;
}

export interface CustomerDirectoryResult {
  customers: CustomerDirectoryRow[];
  totalCount: number;
  totalMrrCents: number;
  page: number;
  totalPages: number;
}

const CUSTOMER_DIRECTORY_PAGE_SIZE = 50;

export function healthBandCondition(band: HealthScoreBand | null) {
  if (band === "healthy") return gte(customerContext.healthScore, WATCH_CEILING);
  if (band === "watch") {
    return and(
      gte(customerContext.healthScore, HEALTH_SCORE_AT_RISK_THRESHOLD),
      lt(customerContext.healthScore, WATCH_CEILING),
    );
  }
  if (band === "at_risk") return lt(customerContext.healthScore, HEALTH_SCORE_AT_RISK_THRESHOLD);
  return undefined;
}

/** Every customer_context row for the account, filtered/sorted/paginated
 *  entirely in SQL. Sort "health_asc" (the default, and the real product
 *  behavior, not a demo affordance) puts the lowest scores - and therefore
 *  the customers most worth a look - first, with null (not yet scored)
 *  always last regardless of direction. */
export async function listCustomerDirectory(
  db: Db,
  accountId: string,
  filters: CustomerDirectoryFilters,
): Promise<CustomerDirectoryResult> {
  const conditions = [eq(customerContext.accountId, accountId)];
  if (filters.search) {
    const term = `%${filters.search}%`;
    const searchCondition = or(like(customerContext.customerName, term), like(customerContext.customerEmail, term));
    if (searchCondition) conditions.push(searchCondition);
  }
  if (filters.tier) conditions.push(eq(customerContext.currentPlanTier, filters.tier));
  const bandCondition = healthBandCondition(filters.healthBand);
  if (bandCondition) conditions.push(bandCondition);
  const where = and(...conditions);

  const [{ n: totalCount }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(customerContext)
    .where(where);
  const [{ n: totalMrrCents }] = await db
    .select({ n: sql<number>`coalesce(sum(${customerContext.mrrContributionCents}), 0)` })
    .from(customerContext)
    .where(where);

  const totalPages = Math.max(1, Math.ceil(Number(totalCount) / CUSTOMER_DIRECTORY_PAGE_SIZE));
  const page = Math.min(Math.max(1, filters.page), totalPages);

  const nullsLast = sql`${customerContext.healthScore} IS NULL`;
  const orderBy =
    filters.sort === "mrr_desc"
      ? [desc(customerContext.mrrContributionCents)]
      : [nullsLast, asc(customerContext.healthScore)];

  const rows = await db
    .select({
      stripeCustomerId: customerContext.stripeCustomerId,
      customerName: customerContext.customerName,
      customerEmail: customerContext.customerEmail,
      currentPlanTier: customerContext.currentPlanTier,
      mrrContributionCents: customerContext.mrrContributionCents,
      currency: customerContext.currency,
      healthScore: customerContext.healthScore,
      lastSeenAt: customerContext.lastSeenAt,
      recoverySignals: customerContext.recoverySignals,
      disputeSignals: customerContext.disputeSignals,
      recommendedAction: customerContext.recommendedAction,
      scheduledChangeKind: customerContext.scheduledChangeKind,
      scheduledChangeAt: customerContext.scheduledChangeAt,
    })
    .from(customerContext)
    .where(where)
    .orderBy(...orderBy)
    .limit(CUSTOMER_DIRECTORY_PAGE_SIZE)
    .offset((page - 1) * CUSTOMER_DIRECTORY_PAGE_SIZE);

  return {
    customers: rows.map((r) => ({
      ...r,
      mrrContributionCents: r.mrrContributionCents ?? 0,
      currency: r.currency ?? "usd",
    })),
    totalCount: Number(totalCount),
    totalMrrCents: Number(totalMrrCents),
    page,
    totalPages,
  };
}

/** The distinct plan tiers present on this account's customers, for the tier
 *  filter's options - never a hardcoded tier list, since current_plan_tier is
 *  a legacy-provenance free-text column (SCHEMA.md), not a fixed enum. */
export async function listCustomerTiers(db: Db, accountId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tier: customerContext.currentPlanTier })
    .from(customerContext)
    .where(eq(customerContext.accountId, accountId));
  return rows
    .map((r) => r.tier)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .sort();
}
