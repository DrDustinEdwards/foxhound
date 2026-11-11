// AES-256-GCM encryption for connected-account Stripe tokens at rest
// (ARCHITECTURE.md non-negotiable #5: never log decrypted Stripe tokens). Ported
// from legacy lib/encryption.ts, moved from Node `crypto` to Web Crypto
// (crypto.subtle) so it runs natively on the Workers runtime. The crypto itself now
// lives in site-runtime ./secret-box (moved there from this file); what is left
// here binds it to Foxhound's env and its ENCRYPTION_KEY* names.
//
// ---- KEY ROTATION ----
//
// FORMAT: `v1:<keyId>:<ivHex>:<cipherHex>`, where cipherHex is the AES-GCM
// ciphertext WITH the 16-byte auth tag appended (Web Crypto's convention, which
// does not expose the tag separately). The keyId is what makes rotation
// possible: a stored value names the key that encrypted it, so a decrypt can
// resolve the right key instead of guessing the current one.
//
// WHY NOW, WHILE IT IS FREE: measured at ruling 311's walk, `stripe_connections`
// held exactly ONE row, belonging to demo_teamflow, with `stripe_access_token`
// NULL. So ZERO ciphertext existed anywhere and this format change migrates
// nothing. The day a real merchant connects, the same change becomes a migration
// touching every connected account, because rotating without a key id makes
// every stored token undecryptable at once.
//
// THE KEYRING, read from env:
//   ENCRYPTION_KEY       the ACTIVE key (64 hex chars). Encrypts everything new.
//   ENCRYPTION_KEY_ID    the active key's id. Optional, defaults to "k1", so the
//                        secret that is already set keeps working untouched.
//   ENCRYPTION_KEYS_OLD  optional, DECRYPT-ONLY previous keys as
//                        "id:hex,id:hex". Never used to encrypt.
//
// THE RUNBOOK a rotation follows, which is why the shape is current-plus-previous
// rather than a single key:
//   1. Move the current key into ENCRYPTION_KEYS_OLD under its existing id.
//   2. Set ENCRYPTION_KEY to the new key and ENCRYPTION_KEY_ID to its new id.
//   3. Deploy. New writes use the new key; old rows still decrypt via the old.
//   4. Run the re-encrypt writers (app/lib/stripe/key-rotation.server.ts: the
//      connection tokens and the sealed Slack webhook URLs) to move
//      every stored value onto the active key.
//   5. Once it reports zero remaining on old keys, drop ENCRYPTION_KEYS_OLD.
// Step 4 is what makes step 5 safe, and the writer reports the counts that prove
// it. Rotating the production key is Dustin's call; this module is the mechanism.
//
// THE LEGACY 2-PART FORMAT IS REFUSED, NOT DECRYPTED (the shared open() throws
// "Malformed sealed value" on it). The pre-312 format was `ivHex:cipherHex` with
// no key id; reading it would assume the ACTIVE key, which is wrong after the
// first rotation. Zero rows exist in it, so a refusal is honest at every moment.
//
// Decrypted values are NEVER logged or returned to a client.

import {
  keyIdOf,
  keyringFromEnv,
  open,
  reseal,
  seal,
  type Keyring,
} from "@dustinedwards/site-runtime/secret-box";

export { keyIdOf, type Keyring };

/** The keyring from env (ENCRYPTION_KEY, ENCRYPTION_KEY_ID, ENCRYPTION_KEYS_OLD).
 *  Throws LOUDLY on anything malformed. */
export function loadKeyring(env: Env): Keyring {
  return keyringFromEnv(env);
}

/** Encrypt a token under the ACTIVE key. Returns `v1:keyId:ivHex:cipherHex`.
 *  The plaintext is never logged. */
export function encryptToken(env: Env, plaintext: string): Promise<string> {
  return seal(loadKeyring(env), plaintext);
}

/** Decrypt a token produced by encryptToken. Throws on malformed input
 *  (including the pre-312 format) and on an unresolvable key id. */
export function decryptToken(env: Env, encrypted: string): Promise<string> {
  return open(loadKeyring(env), encrypted);
}

/** Re-encrypt one stored value onto the ACTIVE key; null when already there. */
export function reencryptToken(env: Env, encrypted: string): Promise<string | null> {
  return reseal(loadKeyring(env), encrypted);
}
