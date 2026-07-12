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
  accountId: string;
  /** Re-delivery with the same key is a no-op (SCHEMA.md spine #4). */
  idempotencyKey: string;
  build: MoneyWriteBuilder;
}

/**
 * Executes a money write as one atomic, per-account-serialized batch.
 * Phase 4 implements this by routing through the per-account Durable Object;
 * until then it is a type contract only.
 */
export type MoneyWriteExecutor = (write: MoneyWrite) => Promise<void>;
