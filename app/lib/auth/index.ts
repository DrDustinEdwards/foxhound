// Auth module entry point. Application code imports from "~/lib/auth".
export { getAuth } from "./auth.server";
export {
  authOptions,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  MIN_PASSWORD_LENGTH,
} from "./options";
export { getSession, type SessionResult } from "./session";
export {
  MEMBER_ROLE,
  MEMBER_STATUS,
  INVITE_TTL_MS,
  adminEmails,
  isAdminEmail,
  type MemberRole,
  type MemberStatus,
} from "./roles";
export {
  resolveMembership,
  createAccountForUser,
  getInviteByToken,
  createInvite,
  acceptInvite,
  listMembers,
  type Membership,
  type InviteView,
  type AcceptInviteResult,
} from "./account";
export { authContext, type AuthContext } from "./context";
export { appShellMiddleware, adminOnlyMiddleware } from "./guards";
