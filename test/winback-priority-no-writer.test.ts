// The Intelligence FAQ and the Platform guide say "Nothing in Foxhound flags a
// customer as a win-back priority yet" (INTELLIGENCE_WINBACK_SENTENCE in
// app/lib/marketing/winback-copy.ts). That is true only while no code writes
// health_factors.recommended_action = "winback_priority".
//
// This test scans app/, mcp/ and scripts/ with comments stripped and counts
// two things per file in CODE:
//   * the value: `winback_priority` or its constant WINBACK_PRIORITY_ACTION;
//   * the key: `recommended_action` (snake_case, whole word), because a writer
//     can set the key from a variable without ever naming the value.
// Each count is pinned to the exact number of known mentions: constants.ts
// defines the value, process.ts imports and compares it and reads the key.
// Any other mention anywhere, including an extra one inside those two files,
// fails. A file is never exempt as a whole.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["app", "mcp", "scripts"];
const CODE = /\.(ts|tsx|js|mjs|cjs|sql)$/;
// Prose and data under app/ too (there are none today, so this costs nothing).
const APP_EXTRA = /\.(json|md)$/;

const VALUE = /winback_priority|WINBACK_PRIORITY_ACTION/g;
const KEY = /\brecommended_action\b/g;

/** Exact code mentions allowed. Anything not listed must have zero. */
const EXPECTED_VALUE: Record<string, number> = {
  // `export const WINBACK_PRIORITY_ACTION = "winback_priority";`
  "app/lib/constants.ts": 2,
  // the import, and `recommendation === WINBACK_PRIORITY_ACTION`
  "app/lib/webhooks/lookups.ts": 2,
};
const EXPECTED_KEY: Record<string, number> = {
  // the read: `{ recommended_action?: string }` and `?.recommended_action`
  "app/lib/webhooks/lookups.ts": 2,
};

const MESSAGE =
  "If this is a writer, INTELLIGENCE_WINBACK_SENTENCE (app/lib/marketing/winback-copy.ts), which the Intelligence FAQ " +
  'and the /docs/platform win-back paragraph both use, says "Nothing in Foxhound flags a customer as a win-back ' +
  'priority yet" and must change too. If it is only a new reader, update the pinned count here.';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else {
      const rel = path.split("\\").join("/");
      if (CODE.test(name) || (rel.startsWith("app/") && APP_EXTRA.test(name))) out.push(rel);
    }
  }
  return out;
}

/** Text with comments removed: JS block and line comments, and `--` lines only in .sql. */
function withoutComments(path: string, text: string): string {
  if (/\.(json|md)$/.test(path)) return text;
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  if (path.endsWith(".sql")) out = out.replace(/--.*$/gm, "");
  return out;
}

function counts(files: string[], read: (path: string) => string, re: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of files) {
    const n = (withoutComments(f, read(f)).match(re) ?? []).length;
    if (n > 0) found[f] = n;
  }
  return found;
}

const FILES = ROOTS.flatMap((root) => walk(root));
const readReal = (f: string) => readFileSync(f, "utf8");

describe("nothing writes winback_priority, so the copy's \"nothing flags a customer\" stays true", () => {
  it("scans a real file set", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain("app/lib/webhooks/lookups.ts");
  });

  it("the value is named in code exactly where it is defined and read, and nowhere else", () => {
    expect(counts(FILES, readReal, VALUE), `winback_priority is named in code somewhere new. ${MESSAGE}`).toEqual(
      EXPECTED_VALUE,
    );
  });

  it("the recommended_action key is named in code only by lookups.ts's read", () => {
    expect(counts(FILES, readReal, KEY), `recommended_action is named in code somewhere new. ${MESSAGE}`).toEqual(
      EXPECTED_KEY,
    );
  });

  it("comments do not count; code does; SQL comments are stripped only in .sql", () => {
    const src: Record<string, string> = {
      "a.ts": "// winback_priority and recommended_action in a comment\nconst x = 1;",
      "b.ts": "const flag = pick();\nset({ recommended_action: flag });",
      "c.sql": "-- recommended_action in a SQL comment\nSELECT 1;",
      "d.ts": "const s = x -- recommended_action;",
    };
    const files = Object.keys(src);
    expect(counts(files, (f) => src[f], KEY)).toEqual({ "b.ts": 1, "d.ts": 1 });
  });
});
