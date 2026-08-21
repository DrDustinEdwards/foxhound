import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "./client";

// Money-write contract (ARCHITECTURE.md non-negotiable #1: money writes are
// DO-serialized atomic batches). Outcome recording, attributed billing, and
// webhook claims are per-account serialized through a Durable Object and
// committed as one atomic db.batch(). Phase 4 wires the DO; this file is the
// type contract only, so later phases build against a stable signature.

/** The atomic unit of a money write: >=1 statements committed together via db.batch(). */
export type MoneyWriteBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/** Builds the atomic batch for a money write from the db handle. */
export type MoneyWriteBuilder = (db: Db) => MoneyWriteBatch;

/** A money-write request: serialized per account, idempotent on the key. */
export interface MoneyWrite {
  /**
   * THE DURABLE OBJECT'S PARTITION KEY. It is the account id for every write
   * that touches an existing account, which is all of them but one.
   *
   * The exception is the write that CREATES a first account (ruling 329 phase
   * (d)), where there is no account id yet to serialize on and the thing that
   * must be serialized is the USER: two racing submits mint two different
   * account ids, so keying on either would put them in two Durable Objects and
   * serialize nothing. That call passes `firstConnectPartition(userId)`, which
   * is a namespaced sentinel rather than an id, and it is the only caller that
   * does. The DO itself is unchanged and does not care: `executeMoneyWrite`
   * feeds this straight to `idFromName`.
   */
  accountId: string;
  /** Re-delivery with the same key is a no-op (SCHEMA.md spine #4). */
  idempotencyKey: string;
  build: MoneyWriteBuilder;
}

/**
 * Executes a money write as one atomic, per-account-serialized batch, routed
 * through the per-account money-write Durable Object. Implemented in Phase 4a as
 * `executeMoneyWrite` (app/lib/money/execute.ts); resolves to whether the batch
 * was newly applied (false = idempotent no-op).
 */
export type MoneyWriteExecutor = (write: MoneyWrite) => Promise<{ applied: boolean }>;
