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
}
