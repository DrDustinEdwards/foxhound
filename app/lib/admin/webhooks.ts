// The admin Webhooks page's filters and links: pure helpers (not a .server
// module, the page renders them), tested without a database. The filters live
// in the address (?type=, ?errors=1, ?pending=1, ?page=), so the list works
// without script, Back and reload keep it, and a filtered page can be linked.
//
// Recova's webhook log (WebhookLogClient.tsx, blob b0fcce84) is the inventory:
// a case-insensitive event-type filter, an errors-only toggle and 50 events a
// page. Pending only is Foxhound's own, the list behind its Unprocessed figure.

import { parsePage } from "capsomer/behavior/pagination";

import { plural } from "@drdustinedwards/site-helpers/text";

export const WEBHOOK_PAGE_SIZE = 50;
export const WEBHOOKS_PATH = "/admin/platform/webhooks";

// Longer than any Stripe event type; a longer query is cut, never refused.
const TYPE_MAX = 100;

export interface WebhookFilters {
  /** A substring of the event type, any case; "" for every type. */
  type: string;
  errorsOnly: boolean;
  pendingOnly: boolean;
  /** 1-based; the loader keeps it inside the list's pages. */
  page: number;
}

export function parseWebhookFilters(params: URLSearchParams): WebhookFilters {
  return {
    type: (params.get("type") ?? "").trim().slice(0, TYPE_MAX),
    errorsOnly: params.get("errors") === "1",
    pendingOnly: params.get("pending") === "1",
    page: parsePage(params.get("page")),
  };
}

export function isFiltered(f: WebhookFilters): boolean {
  return f.type !== "" || f.errorsOnly || f.pendingOnly;
}

/** "120 events", "1 event": the whole log, or what the filter left. */
export function webhookCountWords(total: number): string {
  return plural(total, "event", "events");
}
