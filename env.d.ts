// Ambient secrets not declared in wrangler.jsonc (never committed as real
// values; set via `wrangler secret put`). Declaration-merges with the generated
// Env interface in worker-configuration.d.ts. Non-secret config (BETTER_AUTH_URL,
// GOOGLE_CLIENT_ID) lives in wrangler.jsonc `vars` and is typed by `wrangler types`.
interface Env {
  SENTRY_DSN?: string;
  // Better Auth signing key. Required in real environments; absent locally is
  // tolerated (dev-only default) but flagged.
  BETTER_AUTH_SECRET?: string;
  // Google OAuth (C3). Provider is enabled only when both id and secret are
  // present; otherwise the Google path is cleanly inert. The client id is public
  // but kept ambient (not a committed var) so its type stays `string | undefined`
  // rather than an empty-string literal.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Admin allowlist (C4). Comma-separated emails granted the admin role.
  // Access-control sensitive -> secret, not a committed var. Unset => no admins.
  ADMIN_EMAIL?: string;

  // ---- Phase 4a: Stripe Connect + token encryption ----
  // AES-256-GCM key for encrypting connected-account Stripe tokens at rest.
  // 64 hex chars (32 bytes). Decrypted tokens are NEVER logged.
  ENCRYPTION_KEY?: string;
  // Foxhound's Stripe platform secret key (test key on staging). Used for the
  // Connect OAuth token exchange, account retrieve, and webhook constructEvent.
  STRIPE_SECRET_KEY?: string;
  // Stripe Connect OAuth client id (ca_...). Public-ish but kept ambient.
  STRIPE_CLIENT_ID?: string;
  // Webhook signing secrets (consumed in Phase 4c; declared here so the sig
  // helper types cleanly). Connected-account endpoint + platform endpoint.
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PLATFORM_WEBHOOK_SECRET?: string;

  // ---- Phase 4b: AI dunning-copy generation ----
  // Anthropic API key for Sonnet dunning-copy generation. Dustin-gated secret
  // (set via `wrangler secret put`); the generation call is a seam that stays
  // inert until this is present. Generated copy is sanitized before use.
  ANTHROPIC_API_KEY?: string;
}
