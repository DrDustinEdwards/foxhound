import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildSuppressionInsert } from "~/lib/email/events";
import { UNSUBSCRIBE_REASON } from "~/lib/email/suppression";

import { createInMemoryDb } from "./helpers/inmemory-db";

// CAN-SPAM one-click unsubscribe (/u/:token). Two halves: the HMAC token that
// carries the account-scoped recipient, and the idempotent suppression write the
// route commits. buildSuppressionInsert is the shared suppression insert (the
// bounce consumer's); exercising it against the real migrated schema proves the
// row lands and the unique index collapses a repeat. recordUnsubscribe's own
// upsert, and its unsubscribed/already outcome, are pinned through the route in
// test/unsubscribe-page-f7.test.ts.

// 64 hex chars = 32-byte HMAC key.
const now = new Date("2026-07-21T00:00:00.000Z");

describe("unsubscribe suppression write (real sqlite)", () => {
  const insertUnsub = (db: ReturnType<typeof createInMemoryDb>["db"], token: string) =>
    buildSuppressionInsert(db, {
      email: "cust@example.com",
      token,
      reason: UNSUBSCRIBE_REASON,
      accountId: "acc_1",
      now,
    });

  it("is idempotent: a second click is a no-op, not a duplicate or an error", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme" });

    await insertUnsub(db, "tok_1");
    await insertUnsub(db, "tok_1"); // same link followed twice
    await insertUnsub(db, "tok_2"); // or a List-Unsubscribe POST after the GET

    const rows = await db
      .select()
      .from(schema.emailSuppressions)
      .where(eq(schema.emailSuppressions.email, "cust@example.com"));
    expect(rows).toHaveLength(1);
  });
});

describe("the link signing key (EMAIL_TOKEN_KEY, falling back to ENCRYPTION_KEY)", () => {
  it("signs with EMAIL_TOKEN_KEY once set, and a link signed before it still verifies", async () => {
    const { signUnsubscribeToken, verifyUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
    const payload = { email: "cust@example.com", accountId: "acc_1" };
    const before = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;
    const after = { ENCRYPTION_KEY: "a".repeat(64), EMAIL_TOKEN_KEY: "b".repeat(64) } as unknown as Env;
    const emailKeyOnly = { ENCRYPTION_KEY: "c".repeat(64), EMAIL_TOKEN_KEY: "b".repeat(64) } as unknown as Env;

    const old = await signUnsubscribeToken(before, payload);
    expect(await verifyUnsubscribeToken(after, old)).toMatchObject(payload);

    const fresh = await signUnsubscribeToken(after, payload);
    expect(fresh).not.toBe(old);
    // Signed with EMAIL_TOKEN_KEY, not ENCRYPTION_KEY: it verifies where only that key matches.
    expect(await verifyUnsubscribeToken(emailKeyOnly, fresh)).toMatchObject(payload);
    expect(await verifyUnsubscribeToken(before, fresh)).toBeNull();
  });
});
