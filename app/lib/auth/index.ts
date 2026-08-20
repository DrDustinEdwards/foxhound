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
  listMemberships,
  resolveActiveMembership,
  resolveMembership,
  createAccountForUser,
  getInviteByToken,
  createInvite,
  acceptInvite,
  evaluateAcceptInvite,
  normalizeInviteEmail,
  listMembers,
  type Membership,
  type InviteView,
  type AcceptInviteResult,
} from "./account";
export { authContext, type AuthContext } from "./context";
export { appShellMiddleware, adminOnlyMiddleware } from "./guards";
export {
  MCP_TOKEN_SCOPE,
  MCP_TOKEN_PREFIX,
  hashMcpToken,
  issueMcpToken,
  verifyMcpToken,
  revokeMcpToken,
  type McpTokenScope,
  type IssuedMcpToken,
  type VerifiedMcpToken,
  type IssueMcpTokenInput,
} from "./mcp-tokens";
