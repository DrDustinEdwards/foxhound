# CLAUDE.md - foxhound

Foxhound, https://foxhoundapp.com: failed-payment recovery, disputes and subscription intelligence for Stripe merchants, the Cloudflare-native rebuild of Recova. React Router 8 on Workers, Drizzle on D1, Durable Objects for money writes, Queues for email, Access for the admin. The legacy Recova app is the separate, frozen repo DrDustinEdwards/recova.

## Rules that come first

- Tests: keep the minimal set (a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives), and remove any test that pins design, repeats coverage or has never caught a real mistake, unless it guards a harm that cannot be undone.
- Read `foxhound/core.md` in Capsid with this file. Before writing anything another site might have, read what the family shares: https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md (CI's family check fails on a copy). Fees are `foxhound/PRICING.md`; read it before touching billing.
- Recova is the spec (Dustin: "I want the new site to be like the old site, except built to be native on Cloudflare"): its content, layout, widths, text sizes and features, with Capsomer's components in Recova's amber and the shared family pieces in place of Foxhound's own. Shared pieces, their defaults, not copying Recova's bugs, and plain improvements need no ruling; a change people can see is approved the way every visual PR is, by Dustin's yes on its screenshots. Only dropping a Recova feature or content needs his quoted word in `foxhound/parity/APPROVED-DIFFERENCES.md`, which also lists what is deliberately not built.

## Commands

- `npm run check:all` (typecheck, lint, test, tokens, gates) before a push. `npm run db:generate` and `npm run db:migrate` for migrations.
- One Worker `foxhound` and one D1 `foxhound`, no `--env` anywhere: every deploy is production. The only second Worker is the admin MCP in `mcp/`, whose only bindings are a service binding to `foxhound` and its own OAuth KV, so it can never touch Stripe, D1 or money.
- Read legacy code through Capsid's repo tools (`repo: "legacy"` or `"legacy-mcp"`), never by cloning it here. Legacy Supabase is read-only reference.
- Public repo: never commit a key or real merchant data.

## Hard rules

A ruling number or "RULES.md n.n" in a code comment is a reference to retired rules: look it up in `foxhound/RULES-INDEX.md` in Capsid.

1. Product facts in copy come from Foxhound's engine constants, never retyped and never Recova's numbers. Every statistic names its source URL and date. No recovery-rate promise, testimonial, counter or security attestation until a real one exists. A control that cannot do its job yet is left out. Stripe scope is read_write at /connect and for the free audit (Stripe gives read_only only to Extensions), and Foxhound revokes the audit grant when its window ends; when copy and scope disagree, fix the copy.
2. One writer per money table: recoveries only through buildRecoveryBatch, account state through cancelMerchant, alerts and win-back events through recordOutcome (never billable). Money parameters are required arguments with no default. Totals go through groupSumByCurrency. A second writer is a billing error a merchant finds first, and no test notices one being added.
3. An UPDATE that matches zero rows is a failure, and in a D1 batch it does not stop the statements after it, so join each guard to the write it guards.
4. No agent tool submits a dispute, cancels, disconnects, connects, or writes an outcome or a bill.
5. Migrations that recreate a table are proven against real D1 with defer_foreign_keys (D1 ignores foreign_keys=OFF and the local harness enforces no keys), with row counts before and after on money tables.
6. Any test against production runs on a billing-exempt account with live sends on for it alone, because a test that mints a fee row is a fake bill.
7. Never delete a Cloudflare resource unless Dustin names it and a same-minute check shows it is not the live one. Never work around a credential; the fix is Dustin's.
8. Tenant isolation: the active account lives on the session row; every query helper takes accountId first; no agent tool takes an account argument; one live Foxhound account per Stripe account. Agent tools mask customer name, phone, IP, billing address and email by default. Audit runs are private, and a refusal never names who holds an account.
9. Anything private or carrying a session cookie is private, no-store; public pages send Vary: Cookie. One signed-in cache HIT means turn page caching off.
10. The demo refuses every non-GET with 405 before any membership or database work, and nothing under app/lib/demo/ calls Stripe or Anthropic.
11. Security headers come from site-runtime and its defaults are taken as they change. Never weaken production, or go back to Recova's weaker setup, to make a measurement easier. Merchant-visible HTML from AI is sanitized on the server.
12. No paying merchant's money moves until an LLC exists; until then Terms are under Texas law and name Dustin Edwards as operator. Recova is retired only after Dustin says Foxhound is matched, in the order in `foxhound/CUTOVER-PLAN.md`.
