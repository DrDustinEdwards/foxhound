// Generate the raster icons from public/favicon.svg (ruling 108).
//
//   npm install --no-save sharp && node scripts/build-icons.mjs
//
// Run by hand when the mark changes. sharp is deliberately NOT a repo
// dependency: this is a one-off authoring tool, the same posture as
// scripts/build-og-fonts.py, and the output is committed so a fresh clone
// needs neither.
//
// Why these files exist at all. Legacy ships ONE 512x512 palette PNG served at
// both /favicon.png and /apple-touch-icon.png (byte-identical, verified against
// the live legacy site: 52,188 bytes, 512x512, colortype 3), and declares both
// in its root layout. Foxhound shipped only favicon.svg, so /favicon.png and
// /apple-touch-icon.png both 404'd and no apple-touch declaration existed. That
// is ledger row F21, and it was blocking F5's RSS channel <image>, which needs a
// raster (ruling 99).
//
// A note on fidelity, so nobody reads the output as a downscale artifact: the
// source SVG sets font-family="monospace", so a browser rendering favicon.svg
// today already resolves a SYSTEM mono font rather than the app's DM Mono. This
// rasteriser resolves it the same way, so the PNG matches what the SVG renders,
// and neither matches the wordmark's DM Mono. That is a property of the mark as
// authored, not something introduced here.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = fileURLToPath(new URL(".", import.meta.url));
const pub = new URL("../public/", import.meta.url);

const SIZE = 512; // legacy's, measured from its live PNG rather than assumed
const OUTPUTS = ["favicon.png", "apple-touch-icon.png"];

const svg = readFileSync(new URL("favicon.svg", pub));

const png = await sharp(svg, { density: 384 })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

// Verify before writing, because a rasteriser that silently produces a blank
// image is the same failure shape as the OG card's empty PNG: a 200 and a file
// of plausible size that contains nothing. Assert the teal x is actually there
// (Q11: teal throughout; the mark's x is the header band's teal, #249398).
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
if (info.width !== SIZE || info.height !== SIZE) {
  throw new Error(`expected ${SIZE}x${SIZE}, got ${info.width}x${info.height}`);
}
let teal = 0;
for (let i = 0; i < data.length; i += info.channels) {
  // #249398 with a little tolerance for antialiasing at the glyph edges
  if (Math.abs(data[i] - 0x24) < 24 && Math.abs(data[i + 1] - 0x93) < 24 && Math.abs(data[i + 2] - 0x98) < 24) {
    teal++;
  }
}
if (teal < 200) {
  throw new Error(`only ${teal} teal pixels: the glyph did not render, refusing to write a blank icon`);
}

for (const name of OUTPUTS) {
  writeFileSync(new URL(name, pub), png);
}

console.log(`wrote ${OUTPUTS.join(" and ")} at ${info.width}x${info.height}, ${png.length} bytes`);
console.log(`teal pixels: ${teal} (blank-output guard threshold is 200)`);
console.log(`source: ${here}../public/favicon.svg`);
