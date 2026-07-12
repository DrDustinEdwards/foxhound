import { getDb } from "~/db";
import type { MoneyWrite } from "~/db/money-write";

import type { CommitResult, CompiledStatement } from "./serializer";

// The money-write executor: the single public entry point every money write in
// the engine rides (outcomes, attributed billing, webhook claims, stripe
// connection writes). It compiles the caller's Drizzle batch to plain
// { sql, params } statements and hands them to this account's money-write
// Durable Object, which serializes and commits them atomically.
//
// Callers keep full Drizzle ergonomics via MoneyWrite.build; nothing but plain
// data crosses the DO boundary. See docs/engine/money-writes.md.

interface SqlWrapper {
  toSQL(): { sql: string; params: unknown[] };
}

export async function executeMoneyWrite(
  env: Env,
  write: MoneyWrite,
): Promise<CommitResult> {
  const db = getDb(env);
  const batch = write.build(db);
  const statements: CompiledStatement[] = batch.map((item) => {
    const { sql, params } = (item as unknown as SqlWrapper).toSQL();
    return { sql, params };
  });

  const ns = env.MONEY_WRITER;
  if (!ns) {
    throw new Error("Durable Object binding 'MONEY_WRITER' is not available in this environment");
  }
  const stub = ns.get(ns.idFromName(write.accountId));
  return stub.commit({ idempotencyKey: write.idempotencyKey, statements });
}
