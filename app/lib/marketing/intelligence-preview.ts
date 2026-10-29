import type { PlanPillTone } from "~/lib/intelligence/customer-directory";
import type { PlanRow } from "~/lib/intelligence/dashboard";
import type { HealthScoreBand } from "~/lib/intelligence/health-band";

// The shape of the /product/intelligence preview data (J58), shared by the
// server module that builds it (intelligence-preview.server.ts) and the
// components that draw it (app/components/intelligence-previews.tsx), so no
// client module imports from a .server file (RULES.md 4.5). Every value is a
// plain string, number or array of them: it crosses the loader as JSON.

export interface PreviewCustomerRow {
  id: string;
  name: string;
  /** The directory's plan pill (planTierPill): its word and tone. */
  planLabel: string;
  planTone: PlanPillTone | null;
  healthScore: number;
  band: HealthScoreBand;
  /** formatMoney of the customer's MRR, or "-" with none, as the directory. */
  mrr: string;
}

export interface PreviewBand {
  band: HealthScoreBand;
  customerCount: number;
  /** The band's MRR, whole units ("$594"). */
  mrr: string;
}

export interface IntelligencePreview {
  /** The instant the seed was built at (ISO), so a reader can rebuild it. */
  asOf: string;
  dashboard: {
    /** The latest snapshot's MRR, as the dashboard's MRR card writes it. */
    mrr: string;
    /** The latest snapshot's active customers, as the dashboard writes it. */
    activeCustomers: string;
    /** The dashboard's Day-over-day figure and its sign ("--" and 0 when flat). */
    dayOverDay: string;
    dayOverDaySign: -1 | 0 | 1;
    /** The dashboard's New MRR (MTD) figure. */
    newMrrMtd: string;
    currency: string;
    /** The latest snapshot's MRR per plan, largest first (planBreakdownRows). */
    plans: PlanRow[];
    /** "October 2026": the month of the demo's report. */
    narrativeMonth: string;
    narrative: string;
  };
  /** The directory's first rows: lowest health first. */
  customers: PreviewCustomerRow[];
  /** The churn page's three bands, high risk first. */
  bands: PreviewBand[];
}
