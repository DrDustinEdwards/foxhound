import { ImageResponse } from "workers-og";

import dmSansVariable from "~/assets/fonts/dm-sans-variable.woff2?inline";
import dmMono500 from "~/assets/fonts/dm-mono-500.woff2?inline";

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
// stay visually consistent with the app itself.
const COLOR_BG = "#111210";
const COLOR_WORDMARK = "#f5f5f3";
const COLOR_AMBER = "#f0b429";
const COLOR_TEXT_SECONDARY = "#a8a49e";
const COLOR_TEXT_TERTIARY = "#928d87";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Satori/workers-og constraints (carried over from legacy): no <span>, every
// element is a <div>, every <div> has an explicit display:flex, no `gap`
// (use margins instead).
function wordmarkHtml(fontSize: number): string {
  return `<div style="display:flex;align-items:center;">
    <div style="display:flex;font-family:'DM Mono';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">fo</div>
    <div style="display:flex;font-family:'DM Mono';font-size:${fontSize}px;font-weight:500;color:${COLOR_AMBER};">x</div>
    <div style="display:flex;font-family:'DM Mono';font-size:${fontSize}px;font-weight:500;color:${COLOR_WORDMARK};">hound</div>
  </div>`;
}

function defaultCardHtml(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:1200px;height:630px;background-color:${COLOR_BG};font-family:'DM Sans';">
    ${wordmarkHtml(64)}
    <div style="display:flex;margin-top:28px;font-size:28px;color:${COLOR_TEXT_SECONDARY};max-width:800px;text-align:center;">Recover failed Stripe payments without overbilling for it.</div>
    <div style="display:flex;margin-top:20px;font-family:'DM Mono';font-size:16px;color:${COLOR_AMBER};letter-spacing:0.04em;text-transform:uppercase;">Pay only on Foxhound-attributed recoveries</div>
  </div>`;
}

function blogCardHtml(title: string, tag: string): string {
  const safeTitle = escapeHtml(title);
  const label = escapeHtml(tag || "Blog");
  const titleFontSize = title.length > 60 ? 44 : 56;
  return `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background-color:${COLOR_BG};padding:72px;font-family:'DM Sans';">
    ${wordmarkHtml(28)}
    <div style="display:flex;font-size:${titleFontSize}px;font-weight:500;line-height:1.2;color:${COLOR_WORDMARK};max-width:1000px;">${safeTitle}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-family:'DM Mono';font-size:16px;letter-spacing:0.04em;text-transform:uppercase;color:${COLOR_AMBER};">${label}</div>
      <div style="display:flex;font-family:'DM Mono';font-size:16px;color:${COLOR_TEXT_TERTIARY};">foxhoundapp.com</div>
    </div>
  </div>`;
}

// The font files are self-hosted .woff2 (app/assets/fonts). workers-og needs
// the raw bytes passed in explicitly (it cannot read a CSS @font-face), and
// there is no local-filesystem or ASSETS-binding fetch available at this
// call site, so the fonts are imported with Vite's `?inline` suffix (a
// base64 data: URL baked into the bundle at build time) and decoded to an
// ArrayBuffer here, rather than fetched at request time.
function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const type = params.params === "blog" ? "blog" : "default";
  const title = url.searchParams.get("title") ?? "Foxhound";
  const tag = url.searchParams.get("tag") ?? "";

  const element = type === "blog" ? blogCardHtml(title, tag) : defaultCardHtml();

  return new ImageResponse(element, {
    width: 1200,
    height: 630,
    fonts: [
      { name: "DM Sans", data: dataUrlToArrayBuffer(dmSansVariable), weight: 500, style: "normal" },
      { name: "DM Mono", data: dataUrlToArrayBuffer(dmMono500), weight: 500, style: "normal" },
    ],
  });
}
