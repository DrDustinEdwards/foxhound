// Phase 3 seam for transactional auth emails (verification, password reset).
//
// The real send path is Phase 4: the thin send module on the Cloudflare EMAIL
// binding, dispatched through Queues (ARCHITECTURE.md). Phase 3 must NOT build
// email infrastructure, so this logs the action link. On staging the link is
// readable via `wrangler tail`, which is how the email/password round-trip is
// verified end to end without a live mailbox.
//
// TODO(Phase 4): replace the body with a call to app/lib/email/send.ts. The
// signature stays; only the implementation swaps.
export type AuthEmailKind = "email-verification" | "password-reset";

export async function sendAuthEmail(
  kind: AuthEmailKind,
  to: string,
  url: string,
): Promise<void> {
  // Structured, greppable line. No secrets; the token is single-use and scoped.
  console.log(`[auth-email] kind=${kind} to=${to} url=${url}`);
}
