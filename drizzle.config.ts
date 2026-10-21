import { defineConfig } from "drizzle-kit";

// Migration generation only. Applying to D1 is done via
// `wrangler d1 migrations apply` (see docs/schema/README.md), not drizzle-kit push,
// so no D1 credentials live here.
export default defineConfig({
  dialect: "sqlite",
  // Business tables (schema/) + Better Auth's generated tables (auth-schema.ts,
  // owned by Better Auth's own generator). drizzle-kit merges both into one
  // migration stream applied via `wrangler d1 migrations apply`.
  schema: ["./app/db/schema/*.ts", "./app/db/auth-schema.ts"],
  out: "./drizzle/migrations",
});
