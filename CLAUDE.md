# Claude Code: Session Rules for Foxhound

Mirrored from Capsid `recova/CLAUDE.md` Section 0 (FOXHOUND REBUILD track only; legacy-track
sections omitted since this repo never runs against the legacy app).

Working directory is the `foxhound` repo ONLY.

- Session start: read rebuild-plan.md and backlog.md from Capsid (namespace recova), then the
  repo-root canon docs in `docs/canon/` (ARCHITECTURE.md, PRICING.md, DESIGN.md, SCHEMA.md,
  ROUTES.md), then the TASK-foxhound-phaseN.md you were pointed at. Report which phase items are
  in scope, then build.
- NEVER clone or copy the legacy repo into the workspace. Read old code surgically via Capsid
  read_repo_file (DrDustinEdwards/recova, DrDustinEdwards/recova-mcp) at the exact paths named
  in the TASK file.
- Legacy Supabase (via Supabase MCP where configured) is read-only reference. Target DB is D1
  via wrangler/bindings.
- Money-write rule: outcome recording, attributed billing, and webhook claims go through
  DO-serialized atomic batches. No exceptions. If a task seems to require an interactive
  transaction, stop and flag it.
- Drizzle only. Zero raw SQLite dialect in business logic.
- Email: Cloudflare Email Service via the EMAIL binding, wrapped in the single thin send module.
  Never call the binding directly from business logic. Engagement signals come from OUR
  first-party tracking routes (open pixel + click redirects), not vendor webhooks. Bounce and
  suppression flow through the Email Service events -> Queues consumer. Do not add Resend to
  the rebuild under any circumstances.
- Verification gates, retargeted: crons -> invoke the Cron Trigger handler and check wrangler
  tail; webhooks -> Stripe CLI test event against the staging Worker, verify the D1 row; email
  sends -> wrangler email emulation locally, then staging send with engagement-tracking and
  bounce paths exercised; deploys -> staging first, always; DB changes -> Drizzle migration +
  SELECT verification against D1; billing changes -> verify the evidence FK chain (action ->
  outcome -> line item), not just amounts.
- Brand: all user-facing copy says Foxhound. No Recova strings in this repo outside the
  data-migration mapping docs.
- Build discipline, design rules, security rules, doc-update rules, anti-rationalization, and
  one-logical-change-per-commit all apply unchanged, per Capsid `recova/CLAUDE.md` Sections 2-12.
