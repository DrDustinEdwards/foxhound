import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// RULING 312 build B: the placeholder purge.
//
// 311 measured 22 files under workers/crons, workers/webhooks and workers/queues
// that were EACH a single line holding a TODO comment. They shadowed the real
// implementations, which live in app/lib/cron/registry.ts, app/routes/webhooks/
// and workers/app.ts, and they had already misled two sessions: Session 19
// reported "no process-disputes cron exists" and Session 21 had to correct that
// to "the file exists, unwired", when the truth was that the file was a comment.
//
// This guard is about the CLASS, not those 22 names. It fails if a
// single-line TODO placeholder reappears anywhere under workers/, which is the
// only way the same confusion returns.

const PURGED_DIRS = ["workers/crons", "workers/webhooks", "workers/queues"];

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("312 build B: the placeholder directories are gone", () => {
  it("none of the three purged directories exists", () => {
    for (const dir of PURGED_DIRS) {
      expect(existsSync(dir), `${dir} came back`).toBe(false);
    }
  });

  it("workers/ still holds the REAL modules, so the purge did not overreach", () => {
    // Calibrated before use (239): if this control ever went empty, the guard
    // above would pass against a deleted workers/ tree.
    const files = tsFilesUnder("workers").map((f) => f.replace(/\\/g, "/"));
    expect(files).toEqual(
      expect.arrayContaining([
        "workers/app.ts",
        "workers/cron-lock.ts",
        "workers/money-writer.ts",
        "workers/rate-limiter.ts",
      ]),
    );
  });

  it("THE CLASS GUARD: no single-line TODO placeholder anywhere under workers/", () => {
    // What actually caused the confusion was not the directory names, it was a
    // file that looks like a module and is a comment. This catches the next one
    // wherever it lands.
    const offenders = tsFilesUnder("workers").filter((f) => {
      const body = readFileSync(f, "utf8").trim();
      return body.split("\n").length === 1 && body.startsWith("// TODO");
    });
    expect(offenders).toEqual([]);
  });
});
