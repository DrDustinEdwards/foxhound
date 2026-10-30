import { DurableObject } from "cloudflare:workers";

import {
  SerialMoneyCommitter,
  type CommitRequest,
  type CommitResult,
} from "~/lib/money/serializer";

// Per-account money-write Durable Object (ARCHITECTURE.md: "per-account
// money-write serializer"). Addressed by idFromName(accountId): all money writes
// for one account hit the same instance and are committed one at a time as
// atomic D1 batches. Different accounts get different instances and run in
// parallel. See docs/engine/money-writes.md.
//
// It receives already-compiled { sql, params } statements (the executor compiles
// Drizzle builders via .toSQL() in the calling Worker), so no closures or Drizzle
// internals cross the RPC boundary. The DO owns nothing but serialization,
// idempotency bookkeeping, and the atomic batch.
export class MoneyWriteDurableObject extends DurableObject<Env> {
  private readonly committer: SerialMoneyCommitter;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.committer = new SerialMoneyCommitter({
      hasSeen: async (key) => (await state.storage.get<boolean>(seenKey(key))) === true,
      markSeen: async (key) => {
        await state.storage.put(seenKey(key), true);
      },
      runBatch: async (statements) => {
        const db = env.DB;
        if (!db) throw new Error("D1 binding 'DB' unavailable in MoneyWriteDurableObject");
        const prepared = statements.map((s) => db.prepare(s.sql).bind(...s.params));
        if (prepared.length === 0) return [];
        // D1 batch() runs the statements in a single implicit transaction: all
        // commit or none do.
        const results = await db.batch(prepared as [D1PreparedStatement, ...D1PreparedStatement[]]);
        return results.map((r) => (typeof r.meta?.changes === "number" ? r.meta.changes : 0));
      },
    });
  }

  /** Commit one money write for this account. Idempotent on request.idempotencyKey. */
  commit(request: CommitRequest): Promise<CommitResult> {
    return this.committer.commit(request);
  }
}

function seenKey(idempotencyKey: string): string {
  return `idem:${idempotencyKey}`;
}

;
