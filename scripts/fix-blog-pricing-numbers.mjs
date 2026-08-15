// Content-audit remediation (HIGH-2, foxhound-audit-content.md): blog
// posts must never state a specific Foxhound dollar figure, per PRICING.md's
// "no specific-number pricing in blog/SEO copy, outcome-based pricing
// framing" rule. subscription-intelligence-churn-prediction had a flatly
// wrong number ($299/mo, real price is $199/mo); the fix per the task is
// NOT to swap in the correct number, it is to remove the number entirely
// and reframe outcome-based. A grep sweep of the other 44 posts found three
// more posts computing a specific Foxhound fee/net-benefit dollar figure as
// a worked example (recova-vs-churn-buster, recova-vs-stripe-smart-retries,
// stripe-smart-retries-vs-dunning); those are reframed the same way. This
// script never touches a competitor's own published price (Churnkey,
// Churn Buster) or a hypothetical merchant's illustrative revenue figures:
// those are sourced third-party facts or math inputs, not a Foxhound
// pricing promise, and are explicitly out of scope.
//
// Usage:
//   node scripts/fix-blog-pricing-numbers.mjs          # dry run
//   node scripts/fix-blog-pricing-numbers.mjs --apply  # writes to D1, then re-verifies

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const DB_NAME = "foxhound";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WRANGLER_BIN = join(SCRIPT_DIR, "..", "node_modules", "wrangler", "bin", "wrangler.js");

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
  });
}

function d1Query(sql) {
  const out = wrangler(["d1", "execute", DB_NAME, "--remote", "--json", "--command", sql]);
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

function d1ExecuteFile(path) {
  wrangler(["d1", "execute", DB_NAME, "--remote", "--file", path]);
}

const REPLACEMENTS = [
  {
    slug: "subscription-intelligence-churn-prediction",
    before:
      "Intelligence is $299 per month, account-wide. It connects to your Stripe data via Stripe Connect with no code required.",
    after:
      "Intelligence is the paid predictive layer, priced flat monthly with free basic analytics for Recovery merchants. It connects to your Stripe data via Stripe Connect with no code required.",
  },
  {
    slug: "recova-vs-churn-buster",
    before:
      "Foxhound at 20 percent of $2,000/month: $400/month, $4,800/year. At this recovery volume, Churn Buster is cheaper.",
    after:
      "Foxhound's 20 percent fee on that same $2,000/month in recovered revenue comes out above Churn Buster's flat rate, so Churn Buster is cheaper at this volume.",
  },
  {
    slug: "recova-vs-churn-buster",
    before:
      "Churn Buster: $2,988/year. Foxhound: $1,000/month, $12,000/year. Churn Buster is significantly cheaper at scale.",
    after:
      "Churn Buster: $2,988/year. Foxhound's 20 percent fee scales with recovery volume and is well above Churn Buster's flat rate at this level, so Churn Buster is significantly cheaper at scale.",
  },
  {
    slug: "recova-vs-stripe-smart-retries",
    before:
      "For a $200K ARR business with 7 percent payment failure rate: $14,000 in annual failures. Smart Retries recover 38 percent: $5,320. Foxhound recovers 70 percent: $9,800. Incremental recovery: $4,480. Foxhound's 20 percent fee on incremental: $896. Net benefit: $3,584 per year.\n\nFor a $1M ARR business: $22,400 net benefit per year.",
    after:
      "For a $200K ARR business with 7 percent payment failure rate: $14,000 in annual failures. Smart Retries recover 38 percent: $5,320. Foxhound recovers 70 percent: $9,800. Incremental recovery: $4,480, comfortably worth pursuing even after Foxhound's 20 percent fee on that incremental amount.\n\nFor a $1M ARR business, the same math scales: the incremental recovery still clears Foxhound's fee by a wide margin.",
  },
  {
    slug: "stripe-smart-retries-vs-dunning",
    before:
      "Foxhound charges 20 percent of recovered revenue. On $14,400 incremental recovery, that is $2,880 per year. Net benefit: $11,520.",
    after:
      "Foxhound charges 20 percent of recovered revenue, so on $14,400 incremental recovery, the fee is well below the value recovered, leaving a strongly positive net benefit.",
  },
];

function sqlValue(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const slugs = [...new Set(REPLACEMENTS.map((r) => r.slug))];
  const placeholders = slugs.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  const rows = d1Query(`SELECT id, slug, body FROM blog_posts WHERE slug IN (${placeholders});`);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  console.log(`Loaded ${rows.length} of ${slugs.length} target posts from D1.`);

  const bodies = new Map(rows.map((r) => [r.slug, r.body]));
  const report = [];

  for (const r of REPLACEMENTS) {
    const current = bodies.get(r.slug);
    if (current === undefined) {
      console.error(`ABORT: slug not found: ${r.slug}`);
      process.exit(1);
    }
    const occurrences = current.split(r.before).length - 1;
    if (occurrences !== 1) {
      console.error(
        `ABORT: expected exactly 1 occurrence of the "before" text in ${r.slug}, found ${occurrences}.`,
      );
      console.error(JSON.stringify(r.before));
      process.exit(1);
    }
    const updated = current.replace(r.before, r.after);
    bodies.set(r.slug, updated);
    report.push({ slug: r.slug, before: r.before, after: r.after });
  }

  console.log(`\n=== Blog pricing-number sweep (${APPLY ? "apply" : "dry-run"}) ===`);
  for (const entry of report) {
    console.log(`\n--- ${entry.slug} ---`);
    console.log(`BEFORE: ${entry.before}`);
    console.log(`AFTER:  ${entry.after}`);
  }

  const logPath = join(SCRIPT_DIR, "blog-pricing-number-sweep-log.json");
  writeFileSync(logPath, JSON.stringify({ mode: APPLY ? "apply" : "dry-run", changes: report }, null, 2));
  console.log(`\nLog written to ${logPath}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write to D1.");
    return;
  }

  const statements = slugs.map((slug) => {
    const id = bySlug.get(slug).id;
    return `UPDATE "blog_posts" SET "body"=${sqlValue(bodies.get(slug))} WHERE "id"='${id}';`;
  });
  const sqlPath = join(SCRIPT_DIR, "out", "blog-pricing-number-sweep-apply.sql");
  writeFileSync(sqlPath, statements.join("\n") + "\n");
  d1ExecuteFile(sqlPath);

  // Re-verify: every "before" string is gone, every "after" string is present.
  const after = d1Query(`SELECT slug, body FROM blog_posts WHERE slug IN (${placeholders});`);
  const afterBySlug = new Map(after.map((r) => [r.slug, r.body]));
  let ok = true;
  for (const r of REPLACEMENTS) {
    const body = afterBySlug.get(r.slug);
    if (body.includes(r.before)) {
      console.error(`VERIFICATION FAILED: ${r.slug} still contains the old text.`);
      ok = false;
    }
    if (!body.includes(r.after)) {
      console.error(`VERIFICATION FAILED: ${r.slug} does not contain the new text.`);
      ok = false;
    }
  }
  console.log(ok ? "\nApply + verification OK." : "\nVERIFICATION FAILED.");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
