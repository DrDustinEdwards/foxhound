// Data layer entry point. Later phases import from "~/db".
export * from "./schema";
// Better Auth's generated tables (user/session/account/verification). Distinct
// names from our plural accounts/account_members, so no collision.
export * from "./auth-schema";
export { getDb, type Db } from "./client";
export { byAccount, byAccountActive } from "./scope";
export {
  billableRecoveryRowConditions,
  getBillableRecoveries,
} from "./billable";
export type {
  MoneyWrite,
  MoneyWriteBatch,
  MoneyWriteBuilder,
  MoneyWriteExecutor,
} from "./money-write";
