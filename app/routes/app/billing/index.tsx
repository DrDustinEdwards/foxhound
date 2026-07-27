import { eq } from "drizzle-orm";
import { data, redirect, useActionData, useNavigation } from "react-router";

import { BillingEstimateCard } from "~/components/billing-estimate-card";
import { LedgerFreeRow, LedgerLineItemRow } from "~/components/billing-ledger-row";
import { Badge } from "~/components/badge";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { accounts, getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { BILLING_INVOICE_STATUS_LABELS, billingInvoiceStatusTone } from "~/lib/billing/labels";
import {
  buildPlatformCustomerUpdate,
  createBillingSetupSession,
  ensurePlatformCustomer,
  finalizeBillingSetupSession,
} from "~/lib/billing/platform-customer";
import { getBillingPreview } from "~/lib/billing/preview.server";
import { getBillingLedger, listBillingInvoices } from "~/lib/billing/queries.server";
import { formatMoney } from "~/lib/money-format";
import { executeMoneyWrite } from "~/lib/money/execute";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Billing - Foxhound" }];
}

async function loadAccountBillingRow(env: Env, accountId: string) {
  const db = getDb(env);
  const rows = await db
    .select({ platformStripeCustomerId: accounts.platformStripeCustomerId, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0] ?? null;
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;

  // Return leg of the Stripe-hosted setup session (mirrors the Connect OAuth
  // callback shape): finalize once, then redirect to the clean URL so a
  // refresh never re-processes the same session_id. The session_id is an
  // unauthenticated URL param, so finalize verifies it belongs to THIS account
  // (account-scoping audit HIGH #2): pass our OWN stored platform customer id
  // as the expected owner; a foreign session never mutates a customer.
  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (sessionId) {
    const accountRow = await loadAccountBillingRow(env, accountId);
    await finalizeBillingSetupSession(env, {
      sessionId,
      expectedCustomerId: accountRow?.platformStripeCustomerId ?? null,
    }).catch((err) => {
      console.error("billing setup finalize failed:", err instanceof Error ? err.message : err);
    });
    throw redirect("/billing");
  }

  const db = getDb(env);
  const [accountRow, ledger, invoices, preview] = await Promise.all([
    loadAccountBillingRow(env, accountId),
    getBillingLedger(db, accountId),
    listBillingInvoices(db, accountId),
    getBillingPreview(db, accountId, Date.now()),
  ]);

  return {
    billingSetUp: Boolean(accountRow?.platformStripeCustomerId),
    ledger,
    invoices,
    preview,
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;

  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "setup_billing") {
    return data({ error: "Unknown action." }, { status: 400 });
  }

  try {
    const accountRow = await loadAccountBillingRow(env, accountId);
    const existingCustomerId = accountRow?.platformStripeCustomerId ?? null;
    const customerId = await ensurePlatformCustomer(env, {
      existingCustomerId,
      accountId,
      accountName: accountRow?.name ?? null,
    });

    if (!existingCustomerId) {
      await executeMoneyWrite(env, {
        accountId,
        idempotencyKey: `platform-customer:${accountId}`,
        build: (bdb) => buildPlatformCustomerUpdate(bdb, { accountId, platformStripeCustomerId: customerId }),
      });
    }

    if (!env.BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is not set");
    const session = await createBillingSetupSession(env, {
      customerId,
      successUrl: `${env.BETTER_AUTH_URL}/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${env.BETTER_AUTH_URL}/billing`,
    });
    return redirect(session.url);
  } catch (err) {
    return data(
      { error: err instanceof Error ? err.message : "Could not start billing setup." },
      { status: 400 },
    );
  }
}

export default function Billing({ loaderData }: Route.ComponentProps) {
  const { billingSetUp, ledger, invoices, preview } = loaderData;
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  const entries = [
    ...ledger.lineItems.map((entry) => ({ date: entry.lineItem.createdAt, node: <LedgerLineItemRow key={entry.lineItem.id} entry={entry} /> })),
    ...ledger.freeRecoveries.map((entry) => ({
      date: entry.recoveredPayment.recoveredAt,
      node: <LedgerFreeRow key={entry.recoveredPayment.id} entry={entry} />,
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Billing</h1>

      {actionData && "error" in actionData ? (
        <p className="mt-4 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text" role="alert">
          {actionData.error}
        </p>
      ) : null}

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Payment method</p>
        <p className="mt-2 text-label text-text-tertiary">
          {billingSetUp
            ? "A payment method is on file with Foxhound. Fees are invoiced monthly."
            : "No payment method on file yet. Set one up so Foxhound can invoice your monthly fees."}
        </p>
        <DemoGuardedForm method="post" className="mt-3">
          <input type="hidden" name="intent" value="setup_billing" />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-purple px-4 py-2 text-body font-medium text-text disabled:opacity-60"
          >
            {busy ? "Redirecting..." : billingSetUp ? "Update payment method" : "Set up billing"}
          </button>
        </DemoGuardedForm>
      </div>

      <BillingEstimateCard preview={preview} />

      {invoices.length > 0 ? (
        <div className="mt-6 rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Invoices</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="py-2 pr-4 font-normal">Period</th>
                  <th className="py-2 pr-4 font-normal">Total</th>
                  <th className="py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-border-sub last:border-0">
                    <td className="py-2 pr-4">
                      <a href={`/billing/invoices/${invoice.id}`} className="text-text hover:text-amber">
                        {invoice.periodStart.toLocaleDateString()} - {invoice.periodEnd.toLocaleDateString()}
                      </a>
                    </td>
                    <td className="py-2 pr-4 font-mono text-text">{formatMoney(invoice.totalCents, invoice.currency)}</td>
                    <td className="py-2">
                      <Badge tone={billingInvoiceStatusTone(invoice.status)}>
                        {BILLING_INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Evidence ledger</p>
        {entries.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">
            Nothing to show yet. Every fee Foxhound ever charges, and every free recovery, will
            appear here with its full evidence.
          </p>
        ) : (
          <ol className="mt-3 flex flex-col">{entries.map((e) => e.node)}</ol>
        )}
      </div>
    </div>
  );
}
