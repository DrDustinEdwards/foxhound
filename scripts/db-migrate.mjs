#!/usr/bin/env node
// Guarded wrapper around `wrangler d1 migrations apply`.
//
// Why this exists. The D1 bound as DB is named "foxhound-production" and IS the
// production database. wrangler.jsonc declares a single environment, the Worker
// serves foxhoundapp.com, and that same config binds DB to foxhound-production;
// the config says so outright in its own comment. The separate
// foxhound-production database is bound nowhere.
//
// So every `--remote` command naming foxhound-production is a production write,
// while reading like a staging one. The npm script used to be a bare
// `wrangler d1 migrations apply foxhound-production --remote`, which meant a
// reflexive `npm run db:migrate` applied migrations to live data with nothing
// asked and nothing confirmed.
//
// This wrapper does not change what a migration does. It only refuses to touch
// the remote database unless the caller says so explicitly, so that hitting
// production is a decision rather than a default.
//
// Usage:
//   npm run db:migrate                    -> local D1 (safe default)
//   npm run db:migrate -- --remote-confirm -> remote, i.e. PRODUCTION
//   DB_MIGRATE_CONFIRM=1 npm run db:migrate -> remote, for CI
//
// CI sets DB_MIGRATE_CONFIRM=1 deliberately: applying migrations before the
// deploy is the point of the step, and CI has no human to prompt.

import { spawnSync } from "node:child_process";

const DATABASE = "foxhound-production";

const args = process.argv.slice(2);
const confirmedByFlag = args.includes("--remote-confirm");
const confirmedByEnv = process.env.DB_MIGRATE_CONFIRM === "1";
const remote = confirmedByFlag || confirmedByEnv;

if (args.includes("--remote")) {
  console.error(
    [
      "Refusing to run: pass --remote-confirm, not --remote.",
      "",
      `The database named "${DATABASE}" is PRODUCTION despite its name.`,
      "The explicit flag exists so that is acknowledged rather than assumed.",
    ].join("\n"),
  );
  process.exit(2);
}

const passthrough = args.filter((a) => a !== "--remote-confirm");

if (remote) {
  const how = confirmedByFlag ? "--remote-confirm" : "DB_MIGRATE_CONFIRM=1";
  console.log(`Applying migrations to REMOTE "${DATABASE}" (production), authorised by ${how}.`);
} else {
  console.log(
    [
      `Applying migrations to the LOCAL "${DATABASE}" only.`,
      "To apply to production, re-run with --remote-confirm.",
    ].join("\n"),
  );
}

// --no-install pins this to the wrangler in devDependencies. Without it npx
// silently fetches whatever is latest on npm, which would mean an unpinned
// wrangler version applying migrations to production.
const wranglerArgs = [
  "--no-install",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  DATABASE,
  remote ? "--remote" : "--local",
  ...passthrough,
];

const result = spawnSync("npx", wranglerArgs, { stdio: "inherit", shell: process.platform === "win32" });

if (result.error) {
  console.error(`Failed to run wrangler: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
