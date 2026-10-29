import "capsomer/button.css";
import { useState } from "react";
import { AdminTime } from "~/components/admin-time";
import { data, Form, useNavigation } from "react-router";

import { ViewAsForm } from "~/components/admin-merchants-parts";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { getMerchantDetail, setBillingExempt, setProcessingPaused } from "~/lib/admin/merchants.server";
import { cancelMerchant } from "~/lib/admin/merchant-cancel.server";
import { adminContext } from "~/lib/admin/context";
import { createAdjustment } from "~/lib/billing/adjustment";
import { BILLING_INVOICE_STATUS_LABELS, billingInvoiceStatusTone } from "~/lib/billing/labels";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatMoney } from "~/lib/money-format";
import { parseDollarsToCents } from "~/lib/settings/dollars";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/detail";

export const handle: AdminHandle<{ account: { name: string | null; id: string } }> = {
  page: (data: { account: { name: string | null; id: string } }) => data.account.name ?? data.account.id,
};

export function meta({ loaderData }: Route.MetaArgs) {
  const name = loaderData ? (loaderData.account.name ?? loaderData.account.id) : "Merchant";
  return [{ title: `${name} - Foxhound admin` }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const detail = await getMerchantDetail(db, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  // Idempotency anchor for the adjustment form: minted per render, carried as a
  // hidden field, and rotated by the post-submit loader revalidation. A double-
  // submit of one rendered form reuses it (deduped in createAdjustment); a
  // deliberate new adjustment comes from a fresh render with a fresh token.
  return { ...detail, adjustmentToken: crypto.randomUUID() };
}

// Uniform action result shape across every intent, so the component narrows
// on a single `ok` discriminant instead of a per-intent union.
interface ActionResult {
  ok: boolean;
  error?: string;
  warning?: string;
  adjustmentInvoiceId?: string;
}

// Every action here is money-adjacent (admin Pass 2). Each is operator-guarded
// by the admin-guard layout (app/layouts/admin-guard.tsx, nested under the
// app-shell session guard), and each writes an admin_audit_log row.
export async function action({ context, request, params }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);
  const accountId = params.id;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "toggle-billing-exempt") {
    const nextExempt = String(form.get("nextExempt") ?? "") === "true";
    await setBillingExempt(env, accountId, nextExempt, new Date());
    await logAdminAction(db, {
      actorEmail: auth.email,
      action: nextExempt ? "merchant.billing_exempt.enable" : "merchant.billing_exempt.disable",
      metadata: { accountId },
    });
    return data<ActionResult>({ ok: true });
  }

  if (intent === "toggle-processing-paused") {
    const nextPaused = String(form.get("nextPaused") ?? "") === "true";
    await setProcessingPaused(db, accountId, nextPaused);
    await logAdminAction(db, {
      actorEmail: auth.email,
      action: nextPaused ? "merchant.processing.pause" : "merchant.processing.resume",
      metadata: { accountId },
    });
    return data<ActionResult>({ ok: true });
  }

  if (intent === "cancel") {
    const result = await cancelMerchant(env, accountId);
    await logAdminAction(db, {
      actorEmail: auth.email,
      action: "merchant.cancel",
      metadata: {
        accountId,
        connectionsDisconnected: result.connectionsDisconnected,
        deauthorizeErrors: result.deauthorizeErrors,
      },
    });
    if (result.deauthorizeErrors.length > 0) {
      return data<ActionResult>({
        ok: true,
        warning:
          `Canceled. ${result.deauthorizeErrors.length} Stripe connection(s) could not be revoked ` +
          "automatically and will need a manual revoke or a retry; the account is fully canceled locally either way.",
      });
    }
    return data<ActionResult>({ ok: true });
  }

  if (intent === "create-adjustment") {
    const direction = String(form.get("direction") ?? "");
    const currency = String(form.get("currency") ?? "").trim().toLowerCase();
    const description = String(form.get("description") ?? "").trim();
    const magnitudeCents = parseDollarsToCents(String(form.get("amount") ?? ""));
    const idempotencyToken = String(form.get("idempotencyToken") ?? "");

    if (!magnitudeCents || !currency || !description || !idempotencyToken || (direction !== "credit" && direction !== "correction")) {
      return data<ActionResult>(
        { ok: false, error: "Enter a nonzero amount, a currency, and a reason." },
        { status: 400 },
      );
    }

    const amountCents = direction === "credit" ? -magnitudeCents : magnitudeCents;
    const result = await createAdjustment(env, {
      accountId,
      currency,
      amountCents,
      description,
      actorEmail: auth.email,
      idempotencyToken,
      now: new Date(),
    });
    return data<ActionResult>({ ok: true, adjustmentInvoiceId: result.invoiceId });
  }

  return data<ActionResult>({ ok: false, error: "Unknown action." }, { status: 400 });
}

function ActionButton({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "danger" }) {
  const busy = useNavigation().state !== "idle";
  return (
    <button
      type="submit"
      disabled={busy}
      className={
        tone === "danger"
          ? "rounded-md border border-red px-3 py-1.5 text-label text-error-text hover:bg-red-bg disabled:opacity-60"
          : "rounded-md border border-border px-3 py-1.5 text-label text-text hover:border-brand disabled:opacity-60"
      }
    >
      {children}
    </button>
  );
}

function CancelForm({ accountId }: { accountId: string }) {
  const [confirming, setConfirming] = useState(false);
  const busy = useNavigation().state !== "idle";

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-red px-3 py-1.5 text-label text-error-text hover:bg-red-bg"
      >
        Cancel merchant
      </button>
    );
  }

  return (
    <Form method="post" className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="intent" value="cancel" />
      <span className="text-label text-error-text">
        Disconnects Stripe and stops all processing for {accountId}. Already-matured, unbilled fees still bill. Confirm?
      </span>
      <ActionButton tone="danger">Yes, cancel</ActionButton>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="rounded-md border border-border px-3 py-1.5 text-label text-text-tertiary hover:text-text"
      >
        Never mind
      </button>
    </Form>
  );
}

function AdjustmentForm({
  defaultCurrency,
  actionData,
  idempotencyToken,
}: {
  defaultCurrency: string;
  actionData: ActionResult | undefined;
  idempotencyToken: string;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <Form method="post" className="flex flex-col gap-3">
      <input type="hidden" name="intent" value="create-adjustment" />
      <input type="hidden" name="idempotencyToken" value={idempotencyToken} />
      {actionData?.error ? (
        <p role="alert" className="rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text">
          {actionData.error}
        </p>
      ) : null}
      {actionData?.adjustmentInvoiceId ? (
        <p role="status" className="rounded-md border border-green bg-green-bg px-3 py-2 text-label text-success-text">
          Adjustment recorded.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Direction</span>
          <select
            name="direction"
            defaultValue="credit"
            className="rounded-md border border-border bg-surface px-3 py-2 text-body text-text focus-visible:border-brand"
          >
            <option value="credit">Credit merchant (reduces what they owe)</option>
            <option value="correction">Correction (increases what they owe)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Amount</span>
          <input
            name="amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            required
            className="w-32 rounded-md border border-border bg-surface px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-brand"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Currency</span>
          <input
            name="currency"
            type="text"
            defaultValue={defaultCurrency}
            required
            className="w-20 rounded-md border border-border bg-surface px-3 py-2 text-body text-text focus-visible:border-brand"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Reason</span>
        <textarea
          name="description"
          rows={2}
          required
          placeholder="Goodwill credit for a delayed dunning email; error correction for..."
          className="rounded-md border border-border bg-surface px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-brand"
        />
      </label>
      <div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-brand px-4 py-2 text-body font-medium text-on-brand disabled:opacity-60"
        >
          Record adjustment
        </button>
      </div>
      <p className="text-micro text-text-tertiary">
        Adjustments never touch Stripe: they are internal ledger entries only, never a card charge or refund.
      </p>
    </Form>
  );
}

export default function AdminMerchantDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { account, connections, subscriptions, recoveryActivity, disputeActivity, recentInvoices, adjustmentToken } =
    loaderData;

  return (
    <div>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          {account.cancelledAt ? <Badge tone="failure">Canceled</Badge> : null}
          {account.billingExempt ? <Badge tone="neutral">Billing exempt</Badge> : null}
          {account.processingPaused ? (
            <Badge tone="failure">
              {account.pauseReason === PAUSE_REASON_BRAKE ? "Paused by brake" : "Processing paused"}
            </Badge>
          ) : null}
          {!account.cancelledAt && !account.billingExempt && !account.processingPaused ? (
            <Badge tone="success">Normal</Badge>
          ) : null}
        </div>
        <p className="mt-2 text-label text-text-tertiary">
          Account id <span className="font-mono text-text">{account.id}</span>
        </p>
        <p className="text-label text-text-tertiary">
          Created <AdminTime at={account.createdAt} empty="unknown" />
        </p>
        {account.cancelledAt ? (
          <p className="text-label text-text-tertiary">
            Canceled <AdminTime at={account.cancelledAt} />
          </p>
        ) : null}
        <p className="text-label text-text-tertiary">
          Platform Stripe customer:{" "}
          <span className="font-mono text-text">{account.platformStripeCustomerId ?? "not set up"}</span>
        </p>

        {actionData?.warning ? (
          <p role="alert" className="mt-3 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text">
            {actionData.warning}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Form method="post">
            <input type="hidden" name="intent" value="toggle-billing-exempt" />
            <input type="hidden" name="nextExempt" value={String(!account.billingExempt)} />
            <ActionButton>{account.billingExempt ? "Remove billing exemption" : "Exempt from billing"}</ActionButton>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="toggle-processing-paused" />
            <input type="hidden" name="nextPaused" value={String(!account.processingPaused)} />
            <ActionButton>{account.processingPaused ? "Resume processing" : "Pause processing"}</ActionButton>
          </Form>

          <ViewAsForm accountId={account.id} who={account.name ?? account.id} />

          {!account.cancelledAt ? <CancelForm accountId={account.id} /> : null}
        </div>

        {/* Review INFO-E. The pause toggle behaves differently on a row the brake
            owns, and nothing on this page said so. Both sentences below are the
            behavior pinned in test/admin-brake.test.ts: resuming clears the
            marker, and re-pausing a still-marked row PRESERVES 'brake' via the
            CASE in buildSetProcessingPaused, so that pause is undone by the next
            Release. The stale-tab version of that (a form rendered before the
            brake engaged, submitted after) is exactly how an operator hits it. */}
        {account.processingPaused && account.pauseReason === PAUSE_REASON_BRAKE ? (
          <p role="status" className="mt-3 rounded-md border border-orange bg-orange-bg px-3 py-2 text-label text-warning-text">
            The global emergency brake paused this account, not a person. Resuming here takes it off
            the brake&apos;s books for good, and a later Release will leave it alone. Pausing it again
            while the brake still holds it keeps the brake marker, so that pause will NOT survive the
            next Release. To hold this merchant for its own reasons, resume it first, then pause it.
          </p>
        ) : null}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Record a billing adjustment</p>
        <div className="mt-3">
          <AdjustmentForm defaultCurrency={account.currency ?? "usd"} actionData={actionData} idempotencyToken={adjustmentToken} />
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Stripe connections</p>
        {connections.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No Stripe connections.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {connections.map((c) => (
              <div key={c.id} className="flex items-center justify-between border-b border-border-sub py-2 last:border-0">
                <div>
                  <p className="text-text">{c.name ?? c.stripeUserId}</p>
                  <p className="font-mono text-micro text-text-subtle">{c.stripeUserId}</p>
                </div>
                <div className="flex items-center gap-2">
                  {c.isPrimary && !c.disconnectedAt ? <Badge tone="neutral">Primary</Badge> : null}
                  <Badge tone={c.disconnectedAt ? "failure" : "success"}>
                    {c.disconnectedAt ? "Disconnected" : "Active"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* The Products card was REMOVED with the account_products table (298).
          It had ZERO writers, so it rendered "None." for every merchant on every
          visit since the rebuild: a permanently empty card describing a table
          nothing filled. Subscriptions was its grid partner and is now a plain
          full-width section, matching this page's four other full-width sections
          rather than sitting alone in a grid built for two. */}
      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Subscriptions</p>
        {subscriptions.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">None.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {subscriptions.map((s) => (
              <li key={s.id} className="flex items-center justify-between text-label">
                <span className="text-text">
                  {s.product}
                  {s.adminGranted ? <span className="ml-1.5 text-text-subtle">(admin-granted)</span> : null}
                </span>
                <Badge tone={s.status === "active" ? "success" : "neutral"}>{s.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recovery activity</p>
          <p className="mt-2 text-label text-text-tertiary">
            <span className="font-mono text-text">{recoveryActivity.activeCount}</span> active,{" "}
            <span className="font-mono text-text">{recoveryActivity.recoveredCount}</span> recovered
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Dispute activity</p>
          <p className="mt-2 text-label text-text-tertiary">
            <span className="font-mono text-text">{disputeActivity.openCount}</span> open,{" "}
            <span className="font-mono text-text">{disputeActivity.resolvedWonCount}</span> won,{" "}
            <span className="font-mono text-text">{disputeActivity.resolvedLostCount}</span> lost
          </p>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recent invoices</p>
        {recentInvoices.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No invoices yet.</p>
        ) : (
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
                {recentInvoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-border-sub last:border-0">
                    <td className="py-2 pr-4 text-text-tertiary">
                      {inv.periodStart.toLocaleDateString()} - {inv.periodEnd.toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 font-mono text-text">{formatMoney(inv.totalCents, inv.currency)}</td>
                    <td className="py-2">
                      <Badge tone={billingInvoiceStatusTone(inv.status)}>
                        {BILLING_INVOICE_STATUS_LABELS[inv.status] ?? inv.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
