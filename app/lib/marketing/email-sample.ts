// The home page's live email generator, its shapes. Plain data,
// no server-only imports, so both the client component and the server
// generation route can import it.
//
// There is no stored fallback sample any more. One was shown when the model
// call failed or the visitor was over the rate limit, under a line saying it
// was generated in real time, which it was not. Recova shows "Generation
// failed. Try again." there (components/marketing/EmailGenerator.tsx, blob
// c4592a56), and so does Foxhound now (M3 divergence 28).

export type MarketingEmailCategory = "soft" | "network" | "expired" | "fraud";

export const MARKETING_EMAIL_CATEGORIES: MarketingEmailCategory[] = ["soft", "network", "expired", "fraud"];

export interface MarketingEmailCopy {
  subject: string;
  body: string;
}

/** What the generation route answers: an email, or that it could not make one. */
export type MarketingEmailResult = MarketingEmailCopy | { error: true };
