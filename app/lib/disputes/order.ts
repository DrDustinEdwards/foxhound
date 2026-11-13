// The order the merchant's /disputes list shows disputes in: newest first, as
// Recova orders it (created_at descending). listDisputesPage (queries.server.ts)
// reads the dashboard's rows in this order in SQL, and the /product/disputes
// preview sorts the demo seed with this function. Pure.

export function sortDisputesNewestFirst<T extends { createdAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
