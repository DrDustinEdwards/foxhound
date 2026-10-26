import { fromBase64 } from "@dustinedwards/site-runtime/encoding";
import { cardText, renderShareCard } from "@dustinedwards/site-runtime/share-card";
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
// license to change the design, and recording that change as deliberate
// without a ratification is what PRIME DIRECTIVE item 4 exists to catch.
//
// DM Mono is retained for the WORDMARK only: that is Foxhound's own brand
// treatment (wordmark.tsx), sanctioned under PRIME DIRECTIVE item 2(b).
import dmMono500 from "~/assets/fonts/dm-mono-500.ttf?inline";
import dmSans400 from "~/assets/fonts/dm-sans-400.ttf?inline";
import dmSans500 from "~/assets/fonts/dm-sans-500.ttf?inline";
import dmSans600 from "~/assets/fonts/dm-sans-600.ttf?inline";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { EMBEDDABLE_RESOURCE_HEADERS } from "~/lib/http/header-set";
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
// Route shape: registered twice. `og/:params` (a path segment) is the form
// Foxhound's own meta tags use: `:params` carries the card TYPE ("default" |
// "blog") and the query string carries the per-card text ("title",
// "description"). `og` is Recova's own URL, where the type is the `type` query
// parameter; it is served so ruling 41's redirect entry maps /og to itself. A resource-route loader gets
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
// these seven constants to match in the same commit.
const COLOR_BG = "#111210";
const COLOR_WORDMARK = "#f5f5f3";
// Legacy's card text color (#f0ede8 on both of its cards), which app.css keeps
// as --chrome-text, legacy's value for text on the dark band. The blog title
// uses it; the wordmark keeps --wordmark, which is Foxhound branding (J20).
const COLOR_TEXT = "#f0ede8";
const COLOR_BRAND = "#f0b429";
const COLOR_TEXT_SECONDARY = "#a8a49e";
const COLOR_TEXT_TERTIARY = "#928d87";
const COLOR_ON_BRAND = "#0d0e0c";
const FONT = "DM Mono";
const FONT_SANS = "DM Sans";

// Satori/workers-og constraints (carried over from legacy): no <span>, every
// element is a <div>, every <div> has an explicit display:flex, no `gap`
// (use margins instead).
function wordmarkHtml(fontSize: number, extraStyle = ""): string {
  return `<div style="display:flex;align-items:center;${extraStyle}">
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">fo</div>
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_BRAND};">x</div>
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">hound</div>
  </div>`;
}

// Legacy's default card (app/og/route.tsx, blob 59c49647): wordmark 80px with
// 24px below it, tagline 28px at letter-spacing -0.01em with 24px below it,
// then an 18px amber line at weight 500 with 8px above it. The margins are
// legacy's, placed where legacy places them, so the amber line sits 32px under
// the tagline (24 + 8), not 8px as this card had it (J20). The COPY is
// Foxhound's and stays 20d-frozen (legacy's "20% of recovered revenue" is a
// pricing claim, Foxhound's attribution wording is the accurate one).
// Legacy sets no max-width or text-align here; the centered container does it.
function defaultCardHtml(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:1200px;height:630px;background-color:${COLOR_BG};font-family:'${FONT_SANS}';">
    ${wordmarkHtml(80, "margin-bottom:24px;")}
    <div style="display:flex;font-size:28px;color:${COLOR_TEXT_SECONDARY};letter-spacing:-0.01em;margin-bottom:24px;">Recover failed Stripe payments without overbilling for it.</div>
    <div style="display:flex;margin-top:8px;font-size:18px;font-weight:500;color:${COLOR_BRAND};">Pay only on Foxhound-attributed recoveries</div>
  </div>`;
}

// Legacy's blog card, ported structure for structure (app/og/route.tsx):
// an amber 10px dot plus an 18px weight-500 amber eyebrow, the title at
// 56px (48px past 50 characters) weight 600 with line-height 1.15 and
// letter-spacing -0.03em, the post EXCERPT beneath it at 22px, and a footer
// pairing the host with an amber pill. Foxhound had dropped the excerpt
// entirely, replaced the pill with a tag chip, and shrunk the title; all four
// were unratified. Branding only is Foxhound's: "Foxhound Blog", "FOXHOUND".
function blogCardHtml(title: string, description: string, host: string): string {
  const safeTitle = cardText(title);
  const safeDescription = cardText(description);
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
      <div style="display:flex;font-size:${titleFontSize}px;font-weight:600;line-height:1.15;letter-spacing:-0.03em;color:${COLOR_TEXT};max-width:900px;${safeDescription ? "margin-bottom:24px;" : ""}">${safeTitle}</div>${descriptionHtml}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-size:18px;color:${COLOR_TEXT_TERTIARY};">${cardText(host)}</div>
      <div style="display:flex;background-color:${COLOR_BRAND};color:${COLOR_ON_BRAND};font-size:14px;font-weight:600;padding:8px 20px;border-radius:8px;letter-spacing:0.04em;">FOXHOUND</div>
    </div>
  </div>`;
}

// workers-og needs the raw font bytes passed in explicitly (it cannot read
// a CSS @font-face), and there is no local-filesystem or ASSETS-binding
// fetch available at this call site, so the font is imported with Vite's
// `?inline` suffix (a base64 data: URL baked into the bundle at build time)
// and decoded to bytes here, rather than fetched at request time.
function fontBytes(dataUrl: string): ArrayBuffer {
  return fromBase64(dataUrl.slice(dataUrl.indexOf(",") + 1)).buffer;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);
  // Two URL shapes reach this loader. Foxhound's own pages use the path form,
  // /og/default and /og/blog. Recova's URL is /og with the type in the query
  // (?type=blog), and ruling 41's redirect entry sends it here at the same path,
  // so a card URL already embedded in a shared link keeps drawing the same
  // card. As in Recova, any type but "blog" is the default card.
  const requested = params.params ?? url.searchParams.get("type");
  const type = requested === "blog" ? "blog" : "default";
  const title = url.searchParams.get("title") ?? "Foxhound";
  // `description` is legacy's parameter name and legacy's content: the post
  // excerpt. It replaced `tag`, which legacy's card never carried (ruling 96).
  const description = url.searchParams.get("description") ?? "";
  // Derived from SITE_URL (site URL discipline, TASK-foxhound-phase6.md),
  // never hardcoded: previously this card always showed "foxhoundapp.com"
  // literally, wrong on every card generated before the Phase 9 domain
  // cutover (Phase 6 review finding).
  const host = new URL(siteUrl(env)).host;

  const html = type === "blog" ? blogCardHtml(title, description, host) : defaultCardHtml();

  // site-runtime's renderShareCard removes the whitespace between tags (a text child of the flex box: on the blog card
  // it pulled the footer's host and pill in from the edges and the footer up off Recova's 72px bottom padding, J20) and
  // reads the whole PNG, so a failed render is a 503 rather than an empty image. A card is an image other sites show
  // (og:image previews, embeds), so it sends Cross-Origin-Resource-Policy: cross-origin; the Worker's default is
  // same-origin, and its merge keeps this route-set value (header-set.ts, EMBEDDABLE_RESOURCE_HEADERS).
  const card = await renderShareCard(ImageResponse, html, {
    fonts: [
      { name: FONT, data: fontBytes(dmMono500), weight: 500, style: "normal" },
      { name: FONT_SANS, data: fontBytes(dmSans400), weight: 400, style: "normal" },
      { name: FONT_SANS, data: fontBytes(dmSans500), weight: 500, style: "normal" },
      { name: FONT_SANS, data: fontBytes(dmSans600), weight: 600, style: "normal" },
    ],
    headers: EMBEDDABLE_RESOURCE_HEADERS,
  });
  return card ?? new Response("Card unavailable", { status: 503, headers: { "Retry-After": "300" } });
}
