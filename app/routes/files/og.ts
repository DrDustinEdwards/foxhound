import { cardText, shareCardResponse, titleFontSize } from "@dustinedwards/site-runtime/share-card";
import { drawShareCard } from "@dustinedwards/site-runtime/share-card-draw";

// The card draws static per-weight TTFs, stored as .bin so the Worker carries them as binary modules (dm-sans-{400,500,600}.bin, derived by scripts/build-og-fonts.py from the variable woff2 the app ships; dm-mono-500.bin). The card is sans throughout; DM Mono is the wordmark only. They stay as they are so the card's pixels do not move.
import dmMono500 from "~/assets/fonts/dm-mono-500.bin";
import dmSans400 from "~/assets/fonts/dm-sans-400.bin";
import dmSans500 from "~/assets/fonts/dm-sans-500.bin";
import dmSans600 from "~/assets/fonts/dm-sans-600.bin";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/og";

// Dynamic Open Graph image generation, drawn by site-runtime's share-card-draw (Takumi, WebAssembly), NOT next/og: next/og compiles its WASM dynamically at request time, which Cloudflare Workers blocks outright. share-card-draw imports its .wasm statically, which @cloudflare/vite-plugin handles like any other .wasm import.
// Registered twice. `og/:params` (a path segment) is the form Foxhound's own meta tags use: `:params` carries the card TYPE ("default" | "blog") and the query string carries the per-card text ("title", "description"). `og` alone takes the type as the `type` query parameter, so an older /og URL maps to itself.
// Colors are hardcoded hex (not var(--*) tokens): the renderer works in total isolation from this app's CSS pipeline, so there is no token mechanism it could read from. Values are copied from the dark theme's tokens (--ground, --wordmark, --accent, etc.); DESIGN.md sanctions this as an exception beside email HTML, for the same reason. If app.css's dark-theme values change, update these seven constants in the same commit.
const COLOR_BG = "#111210";
const COLOR_WORDMARK = "#f5f5f3";
// The card text color (#f0ede8), which app.css keeps as --chrome-text, the value for text on the dark band. The blog title uses it; the wordmark keeps --wordmark, which is Foxhound branding.
const COLOR_TEXT = "#f0ede8";
const COLOR_BRAND = "#f0b429";
const COLOR_TEXT_SECONDARY = "#a8a49e";
const COLOR_TEXT_TERTIARY = "#928d87";
const COLOR_ON_BRAND = "#0d0e0c";
const FONT = "DM Mono";
const FONT_SANS = "DM Sans";

// Renderer constraints: no <span>, every element is a <div>, every <div> has an explicit display:flex, no `gap` (use margins instead).
function wordmarkHtml(fontSize: number, extraStyle = ""): string {
  return `<div style="display:flex;align-items:center;${extraStyle}">
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">fo</div>
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_BRAND};">x</div>
    <div style="display:flex;font-family:'${FONT}';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">hound</div>
  </div>`;
}

// The default card: wordmark 80px with 24px below it, tagline 28px at letter-spacing -0.01em with 24px below it, then an 18px amber line at weight 500 with 8px above it, so the amber line sits 32px under the tagline (24 + 8). No max-width or text-align here; the centered container does it.
function defaultCardHtml(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:1200px;height:630px;background-color:${COLOR_BG};font-family:'${FONT_SANS}';">
    ${wordmarkHtml(80, "margin-bottom:24px;")}
    <div style="display:flex;font-size:28px;color:${COLOR_TEXT_SECONDARY};letter-spacing:-0.01em;margin-bottom:24px;">Recover failed Stripe payments without overbilling for it.</div>
    <div style="display:flex;margin-top:8px;font-size:18px;font-weight:500;color:${COLOR_BRAND};">Pay only on Foxhound-attributed recoveries</div>
  </div>`;
}

// The blog card: an amber 10px dot plus an 18px weight-500 amber eyebrow, the title at 56px (48px past 50 characters) weight 600 with line-height 1.15 and letter-spacing -0.03em, the post EXCERPT beneath it at 22px, and a footer pairing the host with an amber pill. Branding: "Foxhound Blog", "FOXHOUND".
const BLOG_TITLE_SIZES = [
  { maxChars: 50, fontSize: 56 },
  { maxChars: Infinity, fontSize: 48 },
];
function blogCardHtml(title: string, description: string, host: string): string {
  const safeTitle = cardText(title);
  const safeDescription = cardText(description);
  const fontSize = titleFontSize(title, BLOG_TITLE_SIZES);
  const descriptionHtml = safeDescription
    ? `\n      <div style="display:flex;font-size:22px;color:${COLOR_TEXT_SECONDARY};line-height:1.5;max-width:800px;">${safeDescription}</div>`
    : "";
  return `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background-color:${COLOR_BG};padding:72px 80px;font-family:'${FONT_SANS}';">
    <div style="display:flex;align-items:center;">
      <div style="display:flex;width:10px;height:10px;border-radius:50%;background-color:${COLOR_BRAND};margin-right:12px;"></div>
      <div style="display:flex;font-size:18px;font-weight:500;color:${COLOR_BRAND};letter-spacing:-0.02em;">Foxhound Blog</div>
    </div>
    <div style="display:flex;flex-direction:column;">
      <div style="display:flex;font-size:${fontSize}px;font-weight:600;line-height:1.15;letter-spacing:-0.03em;color:${COLOR_TEXT};max-width:900px;${safeDescription ? "margin-bottom:24px;" : ""}">${safeTitle}</div>${descriptionHtml}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-size:18px;color:${COLOR_TEXT_TERTIARY};">${cardText(host)}</div>
      <div style="display:flex;background-color:${COLOR_BRAND};color:${COLOR_ON_BRAND};font-size:14px;font-weight:600;padding:8px 20px;border-radius:8px;letter-spacing:0.04em;">FOXHOUND</div>
    </div>
  </div>`;
}

// The renderer needs the raw font bytes passed in explicitly (it cannot read a CSS @font-face), and no local-filesystem or ASSETS-binding fetch is available at this call site, so the font is imported with Vite's `?inline` suffix (a base64 data: URL baked into the bundle) and decoded to bytes here.
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);
  // Two URL shapes reach this loader: the path form, /og/default and /og/blog, and /og with the type in the query (?type=blog), so a card URL already embedded in a shared link keeps drawing the same card. Any type but "blog" is the default card.
  const requested = params.params ?? url.searchParams.get("type");
  const type = requested === "blog" ? "blog" : "default";
  const title = url.searchParams.get("title") ?? "Foxhound";
  // `description` is the post excerpt.
  const description = url.searchParams.get("description") ?? "";
  // Derived from SITE_URL, never hardcoded.
  const host = new URL(siteUrl(env)).host;

  const html = type === "blog" ? blogCardHtml(title, description, host) : defaultCardHtml();

  // site-runtime's shareCardResponse (renderShareCard underneath) removes the whitespace between tags (a text child of the flex box: on the blog card it pulled the footer's host and pill in from the edges and the footer up off the 72px bottom padding) and reads the whole PNG, so a failed render is a 503 rather than an empty image, and sends the card with Cross-Origin-Resource-Policy: cross-origin, which the Worker's merge keeps.
  return shareCardResponse(drawShareCard, {
    html,
    fonts: () => [
      { name: FONT, data: dmMono500, weight: 500, style: "normal" },
      { name: FONT_SANS, data: dmSans400, weight: 400, style: "normal" },
      { name: FONT_SANS, data: dmSans500, weight: 500, style: "normal" },
      { name: FONT_SANS, data: dmSans600, weight: 600, style: "normal" },
    ],
  });
}
