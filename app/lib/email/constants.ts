/** Authenticated send domain (warmed independently of Worker routing). */
const EMAIL_SEND_DOMAIN = "send.foxhoundapp.com";
/**
 * Envelope From address for merchant dunning copy (merchant display name is
 * prefixed per send).
 */
export const EMAIL_FROM_ADDRESS = `recovery@${EMAIL_SEND_DOMAIN}`;
/**
 * Authenticated domain for transactional platform mail (signup verification,
 * password reset), kept apart from EMAIL_SEND_DOMAIN so auth mail's reputation
 * never mixes with bulk dunning mail's. Never use for merchant-customer sends.
 */
const EMAIL_AUTH_DOMAIN = "auth.foxhoundapp.com";
/**
 * Envelope From address for transactional auth mail only
 * (sendTransactionalEmail); never EMAIL_FROM_ADDRESS.
 */
export const EMAIL_AUTH_SENDER_ADDRESS = `noreply@${EMAIL_AUTH_DOMAIN}`;
/**
 * Public utility path bases for CAN-SPAM one-click unsubscribe and the hosted
 * card-update page.
 */
export const UNSUBSCRIBE_PATH = "/u";
export const CARD_UPDATE_PATH = "/p";
/** Engagement tracking path bases (first-party open pixel + click redirect). */
export const ENGAGEMENT_OPEN_PATH = "/e/o";
export const ENGAGEMENT_CLICK_PATH = "/e/c";
/**
 * The honeypot link's route; shaped like its siblings so it is
 * indistinguishable in the markup.
 */
export const ENGAGEMENT_HONEYPOT_PATH = "/e/h";

/**
 * A click landing sooner than this after the email was sent is `too_fast`.
 * Enterprise link scanners (SafeLinks, Proofpoint, Mimecast) present a full
 * browser user agent and fetch on delivery, seconds after the send, while a
 * person has to receive and open the mail; `clicked_at - executed_at` is the
 * one stored signal that separates them.
 */
export const CLICK_SUSPECT_MIN_SECONDS = 60;
export const CLICK_SUSPECT_MIN_MS = CLICK_SUSPECT_MIN_SECONDS * 1000;

/**
 * Why a click is not trusted. Stored on recovery_steps.click_suspect_reason.
 */
export const CLICK_SUSPECT_TOO_FAST = "too_fast";
export const CLICK_SUSPECT_HONEYPOT = "honeypot";
