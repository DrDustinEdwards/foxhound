import { Form, Link } from "react-router";

import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatMoney } from "~/lib/money-format";
import {
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  failedPaymentStatusTone,
} from "~/lib/recovery/labels";
import { listFilteredFailedPayments, type FailedPaymentSort } from "~/lib/recovery/queries.server";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Payments - Foxhound" }];
}

const STATUS_OPTIONS = ["active", "recovered", "failed_unrecovered"] as const;
const DECLINE_CATEGORY_OPTIONS = Object.keys(DECLINE_CATEGORY_LABELS) as (keyof typeof DECLINE_CATEGORY_LABELS)[];

function parseSort(value: string | null): FailedPaymentSort {
  return value === "oldest" || value === "amount_desc" || value === "amount_asc" ? value : "newest";
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);

  const params = new URL(request.url).searchParams;
  const search = params.get("q")?.trim() || null;
  const status = params.get("status") || null;
  const declineCategory = params.get("category") || null;
  const sort = parseSort(params.get("sort"));
  const pageParam = Number(params.get("page") ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  const result = await listFilteredFailedPayments(db, auth.membership.accountId, {
    search,
    status,
    declineCategory,
    sort,
    page,
  });

  return {
    result,
    filters: { search: search ?? "", status: status ?? "", declineCategory: declineCategory ?? "", sort },
  };
}

interface Filters {
  search: string;
  status: string;
  declineCategory: string;
  sort: FailedPaymentSort;
}

function pageHref(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.status) params.set("status", filters.status);
  if (filters.declineCategory) params.set("category", filters.declineCategory);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/recovery/payments?${qs}` : "/recovery/payments";
}

export default function RecoveryPayments({ loaderData }: Route.ComponentProps) {
  const { result, filters } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-title font-medium text-text">Payments</h1>
        <p className="font-mono text-label text-text-tertiary">
          {result.totalCount} {result.totalCount === 1 ? "payment" : "payments"}
        </p>
      </div>

      <Form method="get" className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Name or email</span>
          <input
            type="text"
            name="q"
            defaultValue={filters.search}
            placeholder="Search"
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-amber"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Status</span>
          <select
            name="status"
            defaultValue={filters.status}
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {FAILED_PAYMENT_STATUS_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Decline</span>
          <select
            name="category"
            defaultValue={filters.declineCategory}
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
          >
            <option value="">All declines</option>
            {DECLINE_CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {DECLINE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Sort</span>
          <select
            name="sort"
            defaultValue={filters.sort}
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="amount_desc">Amount, highest first</option>
            <option value="amount_asc">Amount, lowest first</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-amber px-4 py-2 text-body font-medium text-on-amber">
          Filter
        </button>
      </Form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-label">
          <thead>
            <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
              <th className="px-4 py-3 font-normal">Customer</th>
              <th className="px-4 py-3 font-normal">Amount</th>
              <th className="px-4 py-3 font-normal">Decline</th>
              <th className="px-4 py-3 font-normal">Status</th>
              <th className="px-4 py-3 font-normal">Detected</th>
            </tr>
          </thead>
          <tbody>
            {result.payments.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-body text-text-tertiary">
                  {filters.search || filters.status || filters.declineCategory
                    ? "No payments match these filters."
                    : "No failed payments yet. Foxhound will list every failed payment it detects here."}
                </td>
              </tr>
            ) : (
              result.payments.map((p) => (
                <tr key={p.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <Link to={`/recovery/payments/${p.id}`} className="text-text hover:text-amber">
                      {p.customerName ?? p.customerEmail}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-text">{formatMoney(p.amountCents, p.currency)}</td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {DECLINE_CATEGORY_LABELS[p.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
                      p.declineCategory}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={failedPaymentStatusTone(p.status)}>
                      {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">{p.detectedAt.toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {result.totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-label text-text-tertiary">
          {result.page > 1 ? (
            <Link to={pageHref(filters, result.page - 1)} className="text-amber-text hover:underline">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="font-mono text-micro">
            Page {result.page} of {result.totalPages}
          </span>
          {result.page < result.totalPages ? (
            <Link to={pageHref(filters, result.page + 1)} className="text-amber-text hover:underline">
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
