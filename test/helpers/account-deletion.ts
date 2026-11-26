import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, vi } from "vitest";

import * as schema from "~/db/schema";
import { account as authAccount, session, user, verification } from "~/db/auth-schema";
import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";
import { getBillingLedger } from "~/lib/billing/queries.server";
import { getBillingPreview } from "~/lib/billing/preview.server";
import { deleteUserAccountLocal as deleteLocal } from "~/lib/auth/delete-account.server";
import type { Db } from "~/db";

import { createInMemoryDb } from "./inmemory-db";
import { DAY, NOW, OLD, OLDER, OWNER_EMAIL, seedRecords } from "./account-deletion-seed";

// Account deletion keeps fee evidence. Deletion removes the merchant's personal
// data and their end customers' names, emails and other personal details, while
// the payments Foxhound recovered survive with only what proves the fee:
// amounts, currency, dates, Stripe ids and the attribution chain.
//
// The database enforces foreign keys here, as D1 does in production. The shared
// harness leaves them off, so a delete in the wrong order would pass there and
// fail on D1.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

/** The deletion as Better Auth's deleteUser runs it: Foxhound's batch (its
 *  beforeDelete hook), then the user row, which Better Auth deletes. */
export async function deleteUserAccountLocal(db: Db, userId: string, now: Date) {
  const result = await deleteLocal(db, userId, now);
  await db.delete(user).where(eq(user.id, userId));
  return result;
}
const OWNER_NAME = "Olive Owner";
const TEAMMATE_EMAIL = "teammate@acme.test";

// The other merchant: a different user owning a different account. Nothing
// about them may change.
const OTHER_EMAIL = "other@globex.test";

let sqlite: Database.Database;
export let db: Db;

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  sqlite.pragma("foreign_keys = ON");
  harness.db = db;
});

export function foreignKeyViolations(): unknown[] {
  return sqlite.prepare("PRAGMA foreign_key_check").all();
}

function tableNames(): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name NOT LIKE '%_fts%'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** Every row of every table, as text. */
export function dumpAll(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const name of tableNames()) {
    out[name] = sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return out;
}

interface Seeded {
  userId: string;
  accountId: string;
}

async function seedMerchant(opts: {
  userId: string;
  email: string;
  name: string;
  accountId: string;
  prefix: string;
  personal: boolean;
}): Promise<Seeded> {
  const { userId, accountId, prefix: p } = opts;
  // The other merchant's values are the deleting merchant's REVERSED, so they
  // are just as present but never equal one of the deleting merchant's values.
  const t = (s: string) => (opts.personal ? s : `${p}:${s.split("").reverse().join("")}`);
  const at = (ms: number) => new Date(ms);

  await db.insert(user).values({
    id: userId,
    name: opts.name,
    email: opts.email,
    emailVerified: true,
    updatedAt: OLD,
  });
  await db.insert(session).values({
    id: `${p}-sess`,
    token: `${p}-token`,
    userId,
    expiresAt: at(NOW.getTime() + DAY),
    updatedAt: OLD,
    ipAddress: t("203.0.113.77"),
    userAgent: "test",
    activeAccountId: accountId,
  });
  await db.insert(authAccount).values({
    id: `${p}-ba`,
    accountId: userId,
    providerId: "credential",
    userId,
    password: "hash",
    updatedAt: OLD,
  });
  await db.insert(verification).values({
    id: `${p}-ver`,
    identifier: opts.email,
    value: userId,
    expiresAt: at(NOW.getTime() + DAY),
  });

  await db.insert(schema.accounts).values({
    id: accountId,
    name: t("Acme Widgets LLC"),
    notificationEmail: t("notify@acme.test"),
    digestEmail: t("digest@acme.test"),
    slackWebhookUrl: t("https://hooks.slack.com/services/T000/B000/acme"),
    merchantIndustry: t("the industry is Ada widgets"),
    primaryCustomerType: "b2b",
    merchantMrrSelfReported: 500_000,
    mrrEstimateCents: 500_000,
    disputeProductDescription: t("Ada widgets, hand made"),
    createdAt: OLDER,
    platformStripeCustomerId: `cus_platform_${p}`,
    liveSendsEnabled: true,
    currency: "usd",
  });
  await db.insert(schema.accountMembers).values({
    id: `${p}-owner`,
    accountId,
    userId,
    role: "owner",
    status: "active",
    createdAt: OLDER,
  });
  await db.insert(schema.accountMembers).values({
    id: `${p}-invite`,
    accountId,
    userId: null,
    role: "member",
    invitedEmail: t(TEAMMATE_EMAIL),
    status: "pending",
    inviteToken: `${p}-invite-token`,
    createdAt: OLDER,
  });
  await db.insert(schema.stripeConnections).values({
    id: `${p}-conn`,
    accountId,
    stripeUserId: `acct_${p}`,
    stripeAccessToken: t("sk_live_acme_secret"),
    stripePublishableKey: t("pk_live_acme"),
    name: t("Acme Widgets LLC"),
    isPrimary: true,
    connectedAt: OLDER,
    createdAt: OLDER,
    senderName: t("Acme Billing Team"),
    replyToEmail: t("replies@acme.test"),
    brandVoice: t("Warm and friendly, Acme voice"),
  });
  await db.insert(schema.apiKeys).values({
    id: `${p}-key`,
    accountId,
    keyHash: `${p}-hash`,
    label: t("Ada key"),
    scope: "read",
    createdAt: OLDER,
  });
  // An external agent connected over OAuth: its client, the code the
  // owner approved and the grant whose access token is the key above. The
  // grant points at the key, so the key cannot go first.
  await db.insert(schema.oauthClients).values({
    id: `${p}-client`,
    clientName: "Agent",
    redirectUris: ["https://agent.example.com/callback"],
    createdAt: OLDER,
  });
  await db.insert(schema.oauthAuthorizationCodes).values({
    id: `${p}-code`,
    codeHash: `${p}-code-hash`,
    clientId: `${p}-client`,
    accountId,
    userId,
    redirectUri: "https://agent.example.com/callback",
    codeChallenge: "x".repeat(43),
    expiresAt: OLDER,
    usedAt: OLDER,
    createdAt: OLDER,
  });
  await db.insert(schema.oauthGrants).values({
    id: `${p}-grant`,
    clientId: `${p}-client`,
    accountId,
    apiKeyId: `${p}-key`,
    userId,
    codeId: `${p}-code`,
    refreshHash: `${p}-refresh-hash`,
    refreshExpiresAt: NOW,
    createdAt: OLDER,
  });

  await seedRecords(db, opts, t);

  return { userId, accountId };
}

export async function seedBoth(): Promise<{ me: Seeded; other: Seeded }> {
  const me = await seedMerchant({
    userId: "user_me",
    email: OWNER_EMAIL,
    name: OWNER_NAME,
    accountId: "acct_me",
    prefix: "me",
    personal: true,
  });
  const other = await seedMerchant({
    userId: "user_other",
    email: OTHER_EMAIL,
    name: "Otto Other",
    accountId: "acct_other",
    prefix: "ot",
    personal: false,
  });
  return { me, other };
}

/** The numbers the fee is computed from: the billable sets, the preview the
 *  /billing page shows, and the evidence ledger, reduced to amounts and ids. */
export async function feePicture(accountId: string) {
  const recoveries = await getBillableRecoveries(db, accountId, NOW.getTime());
  const disputes = await getBillableDisputes(db, accountId, NOW.getTime());
  const preview = await getBillingPreview(db, accountId, NOW.getTime());
  const ledger = await getBillingLedger(db, accountId);
  return {
    billableRecoveries: recoveries.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      currency: r.currency,
    })),
    billableDisputes: disputes.map((d) => ({
      id: d.id,
      amountCents: d.amountCents,
      fee: d.resolvedFeeCents,
    })),
    estimatedInvoice: preview.estimatedInvoice,
    ledgerLines: ledger.lineItems.map((l) => ({
      line: l.lineItem.id,
      amountCents: l.lineItem.amountCents,
      recovered: l.recoveredPayment?.id ?? null,
      recoveredAmount: l.recoveredPayment?.amountCents ?? null,
      attribution: l.recoveredPayment?.attributionKind ?? null,
      step: l.creditedStepType,
    })),
    free: ledger.freeRecoveries.map((f) => ({
      id: f.recoveredPayment.id,
      amountCents: f.recoveredPayment.amountCents,
    })),
  };
}
