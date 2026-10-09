# Cloudflare best-practices and vendor-first audit: foxhound

Job job_2e83af95c8f9, audited 2026-10-09 at 248ddcd. Capsid's own audit files
(capsid/research/vendor-replacements.md, cloudflare-best-practices.md) and the
four vendor pages were not readable from this session, so the vendor
recommendations below are cited from memory of those pages and marked
"unverified against the live page" where that matters. This file lives in the
repo because the session may not write to Capsid; move it to
foxhound/research/cloudflare-audit.md in Capsid if wanted.

Scope: foxhound only (recova and recova-mcp are being retired).

| # | Item | What the code does | Vendor recommendation | Status | Bundle | Risk | Recommendation |
|---|------|--------------------|-----------------------|--------|--------|------|----------------|
| 1a | compatibility_date | `2026-07-12`, about 3 months old | Use a recent date | Verified in wrangler.jsonc | none | low | Bump at the next deploy window; not changed here (a bump can change runtime behavior on a payments Worker) |
| 1b | nodejs_compat | Set | Recommended | Verified | none | none | None |
| 1c | observability | `{ "enabled": true }` only: no `traces`, no `head_sampling_rate` | Enable logs and traces and state the sampling rate | Verified | none | low | DECIDE 1 |
| 1d | Structured logs | 32 `console.*` calls in app and workers, 1 uses JSON.stringify | Log JSON objects so they are searchable | Verified by grep | none | low | Add a small `logJson` helper and migrate the 32 calls (follow-up PR, mechanical) |
| 2 | Env types | `wrangler types` runs inside `npm run typecheck`; `worker-configuration.d.ts` is gitignored; `env.d.ts` only adds secrets that have no binding | Generated types | Verified | none | none | None. Secrets declared by hand in env.d.ts is the documented gap (`wrangler types` cannot see secrets without `.dev.vars`) |
| 3 | Constant-time compares | Card-update, engagement and unsubscribe tokens use `crypto.subtle.verify("HMAC", ...)`, which is constant-time. No hand-written compare loop found (grep for `charCodeAt`, `===` on sigs) | Constant-time compare | Verified | none | none | None |
| 4a | no-floating-promises | Was absent | Lint rule in CI | Verified | none | none | DONE in this PR: type-aware rule on app and workers source; found 3 floating promises (React Router `submit`/`navigate`/`switchAccount` in event handlers), marked `void`. Seen red before the fix |
| 4b | waitUntil destructured | The only call sites pass `(promise) => ctx.waitUntil(promise)` (app/layouts/app-shell.tsx:82), not a destructured method | Never destructure | Verified | none | none | None |
| 4c | passThroughOnException | No match | Do not use | Verified | none | none | None |
| 4d | Request state in module globals | Module-level `Map` in app/lib/mcp/redact.ts is a static rules table, not request state | None per request | Verified | none | none | None |
| 5 | Bindings over REST | No `api.cloudflare.com` reference in app or workers | Use bindings | Verified | none | none | None |
| 6a | Stripe webhook verify | `stripe.webhooks.constructEventAsync` (vendor SDK) in app/lib/stripe/webhook.ts | Vendor verifier | Verified | none | none | None |
| 6b | JWT/OIDC/PKCE/cookie signing | Better Auth owns sessions and OAuth; no hand-written JWT or PKCE | Library | Verified by grep | none | none | None |
| 6c | HMAC tokens (3 copies) | card-update/token.ts, engagement/token.ts, email/unsubscribe-token.ts each carry their own base64url and sign/verify code (bin/charCodeAt decode loop is duplicated three times) | One shared helper | Verified | small drop | medium: token formats are customer-visible links and payment paths | DECIDE 2 |
| 6d | MCP | app/lib/mcp/protocol.ts is a hand-written JSON-RPC layer; `@modelcontextprotocol/sdk` is not a dependency, so there are no duplicate SDK copies | Cloudflare recommends the `agents`/MCP SDK for remote MCP servers (unverified against live page) | Verified for absence of duplicates; replacement unverified | would grow the bundle | medium | DECIDE 3 |
| 7 | Rate limiting | Durable Object per `bucket:IP` (workers/rate-limiter.ts): per entity, not one global object, which matches the Rules of Durable Objects. The file records the Workers Rate Limiting binding was tried and returned success past the limit | Rate limiting binding or WAF; DO only per entity | Verified | none | low | Keep. Revisit the binding when it can be tested again; a WAF rule for the auth paths is an account setting for Dustin |
| 8 | Background work | Five crons, a cron-lock DO, an email queue with DLQ, a MoneyWriter DO that serializes atomic batches | Queues/Workflows rules: steps safe to repeat, small steps, fixed names | Partly verified (structure read, per-step idempotency not audited) | none | HIGH: touches money | DECIDE 4. Not changed; money paths stay gated |
| 9 | Static assets | `assets.directory ./build/client` on Workers Static Assets; no Pages | Static Assets | Verified | none | none | None |
| 10 | Shared packages | package.json has none of Capsomer, Enarratio, Prelum, security-headers, rate-limit, site-helpers. CLAUDE.md forbids moving toward Capsomer before parity | Use shared packages | Verified for absence | unknown | medium: look and behavior | DECIDE 5 |

## DECIDE points

1. Observability. Recommendation: add `"traces": { "enabled": true }` and an
   explicit `head_sampling_rate` (1 for logs at launch volume). It changes what
   Cloudflare bills and stores, so it is Dustin's call.
2. Merge the three HMAC token modules into one helper. Recommendation: yes,
   after parity, with the existing token tests kept as the safety net. It
   touches card-update links, so not done here.
3. Replace the hand-written MCP JSON-RPC layer with the vendor MCP SDK.
   Recommendation: not now; larger bundle, and the current layer is tested.
4. Audit retry/dunning steps against the Rules of Workflows. Recommendation:
   yes, as a read-only follow-up audit of app/lib/engine, with no code change
   until the idempotency of each step is shown.
5. Adopt the shared packages. Recommendation: wait for parity, per CLAUDE.md.

## Fixes shipped

Only item 4a, in this PR. Items 1d and the compatibility_date bump are clear but
small follow-ups, left for separate PRs.
