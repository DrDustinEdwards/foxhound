# ARCHITECTURE.md — Foxhound Canon (Phase 0)

Status: DRAFT pending Dustin lock. Mirrored at `foxhound` repo root once the repo exists. Companion canon: PRICING.md, DESIGN.md, SCHEMA.md, ROUTES.md. Supersedes nothing; rebuild-plan.md remains the plan-of-record, this is the technical constitution.

## Stack

- **Framework:** React Router 8 (framework mode) on Cloudflare Workers via `@cloudflare/vite-plugin`. React 19, TypeScript 5 strict, Vite 7+, Node 22+ toolchain, ESM-only. Tailwind v4 with the token system from DESIGN.md.
- **Database:** D1, one shared database, `account_id` scoping on every tenant table. Drizzle ORM exclusively; zero raw SQLite dialect in business logic. Interactive transactions do not exist on D1: all money writes (outcomes, attributed billing, webhook claims) are per-account serialized through a Durable Object and committed as one atomic `batch()`.
- **Auth:** Better Auth on D1. Sessions, email/password, Google OAuth, team invites, merchant/admin role split. RR8 middleware (default in v8) guards route trees. The legacy app's own OAuth server (oauth_clients/codes/tokens, used by the MCP) is replaced by Better Auth + token issuance for the Foxhound MCP in Phase 7; design the token model in Phase 3 so Phase 7 doesn't retrofit.
- **Email:** Cloudflare Email Service via the EMAIL binding, wrapped in ONE thin send module (`app/lib/email/send.ts` is the only file that touches the binding). Dispatch through Queues (retries + dead-letter). First-party engagement tracking: open pixel + click-redirect routes on our own Worker write idempotent engagement_events rows (feeds attribution and Intelligence). Bounce/complaint events consumed from Email Service via Queues into the suppression flow. No Resend, ever, in this repo.
- **Queues:** email dispatch; email event consumption; any future async fan-out. Every consumer idempotent on an event key.
- **Durable Objects:** (1) per-account money-write serializer, (2) webhook event claim keyed by Stripe event id, (3) cron mutex where a Cron Trigger needs one (most won't).
- **Cron Triggers:** all scheduled jobs. `cron_config` runtime gating carries over (admin can disable any job without deploy). No HTTP cron endpoints, no CRON_SECRET.
- **KV:** small hot config/cache only. Not a datastore.
- **R2:** blog images (existing bucket carries over), dispute evidence (existing bucket carries over), self-hosted fonts, static assets.
- **Rate limiting:** Cloudflare rate limiting binding, keyed on `cf-connecting-ip`; Turnstile on the public abuse surfaces (no-auth estimator, audit entry, signup).
- **Errors:** Sentry (Workers SDK), new project, DSN verified in Phase 8. Post-launch review item: evaluate replacing with Workers Observability.
- **AI:** Anthropic API. One constants module holds ALL model IDs; Sonnet for generation (dunning copy, dispute evidence, AI analyst), Haiku for scoring/quality gates. ai_calls cost map must cover every model ID in constants (closes legacy R-49 drift).

## Environments and deploy

- wrangler config defines `staging` and `production` from the first commit. Separate D1 databases, Queues, DOs, KV per environment.
- Initial deploys run on the workers.dev subdomain. The foxhoundapp.com zone (already live on Cloudflare) is attached to the production Worker when Dustin flips DNS; nothing in the build assumes the custom domain is routed. Email Service is enabled on the foxhoundapp.com ZONE independently of Worker routing (DNS auth records only), so warm-up can begin before the app is on the domain.
- CI: GitHub Actions on `foxhound` repo. Required check: tsc --noEmit + build + tests. Merge to main deploys staging; production deploy is a manual promotion. Branch protection on main from day one.
- Local dev: wrangler dev with D1 local, wrangler email emulation for send paths.

## External dependency inventory (everything not Cloudflare, and why)

| Dependency | Status | Rationale |
|---|---|---|
| Stripe | Permanent | It is the product |
| Anthropic API | Permanent | Output quality is the product; Workers AI is not a substitute for revenue-critical copy |
| GitHub | Permanent | Repo hosting + Capsid fallthrough; no Cloudflare equivalent |
| Google OAuth | Kept | Signup friction; identity convenience, not infrastructure |
| Sentry | Kept, free tier | Exception grouping on revenue crons; post-launch review vs Workers Observability |
| Serper + X/Bluesky/Reddit APIs | Permanent | External by nature (social Scout/Poster) |
| GSC/Bing/IndexNow | Permanent | External by definition |

Decommissioned at Phase 9 with legacy: Vercel, Supabase, Upstash, Resend, ngrok (staging Worker is public; Stripe CLI fires test events at it directly). Fonts self-hosted from R2/assets (removes Google Fonts, improves LCP).

## Retention policies (the D1 cap provision, enforced by Cron Triggers from day one)

| Table family | Policy |
|---|---|
| engagement_events / email send log | raw 180 days, then monthly aggregates per customer |
| webhook_events | raw 90 days (claims/audit), then delete |
| health_score_history | snapshot-on-change only; 90 days raw, weekly rollups after |
| cron run history | 90 days |
| page 404 tracking | REDESIGNED: daily aggregate per path; raw rows 30 days. (Legacy has 140,428 unbounded rows — the proof this provision exists.) |
| social scout/leads | 180 days for non-actioned leads |
| ai_calls | raw 90 days, monthly cost aggregates after |
| admin_audit_log, outcomes, billing, disputes | permanent (compliance/moat) |

D1 size + per-table growth surfaced on /admin/operations; alert at 50% of 10GB.

## Non-negotiables (Phase 8 audit checks each)

1. Money writes: DO-serialized atomic batches only.
2. Drizzle only; portable schema; no raw SQLite-isms in business logic.
3. One email send module; engagement signals first-party only.
4. Retention crons live before any table they govern receives production writes.
5. Never log decrypted Stripe tokens. constructEvent() on every webhook with the correct secret. Webhook claim before side effects; fee writes exactly-once; the invoice.payment_succeeded webhook owns recovered status (never a cron).
6. All constants centralized; no hardcoded fees, model IDs, timings, limits, UUIDs, URLs.
7. Demo accounts excluded from all processing via prefix constant; billing_exempt honored everywhere money is computed.
8. PHYSICAL_ADDRESS present before any merchant-customer email send (CAN-SPAM); unsubscribe token in every dunning email.
