import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { csvResponse } from "@dustinedwards/site-runtime/csv";
import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import { listFilteredFailedPayments, readPaymentFilters } from "~/lib/recovery/queries.server";
import { countStepsForFailedPayments } from "~/lib/recovery/step-queries.server";

import type { Route } from "./+types/export";

// /recovery/payments/export.csv writes the rows on screen, so it re-runs the list's own filters, sort, page and page size, server side and scoped to the signed-in account. "All" as the page size exports every matching row. Columns: app/lib/recovery/payments-csv.ts.

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const nowMs = Date.now();

  const { filters } = await readPaymentFilters(
    db,
    accountId,
    new URL(request.url).searchParams,
    nowMs,
  );
  const result = await listFilteredFailedPayments(db, accountId, filters);

  const stepCounts = await countStepsForFailedPayments(
    db,
    accountId,
    result.payments.map((p) => p.id),
  );
  const csv = buildPaymentsCsv(result.payments, stepCounts);
  const filename = `foxhound-payments-${new Date(nowMs).toISOString().slice(0, 10)}.csv`;
  return csvResponse(csv, filename);
}
