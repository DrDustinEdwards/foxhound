// Foxhound D1 schema (Drizzle, SQLite dialect), governed by SCHEMA.md (Capsid, namespace foxhound). Conventions: ids are text uuids from crypto.randomUUID(); timestamps are integer epoch ms (mode 'timestamp_ms'); booleans integer 0/1; json and arrays text (mode 'json'); money is integer cents, always paired with a currency column in the same row; enums defined by the product are CHECK constraints, other text columns stay plain text. Every tenant table carries account_id + an index. Better Auth owns user/session/account(singular)/verification; user_id columns here are soft references. One module per domain; every table is re-exported here, so "~/db/schema" stays the one import path.

export * from "./tenancy";
export * from "./oauth";
export * from "./recovery";
export * from "./email";
export * from "./billing";
export * from "./disputes";
export * from "./intelligence";
export * from "./audit";
export * from "./platform";
export * from "./content";
export * from "./media";
