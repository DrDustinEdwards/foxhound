import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { describe, expect, it } from "vitest";

import * as authSchema from "~/db/auth-schema";
import { authOptions } from "~/lib/auth/options";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-email-provisioning.md: exercises the real Better Auth call
// signup.tsx and forgot-password.tsx actually make, against a real in-memory
// instance built the same way auth.server.ts's buildAuth does, and asserts
// on the exact url handed to sendVerificationEmail/sendResetPassword - the
// string that becomes the link in the email - rather than reasoning about
// what the framework should do.
function buildTestAuth(captured: { verify: string | null; reset: string | null }) {
  const { db } = createInMemoryDb();
  return betterAuth({
    ...authOptions,
    baseURL: "https://foxhoundapp.com",
    secret: "test-secret-not-real",
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    emailAndPassword: {
      ...authOptions.emailAndPassword,
      sendResetPassword: async ({ url }) => {
        captured.reset = url;
      },
    },
    emailVerification: {
      ...authOptions.emailVerification,
      sendVerificationEmail: async ({ url }) => {
        captured.verify = url;
      },
    },
  });
}

describe("auth email links carry the real app's redirect, not Better Auth's default", () => {
  it("signup's verification link carries callbackURL=/login?verified=1", async () => {
    const captured = { verify: null as string | null, reset: null as string | null };
    const auth = buildTestAuth(captured);

    await auth.api.signUpEmail({
      body: {
        name: "Verify Test",
        email: "verify-link-test@example.com",
        password: "Verify-link-test-2026!",
        callbackURL: "/login?verified=1",
      },
      asResponse: true,
    });

    expect(captured.verify).not.toBeNull();
    expect(captured.verify).toContain("callbackURL=%2Flogin%3Fverified%3D1");
  });

  it("password reset's link carries redirectTo=/reset-password", async () => {
    const captured = { verify: null as string | null, reset: null as string | null };
    const auth = buildTestAuth(captured);

    await auth.api.signUpEmail({
      body: { name: "Reset Test", email: "reset-link-test@example.com", password: "Reset-link-test-2026!" },
      asResponse: true,
    });
    await auth.api.requestPasswordReset({
      body: { email: "reset-link-test@example.com", redirectTo: "/reset-password" },
    });

    expect(captured.reset).not.toBeNull();
    expect(captured.reset).toContain("callbackURL=%2Freset-password");
  });
});
