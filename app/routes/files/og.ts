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
//       PNG). DM Mono's static per-weight files have none of those tables,
//       so this card uses DM Mono for every line of text, not just the
//       wordmark. That is a legitimate on-brand choice, not a workaround
//       dressed up as one: DM Mono is already this app's font for every
//       number/stat and the wordmark itself (wordmark.tsx), and reads
//       cleanly at OG card sizes.
import dmMono500 from "~/assets/fonts/dm-mono-500.ttf?inline";

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
// copied from app.css's dark theme (--bg, --wordmark, --amber, etc.) to
// stay visually consistent with the app itself. DESIGN.md sanctions this as
// a second exception to "no hardcoded hex anywhere outside token
// definitions", alongside email HTML, for the same reason: both render
// surfaces are isolated from the CSS pipeline and cannot consume custom
// properties. If app.css's dark-theme values below ever change, update
// these five constants to match in the same commit.
const COLOR_BG = "#111210";
const COLOR_WORDMARK = "#f5f5f3";
const COLOR_AMBER = "#f0b429";
const COLOR_TEXT_SECONDARY = "#a8a49e";
const COLOR_TEXT_TERTIARY = "#928d87";
const FONT = "DM Mono";

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
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_AMBER};">x</div>
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">hound</div>
  </div>`;
}

function defaultCardHtml(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:1200px;height:630px;background-color:${COLOR_BG};font-family:'${FONT}';">
    ${wordmarkHtml(64)}
    <div style="display:flex;margin-top:28px;font-size:24px;color:${COLOR_TEXT_SECONDARY};max-width:800px;text-align:center;">Recover failed Stripe payments without overbilling for it.</div>
    <div style="display:flex;margin-top:20px;font-size:16px;color:${COLOR_AMBER};letter-spacing:0.04em;text-transform:uppercase;">Pay only on Foxhound-attributed recoveries</div>
  </div>`;
}

function blogCardHtml(title: string, tag: string, host: string): string {
  const safeTitle = escapeHtml(title);
  const label = escapeHtml(tag || "Blog");
  const titleFontSize = title.length > 60 ? 40 : 48;
  return `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background-color:${COLOR_BG};padding:72px;font-family:'${FONT}';">
    ${wordmarkHtml(28)}
    <div style="display:flex;font-size:${titleFontSize}px;font-weight:500;line-height:1.3;color:${COLOR_WORDMARK};max-width:1000px;">${safeTitle}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-size:16px;letter-spacing:0.04em;text-transform:uppercase;color:${COLOR_AMBER};">${label}</div>
      <div style="display:flex;font-size:16px;color:${COLOR_TEXT_TERTIARY};">${escapeHtml(host)}</div>
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
  const tag = url.searchParams.get("tag") ?? "";
  // Derived from SITE_URL (site URL discipline, TASK-foxhound-phase6.md),
  // never hardcoded: previously this card always showed "foxhoundapp.com"
  // literally, wrong on every card generated before the Phase 9 domain
  // cutover (Phase 6 review finding).
  const host = new URL(siteUrl(env)).host;

  const element = type === "blog" ? blogCardHtml(title, tag, host) : defaultCardHtml();

  return new ImageResponse(element, {
    width: 1200,
    height: 630,
    fonts: [{ name: FONT, data: dataUrlToArrayBuffer(dmMono500), weight: 500, style: "normal" }],
  });
}
