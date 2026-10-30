// The keys behind the links Foxhound emails: the card-update page (/p/), the
// unsubscribe link (/u/) and the engagement pixel and click redirect (/e/).
// The token format, signing and verification are site-runtime's
// ./signed-token: the first present key signs, every key verifies.
//
// EMAIL_TOKEN_KEY is the link key, so the key that encrypts Stripe tokens at
// rest (ENCRYPTION_KEY, app/lib/stripe/encryption.ts) is not also an HMAC key
// for links anyone can request by the thousand. Until that secret is set,
// links are signed with ENCRYPTION_KEY, as every link was before. Both verify
// while both exist, so links already in inboxes keep working once
// EMAIL_TOKEN_KEY is set; ENCRYPTION_KEY can leave this list once the
// longest-lived of those links has aged out.

/** Link keys, newest first. */
export function linkKeys(env: Pick<Env, "EMAIL_TOKEN_KEY" | "ENCRYPTION_KEY">): (string | undefined)[] {
  return [env.EMAIL_TOKEN_KEY, env.ENCRYPTION_KEY];
}
