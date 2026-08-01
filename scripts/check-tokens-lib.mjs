// Matchers for DESIGN.md's two hard rules: no raw hex color outside the token
// file, no px font sizes anywhere. Kept separate from the CLI in
// check-tokens.mjs so the matchers can be imported and tested against planted
// violations AND planted look-alikes, per capsid/conventions.md: a guard that
// has never been observed failing has not been verified. This module is pure,
// touches no filesystem and reads no process state, so importing it runs
// nothing.

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

// Numeric character references are markup, not color literals: the digits of
// &#10003; (a check mark) read to HEX_PATTERN as the hex color "#10003", which
// blocked a legitimate write. They are stripped before the hex scan rather
// than excluded inside HEX_PATTERN, so that a BARE "#10003" with no ampersand
// and no semicolon is still reported. The exemption is for the entity form
// specifically, never for those digits.
//
// Deliberately decimal-only. The hex form (&#x2713;) cannot reach HEX_PATTERN
// anyway, because the character after the hash is "x", which is not a hex
// digit, so matching it here would be dead code.
const NUMERIC_ENTITY_PATTERN = /&#\d+;/g;

// Three px-font-size shapes (port review finding 9: the original pattern only
// covered the first of these).
//
// WIDENED (M22, /audit hero): each pattern used to require the px length to sit
// alone, so a px inside a CSS function slipped past. `text-[clamp(28px,5vw,44px)]`
// is a px font size in every way that matters to a reader who has changed their
// browser font size, and the guard read it as clean. The value is now matched
// anywhere inside the arbitrary value, the declaration, or the string.
//
// Each pattern still anchors on a FONT-SIZE context (`text-[`, `font-size:`,
// `fontSize:`), so px lengths that are not font sizes stay legal: `mt-[7px]`,
// `w-[680px]`, `padding: 10px` and `border-radius: 12px` are all untouched. A
// matcher that swept those in would be wrong in the other direction.
//
// Measured before widening: zero non-exempt carriers in app/ would newly flag,
// so this closed a hole rather than grandfathering a pile.

// Tailwind arbitrary value, e.g. text-[13px] or text-[clamp(28px,5vw,44px)].
const TAILWIND_PX_FONT_SIZE_PATTERN = /\btext-\[[^\]]*?[0-9.]+px[^\]]*\]/g;
// Raw CSS declarations, e.g. `font-size: 13px;` or `font-size: clamp(28px,5vw,44px);`.
const CSS_PX_FONT_SIZE_PATTERN = /font-size:\s*[^;{}\n]*?[0-9.]+px[^;{}\n]*/g;
// React inline style objects, e.g. style={{ fontSize: "13px" }}.
const INLINE_STYLE_PX_FONT_SIZE_PATTERN = /fontSize:\s*["'`][^"'`]*?[0-9.]+px[^"'`]*["'`]/g;

// Scan one file's content. `rel` is the repo-relative path, used only to
// resolve the exemption lists. Returns an array of violation strings.
export function scanContent(rel, content) {
  const violations = [];
  const hexExempt = HEX_EXEMPT.some((p) => rel === p || rel.startsWith(p));
  const pxFontExempt = PX_FONT_EXEMPT.some((p) => rel === p || rel.startsWith(p));

  if (!hexExempt) {
    const withoutEntities = content.replace(NUMERIC_ENTITY_PATTERN, "");
    for (const match of withoutEntities.matchAll(HEX_PATTERN)) {
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

  return violations;
}
