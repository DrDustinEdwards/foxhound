import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";

import { authOptions } from "./options";

// CLI-ONLY. Consumed by `@better-auth/cli generate` to emit the auth tables as a
// Drizzle schema (app/db/auth-schema.ts). Schema generation introspects the
// options + adapter provider; it never opens a D1 connection, so the adapter is
// handed a placeholder db. The runtime instance lives in auth.server.ts. The
// family sign-in's tables come from its two plugins with tables (passkey; the
// magic link's tokens use `verification`) and its database rate limit.
//
// Do NOT import this from application code.
export const auth = betterAuth({
  ...authOptions,
  plugins: [magicLink({ sendMagicLink: () => {} }), passkey()],
  rateLimit: { enabled: true, storage: "database" },
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
});
