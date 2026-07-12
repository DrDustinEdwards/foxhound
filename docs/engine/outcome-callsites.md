# Outcome call-site inventory (Phase 4a)

Every place the legacy app records a row in `outcomes` (the Network Intelligence
Layer, the moat), mapped to where the Foxhound rebuild wires `recordOutcome`
(app/lib/engine/outcomes.ts) as each owning system lands in 4b-4d. Phase 4a
builds the write path and this inventory; it does NOT wire the sites (those
systems are not ported yet).

Legacy records outcomes via `recordOutcome` / `recordOutcomeAndContext`
(legacy lib/outcomes.ts). The `...AndContext` variant also writes a
per-customer `customer_context` row; in Foxhound the context write is a separate
Phase 4b/Intelligence concern and is tracked with each site below. Attribution
(SCHEMA.md spine #1) is recorded on the outcome/recovered_payment; the billable
attribution kind is set at the recovery/dispute resolution site, not at the
process-event sites.

> Note: the GitHub code-search index was unavailable this session, so this
> inventory is derived from direct reads of the legacy modules + the
> `recordOutcome` API. Each sub-phase reads its legacy file in full and confirms
> exact event vocabulary when it wires the site.

## Recovery (wired in 4b, except the attribution-bearing recovered outcome in 4c)

| Legacy site | event_type (outcome) | product | attribution | Foxhound target |
|---|---|---|---|---|
| `lib/recovery-execution.ts` `executeEmailStep` | `email_sent` (`sent`) | recovery | none (process event); email_engaged is set on click | 4b |
| `lib/recovery-execution.ts` `executeRetryStep` | `retry_attempted` (`success`/`failed`) | recovery | none here; `foxhound_retry` set on the recovered payment | 4b |
| `lib/win-back*` (sequences) | win-back send/convert events | recovery | none / email_engaged | 4b |
| expiring-card pre-dunning (`lib/recovery-schedules.ts` + card alerts) | pre-dunning notice events | recovery | none | 4b |

## Recovered-payment attribution (the billable outcome) — 4c

| Legacy site | event_type (outcome) | product | attribution | Foxhound target |
|---|---|---|---|---|
| Stripe webhook `invoice.payment_succeeded` handler (`app/api/webhooks/stripe`) | `payment_recovered` | recovery | `foxhound_retry` \| `email_engaged` \| `card_update` \| `stripe_baseline` (SCHEMA.md spine #1) | 4c (webhook owns `recovered` status; never a cron) |
| `handlePaymentFailed` (same webhook) | context only (no paired outcome, per legacy note) | recovery | n/a | 4c |
| Hosted card-update page (`/p/:token`) success | `card_update` | recovery | `card_update` | 4c |
| Engagement click (`/e/c/:token`) | engagement -> billable | recovery | `email_engaged` (click is the billable standard) | 4c |

## Disputes — 4c (state machine + webhooks) / 4d (billing at resolution)

| Legacy site | event_type (outcome) | product | attribution | Foxhound target |
|---|---|---|---|---|
| `lib/dispute-handlers.ts` submission | `dispute_submitted` | disputes | requires approval row (schema-enforced) | 4c |
| Dispute resolution webhook (`charge.dispute.closed`) | `dispute_won` / `dispute_lost` | disputes | fee snapshot at resolution (cap applied) | 4c stamps state; 4d bills |

## Billing — 4d

| Legacy site | event_type (outcome) | product | attribution | Foxhound target |
|---|---|---|---|---|
| Billing run (`lib/billing.ts` / billing cron) | `invoice_created` / `fee_billed` | recovery/disputes/intelligence | line item FK -> evidence (SCHEMA.md) | 4d |
| Manual `adjustment` line item | `adjustment_applied` | (n/a) | requires `admin_audit_log` row | 4d |

## Intelligence — later (Phase 5 surfaces; signals in 4/5)

| Legacy site | event_type (outcome) | product | attribution | Foxhound target |
|---|---|---|---|---|
| Prediction / alert generation | `prediction_recorded` / `alert_fired` | intelligence | n/a | Phase 5 (Intelligence); 4a records nothing |

## Wiring rules (all sub-phases)

- Every wired site calls `recordOutcome(env, { ... idempotencyKey })`; the key is
  stable per logical event so a retry collapses (SCHEMA.md spine #4).
- `recordOutcome` never throws; a site's main path must not depend on its return.
- The billable recovery outcome carries `attributionKind` + `attributedRef`; the
  billing engine (4d) reads those, never re-derives them.
- The `invoice.payment_succeeded` webhook is the ONLY writer of `recovered`
  status (race rule, carried from legacy).
