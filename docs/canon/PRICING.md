# PRICING.md — Foxhound Canon (Phase 0)

Status: DRAFT pending Dustin lock. Rev 2 (2026-07-11): refund credit-note policy REPLACED by maturity-window billing per Dustin's first-principles challenge. The billing engine (Phase 4), billing UI (Phase 5), marketing site (Phase 6), and the Phase 8 billing-math audit are all verified against THIS document. Every schema deviation in SCHEMA.md cites a line here.

## The promise (governs all copy and all billing code)

Foxhound only earns when it creates money the merchant can verify they would not otherwise have. Every billed dollar links to visible evidence. No copy may promise anything the billing engine cannot prove.

## Products

### Audit — Free
- No-auth estimator first: MRR + customer count -> benchmark leakage estimate. Turnstile-protected. No signup required.
- Full audit after Stripe OAuth (read-only scopes stated at the connect screen; delete-my-data control present).
- Output framed around LIFT: (a) what Stripe's own retries already recovered, (b) what is still dying, (c) what Foxhound would add. One headline number.
- Scheduled re-audits for connected accounts (retention hook).

### Recovery — 20% of Foxhound-attributed recoveries (pay-on-lift)
- A recovery is BILLABLE only when a Foxhound action provably preceded payment:
  1. `foxhound_retry` — a Foxhound-scheduled retry succeeded;
  2. `email_engaged` — a Foxhound dunning email was engaged (first-party click; open alone is NOT sufficient for billing — Apple MPP inflates opens; clicks are the billable engagement standard. Opens still feed Intelligence signals);
  3. `card_update` — payment method updated through a Foxhound link/page.
- Everything else is `stripe_baseline`: recorded with equal fidelity, never billed, and displayed to the merchant as free.
- Fee: 20% of the recovered amount, in the recovery's currency, invoiced monthly per currency. Per Stripe account.
- **Maturity-window billing (no refund machinery by design):** a recovery becomes billable at the first monthly run after it is at least 30 days old; in practice each run bills the PRIOR month's recoveries, so every billed recovery is 30-60 days settled. The billable predicate excludes any recovery marked refunded or disputed at run time, which automatically absorbs the refund window where SaaS recovery refunds actually occur. Refunds AFTER billing (90+ days out) are the merchant's business event, not Foxhound's: no automatic credit. A manual, admin-audited `adjustment` line item exists for discretionary goodwill or error correction; it is a lever, not a system. Merchant-facing framing (trust feature): "We never bill a recovery until you've held the money for 30 days."
- Evidence: every line item FK-links to its recovered payment and its attributing action. The billing page renders action -> recovery -> fee for every charge, with baseline recoveries in the same ledger marked FREE.

### Disputes — 20% of won disputes, capped at $250 per dispute
- Billable only if Foxhound drafted AND submitted the evidence. Merchant-fought disputes are never billed.
- Mandatory approval gate: state machine draft -> pending_review -> approved -> submitted -> resolved(won|lost). No approval row, no submission — schema-enforced, no admin override.
- Fee computed at resolution in the dispute's currency, cap applied then stored on the record: min(20% of disputed amount, $250 or currency equivalent).
- Billed at the next monthly run after resolution (natural lag against rare pre-arbitration reversals). Reopened disputes are never billed twice (unique on dispute). Anything rarer is a manual adjustment.
- Positioning: attach product. No prevention/alerts layer (no Verifi/Ethoca).

### Intelligence — $199/month, account-wide
- FREE for every Recovery merchant: basic MRR analytics (MRR, movements, churn, simple cohorts). Free analytics is the acquisition sweetener; ChartMogul/ProfitWell free tiers are neutralized, never fought.
- PAID ($199/mo): the predictive revenue-risk layer — risk scoring on EVERY customer via billing-behavior signals (subscription age, plan/seat deltas, annual->monthly switches, payment-latency drift, refund/dispute history, engagement), MRR-at-risk exposure, alerts, nightly AI analyst narrative.
- Hard precondition to charging anyone: universal signal coverage. If most customers would score "unknown," the product is not sellable yet.
- Every prediction logged with horizon + realized-outcome slot. Accuracy claims in marketing only after backtests support them.
- Annual: 10 months paid. Admin-granted rows never touch Stripe APIs.

## Billing mechanics

- Monthly billing run per account per currency; billable predicate: attributed recoveries from the prior month (30-day maturity) not refunded/disputed at run time, plus disputes resolved-won in the prior period not previously billed. Two-layer idempotency (carried from legacy Tier 1, redesigned per SCHEMA.md).
- Invoice line item types: `recovery_fee` (FK recovered payment), `dispute_fee` (FK dispute), `subscription` (Intelligence), `adjustment` (manual, admin-audited, signed amount). No orphan charges possible by construction.
- billing_exempt and processing_paused honored at the query level in every money computation.
- Statement descriptor and platform name: "Foxhound" (Phase 9 / pre-first-merchant).

## Copy rules for pricing surfaces

- Lead with the promise. "20% of what we recover for you — recoveries Stripe would have gotten anyway are free. And we never bill a recovery until you've held the money for 30 days."
- Never publish specific competitor names in pricing copy; comparison pages (Phase 6 SEO) carry those.
- No specific-number pricing in blog/SEO copy — "outcome-based pricing" framing (standing rule).
- No em dashes, no AI-sounding phrasing, benefit-forward (standing rules).
