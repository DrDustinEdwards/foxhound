import type { DeadlineUrgency } from "~/lib/disputes/labels";
import type { Tone } from "~/lib/recovery/labels";

// The shape of the /product/disputes preview data, shared by the server module that builds it and the components that draw it, so no
// client module imports from a .server file. Every value is a plain string, number or boolean: it crosses the loader as JSON.

type PreviewStateTone = Tone;

export interface PreviewDisputeRow {
  id: string;
  customer: string;
  email: string | null;
  amount: string;
  reason: string;
  stateLabel: string;
  stateTone: PreviewStateTone;
  resolved: boolean;
  deadlineDays: number | null;
  deadlineUrgency: DeadlineUrgency;
  deadlineDate: string;
  /** The Triage column: the intake's fight or accept and its confidence. */
  triage: { recommendation: "fight" | "accept"; confidence: number | null } | null;
}

export interface DisputesPreview {
  asOf: string;
  stats: {
    openCount: number;
    atStake: string;
    submittedByFoxhound: number;
    feesOwed: string;
    winRate: string;
    winRateSubtext: string;
  };
  dashboard: PreviewDisputeRow[];
  /** The first rows of the same list (block 3). */
  table: PreviewDisputeRow[];
}
