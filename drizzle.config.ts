import { defineConfig } from "drizzle-kit";

// Migration generation only. Applying to D1 is done via
// `wrangler d1 migrations apply` (see docs/schema/README.md), not drizzle-kit push,
// so no D1 credentials live here.
export default defineConfig({
  dialect: "sqlite",
  schema: "./app/db/schema.ts",
  out: "./drizzle/migrations",
});
