// Ambient secrets not declared in wrangler.jsonc (never committed as real
// values; set via `wrangler secret put`). Declaration-merges with the generated
// Env interface in worker-configuration.d.ts. Non-secret config (BETTER_AUTH_URL,
// GOOGLE_CLIENT_ID) lives in wrangler.jsonc `vars` and is typed by `wrangler types`.
// The family's own (maintenance, admins, Access, the admin idle key, the operator
// and Carrel keys, Anthropic, Turnstile) are site-runtime's SiteSecrets.
type SiteSecrets = import("@dustinedwards/site-runtime/worker").SiteSecrets;

interface Env extends SiteSecrets {
  // Extra exact callbacks a merchant MCP client registration may name, space or
  // comma separated, beside site-runtime's DCR_CALLBACKS (registerClient). A
  // plain list of https URLs, not a secret.
  DCR_REDIRECT_URIS?: string;
  SENTRY_DSN?: string;
  // The seed of the ToolCallLog chain's Ed25519 signing key (site-runtime ./audit-log 0.85, which requires it).
  // Minted by the deploy (devkit worker-deploy `generated-secrets`), never shown.
  AUDIT_SIGNING_KEY: string;
  // Reading errors back for /admin/platform/errors (J48). The DSN only sends;
  // listing issues needs a Sentry auth token with event:read and the
  // organization's slug. Either unset => the page says it cannot read them.
  // The token is sent only to the sentry.io API named by the DSN's region,
  // and is never rendered or logged (app/lib/admin/errors.server.ts).
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_ORG?: string;
  // Better Auth signing key. Required in real environments; absent locally is
  // tolerated (dev-only default) but flagged.
  BETTER_AUTH_SECRET?: string;
  // Google sign-in (C3). Offered only when both id and secret are present;
  // otherwise the Google path is cleanly inert. The client id is public but kept
  // ambient (not a committed var) so its type stays `string | undefined` rather
  // than an empty-string literal.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Sign in with Apple, offered only when all four are set: the Services ID, the
  // team, and the Sign in with Apple key's id and PEM, from which site-runtime
  // ./apple-secret signs the client secret (./sign-in).
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  // Extra inboxes the owner-only admin email send (app/lib/admin/email-send.server.ts)
  // may mail, comma separated. Unset => only the acting admin's own address.
  // A plain list of the owner's own test inboxes; never a customer's address.
  ADMIN_EMAIL_TEST_RECIPIENTS?: string;

  // ---- Phase 4a: Stripe Connect + token encryption ----
  // AES-256-GCM key for encrypting connected-account Stripe tokens at rest.
  // 64 hex chars (32 bytes). Decrypted tokens are NEVER logged. This is the
  // ACTIVE key: everything new is encrypted under it.
  ENCRYPTION_KEY?: string;
  // The active key's id, written into every ciphertext as `v1:<keyId>:...` so a
  // decrypt can resolve the right key instead of guessing (312). OPTIONAL and
  // defaults to "k1", which is why the already-set ENCRYPTION_KEY secret keeps
  // working with no config change.
  ENCRYPTION_KEY_ID?: string;
  // DECRYPT-ONLY previous keys as "id:hex,id:hex", set during a rotation so rows
  // written under the old key still read while the re-encrypt writer moves them
  // (app/lib/stripe/key-rotation.server.ts). Never used to encrypt. Dropped once
  // that writer reports nothing left on old keys. The full runbook is in the
  // header of app/lib/stripe/encryption.ts.
  ENCRYPTION_KEYS_OLD?: string;
  // HMAC key for the links Foxhound emails (/p/, /u/, /e/), 64 hex chars, kept
  // apart from ENCRYPTION_KEY (app/lib/http/signed-token.ts). OPTIONAL: unset,
  // links are signed with ENCRYPTION_KEY as before; set, new links use it and
  // links signed with ENCRYPTION_KEY still verify.
  EMAIL_TOKEN_KEY?: string;
  // Foxhound's Stripe platform secret key. Used for the
  // Connect OAuth token exchange, account retrieve, and webhook constructEvent.
  STRIPE_SECRET_KEY?: string;
  // Stripe Connect OAuth client id (ca_...). Public-ish but kept ambient.
  STRIPE_CLIENT_ID?: string;
  // Webhook signing secrets (consumed in Phase 4c; declared here so the sig
  // helper types cleanly). Connected-account endpoint + platform endpoint.
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PLATFORM_WEBHOOK_SECRET?: string;
  // The merchant MCP's list-only test key for the daily live check
  // (app/lib/mcp/handler.server.ts, site-runtime probeDoor): it lists the read
  // tools and runs none, and it never resolves to an account. OPTIONAL: unset,
  // /mcp admits only merchant keys, as before.
  MCP_PROBE_KEY?: string;

  // ---- Phase 4c: email pipeline (Dustin-provisioned; wrangler bindings added
  // once the queue exists + Email Service is enabled on the zone). Declared
  // ambient + optional so the code is guarded and deploy stays green until then.
  // The send binding shape is a Foxhound adapter; the real Email Service call is
  // finalized in Phase 8 when the binding is live.
  EMAIL?: EmailSendBinding;
  // CAN-SPAM sender postal address (ARCHITECTURE #8: required before any send).
  PHYSICAL_ADDRESS?: string;
}

// Foxhound's adapter shape over the Cloudflare Email Service send binding. The
// concrete binding call lives only in app/lib/email/send.ts and is finalized when
// Email Service is enabled (Phase 8).
//
// `text` is the plain-text part (J02): the Email Service send builder accepts
// `text` beside `html` (workerd's EmailReplyMessageBuilder), and every message
// Foxhound sends carries both, rendered from one Capsomer template.
interface EmailSendMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Reply-To (J03). The Email Service builder's own field: `replyTo?: string |
   *  EmailAddress` (developers.cloudflare.com/email-service/api/send-emails/workers-api/). */
  replyTo?: string;
  headers?: Record<string, string>;
}
interface EmailSendBinding {
  send(message: EmailSendMessage): Promise<{ id?: string; messageId?: string } | void>;
}
