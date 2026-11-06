import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, magicLink } from "better-auth/plugins";

import { authOptions } from "./options";

// CLI-ONLY. Consumed by `@better-auth/cli generate` to emit the auth tables as a
// Drizzle schema (app/db/auth-schema.ts). Schema generation introspects the
// options + adapter provider; it never opens a D1 connection, so the adapter is
// handed a placeholder db. The runtime instance lives in auth.server.ts. The
// family sign-in's tables come from its two plugins with tables (passkey; the
// magic link's tokens and the email OTP's codes use `verification`) and its
// database rate limit.
//
// Do NOT import this from application code.
export const auth = betterAuth({
  ...authOptions,
  // site-runtime's sessionDetails columns (SESSION_DETAILS_SQL), which its
  // options add at runtime (withSignIn), so the generated session table keeps them.
  session: {
    ...authOptions.session,
    additionalFields: {
      ...authOptions.session.additionalFields,
      location: { type: "string", required: false, input: false },
      deviceId: { type: "string", required: false, input: false, returned: false },
    },
  },
  plugins: [magicLink({ sendMagicLink: () => {} }), emailOTP({ sendVerificationOTP: async () => {} }), passkey()],
  rateLimit: { enabled: true, storage: "database" },
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
});
