import { and, count, eq, isNull, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Db } from "./client";

/**
 * account_id = :accountId AND deleted_at IS NULL. Use on tables that carry a
 * soft-delete column (failed_payments, recovery_steps, recovered_payments, etc.).
 */
export function byAccountActive(
  accountIdColumn: SQLiteColumn,
  deletedAtColumn: SQLiteColumn,
  accountId: string,
): SQL {
  const cond = and(eq(accountIdColumn, accountId), isNull(deletedAtColumn));
  // and() of two defined conditions is always defined
  return cond as SQL;
}

/** count(*) of a table's rows matching `where` (all rows when omitted). */
export async function countRows(db: Db, from: SQLiteTable, where?: SQL): Promise<number> {
  return (await db.select({ n: count() }).from(from).where(where))[0]?.n ?? 0;
}
