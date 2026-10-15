// The admin Webhooks page's filters and links: pure helpers (not a .server
// module, the page renders them), tested without a database. The filters live
// in the address (?type=, ?errors=1, ?pending=1, ?page=), so the list works
// without script, Back and reload keep it, and a filtered page can be linked.
//
// Recova's webhook log (WebhookLogClient.tsx, blob b0fcce84) is the inventory:
// a case-insensitive event-type filter, an errors-only toggle and 50 events a
// page. Pending only is Foxhound's own, the list behind its Unprocessed figure.

import { plural } from "~/lib/admin/overview";

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
  const pageText = params.get("page") ?? "";
  const page = /^\d+$/.test(pageText) ? Number(pageText) : 1;
  return {
    type: (params.get("type") ?? "").trim().slice(0, TYPE_MAX),
    errorsOnly: params.get("errors") === "1",
    pendingOnly: params.get("pending") === "1",
    page: page >= 1 && Number.isSafeInteger(page) ? page : 1,
  };
}

export function isFiltered(f: WebhookFilters): boolean {
  return f.type !== "" || f.errorsOnly || f.pendingOnly;
}

/** The address of one page of the list with these filters, defaults left out. */
export function webhookListHref(f: WebhookFilters, page: number): string {
  const params = new URLSearchParams();
  if (f.type) params.set("type", f.type);
  if (f.errorsOnly) params.set("errors", "1");
  if (f.pendingOnly) params.set("pending", "1");
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${WEBHOOKS_PATH}?${query}` : WEBHOOKS_PATH;
}

/** "120 events", "1 event": the whole log, or what the filter left. */
export function webhookCountWords(total: number): string {
  return plural(total, "event", "events");
}
