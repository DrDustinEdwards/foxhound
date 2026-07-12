# DESIGN.md — Foxhound Canon (Phase 0)

Status: DRAFT pending Dustin lock. Tokens port from legacy app/globals.css; this doc governs everything visual in the `foxhound` repo.

## Wordmark (the call, per the legacy single-accent pattern)

**fo`x`hound** — the wordmark is DM Mono, white (#f5f5f3), with the single letter **x** in amber (#f0b429). Lowercase, no space. Rationale: the legacy pattern is a white wordmark with exactly one amber character ("recov" + amber "a"); for Foxhound the distinctive character is the x — it is the visual center of the word, it reads as the fox being highlighted, and a final-letter amber "d" is typographically weak. Favicon/app icon: the amber x on the dark surface. If Dustin prefers a different accent letter, change ONLY this section; the one-amber-character rule itself is canon.

## Tokens (ported, unchanged)

- Dark is default; light theme exists as plumbing via `data-theme` on `<html>`. Every surface uses CSS-variable tokens; both palettes in one stylesheet.
- No hardcoded hex anywhere outside token definitions (email HTML is the one sanctioned exception). No inline `style={{color/background}}` except runtime-dynamic numeric values.
- Amber `#f0b429`: THE action color. One amber element per card maximum. Hover states on text/background. Active state is `text-text` + `font-semibold`; the only sanctioned amber-on-active is the 2px bottom border on primary nav links.
- Purple `#a78bfa`: EXCLUSIVELY Stripe Connect UI (the buttons that immediately initiate Stripe OAuth) and win-back attribution. Nothing else, ever.
- Text scale: `--text-tertiary` / `--text-subtle` (there is no `--text-muted`).
- Type: DM Mono for numbers, labels, wordmark; DM Sans for body/UI. rem sizes only, from the type-scale tokens. Fonts SELF-HOSTED from repo assets/R2 (no Google Fonts request; LCP).
- Recovery-rate thresholds: 0-20 red, 21-35 amber, 36+ green.
- No em dashes in any user-facing string. No AI-sounding phrasing. No three-beat parallel lists in copy. Benefit-forward. Apostrophes avoided in marketing copy where natural.

## Product shell

- ONE shell across marketing and app: shared header pattern, shared tokens, no visual seam at login.
- One dashboard (the console/dashboard split is dead). Login lands on `/dashboard`.
- Mobile: bottom tab bar on app surfaces, rendered as a sibling of the content container; `body` never flex (position:fixed breakage on mobile Chrome). Visual verification at 375px and 1280px is a required gate on nav changes.

## Flagship surfaces (design intent, built in Phase 5/6)

1. **Billing evidence view** — the pricing model made visible. Each fee renders its chain: the Foxhound action (retry / engaged email / card update, with timestamp) -> the recovered payment -> the 20%. Baseline recoveries appear in the same ledger marked FREE. This screen is the trust product; it gets the most design attention in the app.
2. **Dispute approval** — a review-and-sign flow: evidence draft rendered in full, edit affordance, explicit Approve & Submit action with the fee (cap included) stated on the button's confirmation. Never a toggle.
3. **Audit report** — one headline number (lift), three bands beneath it (Stripe recovered / still dying / Foxhound adds), detail collapsed below. The no-auth estimator is the same visual language with estimated data and a clearly labeled confidence caveat.
4. **Intelligence risk view** — every customer scored (no "unknown" walls), sorted by MRR-at-risk; each score expands to its evidence bands. The free analytics tier is visually distinct from the paid risk layer with one upgrade surface, not nags.

## Email design

- One wrapped HTML template (ported wrapEmailHtml pattern): 600px wrapper, sender brand voice, unsubscribe + PHYSICAL_ADDRESS footer on every dunning email. Inline hex is sanctioned here only. Amber links.
- Dunning emails read as the MERCHANT's voice (brand_voice), not Foxhound's. No AI tells. Every generated email is read in full before a template ships (verification gate).
