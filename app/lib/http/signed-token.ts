// The keys behind the emailed links: card-update (/p/), unsubscribe (/u/) and engagement (/e/). Token format,
// signing and verification are site-runtime's ./signed-token: the first present key signs, every key verifies.
// EMAIL_TOKEN_KEY keeps the Stripe-token encryption key (ENCRYPTION_KEY) from also being a link HMAC key; until
// it is set, links are signed with ENCRYPTION_KEY. Both verify while both exist, so links already in inboxes
// keep working; ENCRYPTION_KEY can leave this list once the longest-lived of them has aged out.

export function linkKeys(
  env: Pick<Env, "EMAIL_TOKEN_KEY" | "ENCRYPTION_KEY">,
): (string | undefined)[] {
  return [env.EMAIL_TOKEN_KEY, env.ENCRYPTION_KEY];
}
