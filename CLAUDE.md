# CLAUDE.md - foxhound

Foxhound is the Cloudflare-native rebuild of Recova: failed-payment recovery, disputes and subscription intelligence for Stripe merchants. Work in this repo only; the legacy Recova app is the separate, frozen repo DrDustinEdwards/recova.

## PRIME DIRECTIVE (Dustin, verbatim intent, 2026-07-27)

**"I want the new site to be like the old site, except built to be native on Cloudflare."**

This outranks every rule below. For every user-facing surface (marketing, auth, app shell, product pages, emails) LEGACY IS THE SPEC for content, layout, features, interaction behavior and information architecture, unless `parity/APPROVED-DIFFERENCES.md` in Capsid records Dustin's approval of the difference.

Only three kinds of difference need no per-item approval: internals required by the Cloudflare-native stack and invisible to the user; Foxhound branding where canon already defines it; and truthfulness fixes where legacy copy lied. Anything recorded as a "deliberate improvement" or a "locked decision" WITHOUT Dustin's quoted approval is a re-opened parity defect, corrected toward legacy. No agent adds to the approved list. Fix direction is a ruling, never an agent default.

Look and components come from Capsomer now, on every surface, Recova's amber throughout (Dustin, 2026-10-25; teal from 2026-10-14 to then), with Capsomer's per-site layer where Foxhound needs its own. Dustin answered "yes, the ui will be the same" on 2026-10-14; his seventeen answers, verbatim with message ids, are in Capsid `foxhound/parity/ANSWERS-2026-10-14.md`. Shared family pieces replace Foxhound's own: Enarratio charts, Prelum for blog pages, feeds, sitemap and llms.txt, site-runtime security headers and sign-in limiter, Capsomer's email component for the email shell, Cloudflare Access for admin, and Carrel for admin Social and the blog editor (`foxhound/RULES.md` 1.1, with each piece in the rule it changes). This supersedes the 2026-10-04 ruling that Capsomer waits until parity is done.

## Rules that come first

- Read `foxhound/core.md`, then `foxhound/RULES.md`, the only Foxhound rules document that binds. The prime directive above stands.
- Tests: keep the minimal set (a few browser tests for flows that must never break, one integration test per real behaviour, unit tests only for tricky logic, shared code tested once where it lives), and remove any test that pins design, repeats coverage or has never caught a real mistake, unless it guards a harm that cannot be undone.
- Canon lives in Capsid namespace `foxhound`: ARCHITECTURE.md, PRICING.md, DESIGN.md, SCHEMA.md, ROUTES.md, rebuild-plan.md and backlog.md; parity state is `parity/PARITY-LEDGER.md`. Never copy canon into this repo.

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

`npm run check:all` (typecheck, lint, test, tokens, gates) before a push; `npm run db:generate` and `npm run db:migrate` for migrations; `npm run deploy` builds and deploys. Public repo (since 2026-10-21): never commit a key or real merchant data.
