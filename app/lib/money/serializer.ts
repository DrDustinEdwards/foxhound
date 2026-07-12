// The money-write serialization core (ARCHITECTURE.md non-negotiable #1: money
// writes are DO-serialized atomic batches). This module is pure and
// dependency-injected so it is unit-testable without the Workers runtime; the
// Durable Object (workers/money-writer.ts) is a thin adapter that supplies real
// D1 batch + DO-storage implementations.
//
// Correctness model (see docs/engine/money-writes.md):
//   - Serialization: commits are chained onto a tail promise, so at most one
//     commit for a given committer (= one account's DO instance) runs at a time.
//   - Idempotency: the true exactly-once guarantee is the DB. Money batches carry
//     a row with a UNIQUE idempotency key (e.g. outcomes.idempotency_key); a
//     replay makes the whole atomic batch fail the constraint and roll back. The
//     DO-storage "seen" set is only a fast path that avoids re-running a batch we
//     already know landed. A batch that fails for any OTHER reason is NOT marked
//     seen, so the caller (or Stripe retry) can safely retry it.

/** A driver-ready SQL statement: text plus positional bind params. */
export interface CompiledStatement {
  sql: string;
  params: unknown[];
}

/** One atomic money write: a set of statements committed together, keyed for idempotency. */
export interface CommitRequest {
  idempotencyKey: string;
  statements: CompiledStatement[];
}

/** Whether the batch was newly applied (false = idempotent no-op / already applied). */
export interface CommitResult {
  applied: boolean;
}

/** Injected side effects the serializer drives. Real impls live in the DO. */
export interface CommitterDeps {
  hasSeen(idempotencyKey: string): Promise<boolean>;
  markSeen(idempotencyKey: string): Promise<void>;
  /** Commits the statements as ONE atomic batch. Throws on any failure. */
  runBatch(statements: CompiledStatement[]): Promise<void>;
}

/** True for a SQLite/D1 UNIQUE (or PRIMARY KEY) constraint violation. */
export function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message);
}

export class SerialMoneyCommitter {
  // Every commit awaits the previous one, so commits run strictly one-at-a-time
  // in arrival order. The tail is kept alive across failures.
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CommitterDeps) {}

  commit(request: CommitRequest): Promise<CommitResult> {
    const run = this.tail.then(() => this.doCommit(request));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doCommit(request: CommitRequest): Promise<CommitResult> {
    // Fast path: we already know this key landed.
    if (await this.deps.hasSeen(request.idempotencyKey)) {
      return { applied: false };
    }

    try {
      await this.deps.runBatch(request.statements);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // The DB rejected a replay: the write already exists. Treat as applied
        // by someone, record it, and report a no-op. This is the exactly-once
        // backstop for a duplicate that slipped past the seen-set.
        await this.deps.markSeen(request.idempotencyKey);
        return { applied: false };
      }
      // Any other failure: do NOT mark seen, so a retry re-attempts the batch.
      throw err;
    }

    await this.deps.markSeen(request.idempotencyKey);
    return { applied: true };
  }
}
