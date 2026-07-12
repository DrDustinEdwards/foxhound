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
