import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema";

// The typed Drizzle client, bound to the D1 `DB` binding. Every phase gets its
// database handle from here; nothing constructs a raw D1 query elsewhere.
export function getDb(env: Env) {
  if (!env.DB) {
    throw new Error("D1 binding 'DB' is not available in this environment");
  }
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;

/** Rows a run statement changed: D1 reports meta.changes; the test suite's
 *  better-sqlite3 driver reports changes. Anything else reads as none, so an
 *  unreadable result is never taken for a write. */
export function changedRows(result: unknown): number {
  const r = result as { meta?: { changes?: unknown }; changes?: unknown } | null;
  const n = r?.meta?.changes ?? r?.changes;
  return typeof n === "number" ? n : 0;
}
