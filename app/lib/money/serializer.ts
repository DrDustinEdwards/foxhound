// The money-write serialization core (CLAUDE.md hard rule 2: money writes are
// DO-serialized atomic batches). This module is pure and
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

function constraintName(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return /constraint failed:\s*([\w.,\s]+)/i.exec(message)?.[1]?.trim() ?? "unknown";
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
        // The DB rejected the batch on a unique key, which is how a replay
        // looks: report a no-op. The key is NOT marked seen, because any unique
        // index can fire here, not only the idempotency key (audit M8): a
        // batch refused for another reason must stay retryable rather than be
        // filed as done forever. A true replay is refused again by the DB, so
        // nothing lands twice. The constraint is logged so a misfiled refusal
        // shows up (table and column only, no values).
        console.warn("money write refused on a unique key:", constraintName(err));
        return { applied: false };
      }
      // Any other failure: do NOT mark seen, so a retry re-attempts the batch.
      throw err;
    }

    await this.deps.markSeen(request.idempotencyKey);
    return { applied: true };
  }
}
