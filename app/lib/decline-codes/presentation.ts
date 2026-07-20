import type { BadgeTone } from "~/components/badge";
import type { DeclineCategory } from "~/lib/constants";
import type { DeclineCodeView } from "./codes";

// Shared, category-driven presentation for the /decline-codes surfaces. None
// of this is per-code hand-authored: it derives entirely from the
// classifyDecline()/isRetryable() outputs already carried on a
// DeclineCodeView (app/lib/decline-codes/codes.ts), so the "how Foxhound
// recovers it" section can never say something the recovery engine does not
// actually do.

export function categoryBadgeTone(category: DeclineCategory): BadgeTone {
  if (category === "fraud") return "failure";
  if (category === "expired") return "neutral";
  if (category === "unknown") return "neutral";
  return "success"; // soft, network: both silently retryable
}

export function recoveryApproach(view: DeclineCodeView): string {
  if (view.category === "fraud") {
    return "Fraud and security declines are never retried, silently or otherwise. Foxhound sends a gentle, clearly worded email sequence across 30 days that names the situation plainly and points the customer to their card issuer, rather than repeating the same charge against a flag the issuer already raised.";
  }
  if (view.category === "expired") {
    return "Expired and stale-card declines do not recover through a repeat charge against the same card details. Foxhound skips straight to the card-update path: a hosted, no-login link goes out by email, and an expiring-card alert can fire ahead of the renewal date when the expiration is already visible on the stored card, so the update happens before the charge ever fails.";
  }
  if (view.category === "unknown") {
    return "This code has no dedicated bucket in the recovery engine's classification sets, so it fails closed rather than defaulting to a silent retry: no repeat charge runs against a code Foxhound cannot classify. Recovery goes straight to the same email sequence expired cards get, carrying the hosted card-update link, until this code earns its own bucket.";
  }
  // soft, network (retryable === true)
  return "A Foxhound-scheduled silent retry runs first, timed for the specific decline pattern rather than an immediate repeat. If the retry succeeds, the customer never sees anything happened. If it does not, Foxhound moves to a dunning email sequence across the following weeks, written in the merchant's own brand voice, with a hosted card-update link on every email as a passive fallback channel.";
}
