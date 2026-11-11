import { tokenPattern } from "@dustinedwards/site-runtime/log";

/** The routes whose last segment is one person's token (app/routes.ts): unsubscribe, card update, the engagement
 *  open, click and honeypot links, and an invite. */
export const TOKEN_ROUTES = ["u", "p", "e/o", "e/c", "e/h", "invite"] as const;

/** Those routes and a Carrel preview link, each cut to `/<route>/[token]` in every log line and Sentry event. */
export const TOKEN_PATH = tokenPattern(TOKEN_ROUTES);
