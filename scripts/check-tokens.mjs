#!/usr/bin/env node
// Structural enforcement for DESIGN.md's two hard rules (task
// TASK-foxhound-design-system-port.md Part 1): no raw hex color outside the
// token file, no px font sizes anywhere. The old design system enforced its
// rules by a rulebook; this enforces them by build failure.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Sanctioned raw-hex surfaces (DESIGN.md): structurally isolated from the
// CSS pipeline, cannot consume CSS custom properties.
const HEX_EXEMPT = [
  "app/app.css",
  "app/routes/files/og.ts",
  "app/lib/email/",
  "app/lib/auth/send-auth-email.ts",
];

// Sanctioned raw-px-font-size surfaces: email clients and Satori/SVG
// rendering both require literal px, not rem. Narrower than HEX_EXEMPT -
// app.css itself has no such excuse (it's the token file; a raw px font-size
// there would be a real violation, not a structural necessity).
const PX_FONT_EXEMPT = [
  "app/routes/files/og.ts",
  "app/lib/email/",
  "app/lib/auth/send-auth-email.ts",
];

const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;
// Three px-font-size shapes (port review finding 9: the original pattern only
// covered the first of these). Tailwind arbitrary value, e.g. text-[13px].
const TAILWIND_PX_FONT_SIZE_PATTERN = /\btext-\[[0-9.]+px\]/g;
// Raw CSS declarations, e.g. `font-size: 13px;` in a stylesheet.
const CSS_PX_FONT_SIZE_PATTERN = /font-size:\s*[0-9.]+px/g;
// React inline style objects, e.g. style={{ fontSize: "13px" }}.
const INLINE_STYLE_PX_FONT_SIZE_PATTERN = /fontSize:\s*["'`][0-9.]+px["'`]/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "assets") continue;
      walk(full, out);
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(resolve(ROOT, "app"));
const violations = [];

for (const file of files) {
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
  const hexExempt = HEX_EXEMPT.some((p) => rel === p || rel.startsWith(p));
  const pxFontExempt = PX_FONT_EXEMPT.some((p) => rel === p || rel.startsWith(p));
  const content = readFileSync(file, "utf8");

  if (!hexExempt) {
    for (const match of content.matchAll(HEX_PATTERN)) {
      violations.push(`${rel}: raw hex color "${match[0]}" outside the token file`);
    }
  }

  if (!pxFontExempt) {
    for (const match of content.matchAll(CSS_PX_FONT_SIZE_PATTERN)) {
      violations.push(`${rel}: px font size "${match[0]}", use a rem-based value`);
    }

    if (rel.endsWith(".tsx")) {
      for (const match of content.matchAll(TAILWIND_PX_FONT_SIZE_PATTERN)) {
        violations.push(`${rel}: px font size "${match[0]}", use a rem-based text-* token`);
      }
      for (const match of content.matchAll(INLINE_STYLE_PX_FONT_SIZE_PATTERN)) {
        violations.push(`${rel}: inline px font size "${match[0]}", use a rem-based value`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`check-tokens: ${violations.length} violation(s) found\n`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log("check-tokens: clean");
