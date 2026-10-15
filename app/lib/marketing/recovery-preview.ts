import type { DeclineCategory } from "~/lib/constants";
import type { RecoveryRateTone } from "~/lib/dashboard/recovery-rate";

// The shape of the /products/recovery preview data (J56), shared by the server
// module that builds it (recovery-preview.server.ts) and the components that
// draw it (app/components/recovery-previews.tsx), so no client module imports
// from a .server file (RULES.md 4.5). Every value is a plain string or number:
// it crosses the loader as JSON.

export interface RoiColumn {
  recovered: string;
  fee: string;
  kept: string;
}

export interface PreviewPaymentRow {
  id: string;
  customer: string;
  email: string | null;
  plan: string | null;
  amount: string;
  category: DeclineCategory;
  declineCode: string | null;
  stepsDone: number;
  stepsTotal: number;
  nextStep: string | null;
  status: string;
  statusLabel: string;
  /** The customer's failed payments in total, this one included. */
  failureCount: number;
  detectedAgo: string;
  detectedDate: string;
}

export interface RecoveryPreview {
  /** The instant the seed was built at (ISO), so a reader can rebuild it. */
  asOf: string;
  dashboard: {
    recovered30d: string;
    atRisk: string;
    ratePct: number | null;
    rateBand: string;
    rateTone: RecoveryRateTone | null;
  };
  roi: { feePct: number; thisMonth: RoiColumn; allTime: RoiColumn };
  payments: { totalCount: number; activeCount: number; rows: PreviewPaymentRow[] };
}
