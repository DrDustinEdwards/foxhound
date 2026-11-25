import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";

// Asserts the emitted SQL (the D1 binding does not exist here): catches a dropped exclusion clause in the query feeding the invoice batch.

const db = drizzle({} as never, { schema });
const sqlOf = (q: unknown) => (q as { toSQL(): { sql: string; params: unknown[] } }).toSQL().sql;

const AS_OF = new Date("2026-07-01T00:00:00.000Z").getTime();

describe("getBillableRecoveries excludes what must never be billed", () => {
  const sql = sqlOf(getBillableRecoveries(db, "acc_1", AS_OF));

  it("excludes refunded, disputed and deleted recoveries", () => {
    expect(sql).toMatch(/"?refunded_at"?\s+is\s+null/i);
    expect(sql).toMatch(/"?disputed_at"?\s+is\s+null/i);
    expect(sql).toMatch(/"?deleted_at"?\s+is\s+null/i);
  });
});

describe("getBillableDisputes carries the same exclusions", () => {
  const sql = sqlOf(getBillableDisputes(db, "acc_1", AS_OF));

  it("bills only submitted, resolved disputes that are not already billed", () => {
    expect(sql).toMatch(/from\s+"?disputes"?/i);
    expect(sql).toMatch(/"?submitted_at"?\s+is\s+not\s+null/i);
    expect(sql).toMatch(/"?resolved_at"?\s*<=/i);
    expect(sql).toMatch(/"?billing_line_items"?\."?id"?\s+is\s+null/i);
  });

  it("carries the account billing-eligibility gate", () => {
    expect(sql).toMatch(/"?billing_exempt"?/i);
    expect(sql).toMatch(/"?processing_paused"?/i);
  });
});
