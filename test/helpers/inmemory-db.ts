import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { D1Like, D1StatementLike } from "@dustinedwards/site-api/schedules";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { Db } from "~/db";
import * as schema from "~/db/schema";
import {
  SerialMoneyCommitter,
  type CommitRequest,
  type CommitResult,
} from "~/lib/money/serializer";

// A real in-memory SQLite with the committed drizzle migrations applied verbatim,
// so cross-tenant regression tests can prove not-billable/no-write behavior
// against the actual schema (indexes, CHECK constraints, columns), not just SQL
// shape. Test-only; not a *.test file, so vitest does not run it directly.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle/migrations", import.meta.url));

/** Fresh in-memory DB per call; the raw handle is returned too so a test can
 *  run compiled `{ sql, params }` statements directly and inspect row state. */
export function createInMemoryDb(): { sqlite: Database.Database; db: Db } {
  const sqlite = new Database(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  const db = drizzle(sqlite, { schema }) as unknown as Db;

  // The better-sqlite3 driver has no `.batch()` (that is a D1 method), but
  // production code (money writes, the demo seeder) commits through it. Shim a
  // faithful equivalent: run each statement in order against the real schema,
  // exactly the SQL the D1 path would send. Drizzle statements are thenable, so
  // awaiting one executes it.
  (db as unknown as { batch: (stmts: unknown[]) => Promise<unknown[]> }).batch = async (stmts) => {
    const results: unknown[] = [];
    for (const stmt of stmts) {
      results.push(await (stmt as Promise<unknown>));
    }
    return results;
  };

  return { sqlite, db };
}

/** Run a Drizzle statement (from a builder) against the raw better-sqlite3
 *  handle by compiling it to { sql, params }: executes the EXACT SQL the
 *  production code would send. Returns the number of rows changed. */
export function runStatement(sqlite: Database.Database, statement: unknown): number {
  const { sql, params } = (statement as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
  const info = sqlite.prepare(sql).run(...(params as never[]));
  return info.changes;
}

/** A stand-in for the env.MONEY_WRITER Durable Object namespace that commits
 *  through the REAL SerialMoneyCommitter, one per partition as the DO is, and
 *  runs each batch as one transaction on the in-memory SQLite the getter
 *  returns. The getter is read per commit, so a test that reseeds a fresh
 *  database per case keeps one binding. `commits` records every request in
 *  arrival order, partition included. */
export function inMemoryMoneyWriter(sqlite: () => Database.Database) {
  const committers = new Map<string, SerialMoneyCommitter>();
  const commits: Array<{ partition: string } & CommitRequest> = [];
  const committerFor = (partition: string) => {
    let committer = committers.get(partition);
    if (!committer) {
      const seen = new Set<string>();
      committer = new SerialMoneyCommitter({
        hasSeen: async (key) => seen.has(key),
        markSeen: async (key) => {
          seen.add(key);
        },
        runBatch: async (statements) => {
          const handle = sqlite();
          handle.transaction(() => {
            for (const s of statements) handle.prepare(s.sql).run(...(s.params as never[]));
          })();
        },
      });
      committers.set(partition, committer);
    }
    return committer;
  };
  const binding = {
    idFromName: (name: string) => name,
    get: (partition: string) => ({
      commit: (request: CommitRequest): Promise<CommitResult> => {
        commits.push({ partition, ...request });
        return committerFor(partition).commit(request);
      },
    }),
  };
  return { binding, commits };
}

/** The part of a D1 binding site-api's d1ScheduledUpdates uses, over the same
 *  in-memory SQLite, so the package's own SQL runs against the migrated schema. */
export function d1Over(sqlite: Database.Database): D1Like {
  const statement = (sql: string, values: unknown[] = []): D1StatementLike => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...(values as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => sqlite.prepare(sql).run(...(values as never[])),
  });
  return { prepare: (sql) => statement(sql) };
}
