// Two distinct role axes (kept separate on purpose; see docs/auth/README.md):
//
//   Platform role  - admin vs merchant. Derived from the ADMIN_EMAIL allowlist,
//                    NOT stored per account. Governs /admin/* access.
//   Account role   - owner vs member, stored on account_members.role. Governs
//                    team permissions within a single merchant account.

export const MEMBER_ROLE = {
  OWNER: "owner",
  MEMBER: "member",
} as const;
export type MemberRole = (typeof MEMBER_ROLE)[keyof typeof MEMBER_ROLE];

export const MEMBER_STATUS = {
  ACTIVE: "active",
  PENDING: "pending",
} as const;
export type MemberStatus = (typeof MEMBER_STATUS)[keyof typeof MEMBER_STATUS];

/** Team invites expire after 7 days. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Parsed, normalized ADMIN_EMAIL allowlist (comma-separated). Empty => none. */
export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the email holds the platform admin role. */
export function isAdminEmail(env: Env, email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails(env).includes(email.trim().toLowerCase());
}
