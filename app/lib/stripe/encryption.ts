// AES-256-GCM encryption for connected-account Stripe tokens at rest (ARCHITECTURE.md
// non-negotiable #5: never log decrypted Stripe tokens). The crypto itself now lives in
// site-runtime ./secret-box (moved there from this file); what is left here binds it to Foxhound's
// env and its ENCRYPTION_KEY* names. The day a real merchant connects, the same change becomes a
// migration touching every connected account, because rotating without a key id makes every stored
// token undecryptable at once.

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

/**
 * Decrypt a token produced by encryptToken. Throws on malformed input and on an unresolvable key
 * id.
 */
export function decryptToken(env: Env, encrypted: string): Promise<string> {
  return open(loadKeyring(env), encrypted);
}

/** Re-encrypt one stored value onto the ACTIVE key; null when already there. */
export function reencryptToken(env: Env, encrypted: string): Promise<string | null> {
  return reseal(loadKeyring(env), encrypted);
}
