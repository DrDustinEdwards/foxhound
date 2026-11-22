import type { PlanPillTone } from "~/lib/intelligence/customer-directory";
import type { PlanRow } from "~/lib/intelligence/dashboard";
import type { HealthScoreBand } from "~/lib/intelligence/health-band";

// The shape of the /product/intelligence preview data, shared by the server module that builds it and the components that draw it,
// so no client module imports from a .server file. Every value is a plain string, number or array of them: it crosses the loader as JSON.

export interface PreviewCustomerRow {
  id: string;
  name: string;
  planLabel: string;
  planTone: PlanPillTone | null;
  healthScore: number;
  band: HealthScoreBand;
  mrr: string;
}

export interface PreviewBand {
  band: HealthScoreBand;
  customerCount: number;
  mrr: string;
}

export interface IntelligencePreview {
  asOf: string;
  dashboard: {
    mrr: string;
    activeCustomers: string;
    dayOverDay: string;
    dayOverDaySign: -1 | 0 | 1;
    newMrrMtd: string;
    currency: string;
    plans: PlanRow[];
    narrativeMonth: string;
    narrative: string;
  };
  customers: PreviewCustomerRow[];
  bands: PreviewBand[];
}
