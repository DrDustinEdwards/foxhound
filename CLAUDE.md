# Claude Code: Session Rules for Foxhound

Working directory is the `foxhound` repo ONLY. This repo is the Cloudflare-native rebuild;
the legacy Recova app is a separate, frozen repo (`DrDustinEdwards/recova`).

## Session ritual

Start: read `capsid/conventions.md` (portfolio canon), then `recova/core.md` (the namespace key
stays `recova` until the Phase 9 rename; the content covers Foxhound). Then read the canon docs
in Capsid namespace `recova`: ARCHITECTURE.md, PRICING.md, DESIGN.md, SCHEMA.md, ROUTES.md, plus
rebuild-plan.md and backlog.md. Then the TASK-foxhound-phaseN.md you were pointed at. Report which
phase items are in scope, then build.

End: write a `session-YYYY-MM-DD.md` episodic (type `episodic`, under ~2KB) to the recova namespace.

Canon lives in Capsid, not in this repo. `docs/canon/` is deprecated and holds pointer stubs only.
Do not restore document content there: it drifted from Capsid once already (the repo copies were
missing the Charts decision and the single-account rule, and carried em dashes that Capsid strips
on write).

Portfolio-wide rules (git attribution, writing style, agent conduct, design tokens, secrets
hygiene) are in `capsid/conventions.md`. This file holds only what is true of this repo.

## Repo-specific hard rules

- NEVER clone or copy the legacy repo into the workspace. Read old code surgically at the exact
  paths named in the TASK file.
  KNOWN GAP (2026-07-16): Capsid's repo tools resolve a namespace to its `primary` repo only and
  take no repo or label argument, so `read_repo_file` on namespace `recova` now returns Foxhound
  files. The legacy repos (DrDustinEdwards/recova, DrDustinEdwards/recova-mcp) are not reachable
  through Capsid until the tools accept a repo selector. Use Claude Code with local gh auth for
  legacy reads meanwhile. This gap has already caused one misdirected write (a legacy CLAUDE.md
  landed on this repo's main and was immediately corrected); treat every namespace-addressed
  repo write as a write to THIS repo.
- Legacy Supabase (via Supabase MCP where configured) is read-only reference. Target DB is D1 via
  wrangler/bindings.
- Money-write rule: outcome recording, attributed billing, and webhook claims go through
  DO-serialized atomic batches. No exceptions. If a task seems to require an interactive
  transaction, stop and flag it.
- Drizzle only. Zero raw SQLite dialect in business logic.
- Email: Cloudflare Email Service via the EMAIL binding, wrapped in the single thin send module.
  Never call the binding directly from business logic. Engagement signals come from OUR
  first-party tracking routes (open pixel + click redirects), not vendor webhooks. Bounce and
  suppression flow through the Email Service events -> Queues consumer. Do not add Resend to the
  rebuild under any circumstances.
- Brand: all user-facing copy says Foxhound. No Recova strings in this repo outside the
  data-migration mapping docs.

## Single environment (decided 2026-07-12)

One Worker `foxhound`, one D1 (dashboard label foxhound-staging, id 4aa23f57...), one KV
(foxhound-app-kv-staging). No `--env` flag anywhere: not in wrangler commands, not in CI. At
Phase 9 this single Worker takes app.foxhoundapp.com.

The two-environment language in ARCHITECTURE.md and rebuild-plan.md is SUPERSEDED and has not
been corrected in those docs yet. If they disagree with this section, this section wins, and
`recova/core.md` is the tiebreaker.

## Verification gates

- crons -> invoke the Cron Trigger handler and check wrangler tail
- webhooks -> Stripe CLI test event against the deployed Worker, verify the D1 row
- email sends -> wrangler email emulation locally, then a real send with engagement-tracking and
  bounce paths exercised
- deploys -> the Worker is the only environment; treat every deploy as production-adjacent
- DB changes -> Drizzle migration + SELECT verification against D1
- billing changes -> verify the evidence FK chain (action -> outcome -> line item), not just amounts

## Enforcement

`.claude/hooks/no-em-dash.sh` runs as a PreToolUse hook on Write and Edit and blocks the write if
the incoming content carries an em or en dash. PreToolUse plus exit 2 is the only combination that
actually blocks; PostToolUse fires too late to undo anything. Do not modify `.claude/settings.json`
without explicit instruction.
