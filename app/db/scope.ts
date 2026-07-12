import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

// Account scoping by construction. Tenant queries pass their table's account_id
// column through byAccount(); nothing queries a tenant table without a scope.
// (ARCHITECTURE.md: account_id scoping on every tenant table.)

/** account_id = :accountId */
export function byAccount(accountIdColumn: SQLiteColumn, accountId: string): SQL {
  return eq(accountIdColumn, accountId);
}

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
