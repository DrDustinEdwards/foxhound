import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KNOWN_MIGRATIONS } from "~/lib/admin/operations.server";

// KNOWN_MIGRATIONS is hand-maintained (the Worker has no filesystem at runtime),
// and it had drifted four behind: it stopped at 0005 while the schema was at
// 0009, so /admin/operations under-reported the schema state on the page that is
// treated as the authoritative answer for it.
//
// This asserts the list against the migrations actually on disk, so the next
// migration that ships without updating it fails CI. Deriving the expectation
// from the directory rather than from a second hand-written list is the point: a
// coverage test whose expected set comes from the thing under test proves nothing.

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

  // drizzle-kit's journal is the authoritative ORDER. Filename sort and journal
  // order agree today; if a future migration breaks that, this catches it rather
  // than letting /admin/operations render a misleading sequence.
  it("agrees with the drizzle journal's order", () => {
    const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as { entries: { idx: number; tag: string }[] };
    const journalOrder = [...journal.entries]
      .sort((a, b) => a.idx - b.idx)
      .map((e) => `${e.tag}.sql`);
    expect([...KNOWN_MIGRATIONS]).toEqual(journalOrder);
  });

  it("has no duplicates", () => {
    expect(new Set(KNOWN_MIGRATIONS).size).toBe(KNOWN_MIGRATIONS.length);
  });
});
