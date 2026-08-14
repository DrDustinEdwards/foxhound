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

  // ---- Phase 4c: email pipeline (Dustin-provisioned; wrangler bindings added
  // once the queue exists + Email Service is enabled on the zone). Declared
  // ambient + optional so the code is guarded and deploy stays green until then.
  // The send binding shape is a Foxhound adapter; the real Email Service call is
  // finalized in Phase 8 when the binding is live.
  EMAIL?: EmailSendBinding;
  EMAIL_DLQ?: Queue<unknown>;
  // CAN-SPAM sender postal address (ARCHITECTURE #8: required before any send).
  PHYSICAL_ADDRESS?: string;

  // ---- Phase 6 Pass 3: no-auth estimator Turnstile gate ----
  // Secret key for the Cloudflare Turnstile siteverify call. Dustin-gated
  // secret (set via `wrangler secret put`), never a committed var. While
  // unset, the estimator's action stays cleanly inert: it renders a
  // "temporarily unavailable" state and never accepts a submission or skips
  // the gate silently (mirrors gotcha #16's ANTHROPIC_API_KEY pattern).
  TURNSTILE_SECRET_KEY?: string;
}

// Foxhound's adapter shape over the Cloudflare Email Service send binding. The
// concrete binding call lives only in app/lib/email/send.ts and is finalized when
// Email Service is enabled (Phase 8).
interface EmailSendMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}
interface EmailSendBinding {
  send(message: EmailSendMessage): Promise<{ id?: string } | void>;
}
