import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";

// The single demo account (Foxhound is single-account per user, so one seeded
// account is the whole demo; the legacy two-account carousel does not apply).
// Its id carries the DEMO_ACCOUNT_ID_PREFIX so every prefix-based firewall
// (billable.ts, recovery-tick, intelligence sync/ai) excludes it automatically.
export const DEMO_ACCOUNT_ID = `${DEMO_ACCOUNT_ID_PREFIX}teamflow`;
export const DEMO_ACCOUNT_NAME = "Teamflow";

// Soft user id for the seeded demo member row (no Better Auth user backs it; the
// demo view mode injects a synthetic membership, it never signs in as this user).
export const DEMO_MEMBER_USER_ID = `${DEMO_ACCOUNT_ID_PREFIX}user_teamflow`;
export const DEMO_MEMBER_EMAIL = "demo@foxhoundapp.com";

// Cookie that marks a browser as being in read-only demo mode. Carries NO account
// id (the demo account id is the hardcoded constant above, never taken from the
// cookie), so it can only ever resolve to the demo account, never a real one.
export const DEMO_SESSION_COOKIE = "fh_demo";
export const DEMO_SESSION_COOKIE_VALUE = "1";

// The name registered in the cron registry for the daily demo-reset job, and
// the CronLock DO id both that cron and the demo enter action lock on. Shared
// so the two callers can never drift apart and silently stop excluding each
// other.
export const DEMO_RESET_CRON_NAME = "demo-reset";
