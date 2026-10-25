// AES-256-GCM encryption for connected-account Stripe tokens at rest
// (ARCHITECTURE.md non-negotiable #5: never log decrypted Stripe tokens). Ported
// from legacy lib/encryption.ts, moved from Node `crypto` to Web Crypto
// (crypto.subtle) so it runs natively on the Workers runtime.
//
// ---- KEY ROTATION (ruling 312) ----
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
//   4. Run the re-encrypt writer (app/lib/stripe/key-rotation.server.ts) to move
//      every stored value onto the active key.
//   5. Once it reports zero remaining on old keys, drop ENCRYPTION_KEYS_OLD.
// Step 4 is what makes step 5 safe, and the writer reports the counts that prove
// it. Rotating the production key is Dustin's call; this module is the mechanism.
//
// THE LEGACY 2-PART FORMAT IS RECOGNIZED AND REFUSED, NOT DECRYPTED, and that is
// a decision rather than an oversight. The pre-312 format was `ivHex:cipherHex`
// with no key id. Supporting it on read would mean assuming it was encrypted with
// the ACTIVE key, which is true only until the first rotation and silently WRONG
// after it: the branch would fail exactly when the feature it accompanies is
// first used. Since zero rows in that format exist (measured above), a
// recognition that names the remedy is honest at every moment, where a
// best-effort decrypt is honest only at this one. If such a value ever appears it
// means something wrote it outside this module, which is a condition a human must
// see.
//
// Decrypted values are NEVER logged or returned to a client.

import { fromHex, toHex } from "@dustinedwards/site-runtime/encoding";

const IV_BYTES = 12; // 96-bit IV, the standard for AES-GCM.
const FORMAT_VERSION = "v1";
const DEFAULT_KEY_ID = "k1";
const KEY_HEX_LENGTH = 64; // 32 bytes

export interface Keyring {
  /** Id of the key that encrypts new values. */
  activeId: string;
  /** Every key available for DECRYPT, active plus previous, by id. */
  byId: Map<string, string>;
}

function assertKeyHex(hex: string, label: string): string {
  if (hex.length !== KEY_HEX_LENGTH) {
    throw new Error(`${label} must be 64 hex chars (32 bytes) for AES-256-GCM`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${label} must be hex`);
  }
  return hex;
}

/** Build the keyring from env. Throws LOUDLY on anything malformed: a key
 *  problem must surface as an error a human sees, never as a silent null. */
export function loadKeyring(env: Env): Keyring {
  const activeKey = env.ENCRYPTION_KEY;
  if (!activeKey) throw new Error("ENCRYPTION_KEY is not set");
  assertKeyHex(activeKey, "ENCRYPTION_KEY");

  const activeId = (env.ENCRYPTION_KEY_ID ?? DEFAULT_KEY_ID).trim();
  if (!activeId) throw new Error("ENCRYPTION_KEY_ID is set but empty");
  if (activeId.includes(":")) throw new Error("ENCRYPTION_KEY_ID must not contain ':'");

  const byId = new Map<string, string>([[activeId, activeKey]]);

  const previous = env.ENCRYPTION_KEYS_OLD?.trim();
  if (previous) {
    for (const entry of previous.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(":");
      if (sep <= 0) {
        throw new Error("ENCRYPTION_KEYS_OLD entries must be 'keyId:hex'");
      }
      const id = trimmed.slice(0, sep).trim();
      const hex = trimmed.slice(sep + 1).trim();
      assertKeyHex(hex, `ENCRYPTION_KEYS_OLD entry '${id}'`);
      // The active id wins: a previous entry reusing it is a config mistake that
      // would otherwise silently shadow the encrypting key.
      if (id === activeId) {
        throw new Error(`ENCRYPTION_KEYS_OLD reuses the active key id '${id}'`);
      }
      byId.set(id, hex);
    }
  }

  return { activeId, byId };
}

async function importKeyHex(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromHex(hex), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt a token under the ACTIVE key. Returns `v1:keyId:ivHex:cipherHex`.
 *  The plaintext is never logged. */
export async function encryptToken(env: Env, plaintext: string): Promise<string> {
  const keyring = loadKeyring(env);
  const key = await importKeyHex(keyring.byId.get(keyring.activeId)!);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new Uint8Array(new TextEncoder().encode(plaintext));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return `${FORMAT_VERSION}:${keyring.activeId}:${toHex(iv)}:${toHex(cipher)}`;
}

/** The key id a stored value names, or null when it is not in the v1 format. */
export function keyIdOf(encrypted: string): string | null {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) return null;
  return parts[1];
}

/** Decrypt a token produced by encryptToken. Throws on malformed input, on an
 *  unresolvable key id, and on the pre-312 format. */
export async function decryptToken(env: Env, encrypted: string): Promise<string> {
  const parts = encrypted.split(":");

  if (parts.length === 2) {
    // Recognized, deliberately unsupported. See the header note.
    throw new Error(
      "Encrypted token is in the pre-rotation format (ivHex:cipherHex) with no key id. " +
        "Nothing should hold this format: zero rows existed when 312 introduced key ids. " +
        "Reconnect the Stripe account to mint a token under the current key.",
    );
  }

  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Malformed encrypted token (expected v1:keyId:ivHex:cipherHex)");
  }

  const [, keyId, ivHex, cipherHex] = parts;
  const keyring = loadKeyring(env);
  const keyHex = keyring.byId.get(keyId);
  if (!keyHex) {
    // LOUD by design: a token encrypted under a key this environment cannot see
    // is unreadable, and saying so names the fix. Never a silent null.
    const known = [...keyring.byId.keys()].join(", ");
    throw new Error(
      `No encryption key for id '${keyId}'. Keys available: ${known}. ` +
        "Set it in ENCRYPTION_KEYS_OLD (decrypt-only) or ENCRYPTION_KEY.",
    );
  }

  const key = await importKeyHex(keyHex);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(ivHex) },
    key,
    fromHex(cipherHex),
  );
  return new TextDecoder().decode(plain);
}

/** Re-encrypt one stored value onto the ACTIVE key. Returns null when it is
 *  already active, so a caller can count real work instead of rewriting rows
 *  that need nothing. */
export async function reencryptToken(env: Env, encrypted: string): Promise<string | null> {
  const keyring = loadKeyring(env);
  if (keyIdOf(encrypted) === keyring.activeId) return null;
  return encryptToken(env, await decryptToken(env, encrypted));
}
