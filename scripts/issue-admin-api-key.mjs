#!/usr/bin/env node
// Issue the Foxhound Admin API key (job_21de68b30fc2).
//
// The Foxhound Admin MCP Worker presents this key, together with the acting
// admin's email, on every call to /api/admin/v1. It is an `mcp_admin` row in
// api_keys, the same model the merchant keys use: only the SHA-256 hash is
// stored, and the plaintext is shown here once.
//
// THIS SCRIPT WRITES NOTHING. It prints the key and the two commands the seat
// runs: one stores the hash in production D1, the other hands the key to the
// admin MCP Worker as a secret. Run it, run the two commands, and the key is
// live; lose the output and you issue another and revoke the old row.
//
// Usage: node scripts/issue-admin-api-key.mjs [label]

import { createHash, randomBytes, randomUUID } from "node:crypto";

const label = (process.argv[2] ?? "foxhound-admin-mcp").replace(/[^A-Za-z0-9 _.-]/g, "");
const token = `fox_mcp_${randomBytes(32).toString("base64url")}`;
const keyHash = createHash("sha256").update(token).digest("hex");
const id = randomUUID();
const createdAt = Date.now();

const sql =
  "INSERT INTO api_keys (id, account_id, key_hash, label, scope, created_at) " +
  `VALUES ('${id}', NULL, '${keyHash}', '${label}', 'mcp_admin', ${createdAt});`;

console.log("Foxhound Admin API key. Shown once; it is not stored anywhere.\n");
console.log(`  ${token}\n`);
console.log("1. Store its hash in production D1:\n");
console.log(`  npx wrangler d1 execute foxhound --remote --command "${sql}"\n`);
console.log("2. Give the key to the admin MCP Worker:\n");
console.log("  npx wrangler secret put FOXHOUND_ADMIN_API_KEY --config mcp/wrangler.jsonc\n");
console.log(`Key id ${id}. To revoke it later, set api_keys.revoked_at on that id.`);
