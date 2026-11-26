/**
 * True when STRIPE_SECRET_KEY is a test-mode (sandbox) key. Foxhound acts only on Stripe objects in
 * its key's mode: production holds a live key and ignores every test-mode event and connection; a
 * local copy run on a sandbox key acts on that sandbox's test objects and ignores live ones. An
 * unset key counts as live. Only the mode prefix is read.
 */
export function isTestStripeKey(env: Env): boolean {
  const key = env.STRIPE_SECRET_KEY;
  return typeof key === "string" && (key.startsWith("sk_test_") || key.startsWith("rk_test_"));
}
