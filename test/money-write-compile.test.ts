import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { outcomes } from "~/db";
import * as schema from "~/db/schema";

// Proves the money-write executor's compilation step (app/lib/money/execute.ts):
// a Drizzle batch is compiled to plain { sql, params } via .toSQL() and sent to
// the DO. The crux is that Drizzle encodes column values to driver-ready
// primitives at compile time - Date -> epoch-ms number, json -> string - so no
// Drizzle internals or Date objects need to cross the DO boundary. .toSQL() is
// pure (no DB connection needed).

describe("money-write statement compilation", () => {
  it("compiles an outcomes insert to driver-ready sql + params", () => {
    const db = drizzle({} as never, { schema });
    const at = new Date("2026-01-02T03:04:05.000Z");

    const { sql, params } = db
      .insert(outcomes)
      .values({
        accountId: "acc_1",
        product: "recovery",
        eventType: "payment_recovered",
        eventData: { amountCents: 1234 },
        outcome: "success",
        outcomeAt: at,
        createdAt: at,
        idempotencyKey: "k1",
        attributionKind: "foxhound_retry",
        attributedRef: "step_1",
      })
      .toSQL();

    expect(sql).toMatch(/insert into .outcomes./i);
    // Timestamps are epoch-ms numbers, not Date objects.
    expect(params).toContain(at.getTime());
    expect(params.some((p) => p instanceof Date)).toBe(false);
    // json column is serialized to a string.
    expect(params).toContain(JSON.stringify({ amountCents: 1234 }));
    // The idempotency key (the exactly-once backstop) is bound.
    expect(params).toContain("k1");
  });
});
