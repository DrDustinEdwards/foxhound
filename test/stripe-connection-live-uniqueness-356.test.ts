import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 356, DEFECT 4, LAYER 1 OF TWO: the database refuses a second LIVE
// stripe_connections row for one Stripe account.
//
// WHY A DATABASE CONSTRAINT AND NOT ONLY A CHECK. `resolveConnection` maps an
// incoming connected webhook to a Foxhound account by `stripe_user_id` alone,
// so a duplicate live row sends another merchant's failed payments, recovered
// payments and billing line items to the wrong ledger. An application check can
// be bypassed by a race between two callbacks; the index cannot.
//
// THE FIXTURE CARRIES TWO USERS, NOT TWO MEMBERSHIPS (356 binding 5): DEFECT 4
// predates multi-account and needs two people who both hold Stripe access to
// one connected account, which is why a two-membership fixture would miss it.
//
// The reader half (isNull(disconnectedAt) in resolveConnection) is layer 2 and
// is proven separately, per 340: two layers that independently prevent one
// outcome prove nothing unless each is reached alone.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));


const STRIPE_X = "acct_stripe_x";
const ACCOUNT_A = "acct_a";
const ACCOUNT_B = "acct_b";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  seedAccount(ACCOUNT_A, "Acme, held by user 1");
  seedAccount(ACCOUNT_B, "Globex, held by user 2");
});

function seedAccount(id: string, name: string): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)")
    .run(id, name, 1_000);
}

/** Insert a connection row exactly as the connect callback's money write does. */
function insertConnection(opts: {
  id: string;
  accountId: string;
  stripeUserId: string;
  disconnectedAt?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, stripe_access_token, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, 'enc', 1, ?, ?, ?)",
    )
    .run(opts.id, opts.accountId, opts.stripeUserId, 1_000, opts.disconnectedAt ?? null, 1_000);
}

function liveRowsFor(stripeUserId: string): string[] {
  return (
    sqlite
      .prepare(
        "SELECT account_id AS a FROM stripe_connections WHERE stripe_user_id = ? AND disconnected_at IS NULL ORDER BY rowid",
      )
      .all(stripeUserId) as { a: string }[]
  ).map((r) => r.a);
}

describe("the index exists and is the one this session shipped", () => {
  it("stripe_connections_live_stripe_account_uq is present, unique, and scoped to live rows", () => {
    // CALIBRATION (259): read the real DDL rather than trusting that the
    // migration ran, and pin the WHERE clause, because an index without it
    // would pass every refusal test below while permanently banning reconnect.
    const row = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("stripe_connections_live_stripe_account_uq") as { sql: string } | undefined;

    expect(row?.sql).toBeTruthy();
    expect(row!.sql).toContain("UNIQUE");
    expect(row!.sql).toContain("stripe_user_id");
    expect(row!.sql.toLowerCase()).toContain("disconnected_at");
    expect(row!.sql.toLowerCase()).toContain("is null");
  });
});

describe("PLANT 1: a second LIVE row for one Stripe account is refused", () => {
  it("refuses it on a DIFFERENT Foxhound account, which is DEFECT 4's reproduction", () => {
    insertConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });

    // User 2, active on their own account, completes Stripe's OAuth for the
    // same connected account. Before this index the insert succeeded and the
    // webhook layer then routed X's money to whichever row came first.
    expect(() =>
      insertConnection({ id: "conn_b", accountId: ACCOUNT_B, stripeUserId: STRIPE_X }),
    ).toThrow(/unique/i);

    expect(liveRowsFor(STRIPE_X)).toEqual([ACCOUNT_A]);
  });

  it("refuses it on the SAME Foxhound account too", () => {
    // The constraint is on the Stripe account, not on the pair, so a duplicate
    // within one merchant is refused by the same rule. Nothing legitimate needs
    // two live rows for one connected account.
    insertConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    expect(() =>
      insertConnection({ id: "conn_a2", accountId: ACCOUNT_A, stripeUserId: STRIPE_X }),
    ).toThrow(/unique/i);
  });

  it("does not refuse a DIFFERENT Stripe account on the same Foxhound account", () => {
    // BOTH DIRECTIONS. A constraint that refuses everything would pass both
    // cases above; multiple connections per account is the shape the product
    // is built on (webhooks record which connection a payment arrived through).
    insertConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    expect(() =>
      insertConnection({ id: "conn_a2", accountId: ACCOUNT_A, stripeUserId: "acct_stripe_y" }),
    ).not.toThrow();
  });
});

describe("PLANT 2: a disconnected row does not block a live one (356 binding 4)", () => {
  it("accepts a live row alongside a DISCONNECTED row for the same Stripe account", () => {
    insertConnection({
      id: "conn_a",
      accountId: ACCOUNT_A,
      stripeUserId: STRIPE_X,
      disconnectedAt: 2_000,
    });

    expect(() =>
      insertConnection({ id: "conn_b", accountId: ACCOUNT_B, stripeUserId: STRIPE_X }),
    ).not.toThrow();
    expect(liveRowsFor(STRIPE_X)).toEqual([ACCOUNT_B]);
  });

  it("accepts MANY disconnected rows for one Stripe account", () => {
    // A merchant who connects and disconnects repeatedly accumulates history
    // rows. The constraint must not turn that history into a wall.
    insertConnection({ id: "c1", accountId: ACCOUNT_A, stripeUserId: STRIPE_X, disconnectedAt: 1 });
    insertConnection({ id: "c2", accountId: ACCOUNT_A, stripeUserId: STRIPE_X, disconnectedAt: 2 });
    expect(() =>
      insertConnection({
        id: "c3",
        accountId: ACCOUNT_B,
        stripeUserId: STRIPE_X,
        disconnectedAt: 3,
      }),
    ).not.toThrow();
    expect(liveRowsFor(STRIPE_X)).toEqual([]);
  });
});
