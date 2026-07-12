import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { authOptions } from "./options";

// CLI-ONLY. Consumed by `@better-auth/cli generate` to emit the auth tables as a
// Drizzle schema (app/db/auth-schema.ts). Schema generation introspects the
// options + adapter provider; it never opens a D1 connection, so the adapter is
// handed a placeholder db. The runtime instance lives in auth.server.ts.
//
// Do NOT import this from application code.
export const auth = betterAuth({
  ...authOptions,
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
});
