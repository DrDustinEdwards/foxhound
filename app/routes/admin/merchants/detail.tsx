import { Alert, Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { RecordFacts } from "capsomer/react/record-facts";
import { Row, RowList } from "capsomer/react/row-list";
import { Select } from "capsomer/react/select";
import { Pill } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/record-facts.css";
import "capsomer/select.css";
import "capsomer/status.css";
import { useState } from "react";
import { Time } from "capsomer/react/time";
import { data, Form, useNavigation } from "react-router";

import { ViewAsForm } from "~/components/admin-merchants-parts";
import { BADGE_PILL } from "~/lib/recovery/labels";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import {
  getMerchantDetail,
  setBillingExempt,
  setProcessingPaused,
} from "~/lib/admin/merchants.server";
import { cancelMerchant } from "~/lib/admin/merchant-cancel.server";
import { adminContext } from "~/lib/admin/context";
import { createAdjustment } from "~/lib/billing/adjustment";
import { BILLING_INVOICE_STATUS_LABELS, billingInvoiceStatusTone } from "~/lib/billing/labels";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { parseMoneyInput } from "@dustinedwards/site-runtime/money";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/detail";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

export const handle: AdminHandle<{ account: { name: string | null; id: string } }> = {
  page: (data: { account: { name: string | null; id: string } }) =>
    data.account.name ?? data.account.id,
};

export function meta({ loaderData }: Route.MetaArgs) {
  const name = loaderData ? (loaderData.account.name ?? loaderData.account.id) : "Merchant";
  return [{ title: `${name} - Foxhound admin` }, NOINDEX];
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

  const form = await readForm(request, BODY_MAX_BYTES);
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
    const currency = String(form.get("currency") ?? "")
      .trim()
      .toLowerCase();
    const description = String(form.get("description") ?? "").trim();
    const magnitudeCents = parseMoneyInput(String(form.get("amount") ?? ""), "usd");
    const idempotencyToken = String(form.get("idempotencyToken") ?? "");

    if (
      !magnitudeCents ||
      !currency ||
      !description ||
      !idempotencyToken ||
      (direction !== "credit" && direction !== "correction")
    ) {
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

const INVOICES_HEADING_ID = "admin-merchant-invoices";

function ActionButton({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "danger";
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <button
      type="submit"
      disabled={busy}
      className="cap-btn"
      data-variant={tone === "danger" ? "danger" : undefined}
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
        className="cap-btn"
        data-variant="danger"
      >
        Cancel merchant
      </button>
    );
  }

  return (
    <Form method="post" className="cap-cluster">
      <input type="hidden" name="intent" value="cancel" />
      <span className="text-label text-error-text">
        Disconnects Stripe and stops all processing for {accountId}. Already-matured, unbilled fees
        still bill. Confirm?
      </span>
      <ActionButton tone="danger">Yes, cancel</ActionButton>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="cap-btn"
        data-variant="quiet"
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
    <Form method="post" className="cap-stack">
      <input type="hidden" name="intent" value="create-adjustment" />
      <input type="hidden" name="idempotencyToken" value={idempotencyToken} />
      {actionData?.error ? <Alert>{actionData.error}</Alert> : null}
      {actionData?.adjustmentInvoiceId ? <Banner tone="ok">Adjustment recorded.</Banner> : null}
      <div className="cap-cluster items-start">
        <Field label="Direction">
          <Select
            native
            name="direction"
            defaultValue="credit"
            options={[
              { value: "credit", label: "Credit merchant (reduces what they owe)" },
              { value: "correction", label: "Correction (increases what they owe)" },
            ]}
          />
        </Field>
        <Field label="Amount" size="short">
          <input
            name="amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            required
            className="cap-input"
          />
        </Field>
        <Field label="Currency" size="short">
          <input
            name="currency"
            type="text"
            defaultValue={defaultCurrency}
            required
            className="cap-input"
          />
        </Field>
      </div>
      <Field
        label="Reason"
        help="Adjustments never touch Stripe: they are internal ledger entries only, never a card charge or refund."
      >
        <textarea
          name="description"
          rows={2}
          required
          placeholder="Goodwill credit for a delayed dunning email; error correction for..."
          className="cap-input"
        />
      </Field>
      <div>
        <button type="submit" disabled={busy} className="cap-btn" data-variant="primary">
          Record adjustment
        </button>
      </div>
    </Form>
  );
}

export default function AdminMerchantDetail({ loaderData, actionData }: Route.ComponentProps) {
  const {
    account,
    connections,
    subscriptions,
    recoveryActivity,
    disputeActivity,
    recentInvoices,
    adjustmentToken,
  } = loaderData;

  return (
    <div className="grid grid-cols-1 gap-6">
      <Panel
        title="Account"
        actions={
          <>
            {account.cancelledAt ? <Pill {...BADGE_PILL.failure}>Canceled</Pill> : null}
            {account.billingExempt ? <Pill {...BADGE_PILL.neutral}>Billing exempt</Pill> : null}
            {account.processingPaused ? (
              <Pill {...BADGE_PILL.failure}>
                {account.pauseReason === PAUSE_REASON_BRAKE
                  ? "Paused by brake"
                  : "Processing paused"}
              </Pill>
            ) : null}
            {!account.cancelledAt && !account.billingExempt && !account.processingPaused ? (
              <Pill {...BADGE_PILL.success}>Normal</Pill>
            ) : null}
          </>
        }
      >
        <div className="cap-stack">
          <RecordFacts
            facts={[
              { label: "Account id", value: account.id, mono: true },
              { label: "Created", value: <Time at={account.createdAt} empty="unknown" tip /> },
              ...(account.cancelledAt
                ? [
                    {
                      label: "Canceled",
                      value: <Time at={account.cancelledAt} empty="never" tip />,
                    },
                  ]
                : []),
              {
                label: "Platform Stripe customer",
                value: account.platformStripeCustomerId ?? "not set up",
                mono: account.platformStripeCustomerId !== null,
              },
            ]}
          />

          {actionData?.warning ? <Alert>{actionData.warning}</Alert> : null}

          <div className="cap-cluster">
            <Form method="post">
              <input type="hidden" name="intent" value="toggle-billing-exempt" />
              <input type="hidden" name="nextExempt" value={String(!account.billingExempt)} />
              <ActionButton>
                {account.billingExempt ? "Remove billing exemption" : "Exempt from billing"}
              </ActionButton>
            </Form>

            <Form method="post">
              <input type="hidden" name="intent" value="toggle-processing-paused" />
              <input type="hidden" name="nextPaused" value={String(!account.processingPaused)} />
              <ActionButton>
                {account.processingPaused ? "Resume processing" : "Pause processing"}
              </ActionButton>
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
            <Banner tone="warn">
              The global emergency brake paused this account, not a person. Resuming here takes it
              off the brake&apos;s books for good, and a later Release will leave it alone. Pausing
              it again while the brake still holds it keeps the brake marker, so that pause will NOT
              survive the next Release. To hold this merchant for its own reasons, resume it first,
              then pause it.
            </Banner>
          ) : null}
        </div>
      </Panel>

      <Panel title="Record a billing adjustment">
        <AdjustmentForm
          defaultCurrency={account.currency ?? "usd"}
          actionData={actionData}
          idempotencyToken={adjustmentToken}
        />
      </Panel>

      <Panel title="Stripe connections" flush={connections.length > 0}>
        {connections.length === 0 ? (
          <Empty kind="nothing-yet" title="No Stripe connections." flush />
        ) : (
          <RowList label="Stripe connections">
            {connections.map((c) => (
              <Row
                key={c.id}
                title={c.name ?? c.stripeUserId}
                meta={<span className="font-mono">{c.stripeUserId}</span>}
                actions={
                  <>
                    {c.isPrimary && !c.disconnectedAt ? (
                      <Pill {...BADGE_PILL.neutral}>Primary</Pill>
                    ) : null}
                    <Pill {...BADGE_PILL[c.disconnectedAt ? "failure" : "success"]}>
                      {c.disconnectedAt ? "Disconnected" : "Active"}
                    </Pill>
                  </>
                }
              />
            ))}
          </RowList>
        )}
      </Panel>

      {/* The Products card was REMOVED with the account_products table.
          It had ZERO writers, so it rendered "None." for every merchant on every
          visit since the rebuild: a permanently empty card describing a table
          nothing filled. Subscriptions was its grid partner and is now a plain
          full-width panel, matching this page's other full-width panels
          rather than sitting alone in a grid built for two. */}
      <Panel title="Subscriptions" flush={subscriptions.length > 0}>
        {subscriptions.length === 0 ? (
          <Empty kind="nothing-yet" title="No subscriptions." flush />
        ) : (
          <RowList label="Subscriptions">
            {subscriptions.map((s) => (
              <Row
                key={s.id}
                title={s.product}
                meta={s.adminGranted ? "Admin-granted" : undefined}
                actions={
                  <Pill {...BADGE_PILL[s.status === "active" ? "success" : "neutral"]}>
                    {s.status}
                  </Pill>
                }
              />
            ))}
          </RowList>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel title="Recovery activity" size="sm">
          <p className="text-label text-text-tertiary">
            <span className="font-mono text-text">{recoveryActivity.activeCount}</span> active,{" "}
            <span className="font-mono text-text">{recoveryActivity.recoveredCount}</span> recovered
          </p>
        </Panel>
        <Panel title="Dispute activity" size="sm">
          <p className="text-label text-text-tertiary">
            <span className="font-mono text-text">{disputeActivity.openCount}</span> open,{" "}
            <span className="font-mono text-text">{disputeActivity.resolvedWonCount}</span> won,{" "}
            <span className="font-mono text-text">{disputeActivity.resolvedLostCount}</span> lost
          </p>
        </Panel>
      </div>

      <Panel title="Recent invoices" headingId={INVOICES_HEADING_ID} flush>
        {recentInvoices.length === 0 ? (
          <Empty kind="nothing-yet" title="No invoices yet." />
        ) : (
          <div
            className="cap-table-wrap"
            data-reflow="medium"
            role="region"
            aria-labelledby={INVOICES_HEADING_ID}
            tabIndex={0}
          >
            <table className="cap-table">
              <caption className="cap-sr-only">This merchant&apos;s recent invoices.</caption>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col" data-num="">
                    Total
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentInvoices.map((inv) => (
                  <tr key={inv.id}>
                    <th scope="row" className="font-normal">
                      {inv.periodStart.toLocaleDateString()} - {inv.periodEnd.toLocaleDateString()}
                    </th>
                    <td data-label="Total" data-num="">
                      {formatMoney(inv.totalCents, inv.currency)}
                    </td>
                    <td data-label="Status">
                      <Pill {...BADGE_PILL[billingInvoiceStatusTone(inv.status)]}>
                        {BILLING_INVOICE_STATUS_LABELS[inv.status] ?? inv.status}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
