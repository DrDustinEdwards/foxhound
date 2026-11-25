import { AUDIT_TOKEN_TTL_SECONDS, STRIPE_AUDIT_SCOPE } from "~/lib/stripe/constants";

// What the free audit's Stripe access is, in the words every surface uses. Stripe gives read_only only to Extensions, so the audit
// asks for read_write (STRIPE_AUDIT_SCOPE), Foxhound only reads with it, and revokes it when AUDIT_TOKEN_TTL_SECONDS ends unless the
// Stripe account is connected to a Foxhound account (app/lib/audit/grant-revoke.server.ts). Both come from the constants. Kept apart
// from audit-copy.ts so a component can import it without the /product/audit copy.

export const AUDIT_GRANT_MINUTES = Math.round(AUDIT_TOKEN_TTL_SECONDS / 60);

export const AUDIT_SCOPE_WORDS = STRIPE_AUDIT_SCOPE.split("_").join(" and ");

export const AUDIT_ACCESS_CHIP = `Reads only, disconnects after ${AUDIT_GRANT_MINUTES} minutes`;

export const AUDIT_ACCESS_ASK = `Stripe asks for full (${AUDIT_SCOPE_WORDS}) access, because Stripe no longer offers read-only access to platforms like Foxhound.`;

export const AUDIT_ACCESS_PROMISE = `Foxhound only reads during the audit, and disconnects itself after ${AUDIT_GRANT_MINUTES} minutes unless you connect a Foxhound account.`;
