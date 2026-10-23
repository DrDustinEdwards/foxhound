import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KNOWN_MIGRATIONS } from "~/lib/admin/operations.server";

// KNOWN_MIGRATIONS WAS hand-maintained and failed twice: it drifted four behind
// in July (stopping at 0005 against a schema at 0009, so /admin/operations
// under-reported schema state on the page treated as the authoritative answer
// for it), and it went red again at 316 when 0017 shipped. Under 317 it is now
// DERIVED from drizzle's own `meta/_journal.json`, which drizzle-kit rewrites on
// every generate.
//
// WHAT THAT CHANGES ABOUT THIS FILE, stated rather than left misleading: the old
// "agrees with the drizzle journal's order" assertion is now TAUTOLOGICAL, since
// the journal is the source. It is replaced below by the two checks the journal
// cannot make about itself (a .sql on disk with no journal entry, or a journal
// entry whose file is missing) plus a guard that the list stays derived.
//
// The expectation is still built from the DIRECTORY rather than a second
// hand-written list: a coverage test whose expected set comes from the thing
// under test proves nothing.

const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/migrations", import.meta.url));
const JOURNAL = fileURLToPath(new URL("../drizzle/migrations/meta/_journal.json", import.meta.url));

function migrationFilesOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

describe("KNOWN_MIGRATIONS tracks the migrations directory", () => {
  it("lists every migration file on disk, in order", () => {
    expect([...KNOWN_MIGRATIONS]).toEqual(migrationFilesOnDisk());
  });

  it("lists nothing that does not exist on disk", () => {
    const onDisk = new Set(migrationFilesOnDisk());
    const phantom = KNOWN_MIGRATIONS.filter((m) => !onDisk.has(m));
    expect(phantom).toEqual([]);
  });

  // NOT a comparison of KNOWN_MIGRATIONS to the journal: that is now definitional
  // and would pass by construction. This is the journal against the DIRECTORY,
  // which is the pair that can actually disagree, and it fails in both
  // directions: a .sql added by hand without drizzle-kit, or a journal entry
  // whose file was deleted or renamed.
  it("the journal and the migrations directory agree, in both directions", () => {
    const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as { entries: { idx: number; tag: string }[] };
    const journalFiles = [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => `${e.tag}.sql`);
    const onDisk = migrationFilesOnDisk();

    expect(journalFiles.filter((f) => !onDisk.includes(f))).toEqual([]); // journal entry, no file
    expect(onDisk.filter((f) => !journalFiles.includes(f))).toEqual([]); // file, no journal entry
    // Pair the content check with a count check, so "no disagreements" cannot
    // mean "nothing was read".
    expect(onDisk.length).toBeGreaterThan(0);
    expect(journalFiles).toHaveLength(onDisk.length);
  });

  it("has no duplicates", () => {
    expect(new Set(KNOWN_MIGRATIONS).size).toBe(KNOWN_MIGRATIONS.length);
  });
});
