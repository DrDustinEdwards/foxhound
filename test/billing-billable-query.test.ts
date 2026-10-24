import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";

// THE JOIN NOBODY TESTED. Three links of the refund chain each had coverage and the
// link between them did not:
//
//   1. charge.refunded stamps refunded_at            test/webhooks-refund-stamp.test.ts
//   2. a refunded ROW is not billable                test/billing-billable-predicates.test.ts
//   3. buildBillingInvoiceBatch bills what it is given  test/billing-run.test.ts
//
// Step 3 takes ALREADY-FILTERED rows, so no test of it can show that a refunded
// recovery produces zero fee lines. The thing that decides that is getBillableRecoveries,
// the query feeding the invoice batch, and it had no test at all. Losing its
// isNull(refunded_at) clause would have been invisible: every other test stays green,
// and the first symptom is invoicing 20% of money the merchant already gave back.
//
// These assert the emitted SQL, because the query is built against a D1 binding that
// does not exist in unit tests. That is weaker than executing it and is said out loud
// rather than dressed up: it catches a dropped clause, not a semantic mistake in one.

const db = drizzle({} as never, { schema });
const sqlOf = (q: unknown) => (q as { toSQL(): { sql: string; params: unknown[] } }).toSQL().sql;

const AS_OF = new Date("2026-07-01T00:00:00.000Z").getTime();

describe("getBillableRecoveries excludes what must never be billed", () => {
  const sql = sqlOf(getBillableRecoveries(db, "acc_1", AS_OF));

  it("excludes refunded recoveries", () => {
    // The clause this whole chain exists to produce.
    expect(sql).toMatch(/"?refunded_at"?\s+is\s+null/i);
  });

  it("excludes disputed and deleted recoveries", () => {
    expect(sql).toMatch(/"?disputed_at"?\s+is\s+null/i);
    expect(sql).toMatch(/"?deleted_at"?\s+is\s+null/i);
  });

  it("keeps the maturity window and the not-already-billed join", () => {
    // Without maturity a refund arriving inside the window bills before it can be seen.
    expect(sql).toMatch(/recovered_at/i);
    expect(sql).toMatch(/billing_line_items/i);
  });

  it("the assertions above are not vacuous: the query is real SQL over the right table", () => {
    // A toSQL() that returned an empty string would pass every toMatch above only if
    // they were negated, and would pass a naive "contains" check trivially. Pin the
    // shape so an empty or wrong-table query cannot satisfy this file.
    expect(sql.length).toBeGreaterThan(80);
    expect(sql).toMatch(/from\s+"?recovered_payments"?/i);
  });
});

describe("getBillableDisputes carries the same exclusions", () => {
  const sql = sqlOf(getBillableDisputes(db, "acc_1", AS_OF));

  it("bills only submitted, resolved disputes that are not already billed", () => {
    // `disputes` has no deleted_at column, unlike recovered_payments. Its exclusions
    // are lifecycle ones: a dispute is billable only once it was actually submitted
    // and has resolved, and only if no line item already exists for it.
    expect(sql).toMatch(/from\s+"?disputes"?/i);
    expect(sql).toMatch(/"?submitted_at"?\s+is\s+not\s+null/i);
    expect(sql).toMatch(/"?resolved_at"?\s*<=/i);
    expect(sql).toMatch(/"?billing_line_items"?\."?id"?\s+is\s+null/i);
  });

  it("carries the account billing-eligibility gate", () => {
    // billing_exempt and processing_paused are the account-level gates; without them
    // a paused or exempt merchant is invoiced anyway.
    expect(sql).toMatch(/"?billing_exempt"?/i);
    expect(sql).toMatch(/"?processing_paused"?/i);
  });
});
