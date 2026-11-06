// Build the icon set from Foxhound's one mark (app/lib/brand/hound-mark.ts).
//
//   npm install --no-save @resvg/resvg-js@2.6.2 && node scripts/build-icons.mjs
//
// Run by hand when the mark changes; the output is committed, so a fresh clone
// needs no rasteriser. Node reads the .ts module directly (type stripping, Node
// 22.18 and later), so the path data has one home and this script never copies it.
//
// It writes public/favicon.svg (the mark in the header band's amber on the dark
// rounded square, so it reads in a light and a dark browser tab alike), then
// Prelum's prelum-icons draws the shared icon set from it on the brand amber:
// favicon.ico, icon.svg, apple-touch-icon.png, icon-192.png, icon-512.png and
// icon-maskable-512.png. Look at each PNG before committing.
//
// The mark is a PLACEHOLDER hound head until Dustin picks the real logo
// (capsomer #65 item 15). The real logo replaces hound-mark.ts and this script
// rebuilds every file.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HOUND_MARK_PATH, HOUND_MARK_VIEWBOX } from "../app/lib/brand/hound-mark.ts";

const pub = new URL("../public/", import.meta.url);
const bin = new URL("../node_modules/@drdustinedwards/site-helpers/bin/icons.mjs", import.meta.url);

// The band's colors (app/app.css: --bg in the dark theme, --header-brand). This
// script is outside app/, where the raw-hex rule (scripts/check-tokens.mjs)
// does not reach, because an SVG favicon cannot read CSS custom properties.
const SQUARE = "#111210";
const AMBER = "#f0b429";

// The mark sits in a 26 square centered on the 32 tile, 3 from each edge.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <!-- PLACEHOLDER: a hound's head until Dustin picks the real logo (capsomer #65 item 15).
       Built by scripts/build-icons.mjs from app/lib/brand/hound-mark.ts; do not edit by hand. -->
  <rect width="32" height="32" rx="6" fill="${SQUARE}"/>
  <svg x="3" y="3" width="26" height="26" viewBox="${HOUND_MARK_VIEWBOX}">
    <path fill="${AMBER}" fill-rule="evenodd" d="${HOUND_MARK_PATH}"/>
  </svg>
</svg>
`;

const favicon = new URL("favicon.svg", pub);
writeFileSync(favicon, svg);
execFileSync(process.execPath, [fileURLToPath(bin), "--svg", fileURLToPath(favicon), "--background", AMBER, "--out", fileURLToPath(pub)], { stdio: "inherit" });
