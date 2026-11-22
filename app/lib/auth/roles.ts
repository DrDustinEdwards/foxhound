// Two distinct role axes (kept separate on purpose; see docs/auth/README.md):
//
//   Platform role  - admin vs merchant. Derived from ADMIN_EMAIL and CO_OWNER_EMAILS,
//                    NOT stored per account. Governs /admin/* access.
//   Account role   - owner vs member, stored on account_members.role. Governs
//                    team permissions within a single merchant account.

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
// accounts.

/** Team invites expire after 7 days. */
export const INVITE_TTL_MS = 7 * DAY_MS;

// isAdminEmail (site-runtime/access): true when the email is ADMIN_EMAIL (the
// main admin) or on CO_OWNER_EMAILS, as site-runtime's admin roster reads them.
