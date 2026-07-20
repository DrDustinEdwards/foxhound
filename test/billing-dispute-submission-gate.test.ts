import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { getBillableDisputes } from "~/db/billable";
import * as schema from "~/db/schema";
import { disputeApprovals, disputes } from "~/db/schema";
import { disputeFeeCents } from "~/lib/billing/fees";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";

// Behavioral regression for the dispute-intake review HIGH: a won dispute is
// billable ONLY if Foxhound actually drafted AND submitted the evidence
// (PRICING.md rev 3: "merchant-fought disputes are never billed"). This runs
// getBillableDisputes against a REAL in-memory SQLite with the actual schema
// (the committed drizzle migrations applied verbatim), seeding the exact rows
// the invariant is about, so it proves not-billable/billable behavior, not just
// SQL shape.

const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/migrations", import.meta.url));

function applyMigrations(sqlite: Database.Database) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
}

const ACCOUNT_ID = "acc_billing_1";
const ASOF = new Date("2026-08-01T00:00:00.000Z").getTime();
const RESOLVED_AT = new Date("2026-07-20T00:00:00.000Z");
const SUBMITTED_AT = new Date("2026-07-10T00:00:00.000Z");

let db: Db;

function seedDispute(over: {
  id: string;
  amountCents: number;
  submittedAt: Date | null;
  withApproval: boolean;
}) {
  db.insert(disputes)
    .values({
      id: over.id,
      accountId: ACCOUNT_ID,
      stripeDisputeId: `dp_${over.id}`,
      stripeChargeId: `ch_${over.id}`,
      amountCents: over.amountCents,
      currency: "usd",
      reason: "fraudulent",
      status: "won",
      state: "resolved_won",
      submittedAt: over.submittedAt,
      resolvedAt: RESOLVED_AT,
      createdAt: RESOLVED_AT,
    })
    .run();
  if (over.withApproval) {
    db.insert(disputeApprovals)
      .values({
        id: `appr_${over.id}`,
        disputeId: over.id,
        accountId: ACCOUNT_ID,
        approvedByEmail: "owner@example.com",
        evidenceVersionHash: "hash",
        approvedAt: SUBMITTED_AT,
      })
      .run();
  }
}

beforeEach(() => {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  db = drizzle(sqlite, { schema }) as unknown as Db;
  db.insert(schema.accounts)
    .values({ id: ACCOUNT_ID, name: "Acme", billingExempt: false, processingPaused: false })
    .run();
});

describe("getBillableDisputes: Foxhound-submitted gate (review HIGH)", () => {
  it("a resolved_won dispute WITH an approval row AND submitted_at is billable at 20% capped $500", async () => {
    // $500 disputed -> 20% = $100 (10_000), under the cap.
    seedDispute({ id: "d_submitted", amountCents: 50_000, submittedAt: SUBMITTED_AT, withApproval: true });

    const rows = await getBillableDisputes(db, ACCOUNT_ID, ASOF);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("d_submitted");
    expect(disputeFeeCents(rows[0].amountCents)).toBe(10_000);
  });

  it("the fee caps at $500 for a large Foxhound-submitted win", async () => {
    // $10,000 disputed -> 20% would be $2,000, capped to $500.
    seedDispute({ id: "d_big", amountCents: 10_000_00, submittedAt: SUBMITTED_AT, withApproval: true });

    const rows = await getBillableDisputes(db, ACCOUNT_ID, ASOF);
    expect(rows).toHaveLength(1);
    expect(disputeFeeCents(rows[0].amountCents)).toBe(DISPUTE_FEE_CAP_CENTS);
  });

  it("a merchant-fought win (no approval row, no submitted_at) is NOT billable", async () => {
    // The exact PRICING rev 3 case: won, but Foxhound never submitted -> zero fee.
    seedDispute({ id: "d_merchant_fought", amountCents: 50_000, submittedAt: null, withApproval: false });

    const rows = await getBillableDisputes(db, ACCOUNT_ID, ASOF);
    expect(rows).toHaveLength(0);
  });

  it("an approval row WITHOUT a confirmed submission (submitted_at null) is NOT billable", async () => {
    // A pending or failed submission attempt left an approval row but the
    // submitted marker never landed (Stripe never accepted): not billed.
    seedDispute({ id: "d_pending", amountCents: 50_000, submittedAt: null, withApproval: true });

    const rows = await getBillableDisputes(db, ACCOUNT_ID, ASOF);
    expect(rows).toHaveLength(0);
  });

  it("submitted_at set but NO approval row is NOT billable (both signals are required)", async () => {
    seedDispute({ id: "d_no_approval", amountCents: 50_000, submittedAt: SUBMITTED_AT, withApproval: false });

    const rows = await getBillableDisputes(db, ACCOUNT_ID, ASOF);
    expect(rows).toHaveLength(0);
  });

  it("mixes cleanly: only the genuinely-submitted win among several resolved_won disputes bills", async () => {
    seedDispute({ id: "d_submitted", amountCents: 50_000, submittedAt: SUBMITTED_AT, withApproval: true });
    seedDispute({ id: "d_merchant_fought", amountCents: 80_000, submittedAt: null, withApproval: false });
    seedDispute({ id: "d_pending", amountCents: 90_000, submittedAt: null, withApproval: true });

    const rows = await getBillableDisputes(db, ACCOUNT_ID, ASOF);
    expect(rows.map((r) => r.id)).toEqual(["d_submitted"]);
  });
});
