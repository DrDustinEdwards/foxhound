// AES-256-GCM encryption for connected-account Stripe tokens at rest
// (ARCHITECTURE.md non-negotiable #5: never log decrypted Stripe tokens). Ported
// from legacy lib/encryption.ts, moved from Node `crypto` to Web Crypto
// (crypto.subtle) so it runs natively on the Workers runtime.
//
// Format: `ivHex:cipherHex`, where cipherHex is the AES-GCM ciphertext WITH the
// 16-byte auth tag appended (Web Crypto's convention). Two parts, not the
// legacy three, because Web Crypto does not expose the tag separately. Legacy
// tokens are demo-only and are not migrated, so no cross-format compatibility is
// required. Decrypted values are NEVER logged or returned to a client.

const IV_BYTES = 12; // 96-bit IV, the standard for AES-GCM.

function requireKeyHex(env: Env): string {
  const keyHex = env.ENCRYPTION_KEY;
  if (!keyHex) throw new Error("ENCRYPTION_KEY is not set");
  if (keyHex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be 64 hex chars (32 bytes) for AES-256-GCM");
  }
  return keyHex;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("Malformed hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function importKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(requireKeyHex(env)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a token. Returns `ivHex:cipherHex`. The plaintext is never logged. */
export async function encryptToken(env: Env, plaintext: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new Uint8Array(new TextEncoder().encode(plaintext));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data),
  );
  return `${bytesToHex(iv)}:${bytesToHex(cipher)}`;
}

/** Decrypt a token produced by encryptToken. Throws on malformed/invalid input. */
export async function decryptToken(env: Env, encrypted: string): Promise<string> {
  const parts = encrypted.split(":");
  if (parts.length !== 2) {
    throw new Error("Malformed encrypted token (expected ivHex:cipherHex)");
  }
  const [ivHex, cipherHex] = parts;
  const key = await importKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(ivHex) },
    key,
    hexToBytes(cipherHex),
  );
  return new TextDecoder().decode(plain);
}
