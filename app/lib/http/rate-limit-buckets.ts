/**
 * The audit OAuth pair's IP rate limit: 10 per hour, applied to the start and
 * the callback.
 */
export const RATE_LIMIT_AUDIT = { max: 10, windowMs: 60 * 60 * 1000 } as const;
/** The team invite's IP rate limit: 5 per hour on `invite:{ip}`. */
export const RATE_LIMIT_INVITE = { max: 5, windowMs: 60 * 60 * 1000 } as const;

/**
 * The unsubscribe page's IP rate limit: 10 requests per 60 seconds per IP, on
 * its own bucket.
 */
export const RATE_LIMIT_UNSUBSCRIBE = { max: 10, windowMs: 60 * 1000 } as const;

/**
 * The admin API's authenticated bucket, keyed on the api_keys row id. 120 per
 * minute: an agent fans out several tool calls per turn and a read-only surface
 * has no write to serialize, yet a runaway loop is capped within a minute.
 * Keyed on the key, not the IP, because the caller is the credential.
 */
export const RATE_LIMIT_MCP = { max: 120, windowMs: 60 * 1000 } as const;
/**
 * The merchant MCP endpoint's unauthenticated bucket, keyed on cf-connecting-ip
 * and spent only when authentication FAILS: 20 per minute, matching the
 * `public` bucket. Not spent on successful requests, which would break a team
 * behind one NAT for no gain (each agent is bounded by its own key bucket).
 */
export const RATE_LIMIT_MCP_ANON = { max: 20, windowMs: 60 * 1000 } as const;

/** OAuth limits: approve is per signed-in user, token and revoke per IP. */
export const RATE_LIMIT_OAUTH_APPROVE = { max: 20, windowMs: 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_TOKEN = { max: 30, windowMs: 60 * 1000 } as const;
/**
 * Registration: site-runtime's registrationLimited numbers, the limit every
 * family MCP door runs: five an hour from one address (every registration),
 * thirty a day from everyone (allowlisted only).
 */
export const RATE_LIMIT_OAUTH_REGISTER = { max: 5, windowMs: 60 * 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_REGISTER_DAILY = { max: 30, windowMs: 24 * 60 * 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_REVOKE = { max: 30, windowMs: 60 * 1000 } as const;
