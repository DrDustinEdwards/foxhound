// The Stripe Connect OAuth `state` payload, and the one place that decides whether a callback's
// state is trustworthy. WHERE THE MINT RECORD LIVES: the existing state cookie
// (`stripe_oauth_state`, HttpOnly, Secure, SameSite=Lax, 600s), which is set server-side at flow
// start and never readable or writable by a client. Its callback accepts a bare non-JSON state as a
// plain CSRF token (`catch { csrfFromState = state }`), because it grew the JSON form later and had
// live flows to keep working.

export const ADD_ACCOUNT_ACTION = "add_account";
export const CONNECT_ACTION = "connect";
/**
 * The ANONYMOUS AUDIT flow. FOXHOUND MINTS ONE SHAPE FOR ALL THREE, so both callbacks can ask the
 * same question and get a name back. That is the point of adding a third action rather than writing
 * a parallel state module: the audit callback refuses anything that is not "audit", and
 * /connect/callback refuses "audit", so a short-lived audit grant can never be walked into the
 * branch that attaches a connection or mints an account.
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
 * A fresh state payload for one OAuth flow. The caller puts the returned string in BOTH the `state`
 * query parameter and the state cookie.
 */
export function buildConnectState(action: ConnectAction, userId: string | null = null): string {
  const nonce = crypto.randomUUID();
  return JSON.stringify(userId === null ? { nonce, action } : { nonce, action, uid: userId });
}

/**
 * Parse a state payload, STRICTLY. Null means refuse. It never falls back to treating the raw
 * string as a nonce, and it never defaults a missing action, because both of those are ways an
 * unmarked state ends up running the add-account or the attach branch by accident rather than by
 * intent.
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
 * The callback's whole trust decision, in one function so it cannot be done differently in two
 * places. Returns the state ONLY when: both sides are present, they are byte-identical (so this
 * state was minted by us, in this browser, within the cookie's TTL), and the payload parses to a
 * known action.
 */
export function verifyConnectState(
  stateParam: string | null,
  cookieState: string | null,
): ConnectState | null {
  if (!stateParam || !cookieState) return null;
  if (stateParam !== cookieState) return null;
  return parseConnectState(stateParam);
}
