# Claude Code: Session Rules for Foxhound

Working directory is the `foxhound` repo ONLY. This repo is the Cloudflare-native rebuild;
the legacy Recova app is a separate, frozen repo (`DrDustinEdwards/recova`).

## PRIME DIRECTIVE (Dustin, verbatim intent, 2026-07-27)

**"I want the new site to be like the old site, except built to be native on Cloudflare."**

This outranks every rule below. For every user-facing surface (marketing, auth, app shell,
product pages, emails) LEGACY IS THE SPEC: pixel treatment, interaction behavior and
information architecture match legacy source unless a ruling in Capsid `recova/parity/
DECISIONS.md` records Dustin's ratification of the divergence.

Only three divergence classes need no per-item ratification: internals required by the
Cloudflare-native stack and invisible to the user; Foxhound branding where canon already
defines it; and truthfulness fixes where legacy copy lied. Anything recorded anywhere as a
"deliberate improvement" or a "locked decision" WITHOUT a quoted Dustin ratification is a
re-opened parity defect, not a decision, and is corrected toward legacy rather than defended.

The ratified list is CLOSED and lives in DECISIONS.md's PRIME DIRECTIVE item 3. No agent adds
to it. Fix direction is a ruling, never an agent default.

## Session ritual

Start: read `capsid/conventions.md` (portfolio canon), then `recova/core.md` (the namespace key
stays `recova` until the Phase 9 rename; the content covers Foxhound). Then read the canon docs
in Capsid namespace `recova`: ARCHITECTURE.md, PRICING.md, DESIGN.md, SCHEMA.md, ROUTES.md, plus
rebuild-plan.md and backlog.md. Then the TASK-foxhound-phaseN.md you were pointed at. Report which
phase items are in scope, then build.

End: write a `session-YYYY-MM-DD.md` episodic (type `episodic`, under ~2KB) to the recova namespace.

Canon lives in Capsid, not in this repo. `docs/canon/` is deprecated and holds pointer stubs only.
Do not restore document content there: it drifted from Capsid once already (the repo copies were
missing the Charts decision and the then-current single-account rule, and carried em dashes that
Capsid strips on write). That single-account rule was REVOKED by ruling 53 on 2026-07-27:
multi-account is the product. It survives in this sentence only as evidence that repo copies
drift, never as a live constraint.

Portfolio-wide rules (git attribution, writing style, agent conduct, design tokens, secrets
hygiene) are in `capsid/conventions.md`. This file holds only what is true of this repo.

## Repo-specific hard rules

- NEVER clone or copy the legacy repo into the workspace. Read old code surgically at the exact
  paths named in the TASK file.
  Legacy IS readable through Capsid. The repo selector shipped 2026-07-17: pass `repo` on any
  Capsid repo tool (`list_repo_tree`, `read_repo_file`, `search_code`, ...) with `"primary"`
  (foxhound), `"legacy"` (recova), or `"legacy-mcp"` (recova-mcp). Omitting it targets the
  primary repo, which is why a namespace-addressed call reads Foxhound files. Run
  `Capsid:namespaces` to confirm the mapping before ever claiming a repo is unreachable.
  A dated "KNOWN GAP (2026-07-16)" block used to sit here claiming the legacy repos were
  unreachable and telling you to use Claude Code with local gh auth instead. That was true for
  one day and has been false since. It cost three separate sessions, because it made the primary
  parity reference look inaccessible. Deleted 2026-07-25.
  Still true and worth keeping from that block: a namespace-addressed repo WRITE with no `repo`
  selector goes to THIS repo. A legacy CLAUDE.md once landed on this repo's main that way.
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

One Worker `foxhound`, one D1 (**foxhound**, id 3ad240ed..., renamed 2026-08-15 by
ruling 301), one KV (**foxhound**, id 8ff187..., renamed by ruling 303). Every earlier
database is GONE and the attribution matters, because the no-delete rule is about WHO
may act: 4aa23f57 was deleted by the SEAT under 302's quoted delegation, 7469d599 by
the seat under 303, and only the old empty ae406c63 was retired by Dustin himself.
The no-delete sentence those rulings carried has therefore been DISCHARGED rather
than quietly dropped: it protected 7469d599 until 303 authorised its deletion. No `--env` flag anywhere: not in wrangler commands, not in CI. At
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
The hook fails CLOSED if python3 breaks on PATH (missing or crashing): every Write and Edit is
blocked with a diagnostic naming python3, so if Writes are blocked and no dash is present,
diagnose python3 first instead of thrashing on retries.
