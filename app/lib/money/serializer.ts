import { errorMessage } from "@dustinedwards/site-runtime/log";
// The money-write serialization core (CLAUDE.md, Money writes: DO-serialized atomic batches). Pure and dependency-injected, so it is
// unit-testable; workers/money-writer.ts supplies the real D1 batch and DO storage. Serialization: commits chain onto a
// tail promise, so one account's DO runs one commit at a time. Idempotency: the DB is the exactly-once guarantee (money
// batches carry a UNIQUE idempotency key; a replay fails the constraint and rolls the batch back); the DO-storage "seen"
// set is only a fast path. A batch that fails for any OTHER reason is NOT marked seen, so a retry is safe.
// See docs/engine/money-writes.md.

export interface CompiledStatement {
  sql: string;
  params: unknown[];
}

export interface CommitRequest {
  idempotencyKey: string;
  statements: CompiledStatement[];
}

export interface CommitResult {
  applied: boolean;
  /** Rows each statement changed, in batch order, so an UPDATE-only write can tell a real change from a zero-row no-op
   *  (CLAUDE.md, Money writes). Absent on a no-op or an unreporting driver. */
  changes?: number[];
}

export interface CommitterDeps {
  hasSeen(idempotencyKey: string): Promise<boolean>;
  markSeen(idempotencyKey: string): Promise<void>;
  /** Commits the statements as ONE atomic batch. Throws on any failure; may return the rows each statement changed. */
  runBatch(statements: CompiledStatement[]): Promise<number[] | void>;
}

export function isUniqueConstraintError(err: unknown): boolean {
  const message = errorMessage(err);
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message);
}

/** The table and column(s) a SQLite unique violation names, e.g. "outcomes.idempotency_key" or "t.a, t.b"; "unknown" when absent. */
function constraintName(err: unknown): string {
  const message = errorMessage(err);
  return (
    /constraint failed:\s*([\w.,\s]+)/i.exec(message)?.[1]?.trim().replace(/\s+/g, " ") ?? "unknown"
  );
}

/** The unique keys that are designed replay keys, and only these. A batch refused on one is a re-delivery of a write that
 *  already landed, so it reports `applied: false`. Any other unique key is a real conflict (two live connections for one
 *  Stripe account, a second open exemption stretch, a second active membership) and throws, or a caller would read
 *  `applied: false` as "already done" and redirect as connected or answer Stripe 200 "duplicate". Named as SQLite names
 *  them (table.column, composites joined by ", "); a unique index a money batch relies on for exactly-once is added here. */
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

function isReplayConstraintError(err: unknown): boolean {
  return isUniqueConstraintError(err) && REPLAY_KEYS.has(constraintName(err));
}

export function isConstraintOn(err: unknown, key: string): boolean {
  return isUniqueConstraintError(err) && constraintName(err) === key;
}

export class SerialMoneyCommitter {
  // Every commit awaits the previous one, so commits run one at a time in arrival order; the tail survives failures.
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
    if (await this.deps.hasSeen(request.idempotencyKey)) {
      return { applied: false };
    }

    let changes: number[] | void;
    try {
      changes = await this.deps.runBatch(request.statements);
    } catch (err) {
      if (isReplayConstraintError(err)) {
        // A designed replay key: a re-delivery of a write that already landed, so a no-op. Not marked seen: the DB stays the authority.
        return { applied: false };
      }
      if (isUniqueConstraintError(err)) {
        // Any other unique key is a real conflict: it throws so the caller sees it (a webhook answers 500 and Stripe retries). Logged by table and column only, no values.
        console.warn("money write refused on a non-replay unique key:", constraintName(err));
      }
      throw err;
    }

    await this.deps.markSeen(request.idempotencyKey);
    return changes ? { applied: true, changes } : { applied: true };
  }
}
