// Disposable / throwaway email domains blocked at signup (legacy rule carried
// into the rebuild). Not exhaustive by design: this is a blocklist of the common
// throwaway providers, not an allowlist. Keep lowercase, bare domains.
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "grr.la",
  "sharklasers.com",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "tempmailo.com",
  "throwawaymail.com",
  "getnada.com",
  "nada.email",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.net",
  "dispostable.com",
  "maildrop.cc",
  "mailnesia.com",
  "mailcatch.com",
  "fakeinbox.com",
  "fakemail.net",
  "spam4.me",
  "mohmal.com",
  "emailondeck.com",
  "mintemail.com",
  "moakt.com",
  "tmail.ws",
  "tmpmail.org",
  "tempr.email",
  "discard.email",
  "burnermail.io",
  "getairmail.com",
  "inboxkitten.com",
  "vomoto.com",
  "harakirimail.com",
]);

/** True when the email's domain is a known disposable/throwaway provider. */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
