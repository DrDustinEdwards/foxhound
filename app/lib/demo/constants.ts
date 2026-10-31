import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";

// The demo businesses. Legacy seeded two (lib/constants.ts DEMO_ACCOUNTS, blob
// `a21b32b8`: Teamflow and Bolt Analytics) and let a visitor switch between
// them from the account switcher; Foxhound does the same. Each id carries the
// DEMO_ACCOUNT_ID_PREFIX so every prefix-based firewall (billable.ts,
// recovery-tick, intelligence sync/ai) excludes it automatically.
//
// `idPrefix` starts every seeded row's id for that business, so the two
// businesses' rows never share a primary key. Teamflow keeps the "d" ids it
// always had; Bolt's rows start "dbolt_".
export interface DemoBusiness {
  accountId: string;
  name: string;
  /** Soft user id for the seeded member row (no Better Auth user backs it; the
   *  demo view mode injects a synthetic membership, it never signs in). */
  memberUserId: string;
  stripeUserId: string;
  idPrefix: string;
}

export const DEMO_ACCOUNT_ID = `${DEMO_ACCOUNT_ID_PREFIX}teamflow`;
const DEMO_ACCOUNT_NAME = "Teamflow";
const DEMO_MEMBER_USER_ID = `${DEMO_ACCOUNT_ID_PREFIX}user_teamflow`;

export const DEMO_BOLT_ACCOUNT_ID = `${DEMO_ACCOUNT_ID_PREFIX}bolt`;
const DEMO_BOLT_ACCOUNT_NAME = "Bolt Analytics";

export const TEAMFLOW_DEMO: DemoBusiness = {
  accountId: DEMO_ACCOUNT_ID,
  name: DEMO_ACCOUNT_NAME,
  memberUserId: DEMO_MEMBER_USER_ID,
  stripeUserId: "acct_demo_teamflow",
  idPrefix: "d",
};

export const BOLT_DEMO: DemoBusiness = {
  accountId: DEMO_BOLT_ACCOUNT_ID,
  name: DEMO_BOLT_ACCOUNT_NAME,
  memberUserId: `${DEMO_ACCOUNT_ID_PREFIX}user_bolt`,
  stripeUserId: "acct_demo_bolt",
  idPrefix: "dbolt_",
};

/** Legacy's order: Teamflow first, so a visitor who has not switched sees it. */
export const DEMO_BUSINESSES: readonly DemoBusiness[] = [TEAMFLOW_DEMO, BOLT_DEMO];

// Both demo businesses share the one sample member address.
export const DEMO_MEMBER_EMAIL = "demo@foxhoundapp.com";

// Cookie that marks a browser as being in read-only demo mode. Carries NO account
// id, so on its own it can only ever resolve to a demo account, never a real one.
export const DEMO_SESSION_COOKIE = "__Host-fh_demo";
export const DEMO_SESSION_COOKIE_VALUE = "1";

// Which demo business the visitor last switched to: legacy's
// `active_demo_account` cookie (app/api/demo/switch-account/route.ts, blob
// `f6786c87`). Its value is only ever matched against DEMO_BUSINESSES, so a
// forged value falls back to Teamflow rather than naming any other account.
export const DEMO_ACTIVE_ACCOUNT_COOKIE = "__Host-fh_demo_account";

// The name registered in the cron registry for the daily demo-reset job, and
// the CronLock DO id both that cron and the demo enter action lock on. Shared
// so the two callers can never drift apart and silently stop excluding each
// other.
export const DEMO_RESET_CRON_NAME = "demo-reset";
