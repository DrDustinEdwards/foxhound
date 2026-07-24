import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import { getAmountBounds, listFilteredFailedPayments, type FailedPaymentSort } from "~/lib/recovery/queries.server";
import { isPaymentTimeRange, resolvePaymentTimeRangeCutoff, type PaymentTimeRange } from "~/lib/recovery/time-range";

import type { Route } from "./+types/export";

// /recovery/payments/export.csv (TASK-foxhound-recovery-surface-parity.md
// Phase 3): re-runs the SAME filters the payments list itself uses, server-
// side, over every matching row (pageSize "all"), never the page currently
// on screen - so the export always matches what "Export CSV" was clicked
// from, not whatever happened to be paginated in.

function parseSort(value: string | null): FailedPaymentSort {
  return value === "oldest" || value === "amount_desc" || value === "amount_asc" ? value : "newest";
}

function parseTimeRange(value: string | null): PaymentTimeRange {
  return value && isPaymentTimeRange(value) ? value : "all";
}

function parseAmountParam(value: string | null, floorCents: number, ceilingCents: number): number | null {
  if (!value) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, floorCents), ceilingCents);
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const nowMs = Date.now();

  const params = new URL(request.url).searchParams;
  const search = params.get("q")?.trim() || null;
  const status = params.get("status") || null;
  const declineCategory = params.get("category") || null;
  const sort = parseSort(params.get("sort"));
  const time = parseTimeRange(params.get("time"));

  const bounds = await getAmountBounds(db, accountId);
  const amountMinParsed = parseAmountParam(params.get("amountMin"), bounds.minCents, bounds.maxCents);
  const amountMaxParsed = parseAmountParam(params.get("amountMax"), bounds.minCents, bounds.maxCents);
  const amountMinCents = amountMinParsed !== null && amountMinParsed > bounds.minCents ? amountMinParsed : null;
  const amountMaxCents = amountMaxParsed !== null && amountMaxParsed < bounds.maxCents ? amountMaxParsed : null;
  const detectedAfterMs = resolvePaymentTimeRangeCutoff(time, nowMs);

  const result = await listFilteredFailedPayments(db, accountId, {
    search,
    status,
    declineCategory,
    detectedAfterMs,
    amountMinCents,
    amountMaxCents,
    sort,
    page: 1,
    pageSize: "all",
  });

  const csv = buildPaymentsCsv(result.payments);
  const filename = `foxhound-payments-${new Date(nowMs).toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
