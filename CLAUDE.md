# CLAUDE.md - foxhound

Foxhound, https://foxhoundapp.com: failed-payment recovery and disputes for Stripe merchants, the Cloudflare-native rebuild of Recova (frozen repo DrDustinEdwards/recova). Fees are `foxhound/PRICING.md` in Capsid.

## Rules every repo shares

- **Tests.** Reproduce a reported failure first: red before, green after. Keep the set minimal; delete a test that pins design or repeats coverage.
- **UI copy.** Let the layout explain: no eyebrows, restating subtitles, intros or hints a label already gives (Dustin, 2026-11-18).
- **Shared code.** Check devkit's [SHARED.md](https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md) before writing anything another repo might have. Change shared code in place and delete what it replaces.
- **Secrets.** Never commit or print a key or token. AI provider keys stay on the server.
- **Production.** Never deploy, tag, release or run production DDL from a session; a merge deploys. Back up and restore D1 only with d1-dump.
- **Copy.** Site copy says only what the current build does.

## Rules for this repo

- **Money writes.** One writer per money table (recoveries through buildRecoveryBatch, account state through cancelMerchant, outcomes through recordOutcome); money parameters have no default; totals go through groupSumByCurrency. An UPDATE that matches zero rows is a failure: join each guard to the write it guards.
- **Tenants.** The active account lives on the session row and every query helper takes accountId first. Private or cookie-carrying responses are private, no-store; public pages send Vary: Cookie.
- **Agent tools and demo.** No agent tool submits a dispute, cancels, disconnects, connects, writes an outcome or a bill, or takes an account argument; they mask customer name, phone, IP, billing address and email. The demo refuses every non-GET before any database work and never calls Stripe or Anthropic.
- **Live tests.** A test against production runs on a billing-exempt account. A migration that recreates a money table is proven against real D1 with row counts before and after. Never delete a Cloudflare resource Dustin has not named.
- **Launch.** No paying merchant's money moves until an LLC exists. Copy makes no claim, statistic or promise without a real source. Recova is the spec; dropping a Recova feature needs Dustin's quoted word in `foxhound/parity/APPROVED-DIFFERENCES.md`.

## Commands

- `npm run check:all` before a push. Public repo: never commit real merchant data.
- `RULES.md n.n` in an old comment points to `foxhound/RULES-INDEX.md` in Capsid.
