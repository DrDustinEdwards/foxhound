// The order the merchant's /disputes list shows disputes in: newest first, as
// Recova orders it (created_at descending). listDisputes (queries.server.ts)
// returns the dashboard's rows in this order, and the /product/disputes
// preview (J57) lists the demo seed with the same function. Pure.

export function sortDisputesNewestFirst<T extends { createdAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
