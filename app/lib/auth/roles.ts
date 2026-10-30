// Two distinct role axes (kept separate on purpose; see docs/auth/README.md):
//
//   Platform role  - admin vs merchant. Derived from the ADMIN_EMAIL allowlist,
//                    NOT stored per account. Governs /admin/* access.
//   Account role   - owner vs member, stored on account_members.role. Governs
//                    team permissions within a single merchant account.

import { adminEmails } from "@dustinedwards/site-runtime/access";
import { DAY_MS } from "~/lib/constants";

export const MEMBER_ROLE = {
  OWNER: "owner",
  MEMBER: "member",
} as const;

export const MEMBER_STATUS = {
  ACTIVE: "active",
  PENDING: "pending",
} as const;

// NOTE: the partial unique index is account_members_user_account_active_uq
// (migration 0018), over (user_id, account_id) WHERE status = 'active', so a
// user holds at most one ACTIVE membership PER ACCOUNT and may hold many
// accounts. It replaced account_members_one_active_per_user_uq, which was over
// (user_id) alone and is what ruling 324 struck.
//
// The warning that came with the old index still applies, narrowed: a "leave
// account" or member-removal feature MUST move the row off status='active'
// (delete it, or add and set a non-active status here), or a user who leaves an
// account can never be re-invited to THAT account. It no longer pins them to
// their first account, which is what the old shape did.

/** Team invites expire after 7 days. */
export const INVITE_TTL_MS = 7 * DAY_MS;

/** The ADMIN_EMAIL allowlist, parsed by site-runtime (comma-separated). Empty => none. */
export { adminEmails };

/** True when the email holds the platform admin role. */
export function isAdminEmail(env: Env, email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails(env).includes(email.trim().toLowerCase());
}
