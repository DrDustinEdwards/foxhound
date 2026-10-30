import { eq } from "drizzle-orm";
import { data, redirect, useActionData, useNavigation } from "react-router";
import { Alert } from "capsomer/react/banner";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import "capsomer/banner.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";

import {
  DisputeFeesSection,
  PaymentMethodSection,
  RecoverySection,
  SubscriptionsSection,
} from "~/components/billing-sections";
import { LedgerFreeRow, LedgerLineItemRow } from "~/components/billing-ledger-row";
import { accounts, getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { MEMBER_ROLE } from "~/lib/auth";
import { authContext } from "~/lib/auth/context";
import { buildDisputeFeeRows, buildRecoveryHistory } from "~/lib/billing/page.server";
import {
  buildPlatformCustomerUpdate,
  createBillingSetupSession,
  ensurePlatformCustomer,
  finalizeBillingSetupSession,
  getDefaultCard,
} from "~/lib/billing/platform-customer";
import { getBillingPreview } from "~/lib/billing/preview.server";
import { getBillingLedger, listAccountSubscriptions, listBillingInvoices } from "~/lib/billing/queries.server";
import { executeMoneyWrite } from "~/lib/money/execute";

import type { Route } from "./+types/index";

// /billing: Recova's billing page on Foxhound's billing engine.
// Recova is the spec (app/(app)/billing/page.tsx at blob 34e56833): the page
// head, then Recovery, Dispute Fees, Subscriptions and Payment method, in a
// 720px column (Recova's Intelligence offer is gone: Intelligence is free,
// Dustin 2026-10-29). The sections are in
// app/components/billing-sections.tsx. The evidence ledger, which Recova does
// not have and PRICING.md requires ("The billing page renders action ->
// recovery -> fee for every charge"), follows them; whether it stays is an open
// question for Dustin in the J65 pull request.
//
// The loader is read-only: billing preview, invoices and their line items,
// subscriptions and the card on file. The one
// write is the existing billing-setup action below, unchanged.

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
    // The demo never calls Stripe (hard rule 10), and an admin viewing as a
    // merchant does not finalize the merchant's card for them: both just land
    // on the clean URL.
    if (auth.isDemo || auth.viewingAs) throw redirect("/billing");
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
  const [accountRow, ledger, invoices, preview, subscriptions] = await Promise.all([
    loadAccountBillingRow(env, accountId),
    getBillingLedger(db, accountId),
    listBillingInvoices(db, accountId),
    getBillingPreview(db, accountId, Date.now()),
    listAccountSubscriptions(db, accountId),
  ]);

  // The card on file is a Stripe read. The demo never calls Stripe (RULES.md
  // 4.12), and an account that never started setup has no customer to read.
  const customerId = accountRow?.platformStripeCustomerId ?? null;
  const card = customerId && !auth.isDemo ? await getDefaultCard(env, customerId) : null;

  return {
    card,
    preview,
    recoveryHistory: buildRecoveryHistory(invoices, ledger.lineItems),
    disputeFees: buildDisputeFeeRows(invoices, ledger.lineItems, preview.pendingDisputeFees),
    subscriptions,
    ledger,
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;

  // OWNERS ONLY: the card on file pays every fee the account owes, so only the
  // owner puts one there, as only an owner disconnects Stripe or mints an API key.
  if (auth.membership.role !== MEMBER_ROLE.OWNER) {
    return data({ error: "Only the account owner can set up billing." }, { status: 403 });
  }

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
    // Stripe's and D1's messages stay in the log; the merchant gets one sentence.
    console.error("billing setup start failed:", err instanceof Error ? err.message : err);
    return data({ error: "Could not start billing setup. Please try again." }, { status: 400 });
  }
}

export default function Billing({ loaderData }: Route.ComponentProps) {
  const { card, preview, recoveryHistory, disputeFees, subscriptions, ledger } = loaderData;
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
    <div className="mx-auto max-w-[720px] px-5 sm:px-8 py-8 md:py-10">
      {/* Ruling 147 f1-f3, legacy app/(app)/billing/page.tsx: max-w-[720px]
      mx-auto px-5 sm:px-8 py-8 md:py-10. NOTE 147 recorded billing as "half
      legacy's width"; that was WRONG. Legacy is 720px and max-w-3xl is 768px,
      so Foxhound was 48px WIDER, not 512px narrower. Legacy also steps
      horizontal padding at sm, not md, and starts from px-5 not px-4. Same
      720/px-5 kit legacy uses on /help and the legal pages. */}
      <div className="mb-8">
        <PageHead title="Billing" lead="Invoices, subscriptions, and payment method." />
      </div>

      {actionData && "error" in actionData ? (
        <div className="mb-6">
          <Alert tone="crit">{actionData.error}</Alert>
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <RecoverySection
          attributedThisMonth={preview.attributedThisMonth}
          estimatedRecoveryFees={preview.estimatedRecoveryFees}
          nextRunAtMs={preview.nextRunAtMs}
          accountBillingState={preview.accountBillingState}
          rows={recoveryHistory}
        />

        <DisputeFeesSection
          estimatedDisputeFees={preview.estimatedDisputeFees}
          nextRunAtMs={preview.nextRunAtMs}
          accountBillingState={preview.accountBillingState}
          rows={disputeFees}
        />

        <SubscriptionsSection subscriptions={subscriptions} />

        <PaymentMethodSection card={card} busy={busy} />

        <Panel title="Evidence ledger">
          {entries.length === 0 ? (
            <p className="text-label text-text-tertiary">
              Nothing to show yet. Every fee Foxhound ever charges, and every free recovery, will
              appear here with its full evidence.
            </p>
          ) : (
            <ol className="flex flex-col">{entries.map((e) => e.node)}</ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
