// The Intelligence FAQ and the Platform guide say "Nothing in Foxhound flags a
// customer as a win-back priority yet" (INTELLIGENCE_WINBACK_SENTENCE in
// app/lib/marketing/winback-copy.ts). That is true only while no code writes
// recommended_action = "winback_priority". This test scans app/, mcp/ and
// scripts/ with comments stripped and fails on any mention of the value or its
// constant outside the files that define it, read it, or describe it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["app", "mcp", "scripts"];
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|sql)$/;
const ALLOWED = new Set([
  "app/lib/constants.ts", // defines WINBACK_PRIORITY_ACTION
  "app/lib/webhooks/process.ts", // reads it: the win-back gate
  "app/lib/recovery/winback.ts", // the planner that takes the gate's offset
  "app/lib/marketing/winback-copy.ts", // describes it
  "app/lib/marketing/intelligence-copy.ts", // describes it
]);
const MARKER = /winback_priority|WINBACK_PRIORITY_ACTION/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (EXTENSIONS.test(name)) out.push(path.split("\\").join("/"));
  }
  return out;
}

/** Source text with block, line and SQL comments removed. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/^\s*--.*$/gm, "");
}

function offenders(files: string[], read: (path: string) => string): string[] {
  return files.filter((f) => !ALLOWED.has(f) && MARKER.test(withoutComments(read(f))));
}

const FILES = ROOTS.flatMap((root) => walk(root));

describe("nothing writes winback_priority, so the copy's \"nothing flags a customer\" stays true", () => {
  it("scans a real file set", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain("app/lib/webhooks/process.ts");
  });

  it("no source outside the allowed readers and copy names winback_priority", () => {
    const found = offenders(FILES, (f) => readFileSync(f, "utf8"));
    expect(
      found,
      "A source now names winback_priority, so something may flag customers as a win-back priority. If it writes the flag, " +
        "INTELLIGENCE_WINBACK_SENTENCE (app/lib/marketing/winback-copy.ts), which the Intelligence FAQ and the /docs/platform " +
        "win-back paragraph both use, says \"Nothing in Foxhound flags a customer as a win-back priority yet\" and must change too.",
    ).toEqual([]);
  });

  it("a comment mentioning it does not count, code does", () => {
    const read = (f: string) =>
      f === "a.ts" ? "// winback_priority in a comment\nconst x = 1;" : 'set({ recommended_action: "winback_priority" })';
    expect(offenders(["a.ts", "b.ts"], read)).toEqual(["b.ts"]);
  });
});
