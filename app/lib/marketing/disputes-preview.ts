import type { DeadlineUrgency } from "~/lib/disputes/labels";
import type { Tone } from "~/lib/recovery/labels";

// The shape of the /product/disputes preview data (J57), shared by the server
// module that builds it (disputes-preview.server.ts) and the components that
// draw it (app/components/disputes-previews.tsx), so no client module imports
// from a .server file (RULES.md 4.5). Every value is a plain string, number or
// boolean: it crosses the loader as JSON.

/** How a dispute's status reads: disputeListStatus's tone, as /disputes. */
export type PreviewStateTone = Tone;

export interface PreviewDisputeRow {
  id: string;
  customer: string;
  email: string | null;
  amount: string;
  reason: string;
  stateLabel: string;
  stateTone: PreviewStateTone;
  resolved: boolean;
  /** Whole days to the evidence deadline, for an open dispute. */
  deadlineDays: number | null;
  deadlineUrgency: DeadlineUrgency;
  /** "Oct 25": the deadline as a date, for the dispute table. */
  deadlineDate: string;
}

export interface DisputesPreview {
  /** The instant the seed was built at (ISO), so a reader can rebuild it. */
  asOf: string;
  stats: {
    openCount: number;
    atStake: string;
    submittedByFoxhound: number;
    feesOwed: string;
    /** Win rate's figure ("-" until something resolves) and its line. */
    winRate: string;
    winRateSubtext: string;
  };
  /** Every demo dispute, in the dashboard's order, newest first (block 1). */
  dashboard: PreviewDisputeRow[];
  /** The first rows of the same list (block 3), as many as Recova's table shows. */
  table: PreviewDisputeRow[];
}
