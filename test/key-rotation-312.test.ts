import { describe, expect, it } from "vitest";

import { stripeConnections, accounts } from "~/db/schema";
import { decryptToken, encryptToken, keyIdOf } from "~/lib/stripe/encryption";
import {
  reencryptConnectionTokens,
  reencryptSlackWebhooks,
} from "~/lib/stripe/key-rotation.server";

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

describe("312: the re-encrypt writer, against a real database", () => {
  /** A connection row holding whatever ciphertext the test wants. */
  function seed(
    sqlite: import("better-sqlite3").Database,
    db: unknown,
    id: string,
    token: string | null,
  ) {
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
    expect(report.failures[0].reason).toMatch(/No key for id 'kX'/);
    expect(JSON.stringify(report)).not.toContain(unreadable);
  });

  it("the sealed Slack webhook URLs move onto the active key too", async () => {
    const { sqlite, db } = createInMemoryDb();
    const url = "https://hooks.slack.com/services/T/B/x";
    runStatement(
      sqlite,
      db.insert(accounts).values({
        id: "acct_slack",
        name: "slack",
        createdAt: new Date(),
        slackWebhookUrl: await encryptToken(envA, url),
      }),
    );

    const report = await reencryptSlackWebhooks(envRotated, db);

    expect(report).toMatchObject({ scanned: 1, rewritten: 1, failures: [] });
    const [row] = await db.select().from(accounts);
    expect(keyIdOf(row.slackWebhookUrl!)).toBe("k2");
    expect(await decryptToken(envRotated, row.slackWebhookUrl!)).toBe(url);
  });
});
