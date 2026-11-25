import { SOFT_DECLINE_CONTENT } from "./content-soft";
import { NETWORK_DECLINE_CONTENT } from "./content-network";
import { EXPIRED_DECLINE_CONTENT } from "./content-expired";
import { FRAUD_DECLINE_CONTENT } from "./content-fraud";
import { OTHER_DECLINE_CONTENT } from "./content-other";

interface DeclineFaq {
  question: string;
  answer: string;
}

export interface DeclineCodeContent {
  meaning: string;
  whyItHappens: string;
  howToFix: string;
  faqs: DeclineFaq[];
}

export const DECLINE_CONTENT: Record<string, DeclineCodeContent> = {
  ...SOFT_DECLINE_CONTENT,
  ...NETWORK_DECLINE_CONTENT,
  ...EXPIRED_DECLINE_CONTENT,
  ...FRAUD_DECLINE_CONTENT,
  ...OTHER_DECLINE_CONTENT,
};
