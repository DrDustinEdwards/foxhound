# Money writes

The spine every money write in the engine rides. Enforces CLAUDE.md
hard rule 2: **money writes are DO-serialized atomic batches** (outcomes,
attributed billing, webhook claims, Stripe connection writes). D1 has no
interactive transactions, so serialization + atomicity are provided by a
per-account Durable Object plus D1's atomic `batch()`.

## Shape

```
caller (loader/action/cron/webhook)
  -> executeMoneyWrite(env, { accountId, idempotencyKey, build })   app/lib/money/execute.ts
       build(db) -> Drizzle batch (insert/update/delete builders)
       .toSQL() each -> { sql, params }[]                            (plain data)
  -> MONEY_WRITER.get(idFromName(accountId)).commit({ idempotencyKey, statements })
       DO serializes (FIFO) + runs env.DB.batch() atomically         workers/money-writer.ts
       core logic: SerialMoneyCommitter                              app/lib/money/serializer.ts
```

Closures and Drizzle internals never cross the DO boundary; only compiled
`{ sql, params }` statements do. Callers keep full Drizzle ergonomics via `build`.

## Why a DO

- **Serialization per account.** The DO is addressed `idFromName(accountId)`, so
  all writes for one account hit one instance and run strictly one at a time
  (FIFO promise-chain in `SerialMoneyCommitter`). Different accounts get
  different instances and run in parallel.
- **Atomicity.** The DO executes `env.DB.batch()`, which D1 runs in a single
  implicit transaction: every statement commits or none do.

## Idempotency (two layers)

1. **Database (authoritative).** Money batches include a row carrying a UNIQUE
   idempotency key (e.g. `outcomes.idempotency_key`, `outcomes_idempotency_uq`).
   A replay makes the whole atomic batch fail the constraint and roll back. The
   committer catches that specific failure and reports `applied: false`.
2. **DO storage (fast path).** A `seen` set in DO storage short-circuits a key we
   already know landed, avoiding a redundant batch. It is only an optimization;
   the DB is the guarantee.

A batch that fails for any OTHER reason (network, non-constraint SQL error) is
**not** marked seen and the error propagates, so the caller (or a Stripe retry)
can safely retry.

## Public API

- `executeMoneyWrite(env, write): Promise<{ applied: boolean }>` - the single
  entry point. `applied: false` means idempotent no-op / already applied.
- `MoneyWrite` (app/db/money-write.ts): `{ accountId, idempotencyKey, build }`.
  `build(db)` returns a non-empty Drizzle batch.

## Rules for callers

- Every money write goes through `executeMoneyWrite`. Never write outcomes or
  billing directly against `db`. Webhook claims and new Stripe connections go
  through it too, with these deliberate exceptions, all plain writes:
  - Claims for events with no account to bill (`claimUnknownAccount` in
    `app/lib/webhooks/process.ts`, `claimUnroutableEvent` in
    `app/lib/billing/platform-webhook.ts`) insert `webhook_events` directly,
    with `account_id` null and no payload, idempotent on the unique index.
  - Disconnect and cancel (`cancelMerchant` and the disconnect batch in
    `app/lib/admin/merchant-cancel.server.ts`) and the
    deauthorize-retry stamps (`app/lib/stripe/deauthorize-retry.server.ts`)
    update `stripe_connections` directly: account state, not money.
- The `idempotencyKey` must be stable for a given logical event (so a retry
  collapses) and unique across distinct events.
- The batch must include the row whose UNIQUE key enforces exactly-once, or
  idempotency degrades to the DO fast-path only.

## Testing

`test/money-write-serialization.test.ts` proves the core: concurrent commits
serialize (max concurrency 1, arrival order preserved), duplicate keys no-op,
UNIQUE violations become idempotent no-ops, other failures propagate without
marking seen, and the chain survives a failed commit. There is no staging
environment; the real DO's D1 batch + storage adapters run in production on
every money write, the Stripe Connect write path included.
