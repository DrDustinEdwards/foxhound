import type { DeclineCategory } from "~/lib/constants";
import type { RecoveryRateTone } from "~/lib/dashboard/recovery-rate";

// The shape of the /product/recovery preview data, shared by the server module that builds it and the components that draw it, so no
// client module imports from a .server file. Every value is a plain string or number: it crosses the loader as JSON.

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
  failureCount: number;
  detectedAgo: string;
  detectedDate: string;
}

export interface RecoveryPreview {
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
