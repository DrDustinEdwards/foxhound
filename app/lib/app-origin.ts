import { SITE_ORIGIN } from "~/lib/seo/jsonld";

/**
 * The origin every link in an email or Slack message starts with: the
 * BETTER_AUTH_URL var (the origin sign-in, passkeys and Stripe's return URLs
 * use), else the production origin. Never "", because a relative link in an
 * email goes nowhere.
 */
export function appOrigin(env: Env): string {
  return env.BETTER_AUTH_URL || SITE_ORIGIN;
}
