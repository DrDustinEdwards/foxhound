import { describe, expect, it } from "vitest";

import { stripeConnections, accounts } from "~/db/schema";
import {
  decryptToken,
  encryptToken,
  keyIdOf,
  loadKeyring,
  reencryptToken,
} from "~/lib/stripe/encryption";
import { reencryptConnectionTokens } from "~/lib/stripe/key-rotation.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// RULING 312: key rotation, built while ZERO ciphertext exists. 311 measured
// stripe_connections at one row (demo_teamflow) with a NULL token, so the format
// change migrates nothing today and becomes a migration touching every connected
// merchant the day after the first one connects.
//
// The format carries a key id: v1:<keyId>:<ivHex>:<cipherHex>. Without it a
// rotation cannot tell which key encrypted a value, so every stored token would
// become undecryptable at once.

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

const envA = { ENCRYPTION_KEY: KEY_A } as unknown as Env; // id defaults to k1
const envRotated = {
  ENCRYPTION_KEY: KEY_B,
  ENCRYPTION_KEY_ID: "k2",
  ENCRYPTION_KEYS_OLD: `k1:${KEY_A}`,
} as unknown as Env;

describe("312: the ciphertext format carries a key id", () => {

  it("reencryptToken moves a value onto the active key, and is a no-op when already there", async () => {
    const old = await encryptToken(envA, "subject");
    const moved = await reencryptToken(envRotated, old);
    expect(moved).not.toBeNull();
    expect(keyIdOf(moved!)).toBe("k2");
    expect(await decryptToken(envRotated, moved!)).toBe("subject");
    // Idempotent: a value already on the active key returns null rather than
    // being rewritten, which is what makes re-running the writer safe.
    expect(await reencryptToken(envRotated, moved!)).toBeNull();
  });
});

describe("312: unresolvable keys and the retired format FAIL LOUD", () => {
  it("an unknown key id names the id and the env var, never a silent null", async () => {
    const fresh = await encryptToken(envRotated, "x");
    await expect(decryptToken(envA, fresh)).rejects.toThrow(/ENCRYPTION_KEYS_OLD/);
  });

  it("THE ADJUDICATION: the pre-312 two-part format is RECOGNIZED and REFUSED", async () => {
    // Adjudicated rather than supported. Reading it would mean assuming the
    // ACTIVE key encrypted it, which is true only until the first rotation and
    // silently wrong after: the branch would fail exactly when rotation is first
    // used. Zero rows in that format existed when 312 landed, so a refusal that
    // names the remedy is honest at every moment.
    const legacy = "aabbccddeeff00112233445566:778899";
    await expect(decryptToken(envA, legacy)).rejects.toThrow(/pre-rotation format/);
    // and it must say what to DO about it
    await expect(decryptToken(envA, legacy)).rejects.toThrow(/Reconnect the Stripe account/);
  });

  it("a malformed value is still rejected as malformed, not mistaken for legacy", async () => {
    await expect(decryptToken(envA, "not-a-valid-token")).rejects.toThrow(/Malformed/);
    await expect(decryptToken(envA, "v9:k1:aa:bb")).rejects.toThrow(/Malformed/);
  });

  it("a keyring that reuses the active id, or carries a bad key, throws", () => {
    expect(() =>
      loadKeyring({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEYS_OLD: `k1:${KEY_B}` } as unknown as Env),
    ).toThrow(/reuses the active key id/);
    expect(() =>
      loadKeyring({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEYS_OLD: "k0:short" } as unknown as Env),
    ).toThrow(/64 hex/);
    expect(() => loadKeyring({} as unknown as Env)).toThrow(/ENCRYPTION_KEY is not set/);
  });
});

describe("312: the re-encrypt writer, against a real database", () => {
  /** A connection row holding whatever ciphertext the test wants. */
  function seed(sqlite: import("better-sqlite3").Database, db: unknown, id: string, token: string | null) {
    runStatement(
      sqlite,
      (db as ReturnType<typeof createInMemoryDb>["db"])
        .insert(accounts)
        .values({ id: `acct_${id}`, name: id, createdAt: new Date() }),
    );
    runStatement(
      sqlite,
      (db as ReturnType<typeof createInMemoryDb>["db"]).insert(stripeConnections).values({
        id,
        accountId: `acct_${id}`,
        stripeUserId: `su_${id}`,
        stripeAccessToken: token,
        createdAt: new Date(),
      }),
    );
  }

  it("moves every stale row onto the active key and reports the counts", async () => {
    const { sqlite, db } = createInMemoryDb();
    seed(sqlite, db, "conn_old", await encryptToken(envA, "tok-old"));
    seed(sqlite, db, "conn_current", await encryptToken(envRotated, "tok-current"));
    seed(sqlite, db, "conn_null", null);

    const report = await reencryptConnectionTokens(envRotated, db);

    // conn_null is excluded by the query, so it is not even scanned.
    expect(report.scanned).toBe(2);
    expect(report.rewritten).toBe(1);
    expect(report.alreadyActive).toBe(1);
    expect(report.failures).toEqual([]);
    expect(report.activeKeyId).toBe("k2");

    const rows = await db.select().from(stripeConnections);
    for (const row of rows) {
      if (!row.stripeAccessToken) continue;
      expect(keyIdOf(row.stripeAccessToken)).toBe("k2");
    }
    // and the plaintext survived the move
    const moved = rows.find((r) => r.id === "conn_old")!;
    expect(await decryptToken(envRotated, moved.stripeAccessToken!)).toBe("tok-old");
  });

  it("IDEMPOTENT: a second run rewrites nothing", async () => {
    const { sqlite, db } = createInMemoryDb();
    seed(sqlite, db, "conn_old", await encryptToken(envA, "tok"));

    await reencryptConnectionTokens(envRotated, db);
    const second = await reencryptConnectionTokens(envRotated, db);

    expect(second.rewritten).toBe(0);
    expect(second.alreadyActive).toBe(1);
  });

  it("a row it cannot read is REPORTED, not thrown past, and carries no token material", async () => {
    // A token under a key this env cannot resolve. The run must continue and
    // name the connection, and the reason must not contain the value.
    const { sqlite, db } = createInMemoryDb();
    const unreadable = await encryptToken(
      { ENCRYPTION_KEY: KEY_B, ENCRYPTION_KEY_ID: "kX" } as unknown as Env,
      "unreadable",
    );
    seed(sqlite, db, "conn_bad", unreadable);

    const report = await reencryptConnectionTokens(envRotated, db);

    expect(report.rewritten).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].connectionId).toBe("conn_bad");
    expect(report.failures[0].reason).toMatch(/No encryption key for id 'kX'/);
    expect(JSON.stringify(report)).not.toContain(unreadable);
  });
});
