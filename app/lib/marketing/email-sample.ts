// Pre-written fallback copy for the home page's live email generator
// (TASK-foxhound-demo-entry-parity.md item 3). Rendered when the per-IP
// rate limit trips or the Anthropic call fails, in the exact same shape a
// live generation returns, so the visitor never sees an error, only a
// sample. Plain data, no server-only imports, so both the client component
// and the server generation route can import it.

export type MarketingEmailCategory = "soft" | "network" | "expired" | "fraud";

export const MARKETING_EMAIL_CATEGORIES: MarketingEmailCategory[] = [
  "soft",
  "network",
  "expired",
  "fraud",
];

export interface MarketingEmailCopy {
  subject: string;
  body: string;
}

export const MARKETING_EMAIL_FALLBACKS: Record<MarketingEmailCategory, MarketingEmailCopy> = {
  soft: {
    subject: "Your Growth plan payment didn't go through",
    body: `Hi Jordan,

Your card was declined for the $149 Growth plan payment, looks like insufficient funds. These things happen.

Could you update your card or check the balance? Here's your billing page:
{{update_url}}

If you've already sorted it, feel free to ignore this. We'll retry the charge in a couple days either way.

Thanks,
The Northline team`,
  },
  network: {
    subject: "A payment hiccup on your Starter plan",
    body: `Hi Priya,

We tried to charge your card for the $49 Starter plan and the payment processor returned an error. Nothing wrong on your end, sometimes the card networks just drop a transaction.

We'll retry automatically. If it fails again, you can update your payment method here:
{{update_url}}

Best,
The Buildkit team`,
  },
  expired: {
    subject: "Quick heads up, your card on file expired",
    body: `Hi Sam,

The card we have on file for your Pro plan ($89/mo) expired. Your next payment won't go through until you swap it out.

Takes about 30 seconds:
{{update_url}}

No rush, but if we can't collect in the next few days your account will pause.

Cheers,
The Claritask team`,
  },
  fraud: {
    subject: "Your bank blocked your Business plan payment",
    body: `Hi Morgan,

Your $299 Business plan charge was declined because your bank flagged it, usually their fraud filters catching something unusual.

Two options: call your bank and approve the charge, or add a different card here:
{{update_url}}

We'll hold your account active for a few days while you sort it out.

Thanks,
The Launchpad team`,
  },
};
