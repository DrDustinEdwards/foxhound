export function sortDisputesNewestFirst<T extends { createdAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
