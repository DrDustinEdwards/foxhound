# ROUTES.md — Foxhound Canonical Route Manifest (Phase 0)

Status: DRAFT pending Dustin lock. RR8 route config is explicit (no filesystem magic); this manifest IS the route config. Kills the legacy duplications: console/dashboard split, app/recovery vs app/(app)/recovery, (marketing)/product vs /products. One shell across marketing and app (DESIGN.md).

## Public (marketing)
- `/` home
- `/pricing`
- `/products` index; `/products/audit`, `/products/recovery`, `/products/disputes`, `/products/intelligence` (ONE pattern; legacy /product/* and top-level app/recovery marketing pages collapse here)
- `/audit` — no-auth estimator (Turnstile) -> Stripe connect -> full audit report
- `/blog`, `/blog/:slug`, `/blog/tag/:tag` (tag archives per roadmap)
- `/docs`, `/docs/:slug`
- `/demos` (interactive demo entry)
- `/privacy`, `/terms`
- Files: `/sitemap.xml` (chunked), `/robots.txt` (AI bots allowed), `/llms.txt`, `/llms-full.txt`, `/feed.rss`, `/og/:params` (workers-og)

## Auth
- `/login`, `/signup`, `/forgot-password`, `/reset-password`
- `/auth/google/callback` (Better Auth)
- `/connect` — Stripe Connect OAuth start; `/connect/callback`
- `/invite/:token`

## App (authenticated, middleware-guarded)
- `/dashboard` — THE dashboard (login destination; includes free MRR analytics tier)
- `/recovery`, `/recovery/payments`, `/recovery/payments/:id`, `/recovery/sequences`, `/recovery/winback`, `/recovery/expiring-cards`
- `/disputes`, `/disputes/:id` (review-and-sign approval flow lives here)
- `/intelligence` (paid risk layer), `/intelligence/customers/:id`, `/intelligence/alerts`, `/intelligence/reports`
- `/billing` — evidence ledger (flagship), `/billing/invoices/:id`
- `/settings` (account, brand voice, email, notifications), `/settings/team`
- `/help`
- `/welcome` (onboarding)

## Public utility (unauthenticated by design)
- `/u/:token` — unsubscribe (one-click, CAN-SPAM)
- `/p/:token` — hosted no-login card update page (PRICING.md table stakes)
- `/e/o/:token` — engagement open pixel; `/e/c/:token` — engagement click redirect (first-party tracking; idempotent writes; no PII in URL beyond the token)

## Webhooks + async (Workers handlers, not user routes)
- `/webhooks/stripe` — connected-account events (constructEvent, DO claim)
- `/webhooks/stripe-platform` — Foxhound's own billing events
- Email Service events -> Queues consumer (no HTTP surface)
- Cron Triggers (no HTTP surface, no CRON_SECRET): recovery processor, winback, expiring cards, billing run, disputes processor, intelligence MRR, intelligence analyst, scheduled audits, weekly digest, blog scheduled publish, blog version cleanup, social scout/responder/poster, retention sweepers (per ARCHITECTURE.md policies), cron health check, demo reset, daily metrics, stats

## Admin (role-guarded)
- `/admin` overview
- `/admin/merchants`, `/admin/merchants/:id` (incl. cancel/disconnect action)
- `/admin/users`
- `/admin/operations` (D1 cap telemetry, deploy state, env sanity)
- `/admin/crons` (cron_config gating + run history)
- `/admin/webhooks`
- `/admin/blog`, `/admin/blog/:id`
- `/admin/social`
- `/admin/audit-log`

## MCP (separate Worker, Phase 7)
- mcp.foxhoundapp.com `/mcp` (merchant scope), `/mcp/admin` (operator scope) — token model from Phase 3

## Redirect map ownership
- Phase 6 builds the recovamrr.com -> foxhoundapp.com page-for-page 301 map as data (old path -> new path), served at cutover. Blog slugs preserved verbatim; legacy /console -> /dashboard; legacy /product/* -> /products/*.
