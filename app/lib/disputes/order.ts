import { isDisputeResolved } from "./labels";

// The order the merchant's /disputes list shows disputes in, moved out of
// app/routes/app/disputes/index.tsx (J57) so the /products/disputes preview
// lists the demo seed the same way, from the same code: newest first, then
// every open dispute ahead of the resolved ones, open ones by the nearest
// evidence deadline, resolved ones by the most recent resolution. Pure.

export interface OrderableDispute {
  state: string;
  createdAt: Date;
  resolvedAt: Date | null;
  evidenceDeadline: Date | null;
}

export function sortDisputesForList<T extends OrderableDispute>(rows: readonly T[]): T[] {
  // Newest first, as listDisputes returns them; the sort below is stable, so
  // this is the tie-break between disputes with the same deadline.
  const newest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return newest.sort((a, b) => {
    const aResolved = isDisputeResolved(a.state);
    const bResolved = isDisputeResolved(b.state);
    if (aResolved !== bResolved) return aResolved ? 1 : -1;
    if (aResolved) return (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0);
    const aDeadline = a.evidenceDeadline?.getTime() ?? Infinity;
    const bDeadline = b.evidenceDeadline?.getTime() ?? Infinity;
    return aDeadline - bDeadline;
  });
}
