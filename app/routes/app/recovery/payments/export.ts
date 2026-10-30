import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import {
  parsePaymentsAmount,
  parsePaymentsPage,
  parsePaymentsPageSize,
  parsePaymentsSort,
  parsePaymentsTimeRange,
} from "~/lib/recovery/payments-list";
import {
  countStepsForFailedPayments,
  getAmountBounds,
  listFilteredFailedPayments,
} from "~/lib/recovery/queries.server";
import { resolvePaymentTimeRangeCutoff } from "~/lib/recovery/time-range";

import type { Route } from "./+types/export";

// /recovery/payments/export.csv: Recova's Export CSV writes the rows on
// screen (PaymentsClient.tsx handleExport, exportToCSV(filtered)), so this
// re-runs the list's own filters, sort, page and page size, server side and
// scoped to the signed-in account. "All" as the page size exports every
// matching row, as it shows every row. The 13 columns are Recova's
// (lib/csv.ts); see app/lib/recovery/payments-csv.ts.

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
  const sort = parsePaymentsSort(params.get("sort"));
  const time = parsePaymentsTimeRange(params.get("time"));
  const page = parsePaymentsPage(params.get("page"));
  const pageSize = parsePaymentsPageSize(params.get("perPage"));

  const bounds = await getAmountBounds(db, accountId);
  const amountMinParsed = parsePaymentsAmount(params.get("amountMin"), bounds.minCents, bounds.maxCents);
  const amountMaxParsed = parsePaymentsAmount(params.get("amountMax"), bounds.minCents, bounds.maxCents);
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
    page,
    pageSize,
  });

  const stepCounts = await countStepsForFailedPayments(
    db,
    accountId,
    result.payments.map((p) => p.id),
  );
  const csv = buildPaymentsCsv(result.payments, stepCounts);
  const filename = `foxhound-payments-${new Date(nowMs).toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
