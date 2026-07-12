// Ambient secrets not yet declared in wrangler.jsonc (never committed as
// real values; see `wrangler secret put`). Declaration-merges with the
// generated Env interface in worker-configuration.d.ts.
interface Env {
  SENTRY_DSN?: string;
}
