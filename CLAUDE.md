# CLAUDE.md - foxhound

Foxhound is the Cloudflare-native rebuild of Recova: failed-payment recovery, disputes and subscription intelligence for Stripe merchants. Work in this repo only; the legacy Recova app is the separate, frozen repo DrDustinEdwards/recova. Before writing anything another site might have, read what the family shares: https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md (CI's family check fails on a copy).

Dustin's prime directive (2026-07-27): **"I want the new site to be like the old site, except built to be native on Cloudflare."** Recova is the spec for content, layout and features; look and components come from Capsomer in Recova's amber, and shared family pieces replace Foxhound's own. Which differences need his word is `foxhound/RULES.md` 1.1 to 1.3.

## Rules that come first

- Read `foxhound/core.md`, then `foxhound/RULES.md` in Capsid, the only Foxhound rules document that binds. A rule that blocks parity or a better website is deleted or changed, not worked around (RULES.md preamble).
- Tests: keep the minimal set (a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives), and remove any test that pins design, repeats coverage or has never caught a real mistake, unless it guards a harm that cannot be undone.
- Canon lives in Capsid namespace `foxhound`: ARCHITECTURE.md, PRICING.md, DESIGN.md, SCHEMA.md and ROUTES.md; parity state is `parity/PARITY-LEDGER.md`. Never copy canon into this repo.

## Repo-specific rules

- Never clone or copy the legacy repo into the workspace. Read legacy code at exact paths through Capsid's repo tools with `repo: "legacy"` (recova) or `"legacy-mcp"` (recova-mcp). A repo WRITE with no `repo` given goes to THIS repo.
- Legacy Supabase is read-only reference. The database is D1 through bindings, Drizzle only, no raw SQLite dialect in business logic.
- Money writes follow RULES.md 3.2 (one writer per money table). If a task seems to need an interactive transaction, stop and flag it.
- Email: Cloudflare Email Service through the EMAIL binding, wrapped in the single send module; never call the binding from business logic. Engagement signals come from Foxhound's own tracking routes. Bounces and complaints flow through Email Service events to the Queues consumer.
- All user-facing copy says Foxhound. No Recova strings outside the data-migration mapping docs.
- One Worker `foxhound`, one D1 `foxhound`, no `--env` anywhere; the only second Worker is the admin MCP in `mcp/` (RULES.md 7.1).

## Verification

- Crons: invoke the cron handler and check wrangler tail.
- Webhooks: a Stripe CLI test event against the deployed Worker, then verify the D1 row.
- Email: wrangler email emulation locally, then a real send with engagement tracking and bounce paths exercised.
- Database changes: a Drizzle migration plus a SELECT against D1.
- Billing: verify the evidence chain (action, outcome, line item), not just amounts.

## Commands

`npm run check:all` (typecheck, lint, test, tokens, gates) before a push; `npm run db:generate` and `npm run db:migrate` for migrations; `npm run deploy` builds and deploys. Public repo (since 2026-10-21): never commit a key or real merchant data.
