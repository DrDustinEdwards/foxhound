import { ImageResponse } from "workers-og";

// Satori (workers-og's layout engine) parses fonts with opentype.js, which:
//   (a) only understands raw TrueType/OpenType signatures, not WOFF2's
//       compressed wrapper (confirmed at request time: "Unsupported OpenType
//       signature wOF2 Error", silently swallowed into an empty PNG rather
//       than a visible error) -- fixed by shipping a .ttf sibling of the
//       real self-hosted font (decompressed with the `wawoff2` package,
//       used once to generate this file, not a runtime or build dependency).
//   (b) cannot parse variable-font tables (fvar/gvar/avar/HVAR/STAT), which
//       the app's DM Sans Variable file carries -- confirmed at request
//       time ("Cannot read properties of undefined (reading '265')" deep
//       inside opentype.js's table parser, again swallowed into an empty
//       PNG).
//
// This file previously concluded from (b) that the card should use DM Mono
// for EVERY line of text, calling it "a legitimate on-brand choice, not a
// workaround dressed up as one". Ruling 96 (Dustin, 2026-08-02) corrected
// that: the constraint rules out one FILE, not the typeface. Legacy's card is
// sans throughout (app/og/route.tsx, `system-ui, sans-serif`), and a STATIC
// per-weight DM Sans instance parses exactly as DM Mono's static file does.
// scripts/build-og-fonts.py derives dm-sans-{400,500,600}.ttf from the same
// dm-sans-variable.woff2 the app already ships, stripping fvar/gvar/avar/
// HVAR/STAT so the table set matches dm-mono-500.ttf, the file already proven
// to parse at request time. A constraint that rules out an artifact is not a
// licence to change the design, and recording that change as deliberate
// without a ratification is what PRIME DIRECTIVE item 4 exists to catch.
//
// DM Mono is retained for the WORDMARK only: that is Foxhound's own brand
// treatment (wordmark.tsx), sanctioned under PRIME DIRECTIVE item 2(b).
import dmMono500 from "~/assets/fonts/dm-mono-500.ttf?inline";
import dmSans400 from "~/assets/fonts/dm-sans-400.ttf?inline";
import dmSans500 from "~/assets/fonts/dm-sans-500.ttf?inline";
import dmSans600 from "~/assets/fonts/dm-sans-600.ttf?inline";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/og";

// Dynamic Open Graph image generation, rewritten from legacy app/og/route.tsx
// (Phase 6 Pass 2) using `workers-og`, NOT next/og's ImageResponse: next/og
// compiles Satori's WASM dynamically at request time, which Cloudflare
// Workers blocks outright. workers-og bundles its WASM (resvg + yoga) as a
// static import inside its own package, which @cloudflare/vite-plugin
// handles like any other .wasm import, so there is nothing extra to wire up
// here beyond `npm install workers-og`.
//
// Route shape: registered as `og/:params` (a path segment), so `:params`
// carries the card TYPE ("default" | "blog") and the request's query string
// carries the per-card text ("title", "tag"). A resource-route loader gets
// the full Request regardless of how the path is shaped, so
// `new URL(request.url).searchParams` works the same way it would for a
// query-string-only route; using the path segment for the type keeps the
// two conceptually distinct (what kind of card vs. what it says) rather
// than stuffing everything into the query string.
//
// Colors are hardcoded hex here (not var(--*) tokens): workers-og renders in
// total isolation from this app's CSS pipeline (no stylesheet is loaded),
// so there is no token mechanism it could read from. Values below are
// copied from app.css's dark theme (--bg, --wordmark, --brand, etc.) to
// stay visually consistent with the app itself. DESIGN.md sanctions this as
// a second exception to "no hardcoded hex anywhere outside token
// definitions", alongside email HTML, for the same reason: both render
// surfaces are isolated from the CSS pipeline and cannot consume custom
// properties. If app.css's dark-theme values below ever change, update
// these five constants to match in the same commit.
const COLOR_BG = "#111210";
const COLOR_WORDMARK = "#f5f5f3";
const COLOR_BRAND = "#249398";
const COLOR_TEXT_SECONDARY = "#a8a49e";
const COLOR_TEXT_TERTIARY = "#928d87";
const COLOR_ON_BRAND = "#070f0f";
const FONT = "DM Mono";
const FONT_SANS = "DM Sans";

// Only `<`/`>` need escaping here: the title/tag are placed as a <div>'s
// TEXT content (never an attribute value), and workers-og's HTMLRewriter-
// based parser does not decode entities back out of text nodes (confirmed
// visually: an escaped "&amp;" rendered as the literal 5 characters
// "&amp;", not "&"), so escaping `&`/`"` would show the entity code on the
// card instead of the character. `<`/`>` still need escaping: an
// unescaped `<` in attacker-controlled input (title/tag come off the
// query string) could otherwise be parsed as the start of a real tag.
function escapeHtml(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Satori/workers-og constraints (carried over from legacy): no <span>, every
// element is a <div>, every <div> has an explicit display:flex, no `gap`
// (use margins instead).
function wordmarkHtml(fontSize: number): string {
  return `<div style="display:flex;align-items:center;">
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">fo</div>
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_BRAND};">x</div>
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">hound</div>
  </div>`;
}

// Legacy's default card (app/og/route.tsx): wordmark 80px, tagline 28px at
// letter-spacing -0.01em with 24px above it, then an 18px teal line at
// weight 500 with 8px above that. Sizes and spacing are legacy's; the COPY is
// Foxhound's and stays 20d-frozen (legacy's "20% of recovered revenue" is a
// pricing claim, Foxhound's attribution wording is the accurate one).
// Legacy sets no max-width or text-align here; the centred container does it.
function defaultCardHtml(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:1200px;height:630px;background-color:${COLOR_BG};font-family:'${FONT_SANS}';">
    ${wordmarkHtml(80)}
    <div style="display:flex;margin-top:24px;font-size:28px;color:${COLOR_TEXT_SECONDARY};letter-spacing:-0.01em;">Recover failed Stripe payments without overbilling for it.</div>
    <div style="display:flex;margin-top:8px;font-size:18px;font-weight:500;color:${COLOR_BRAND};">Pay only on Foxhound-attributed recoveries</div>
  </div>`;
}

// Legacy's blog card, ported structure for structure (app/og/route.tsx):
// a teal 10px dot plus an 18px weight-500 teal eyebrow, the title at
// 56px (48px past 50 characters) weight 600 with line-height 1.15 and
// letter-spacing -0.03em, the post EXCERPT beneath it at 22px, and a footer
// pairing the host with a teal pill. Foxhound had dropped the excerpt
// entirely, replaced the pill with a tag chip, and shrunk the title; all four
// were unratified. Branding only is Foxhound's: "Foxhound Blog", "FOXHOUND".
function blogCardHtml(title: string, description: string, host: string): string {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const titleFontSize = title.length > 50 ? 48 : 56;
  const descriptionHtml = safeDescription
    ? `\n      <div style="display:flex;font-size:22px;color:${COLOR_TEXT_SECONDARY};line-height:1.5;max-width:800px;">${safeDescription}</div>`
    : "";
  return `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background-color:${COLOR_BG};padding:72px 80px;font-family:'${FONT_SANS}';">
    <div style="display:flex;align-items:center;">
      <div style="display:flex;width:10px;height:10px;border-radius:50%;background-color:${COLOR_BRAND};margin-right:12px;"></div>
      <div style="display:flex;font-size:18px;font-weight:500;color:${COLOR_BRAND};letter-spacing:-0.02em;">Foxhound Blog</div>
    </div>
    <div style="display:flex;flex-direction:column;">
      <div style="display:flex;font-size:${titleFontSize}px;font-weight:600;line-height:1.15;letter-spacing:-0.03em;color:${COLOR_WORDMARK};max-width:900px;${safeDescription ? "margin-bottom:24px;" : ""}">${safeTitle}</div>${descriptionHtml}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-size:18px;color:${COLOR_TEXT_TERTIARY};">${escapeHtml(host)}</div>
      <div style="display:flex;background-color:${COLOR_BRAND};color:${COLOR_ON_BRAND};font-size:14px;font-weight:600;padding:8px 20px;border-radius:8px;letter-spacing:0.04em;">FOXHOUND</div>
    </div>
  </div>`;
}

// workers-og needs the raw font bytes passed in explicitly (it cannot read
// a CSS @font-face), and there is no local-filesystem or ASSETS-binding
// fetch available at this call site, so the font is imported with Vite's
// `?inline` suffix (a base64 data: URL baked into the bundle at build time)
// and decoded to an ArrayBuffer here, rather than fetched at request time.
function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);
  const type = params.params === "blog" ? "blog" : "default";
  const title = url.searchParams.get("title") ?? "Foxhound";
  // `description` is legacy's parameter name and legacy's content: the post
  // excerpt. It replaced `tag`, which legacy's card never carried (ruling 96).
  const description = url.searchParams.get("description") ?? "";
  // Derived from SITE_URL (site URL discipline, TASK-foxhound-phase6.md),
  // never hardcoded: previously this card always showed "foxhoundapp.com"
  // literally, wrong on every card generated before the Phase 9 domain
  // cutover (Phase 6 review finding).
  const host = new URL(siteUrl(env)).host;

  const element = type === "blog" ? blogCardHtml(title, description, host) : defaultCardHtml();

  return new ImageResponse(element, {
    width: 1200,
    height: 630,
    fonts: [
      { name: FONT, data: dataUrlToArrayBuffer(dmMono500), weight: 500, style: "normal" },
      { name: FONT_SANS, data: dataUrlToArrayBuffer(dmSans400), weight: 400, style: "normal" },
      { name: FONT_SANS, data: dataUrlToArrayBuffer(dmSans500), weight: 500, style: "normal" },
      { name: FONT_SANS, data: dataUrlToArrayBuffer(dmSans600), weight: 600, style: "normal" },
    ],
  });
}
