import Database from "better-sqlite3";
import { hitRules } from "@dustinedwards/site-runtime/rate-limit";

type Rule = { limit: number; windowSeconds: number };

/** A DurableObjectNamespace whose instances count with site-runtime's own
 *  hitRules on real SQLite: same name, same database; a different name, a
 *  different database, as with real Durable Objects. `now` is the clock. */
export function makeRateLimiterNamespace(now: () => number = () => Date.now()) {
  const dbs = new Map<string, Database.Database>();
  const names: string[] = [];
  const sqlFor = (db: Database.Database) => ({
    exec: (query: string, ...bindings: unknown[]) => {
      const stmt = db.prepare(query);
      const rows = stmt.reader ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows as unknown[] };
    },
  });
  return {
    names,
    idFromName: (name: string) => {
      names.push(name);
      return name;
    },
    get: (id: string) => ({
      hit: async (rules: Rule[]) => {
        let db = dbs.get(id);
        if (!db) {
          db = new Database(":memory:");
          dbs.set(id, db);
        }
        return hitRules(sqlFor(db), rules, now());
      },
    }),
  };
}
