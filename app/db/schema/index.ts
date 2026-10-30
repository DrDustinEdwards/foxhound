// Foxhound D1 schema (Drizzle, SQLite dialect).
//
// Design governed by SCHEMA.md (Capsid, namespace foxhound); column truth cross-checked against the
// legacy database schema (docs/schema/legacy-map.md). Conventions:
//   - ids: text (uuid string), app-generated via crypto.randomUUID()
//   - timestamps: integer epoch ms (mode: 'timestamp_ms' -> Date in TS)
//   - booleans: integer 0/1 (mode: 'boolean')
//   - json / arrays: text (mode: 'json')
//   - money: integer cents, always paired with a currency column in the same row
//   - enums (canon-defined only): CHECK constraints; legacy-valued text columns are
//     left as plain text (their value sets were not probed) per legacy-map.md.
// Every tenant table carries account_id + an index. Better Auth owns user/session/
// account(singular)/verification; user_id columns here are soft references
// (no enforced FK yet) per legacy-map.md.
//
// One module per domain; every table is re-exported here, so "~/db/schema" stays
// the one import path.

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
