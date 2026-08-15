import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// RULING 297: the hygiene set. Two subjects.
//
// ONE, the dispatcher's header paragraph claimed only note and cancel were
// wired, which 272 made false and which survived four sessions of edits to the
// same file.
//
// TWO, the citation hygiene list. 291 ruled that a numbered citation NAMES ITS
// NUMBERING: the constants trio is CHUNKS item 17, not the volume ruling of the
// same number, which is a different subject entirely. 292 corrected what it
// believed were both sites in constants.ts. This session found a THIRD there,
// so the reference file was itself half-corrected while being cited as the
// standard, and the guard below is written to catch the next one by SHAPE
// rather than by listing today's sites.
//
// The tree is CRLF; every matcher normalizes.

const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("297 item 1: the dispatcher's header describes the wired state", () => {
  const DISPATCH = norm("app/lib/recovery/manual-actions.server.ts");

  it("the WIRED SO FAR claim is gone", () => {
    expect(DISPATCH).not.toContain("WIRED SO FAR");
    expect(DISPATCH).not.toContain("still resolve to NOT_WIRED");
  });

  it("and says what is true instead, keeping the history in one clause", () => {
    expect(DISPATCH).toContain("ALL FIVE ARE WIRED, across Sessions B through E");
  });

  it("the money-path contract no longer counts only two intents", () => {
    expect(DISPATCH).not.toContain("Both wired intents commit");
    expect(DISPATCH).toContain("Every mutating intent commits through `ManualActionCommit`");
  });
});

describe("297 item 2: the citation hygiene list", () => {
  it("EVERY item-17 citation names its numbering, measured by shape not by list", () => {
    // The guard that catches the NEXT half-corrected citation rather than
    // today's five. Every occurrence of the ambiguous phrase must be qualified
    // by the word "volume" immediately before it, which is how canon
    // distinguishes the volume ruling from the CHUNKS item.
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of [...sourceFiles("app"), ...sourceFiles("test")]) {
      if (file.endsWith("citation-hygiene-297.test.ts")) continue;
      scanned += 1;
      const text = norm(file);
      for (const m of text.matchAll(/ruling 17\b/g)) {
        const before = text.slice(Math.max(0, m.index - 7), m.index);
        if (!before.endsWith("volume ")) offenders.push(`${file}:${m.index}`);
      }
    }
    // Paired count check: a content assertion that can pass by reading nothing
    // is the failure mode conventions names, so the population is asserted too.
    expect(scanned).toBeGreaterThan(300);
    expect(offenders).toEqual([]);
  });

  it("the corrected sites cite the CHUNKS item explicitly", () => {
    expect(norm("app/lib/ai/cost.ts")).toContain("restored by parity CHUNKS item 17");
    expect(norm("app/lib/constants.ts")).toContain("is 15 since CHUNKS item 17 restored");
    expect(norm("test/ai-cost.test.ts")).toContain("CHUNKS item 17 no-undercount policy");
    expect(norm("test/cron-null-token-retry.test.ts")).toContain("when CHUNKS item 17 restored");
  });

  it("the file is renamed and NOTHING still points at the old name", () => {
    expect(existsSync("test/constants-chunks-17.test.ts")).toBe(true);
    expect(existsSync("test/constants-ruling-17.test.ts")).toBe(false);
    // This file is skipped for the same reason the shape guard skips it: it
    // NAMES the old path in the existsSync above, so a bare scan matches its
    // own assertion rather than a stale pointer. Caught by the first run.
    let scanned = 0;
    for (const file of [...sourceFiles("app"), ...sourceFiles("test")]) {
      if (file.endsWith("citation-hygiene-297.test.ts")) continue;
      scanned += 1;
      expect(norm(file)).not.toContain("constants-ruling-17");
    }
    expect(scanned).toBeGreaterThan(300);
  });

  it("REGRESSION GUARD: 292's two constants.ts corrections still stand", () => {
    // These predate this session. If a later edit reverts them the guard above
    // would also fire, but naming them separately keeps the earlier fix from
    // being silently absorbed into this one.
    const C = norm("app/lib/constants.ts");
    expect(C).toContain('"item 17" here is CHUNKS item 17, the constants trio');
    expect(C).toContain("both restored by parity CHUNKS item 17");
  });
});
