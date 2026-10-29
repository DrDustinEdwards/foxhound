import { AUDIT_TOKEN_TTL_SECONDS, STRIPE_AUDIT_SCOPE } from "~/lib/constants";

// What the free audit's Stripe access is, in the words every surface uses
// (2026-10-29). Stripe gives read_only only to Extensions, so the audit asks for
// read_write (STRIPE_AUDIT_SCOPE), Foxhound only reads with it, and Foxhound
// revokes it when AUDIT_TOKEN_TTL_SECONDS ends unless the Stripe account is
// connected to a Foxhound account (app/lib/audit/grant-revoke.server.ts). Both
// facts come from the constants, never typed. Kept apart from audit-copy.ts so
// a component can import it without the /product/audit page's copy.

/** Minutes until Foxhound disconnects itself from an audited Stripe account. */
export const AUDIT_GRANT_MINUTES = Math.round(AUDIT_TOKEN_TTL_SECONDS / 60);

/** "read_write" as a reader says it: "read and write". */
export const AUDIT_SCOPE_WORDS = STRIPE_AUDIT_SCOPE.split("_").join(" and ");

/** The short form, for a line of chips. */
export const AUDIT_ACCESS_CHIP = `Reads only, disconnects after ${AUDIT_GRANT_MINUTES} minutes`;

/** What Stripe asks for, and why. */
export const AUDIT_ACCESS_ASK = `Stripe asks for full (${AUDIT_SCOPE_WORDS}) access, because Stripe no longer offers read-only access to platforms like Foxhound.`;

/** What Foxhound does with it. */
export const AUDIT_ACCESS_PROMISE = `Foxhound only reads during the audit, and disconnects itself after ${AUDIT_GRANT_MINUTES} minutes unless you connect a Foxhound account.`;
