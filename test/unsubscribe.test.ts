import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildSuppressionInsert } from "~/lib/email/events";
import { UNSUBSCRIBE_REASON } from "~/lib/email/suppression";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "~/lib/email/unsubscribe-token";

import { createInMemoryDb } from "./helpers/inmemory-db";

// CAN-SPAM one-click unsubscribe (/u/:token). Two halves: the HMAC token that
// carries the account-scoped recipient, and the idempotent suppression write the
// route commits. buildSuppressionInsert is the shared suppression insert (the
// bounce consumer's); exercising it against the real migrated schema proves the
// row lands and the unique index collapses a repeat. recordUnsubscribe's own
// upsert, and its unsubscribed/already outcome, are pinned through the route in
// test/unsubscribe-page-f7.test.ts.

// 64 hex chars = 32-byte HMAC key.
const env = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;
const now = new Date("2026-07-21T00:00:00.000Z");

describe("unsubscribe token sign/verify", () => {
  it("round-trips the account-scoped recipient", async () => {
    const token = await signUnsubscribeToken(env, { email: "cust@example.com", accountId: "acc_1" });
    expect(await verifyUnsubscribeToken(env, token)).toEqual({
      email: "cust@example.com",
      accountId: "acc_1",
    });
  });

  it("rejects a tampered token (fail closed to the invalid state)", async () => {
    const token = await signUnsubscribeToken(env, { email: "cust@example.com", accountId: "acc_1" });
    const [payloadPart, sig] = token.split(".");
    const tampered = `${payloadPart.slice(0, -1)}${payloadPart.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    expect(await verifyUnsubscribeToken(env, tampered)).toBeNull();
  });

  it("rejects a garbage token", async () => {
    expect(await verifyUnsubscribeToken(env, "not-a-token")).toBeNull();
  });
});

describe("unsubscribe suppression write (real sqlite)", () => {
  const insertUnsub = (db: ReturnType<typeof createInMemoryDb>["db"], token: string) =>
    buildSuppressionInsert(db, {
      email: "cust@example.com",
      token,
      reason: UNSUBSCRIBE_REASON,
      accountId: "acc_1",
      now,
    });

  it("lands one account-scoped row with reason=unsubscribe", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme" });

    await insertUnsub(db, "tok_1");

    const rows = await db
      .select()
      .from(schema.emailSuppressions)
      .where(eq(schema.emailSuppressions.email, "cust@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("unsubscribe");
    expect(rows[0]?.accountId).toBe("acc_1");
    expect(rows[0]?.suppressedAt).not.toBeNull();
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
