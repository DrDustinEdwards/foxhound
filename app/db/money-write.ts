import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "./client";

// Money-write contract: money writes are DO-serialized atomic batches. Outcome recording, attributed billing and webhook claims are per-account serialized through a Durable Object and committed as one atomic db.batch().

/** The atomic unit of a money write: >=1 statements committed together via db.batch(). */
export type MoneyWriteBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/** Builds the atomic batch for a money write from the db handle. */
export type MoneyWriteBuilder = (db: Db) => MoneyWriteBatch;

/** A money-write request: serialized per account, idempotent on the key. */
export interface MoneyWrite {
  /** THE DURABLE OBJECT'S PARTITION KEY: the account id for every write that touches an existing account. The one exception is the write that CREATES a first account, where there is no account id yet and what must be serialized is the USER (two racing submits mint two account ids and would land in two Durable Objects). That call passes `firstConnectPartition(userId)`, a namespaced sentinel, and is the only caller that does; `executeMoneyWrite` feeds it straight to `idFromName`. */
  accountId: string;
  /** Re-delivery with the same key is a no-op (SCHEMA.md spine #4). */
  idempotencyKey: string;
  build: MoneyWriteBuilder;
}
