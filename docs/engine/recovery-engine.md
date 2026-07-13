# Recovery engine (Phase 4b)

The failed-payment recovery sequence: intake a failure, run the scheduled steps
(silent retries and dunning emails), attribute and record the recovery. The
rebuild change from legacy is **silent-first** ordering (PRICING.md): retryable
declines lead with a quiet Foxhound retry before the first customer-facing email,
so we never dun a payment we could have silently recovered.

## Pieces (all pure unless noted)

```
classify        app/lib/recovery/decline.ts       decline code -> soft|network|expired|fraud
schedule        app/lib/recovery/schedule.ts      category -> ordered steps; planRecoverySteps()
intake          app/lib/engine/intake.ts          plan + insert recovery_steps (OPERATIONAL write)
scheduler       app/lib/engine/scheduler.ts       which step is due now (nextDueStep)
step-runner     app/lib/engine/step-runner.ts     decideRetryStep / decideEmailStep (deciders)
step-state      app/lib/recovery/step-state.ts    send-attempt backoff + retry-result classify
email-gen       app/lib/recovery/email-generation.ts  brand-voice copy: custom_body -> cached -> generate
attribution     app/lib/recovery/attribution.ts   which Foxhound action gets the credit
record-recovery app/lib/recovery/record-recovery.ts  recovered_payments + outcomes (MONEY write, DO)
win-back        app/lib/recovery/winback.ts       terminal-state sequence (never stuck 'active')
expiring-card   app/lib/recovery/expiring-card.ts pre-dunning: alert before a card expires
```

## Flow per tick (Phase 4e cron loads a payment's steps)

```
nextDueStep(steps, now)                                  scheduler.ts
  step is retry_*  -> stripe.invoices.pay                [live; Phase 4c]
                      -> decideRetryStep(attempt, now)   step-runner.ts (pure)
                      -> persist step patch              [operational write; 4c]
                      -> if recovered: recordRecovery(foxhound_retry)   record-recovery.ts (DO money write)
  step is email_*  -> resolveContentPlan(cached)         email-generation.ts (pure)
                      -> generateDunningEmail (if generate)  [live Sonnet; seam, needs ANTHROPIC_API_KEY]
                      -> send via EMAIL binding           [live; Phase 4c thin send module]
                      -> decideEmailStep(step, attempt)   step-runner.ts (pure)
                      -> persist step patch               [operational write; 4c]
```

## Boundaries (what 4b does NOT own)

- **failed_payments row + intake trigger** are written by the
  `invoice.payment_failed` webhook (Phase 4c); intake here only plans and inserts
  the `recovery_steps` for an already-written failed payment id.
- **'recovered' status on failed_payments** is owned by the
  `invoice.payment_succeeded` webhook (Phase 4c), never a cron. record-recovery
  writes the recovery evidence + attribution; the webhook flips the status.
- **Live executors** (`executeRetryStep` / `executeEmailStep`) wrap the pure
  `decide*` deciders around the real `stripe.invoices.pay`, the EMAIL-binding send,
  and the step persistence. Those land in Phase 4c and are exercised on staging;
  full end-to-end verification against Stripe test-mode is deferred to Phase 8.
- **Send module** (Cloudflare Email Service via the EMAIL binding, single thin
  wrapper) and **engagement tracking** (first-party open pixel + click redirects)
  are Phase 4c. email-generation.ts stops at producing sanitized, gated copy.

## Money vs operational writes

recovery_steps inserts/patches are **operational** scheduling state and ride a
plain per-request `db.batch()`. Only recovered_payments + outcomes are **money**
rows and ride the per-account money-write Durable Object (see money-writes.md).
