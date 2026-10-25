// Build the favicon set from Foxhound's one mark (app/lib/brand/hound-mark.ts).
//
//   npm install --no-save sharp && node scripts/build-icons.mjs
//
// Run by hand when the mark changes. sharp is deliberately NOT a repo
// dependency: this is a one-off authoring tool, the same posture as
// scripts/build-og-fonts.py, and the output is committed so a fresh clone
// needs neither. Node reads the .ts module directly (type stripping, Node 22.18
// and later), so the path data has one home and this script never copies it.
//
// It writes three files:
//   public/favicon.svg           the mark in the header band's amber on the dark
//                                rounded square, so it reads in a light and a
//                                dark browser tab alike;
//   public/favicon.png           that SVG at 512;
//   public/apple-touch-icon.png  that SVG at 512.
//
// The mark is a PLACEHOLDER hound head until Dustin picks the real logo
// (capsomer #65 item 15). The real logo replaces hound-mark.ts and this script
// rebuilds all three.
//
// Sizes. Legacy ships ONE 512x512 PNG at both /favicon.png and
// /apple-touch-icon.png (ledger row F21, ruling 108), and both stay at that
// size: legacy is the spec, and the route splash (96) and the RSS channel
// image read favicon.png, so a smaller PNG would blur them.
import { writeFileSync } from "node:fs";

import sharp from "sharp";

import { HOUND_MARK_PATH, HOUND_MARK_VIEWBOX } from "../app/lib/brand/hound-mark.ts";

const pub = new URL("../public/", import.meta.url);

// The band's colors (app/app.css: --bg in the dark theme, --header-brand). This
// script is outside app/, where the raw-hex rule (scripts/check-tokens.mjs)
// does not reach, because an SVG favicon cannot read CSS custom properties.
const SQUARE = "#111210";
const AMBER = "#f0b429";
const AMBER_RGB = [0xf0, 0xb4, 0x29];

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

const OUTPUTS = [
  { name: "favicon.png", size: 512 },
  { name: "apple-touch-icon.png", size: 512 },
];

const rasters = [];
for (const { name, size } of OUTPUTS) {
  const png = await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Verify before writing, because a rasteriser that silently produces a blank
  // image is the same failure shape as the OG card's empty PNG: a 200 and a
  // file of plausible size that contains nothing. Assert the amber is actually
  // there, and in a share of the tile a drawn head fills (well over a tenth).
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size) {
    throw new Error(`${name}: expected ${size}x${size}, got ${info.width}x${info.height}`);
  }
  let amber = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    // #f0b429 with a little tolerance for antialiasing at the edges
    if (
      Math.abs(data[i] - AMBER_RGB[0]) < 24 &&
      Math.abs(data[i + 1] - AMBER_RGB[1]) < 24 &&
      Math.abs(data[i + 2] - AMBER_RGB[2]) < 24
    ) {
      amber++;
    }
  }
  const share = amber / (size * size);
  if (share < 0.15) {
    throw new Error(`${name}: only ${amber} amber pixels (${(share * 100).toFixed(1)}%): the mark did not render, refusing to write a blank icon`);
  }
  rasters.push({ name, png, amber, share });
}

writeFileSync(new URL("favicon.svg", pub), svg);
for (const { name, png, amber, share } of rasters) {
  writeFileSync(new URL(name, pub), png);
  console.log(`wrote ${name}: ${png.length} bytes, ${amber} amber pixels (${(share * 100).toFixed(1)}%, guard is 15%)`);
}
console.log("wrote favicon.svg");
