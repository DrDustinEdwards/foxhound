import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Teal throughout (job_3037f6d2a135, Q11: Dustin "yes", 2026-10-14, Capsid
// foxhound/parity/ANSWERS-2026-10-14.md). No Foxhound page, email or image
// carries an amber accent: wherever Recova used amber, Foxhound shows its teal
// through the brand tokens in app/app.css.
//
// This walks every text file under app/ and public/, plus the generator of
// public/'s raster icons (scripts/build-icons.mjs; the PNGs themselves are
// binary, so their source is what is read). It fails on the word "amber" in any
// case (a token, a class, a tone name, a comment) and on the amber literals the
// old token family carried. It says how many files it read and fails if it read
// none (capsid conventions 3.2).

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["app", "public"];
const EXTRA_FILES = ["scripts/build-icons.mjs"];
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".css",
  ".svg",
  ".json",
  ".md",
  ".html",
  ".txt",
  ".xml",
  ".webmanifest",
  "",
]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);

// The old amber family: its hex values in both themes, the focus border, the
// light selected tint, and the amber scrim's rgb triple.
const AMBER_LITERALS = [
  "f0b429",
  "ffd166",
  "d4941a",
  "b87c10",
  "9e6a0a",
  "8a5c06",
  "f5d98a",
  "b2861f",
  "826217",
  "3d3010",
  "1e1a0a",
  "1f1a0a",
  "fff5d6",
  "faecbf",
  "b5820d",
  "fdf3d8",
];
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "the word amber", re: /amber/gi },
  { name: "an amber hex literal", re: new RegExp(`#(?:${AMBER_LITERALS.join("|")})\\b`, "gi") },
  { name: "the amber rgb triple", re: /rgba?\(\s*240[\s,]+180[\s,]+41\b/gi },
];

// Nothing is allowed. The one exception was a demo company-name prefix ("Amber"),
// and it reached the rendered Recovery page (Grok audit 2026-10-21, FH-18).
const ALLOWED: { file: string; line: string }[] = [];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function collect(): { read: string[]; skippedBinary: string[] } {
  const all: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), all);
  for (const f of EXTRA_FILES) all.push(join(ROOT, f));
  const read: string[] = [];
  const skippedBinary: string[] = [];
  for (const p of all) {
    const ext = extname(p).toLowerCase();
    if (BINARY_EXT.has(ext)) skippedBinary.push(p);
    else if (TEXT_EXT.has(ext)) read.push(p);
    else throw new Error(`no-amber check: unknown file type ${relative(ROOT, p)}; add it to TEXT_EXT or BINARY_EXT`);
  }
  return { read, skippedBinary };
}

function offenders(files: string[]): string[] {
  const found: string[] = [];
  for (const p of files) {
    const rel = relative(ROOT, p).split("\\").join("/");
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (ALLOWED.some((a) => a.file === rel && text.trim() === a.line)) return;
      for (const { name, re } of PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) found.push(`${rel}:${i + 1}: ${name} (${m[0]}): ${text.trim().slice(0, 120)}`);
      }
    });
  }
  return found;
}

describe("no amber accent anywhere in Foxhound (Q11)", () => {
  const { read, skippedBinary } = collect();

  it("reads the files it says it reads", () => {
    console.log(
      `no-amber-q11: read ${read.length} text files under ${DIRS.join(", ")} plus ${EXTRA_FILES.join(", ")}; ` +
        `${skippedBinary.length} binary files checked through their generator`,
    );
    expect(read.length).toBeGreaterThan(0);
    expect(read.map((p) => relative(ROOT, p).split("\\").join("/"))).toContain("app/app.css");
  });

  it("finds no amber token, class, word or literal", () => {
    const found = offenders(read);
    const files = new Set(found.map((f) => f.split(":")[0]));
    if (found.length > 0) {
      console.log(
        `no-amber-q11: ${found.length} offending lines in ${files.size} files (of ${read.length} read)\n` +
          found.join("\n"),
      );
    }
    expect(found, `${found.length} amber lines in ${files.size} files`).toEqual([]);
  });

  it("keeps its one allowed word where it says it is", () => {
    for (const a of ALLOWED) {
      const text = readFileSync(join(ROOT, a.file), "utf8");
      expect(text.split("\n").some((l) => l.trim() === a.line), a.file).toBe(true);
    }
  });

  it("would catch each pattern (the check is not blind)", () => {
    expect(PATTERNS[0].re.test("bg-Amber-dark")).toBe(true);
    PATTERNS[1].re.lastIndex = 0;
    expect(PATTERNS[1].re.test("fill: #F0B429;")).toBe(true);
    PATTERNS[2].re.lastIndex = 0;
    expect(PATTERNS[2].re.test("rgb(240 180 41 / 15%)")).toBe(true);
    for (const p of PATTERNS) p.re.lastIndex = 0;
  });
});
