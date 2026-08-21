// The Stripe Connect OAuth `state` payload.
//
// Foxhound's first-connect flow (app/routes/auth/connect.tsx:86) uses a bare
// `crypto.randomUUID()` and the callback compares it to the cookie by string
// equality. Legacy carries a JSON object instead, because it has a second flow
// to tell apart: `app/api/stripe/connect-additional/route.ts` (blob `60f93b27`)
// builds `JSON.stringify({ csrf, action: 'add_account' })` with the comment
// "Encode action into state so the callback creates a new account", and puts the
// SAME string in both the state param and the cookie.
//
// That shape is what makes this safe to add now: the callback's CSRF check is
// `state !== cookieState` (connect-callback.ts:40), plain string equality over
// an opaque value, so a JSON payload passes through it unchanged and unread. The
// branch that PARSES this and creates a whole new account is phase (d).

/** Legacy's marker value, verbatim. */
export const ADD_ACCOUNT_ACTION = "add_account";

export interface ConnectState {
  csrf: string;
  action?: typeof ADD_ACCOUNT_ACTION;
}

/**
 * A state payload marked as a second-account connect.
 *
 * The csrf half is still a real random value doing the real job; `action` rides
 * alongside it. Serialised with an explicit key order rather than by spreading
 * an object, so the string the cookie holds and the string the URL carries are
 * produced by one expression and cannot drift.
 */
export function buildAddAccountState(csrf: string): string {
  return JSON.stringify({ csrf, action: ADD_ACCOUNT_ACTION });
}

/**
 * Read a state payload back, tolerating the bare-uuid form.
 *
 * Phase (d)'s callback branch is the real consumer. It exists here so the shape
 * has one definition rather than two, and so a test can assert the marker
 * without re-implementing the parse. A non-JSON state (every first-connect flow
 * today) yields `{ csrf: <the raw string> }` with no action, which is the honest
 * reading of a payload that predates this format.
 */
export function parseConnectState(state: string): ConnectState {
  try {
    const parsed = JSON.parse(state) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as ConnectState).csrf === "string") {
      const { csrf, action } = parsed as ConnectState;
      return action === ADD_ACCOUNT_ACTION ? { csrf, action } : { csrf };
    }
  } catch {
    // Not JSON: the bare-uuid form.
  }
  return { csrf: state };
}
