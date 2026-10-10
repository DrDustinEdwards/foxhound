# CLAUDE.md - foxhound

Foxhound is the Cloudflare-native rebuild of Recova: failed-payment recovery, disputes and subscription intelligence for Stripe merchants. Work in this repo only; the legacy Recova app is the separate, frozen repo DrDustinEdwards/recova.

## PRIME DIRECTIVE (Dustin, verbatim intent, 2026-07-27)

**"I want the new site to be like the old site, except built to be native on Cloudflare."**

This outranks every rule below. For every user-facing surface (marketing, auth, app shell, product pages, emails) LEGACY IS THE SPEC: pixel treatment, interaction behavior and information architecture match legacy source unless `parity/APPROVED-DIFFERENCES.md` in Capsid records Dustin's approval of the difference.

Only three kinds of difference need no per-item approval: internals required by the Cloudflare-native stack and invisible to the user; Foxhound branding where canon already defines it; and truthfulness fixes where legacy copy lied. Anything recorded as a "deliberate improvement" or a "locked decision" WITHOUT Dustin's quoted approval is a re-opened parity defect, corrected toward legacy. No agent adds to the approved list. Fix direction is a ruling, never an agent default.

Parity finishes first. Only after it does Foxhound get the careful Capsomer treatment (capsid/decisions.md, 2026-10-04); until then no change moves its look toward Capsomer.

## Rules that come first

- The portfolio rules are in Capsid: `capsid/conventions.md`. Then `foxhound/core.md`, then `foxhound/RULES.md`, the only Foxhound rules document that binds. Where conventions and this file disagree, conventions wins; the prime directive above is Foxhound's own and stands.
- Canon lives in Capsid namespace `foxhound`: ARCHITECTURE.md, PRICING.md, DESIGN.md, SCHEMA.md, ROUTES.md, rebuild-plan.md and backlog.md; parity state is `parity/PARITY-LEDGER.md`. `docs/canon/` in this repo holds pointer stubs only; never restore content there.

## Repo-specific hard rules

- Never clone or copy the legacy repo into the workspace. Read legacy code at exact paths through Capsid's repo tools with `repo: "legacy"` (recova) or `"legacy-mcp"` (recova-mcp). A repo WRITE with no `repo` given goes to THIS repo.
- Legacy Supabase is read-only reference. The database is D1 through bindings.
- Money writes (outcome recording, attributed billing, webhook claims) go through Durable Object-serialized atomic batches. No exceptions; if a task seems to need an interactive transaction, stop and flag it.
- Drizzle only. No raw SQLite dialect in business logic.
- Email: Cloudflare Email Service through the EMAIL binding, wrapped in the single send module; never call the binding from business logic. Engagement signals come from Foxhound's own tracking routes. Bounces and complaints flow through Email Service events to the Queues consumer. Never add Resend.
- All user-facing copy says Foxhound. No Recova strings outside the data-migration mapping docs.

## Single environment

One Worker `foxhound` and one D1 `foxhound`. No KV binding. No `--env` flag anywhere, not in wrangler commands and not in CI. Every deploy is production. If ARCHITECTURE.md or rebuild-plan.md still describe two environments, correct them; they are out of date.

The one exception (MCP ruling 2026-10-10, rule 9 amendment): `foxhound-admin-mcp`, the Foxhound Admin MCP at admin-mcp.foxhoundapp.com, in `mcp/` with its own `mcp/wrangler.jsonc`. It is separate so that it holds no Stripe key, no D1 and no money binding: its only bindings are a service binding to `foxhound` and its own OAuth KV, and everything it does is a call to the admin API at /api/admin/v1. No other second Worker is allowed, and that Worker never gains a binding beyond those two.

## Verification

- Crons: invoke the cron handler and check wrangler tail.
- Webhooks: a Stripe CLI test event against the deployed Worker, then verify the D1 row.
- Email: wrangler email emulation locally, then a real send with engagement tracking and bounce paths exercised.
- Database changes: a Drizzle migration plus a SELECT against D1.
- Billing: verify the evidence chain (action, outcome, line item), not just amounts.

## Commands

`npm run check:all` (typecheck, lint, test, tokens, gates) before a push; `npm run db:generate` and `npm run db:migrate` for migrations; `npm run deploy` builds and deploys. Private repo: CI shares Dustin's free monthly minutes, so heavy runs happen locally, one at a time.
