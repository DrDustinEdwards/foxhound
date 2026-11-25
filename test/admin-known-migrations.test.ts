import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KNOWN_MIGRATIONS } from "~/lib/admin/operations.server";

// The expectation is built from the directory, not a second hand-written list.

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

  it("the journal and the migrations directory agree, in both directions", () => {
    const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const journalFiles = [...journal.entries]
      .sort((a, b) => a.idx - b.idx)
      .map((e) => `${e.tag}.sql`);
    const onDisk = migrationFilesOnDisk();

    expect(journalFiles.filter((f) => !onDisk.includes(f))).toEqual([]); // journal entry, no file
    expect(onDisk.filter((f) => !journalFiles.includes(f))).toEqual([]); // file, no journal entry
    expect(onDisk.length).toBeGreaterThan(0);
    expect(journalFiles).toHaveLength(onDisk.length);
  });
});
