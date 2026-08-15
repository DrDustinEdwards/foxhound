import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken } from "~/lib/stripe/encryption";

// AES-256-GCM token encryption (ARCHITECTURE.md non-negotiable #5). A 32-byte
// (64 hex char) test key.
const env = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;

describe("Stripe token encryption", () => {
  it("round-trips a token and stores ciphertext, not plaintext", async () => {
    const secret = "sk_live_should_never_appear_in_storage";
    const encrypted = await encryptToken(env, secret);

    expect(encrypted).not.toContain(secret);
    // ADJUDICATED AT 312, not silently updated. This read `toHaveLength(2)` for
    // the pre-rotation `ivHex:cipherHex` format. 312 added a key id, so a stored
    // value now names the key that encrypted it, which is what makes rotation
    // possible at all. The assertion was right for the old format and is
    // re-pointed at the new one; the shape is pinned in detail by
    // test/key-rotation-312.test.ts.
    expect(encrypted.split(":")).toHaveLength(4); // v1:keyId:ivHex:cipherHex
    expect(await decryptToken(env, encrypted)).toBe(secret);
  });

  it("uses a random IV so equal plaintexts encrypt differently", async () => {
    const a = await encryptToken(env, "same-token");
    const b = await encryptToken(env, "same-token");
    expect(a).not.toBe(b);
    expect(await decryptToken(env, a)).toBe("same-token");
    expect(await decryptToken(env, b)).toBe("same-token");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", async () => {
    // Re-pointed at the four-part format by 312. The tamper must still land in
    // the CIPHER, not the envelope: flipping a byte of the key id would be
    // rejected by key resolution instead of by the auth tag, which would leave
    // the GCM integrity check unproven.
    const encrypted = await encryptToken(env, "tok_value");
    const [version, keyId, iv, cipher] = encrypted.split(":");
    const lastByte = cipher.slice(-2);
    const flipped = cipher.slice(0, -2) + (lastByte === "00" ? "01" : "00");
    await expect(decryptToken(env, `${version}:${keyId}:${iv}:${flipped}`)).rejects.toThrow();
  });

  it("requires a 32-byte key", async () => {
    const badEnv = { ENCRYPTION_KEY: "abcd" } as unknown as Env;
    await expect(encryptToken(badEnv, "x")).rejects.toThrow(/64 hex/);
  });

  it("rejects a malformed encrypted value", async () => {
    await expect(decryptToken(env, "not-a-valid-token")).rejects.toThrow(/Malformed/);
  });
});
