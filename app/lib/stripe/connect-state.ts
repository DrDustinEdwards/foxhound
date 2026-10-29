// The Stripe Connect OAuth `state` payload, and the one place that decides
// whether a callback's state is trustworthy.
//
// ONE SHAPE FOR ALL THREE FLOWS: `{nonce, action}`, plus `uid` on the two
// merchant flows, where action is "connect", "add_account" (ruling 329 phase
// (d)) or "audit" (phase (f), 362 ruling 1).
// The third arrived with the anonymous audit pair and cost this module one
// constant and one array entry, which is what "reuse the minted state shape with
// a new action" was supposed to cost. Legacy carries the same idea and the
// same marker spelling in app/api/stripe/connect-additional/route.ts (blob
// `60f93b27`), which builds `{ csrf, action: 'add_account' }` with the comment
// "Encode action into state so the callback creates a new account". The field is
// named `nonce` here rather than legacy's `csrf` because it does both jobs: it
// is the CSRF token AND the mint record the callback matches against.
//
// WHERE THE MINT RECORD LIVES: the existing state cookie
// (`stripe_oauth_state`, HttpOnly, Secure, SameSite=Lax, 600s), which is set
// server-side at flow start and never readable or writable by a client. No new
// store, and none available: `env.APP_KV` was unbound at ruling 310 with zero
// consumers. The cookie holding the SAME string the URL carries is what makes
// "did we mint this?" answerable: an attacker can put anything in the query
// param and cannot put the matching value in an HttpOnly cookie.
//
// LEGACY'S FALLBACK IS DELIBERATELY NOT PORTED. Its callback accepts a bare
// non-JSON state as a plain CSRF token (`catch { csrfFromState = state }`),
// because it grew the JSON form later and had live flows to keep working. That
// branch is exactly the hole this file exists to close: an action-less state
// resolves to the DEFAULT branch, which is how legacy's own "+ Add account"
// silently upserts onto the first account (ruling 326's DEFECT 1). Foxhound
// mints every side, so it can require the strict shape.
//
// THE ONE COST, named rather than discovered: an OAuth flow started before this
// deploy and finished after it carries the old bare-uuid state and is REFUSED
// with `invalid_state`. The window is the cookie's 600 second TTL, the failure
// is safe (back to /connect with a retry), and it happens once.

/** Legacy's marker value, verbatim. */
export const ADD_ACCOUNT_ACTION = "add_account";
/** The first-connect and reconnect flow. Legacy has no name for this; it is
 *  legacy's default branch, made explicit so there is no unmarked state. */
export const CONNECT_ACTION = "connect";
/**
 * The ANONYMOUS AUDIT flow (phase (f)). Legacy has no marker for this either,
 * because legacy mints its audit state as a bare `crypto.randomUUID()` in a
 * separate route with a separate cookie and never has to tell the two apart.
 *
 * FOXHOUND MINTS ONE SHAPE FOR ALL THREE, so both callbacks can ask the same
 * question and get a name back. That is the point of adding a third action
 * rather than writing a parallel state module: the audit callback refuses
 * anything that is not "audit", and /connect/callback refuses "audit", so a
 * short-lived audit grant can never be walked into the branch that attaches a
 * connection or mints an account. With a bare uuid neither callback could tell.
 */
export const AUDIT_ACTION = "audit";

const CONNECT_ACTIONS = [CONNECT_ACTION, ADD_ACCOUNT_ACTION, AUDIT_ACTION] as const;
export type ConnectAction = (typeof CONNECT_ACTIONS)[number];

export interface ConnectState {
  nonce: string;
  action: ConnectAction;
  /** The signed-in user who started a merchant flow; null for the anonymous
   *  audit, which has no user. */
  userId: string | null;
}

function isConnectAction(value: unknown): value is ConnectAction {
  return typeof value === "string" && (CONNECT_ACTIONS as readonly string[]).includes(value);
}

/**
 * A fresh state payload for one OAuth flow.
 *
 * The caller puts the returned string in BOTH the `state` query parameter and
 * the state cookie. Serialized in one expression with an explicit key order, so
 * the two copies are produced identically and cannot drift into a mismatch that
 * would read as an attack.
 *
 * THE MERCHANT FLOWS CARRY THE USER WHO STARTED THEM, and the callback refuses a
 * state whose user is not the one signed in when it lands. The cookie alone
 * binds the flow to a browser, not to a person: a browser that changes hands
 * (sign out, sign in as someone else) within the cookie's 600 seconds would
 * otherwise finish the first person's grant on the second person's account.
 */
export function buildConnectState(action: ConnectAction, userId: string | null = null): string {
  const nonce = crypto.randomUUID();
  return JSON.stringify(userId === null ? { nonce, action } : { nonce, action, uid: userId });
}

/**
 * Parse a state payload, STRICTLY. Returns null for anything that is not the
 * exact shape: not JSON, no nonce, no action, or an action outside the three.
 *
 * Null means refuse. It never falls back to treating the raw string as a nonce,
 * and it never defaults a missing action, because both of those are ways an
 * unmarked state ends up running the add-account or the attach branch by
 * accident rather than by intent.
 */
export function parseConnectState(raw: string): ConnectState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { nonce, action, uid } = parsed as { nonce?: unknown; action?: unknown; uid?: unknown };
  if (typeof nonce !== "string" || nonce.length === 0) return null;
  if (!isConnectAction(action)) return null;
  if (uid !== undefined && (typeof uid !== "string" || uid.length === 0)) return null;
  return { nonce, action, userId: uid ?? null };
}

/**
 * The callback's whole trust decision, in one function so it cannot be done
 * differently in two places.
 *
 * Returns the state ONLY when: both sides are present, they are byte-identical
 * (so this state was minted by us, in this browser, within the cookie's TTL),
 * and the payload parses to a known action. The merchant callback then holds
 * its `userId` to the signed-in user, once it has a session to compare with. Anything else is null, and the
 * caller refuses BEFORE exchanging the code or touching the database.
 *
 * The byte-identity check runs FIRST and on the raw strings, before either side
 * is parsed. Comparing parsed nonces instead would let a caller vary the action
 * while keeping the nonce, which is precisely the escalation this guards: a
 * merchant who legitimately started a "connect" flow could rewrite the query
 * param to "add_account" and get a whole new account minted. The audit action
 * makes the same question worth asking in the other direction, and each callback
 * asks it: /connect/callback refuses "audit", /audit/callback refuses the other
 * two, so neither grant can be spent on the other's branch.
 */
export function verifyConnectState(
  stateParam: string | null,
  cookieState: string | null,
): ConnectState | null {
  if (!stateParam || !cookieState) return null;
  if (stateParam !== cookieState) return null;
  return parseConnectState(stateParam);
}
