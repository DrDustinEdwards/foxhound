import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildTemplateEmail } from "~/lib/recovery/email-template";

// Truthfulness fixes to three of Recova's recovery email sentences (CLAUDE.md:
// truthfulness fixes need no parity approval). Dustin approved them on
// 2026-10-15, project message cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6:
// "yes ro all. also do outside research on correct wording and timing".
// Research: /mnt/project-files/foxhound/research/dunning-wording-and-timing-2026-10-15.md
//
// Foxhound never suspends or cancels a customer's account; the merchant and
// the merchant's Stripe settings decide that. And completing the card update
// page only saves the new card as the default (finalizeCardUpdateSession in
// app/lib/card-update/service.ts); it does not pay or retry the invoice, so it
// does not restore anything by itself. Only the untrue part of each sentence
// changed; the rest is Recova's.

const UPDATE_URL = "https://foxhoundapp.test/e/c/EXAMPLE-NOT-A-TOKEN";
const CATEGORIES = ["soft", "network", "expired", "fraud", "unknown"] as const;
const STEPS = ["email_day1", "email_day3", "email_day7", "email_day14", "email_day30"] as const;

const FIXED: Record<"email_day3" | "email_day14" | "email_day30", string> = {
  email_day3:
    "We still haven't been able to process your payment of $49.00. Your account may be suspended if this isn't resolved.",
  email_day14:
    "It has been two weeks since your payment of $49.00 did not go through. Updating your payment method only takes a minute.",
  email_day30:
    "This is the final automated notice on your unpaid balance of $49.00. Without an updated payment method, your account may be cancelled.",
};

// The untrue claims. None may come back, in any wording of the same promise.
const BANNED = [/will be suspended/i, /will be cancell?ed/i, /restores your account/i];

function render(stepType: string, declineCategory: string): string {
  const copy = buildTemplateEmail({
    stepType,
    declineCategory,
    merchantName: "Teamflow",
    senderName: "Teamflow",
    customerName: "Jane Buyer",
    amountFormatted: "$49.00",
    updateUrl: UPDATE_URL,
  });
  return `${copy.subject}\n${copy.bodyHtml}`;
}

describe("recovery emails say only what is true", () => {
  for (const [stepType, sentence] of Object.entries(FIXED)) {
    for (const category of CATEGORIES) {
      it(`${stepType} (${category}) carries the corrected sentence`, () => {
        expect(render(stepType, category)).toContain(sentence);
      });
    }
  }

  for (const stepType of STEPS) {
    for (const category of CATEGORIES) {
      it(`${stepType} (${category}) makes no untrue promise`, () => {
        const out = render(stepType, category);
        for (const pattern of BANNED) expect(out).not.toMatch(pattern);
      });
    }
  }

  it("no source file under app/ carries the untrue sentences", () => {
    const root = fileURLToPath(new URL("../app", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.(ts|tsx|md)$/.test(name)) {
          const text = readFileSync(path, "utf8");
          for (const pattern of BANNED) {
            if (pattern.test(text)) hits.push(`${path}: ${pattern}`);
          }
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
