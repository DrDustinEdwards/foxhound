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
  /** Rows each statement changed, in batch order, when the batch ran and the
   *  driver reported them. Lets an UPDATE-only write tell a real change from a
   *  zero-row no-op (hard rule 3). Absent on a no-op or an unreporting driver. */
  changes?: number[];
}

/** Injected side effects the serializer drives. Real impls live in the DO. */
export interface CommitterDeps {
  hasSeen(idempotencyKey: string): Promise<boolean>;
  markSeen(idempotencyKey: string): Promise<void>;
  /** Commits the statements as ONE atomic batch. Throws on any failure.
   *  May return the rows each statement changed. */
  runBatch(statements: CompiledStatement[]): Promise<number[] | void>;
}

/** True for a SQLite/D1 UNIQUE (or PRIMARY KEY) constraint violation. */
export function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message);
}

/** The table and column(s) a SQLite unique violation names, e.g.
 *  "outcomes.idempotency_key" or "t.a, t.b". "unknown" when the message carries
 *  none (a PRIMARY KEY failure on a rowid table, or a driver that drops it). */
export function constraintName(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return /constraint failed:\s*([\w.,\s]+)/i.exec(message)?.[1]?.trim().replace(/\s+/g, " ") ?? "unknown";
}

/**
 * THE UNIQUE KEYS THAT ARE DESIGNED REPLAY KEYS, and only these. A batch refused
 * on one of them is a re-delivery of a write that already landed, so it reports
 * `applied: false`. A batch refused on ANY other unique key is a real conflict
 * (two live connections for one Stripe account, a second open exemption
 * stretch, a second active membership) and throws: callers that read
 * `applied: false` as "already done" would otherwise redirect as connected, or
 * answer Stripe 200 "duplicate" so the event is never retried.
 *
 * Named as SQLite names them in the error, table.column with composite columns
 * joined by ", ". Adding a unique index that a money batch relies on for
 * exactly-once means adding it here.
 */
const REPLAY_KEYS: ReadonlySet<string> = new Set([
  "outcomes.idempotency_key",
  "webhook_events.stripe_event_id",
  "billing_invoices.idempotency_key",
  "billing_line_items.recovered_payment_id",
  "billing_line_items.dispute_id",
  "billing_line_items.credits_line_item_id",
  "engagement_events.idempotency_key",
  "email_sends.idempotency_key",
  "account_first_creations.user_id",
  "failed_payments.stripe_invoice_id",
  "disputes.stripe_dispute_id",
  "dispute_balance_transactions.stripe_balance_transaction_id",
  "dispute_approvals.dispute_id",
  "early_fraud_warnings.account_id, early_fraud_warnings.stripe_warning_id",
  "subscription_changes.stripe_event_id, subscription_changes.kind",
  "win_back_sequences.stripe_subscription_id",
  "customer_context.account_id, customer_context.stripe_customer_id",
]);

/** True when a unique violation fired on one of the designed replay keys. */
export function isReplayConstraintError(err: unknown): boolean {
  return isUniqueConstraintError(err) && REPLAY_KEYS.has(constraintName(err));
}

/** True when a unique violation fired on exactly the named key ("table.column"). */
export function isConstraintOn(err: unknown, key: string): boolean {
  return isUniqueConstraintError(err) && constraintName(err) === key;
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

    let changes: number[] | void;
    try {
      changes = await this.deps.runBatch(request.statements);
    } catch (err) {
      if (isReplayConstraintError(err)) {
        // The DB rejected the batch on a designed replay key: a re-delivery of
        // a write that already landed, so report a no-op. Not marked seen, so
        // the DB stays the authority (a true replay is refused again).
        return { applied: false };
      }
      if (isUniqueConstraintError(err)) {
        // Any other unique key is a real conflict, not a replay: it throws so
        // the caller sees it (a webhook answers 500 and Stripe retries). Logged
        // by table and column only, no values.
        console.warn("money write refused on a non-replay unique key:", constraintName(err));
      }
      // Any other failure: do NOT mark seen, so a retry re-attempts the batch.
      throw err;
    }

    await this.deps.markSeen(request.idempotencyKey);
    return changes ? { applied: true, changes } : { applied: true };
  }
}
