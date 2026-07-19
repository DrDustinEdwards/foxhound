// Per-code marketing copy for the /decline-codes library (Phase 6 Pass 3).
//
// NOTE ON SOURCING: as of this pass, neither of the two Capsid content docs
// (phase6-content-decline-codes.md, phase6-content-comparisons.md) existed
// yet (checked at session start and again before writing this file). This
// content is therefore Pass 3 TEMPLATE COPY: correct, non-fabricated
// explanations of what each Stripe decline code means grounded in ordinary
// payments-industry knowledge, not sourced from a dedicated content pass. A
// follow-up pass should refine tone and depth per the eventual content doc.
// The page component renders a visible "Draft content" note for this reason
// (see app/routes/decline-codes/code.tsx). No recovery-rate numbers appear
// anywhere here (hard requirement, no platform data exists yet).
//
// Category (soft/network/expired/fraud) and retryability are NEVER
// hand-authored here: every page reads them live from
// app/lib/decline-codes/codes.ts, which calls classifyDecline()/isRetryable()
// directly. This file only holds the code-specific explanatory prose.

export interface DeclineFaq {
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
  insufficient_funds: {
    meaning:
      "insufficient_funds means the card's issuing bank looked at the account balance or available credit and declined the charge because there was not enough available to cover it. Stripe returns this code verbatim from the issuer; it is not a Stripe-side judgment call.",
    whyItHappens:
      "For subscription billing, this is usually simple timing. A customer's payday, an overdrawn checking account tied to a debit card, or a credit card sitting close to its limit are the common cases. It is rarely a sign the customer wants to cancel: most insufficient_funds declines resolve themselves within days once the account is funded again, which is exactly why retry timing matters more than retry count.",
    howToFix:
      "Do not switch the customer to a different payment method automatically and do not cancel the subscription on the first failure. Wait a few days before retrying rather than retrying immediately, since an immediate retry against the same empty account almost always fails again and can trigger card-network rate-limit flags. If the failure repeats across a full billing cycle, a plain, non-alarming email asking the customer to check their funding is more effective than an urgent one.",
    faqs: [
      {
        question: "Does insufficient_funds mean the customer canceled their card?",
        answer:
          "No. The card is still open and valid. The issuer simply will not authorize this specific charge amount right now because of the account balance.",
      },
      {
        question: "Should I retry immediately or wait?",
        answer:
          "Wait. An immediate retry against the same shortfall almost always fails again, and immediate re-attempts are one of the patterns issuers and card networks watch for when rate-limiting an account.",
      },
      {
        question: "Is this the most common decline code?",
        answer:
          "Among subscription businesses, it is consistently one of the most common reasons a recurring charge fails, alongside expired cards.",
      },
    ],
  },

  do_not_honor: {
    meaning:
      "do_not_honor is a catch-all decline from the issuing bank that does not map to a more specific reason. The bank is refusing the transaction but is not required to (and usually does not) tell Stripe or the merchant exactly why.",
    whyItHappens:
      "Because it is a generic refusal, the underlying cause varies: a bank's internal fraud model flagged the transaction pattern, the card has restrictions the cardholder is not aware of, or the issuer's risk rules simply do not like something about this specific charge (amount, merchant category, timing). It is one of the least specific decline codes Stripe surfaces.",
    howToFix:
      "Because the true cause is opaque, the safest default is to treat it as a soft, retryable decline rather than assuming fraud. A dunning email that asks the customer to confirm with their bank that a charge from the merchant's name is expected often resolves it, since many do_not_honor declines clear once the cardholder calls their bank once.",
    faqs: [
      {
        question: "Is do_not_honor a fraud signal?",
        answer:
          "Not necessarily. It is Stripe's most generic decline passthrough. Some do_not_honor declines are fraud-model false positives on an otherwise legitimate charge, which is why Foxhound treats it as soft rather than fraud by default.",
      },
      {
        question: "Why won't the bank say more?",
        answer:
          "Card networks do not require issuers to disclose their internal decision logic, and issuers often decline to for their own fraud-model security.",
      },
      {
        question: "What can the customer do about it?",
        answer:
          "Calling the number on the back of their card and confirming the charge is legitimate resolves a large share of do_not_honor declines.",
      },
    ],
  },

  generic_decline: {
    meaning:
      "generic_decline is Stripe's fallback label when a card is declined but the issuer response does not map to any of Stripe's more specific decline codes. It is the least informative code in the whole list.",
    whyItHappens:
      "This shows up when an issuing bank's response is malformed, unusual, or simply not something Stripe's mapping table recognizes. It says nothing definitive about funds, fraud, or card status, only that the charge did not go through.",
    howToFix:
      "Treat it the same way as do_not_honor: as a soft, retryable decline until repeated failures suggest otherwise. A short delay before retry plus a plain dunning email covers the large majority of cases, since most generic_decline failures are transient.",
    faqs: [
      {
        question: "Is generic_decline worse than a specific code?",
        answer:
          "Not inherently. It carries less information, but the underlying cause is often just as ordinary as insufficient_funds or a temporary issuer hiccup.",
      },
      {
        question: "Should I contact the customer differently for this code?",
        answer:
          "No special framing is needed. A standard, non-alarming payment-failed email works, since assuming the worst here is not supported by the code itself.",
      },
      {
        question: "Does Stripe ever provide more detail later for the same charge?",
        answer:
          "Occasionally a retry against the same card surfaces a more specific code on a later attempt, which is one more reason not to give up after a single generic_decline.",
      },
    ],
  },

  card_declined: {
    meaning:
      "card_declined is a general decline returned when the issuer rejects the charge without Stripe having a more specific reason code to attach. It behaves like a close cousin of generic_decline and do_not_honor.",
    whyItHappens:
      "Common underlying causes include a card that has been closed or replaced without the merchant knowing yet, a spending control the cardholder has set on the card, or a routine issuer-side rejection with no further detail passed back to Stripe.",
    howToFix:
      "Retry after a short delay and fall back to a dunning email if the decline repeats. Because this code does not indicate fraud or expiration specifically, jumping straight to a card-update request is usually premature; give the existing card a fair chance first.",
    faqs: [
      {
        question: "Is card_declined the same as do_not_honor?",
        answer:
          "They are closely related generic decline paths. Neither carries enough detail on its own to justify treating the customer as fraudulent or the card as dead.",
      },
      {
        question: "Could this mean the card was replaced?",
        answer:
          "It can, especially if the decline persists across multiple attempts over a week or more. A gentle prompt to confirm the card on file is current handles that case without alarming the customer.",
      },
      {
        question: "Will retries eventually stop working if the card was replaced?",
        answer:
          "Yes, and that is expected. The dunning sequence's card-update link exists exactly for this scenario, since a replaced card cannot be recovered by retrying the old number.",
      },
    ],
  },

  transaction_not_allowed: {
    meaning:
      "transaction_not_allowed means the issuer's rules do not permit this particular type of transaction on this card, independent of available balance or fraud concerns.",
    whyItHappens:
      "Some cards, especially certain debit, prepaid, or corporate cards, are configured by the issuer or the cardholder's employer to block specific transaction types: recurring charges, charges over a certain amount, or charges from specific merchant categories. The block is a rule, not a balance or fraud problem.",
    howToFix:
      "A retry against the identical card rarely helps because the restriction is structural, not transient. The most effective path is a dunning email that plainly explains the charge type was blocked by the card issuer and asks the customer to check with their bank or, if available, use a different card.",
    faqs: [
      {
        question: "Will retrying the same card eventually work?",
        answer:
          "Usually not, since the restriction is a rule the issuer applies to every attempt of that transaction type, not a one-time balance issue.",
      },
      {
        question: "Is this common on corporate or prepaid cards?",
        answer:
          "Yes. Corporate cards with spending controls and some prepaid cards commonly block recurring subscription charges by default.",
      },
      {
        question: "Should the customer add a different card?",
        answer:
          "That is usually the fastest resolution when the block is structural rather than a fixable account setting.",
      },
    ],
  },

  withdrawal_count_limit_exceeded: {
    meaning:
      "withdrawal_count_limit_exceeded means the issuer has capped how many withdrawals or charges are allowed against this account in a given period, and this attempt would exceed that cap.",
    whyItHappens:
      "This is most common on certain savings-style or regulated deposit accounts tied to a debit card, which historically limited the number of outgoing transactions per statement cycle, and on some prepaid or limited-use cards with issuer-set transaction caps.",
    howToFix:
      "Retrying immediately will not help since the limit resets on the issuer's schedule, not on a retry. A dunning email suggesting the customer try again after their next statement cycle, or switch to a different card entirely, resolves this more reliably than repeated attempts.",
    faqs: [
      {
        question: "Will this decline clear on its own?",
        answer:
          "Yes, typically once the account's withdrawal count resets at the start of its next cycle, which is set by the issuer, not by Stripe or Foxhound.",
      },
      {
        question: "Is this related to fraud?",
        answer:
          "No. It is an account-level transaction cap, unrelated to fraud or the cardholder's identity.",
      },
      {
        question: "Is a card-update prompt the right response?",
        answer:
          "It can help if the customer has another card available, since the current one will keep hitting the same cap on a repeat attempt within the same cycle.",
      },
    ],
  },

  processing_error: {
    meaning:
      "processing_error means something went wrong on the processing side of the transaction, at the card network, the issuer's systems, or in transit, rather than the issuer making a deliberate decision to decline.",
    whyItHappens:
      "This is typically a transient, infrastructure-level hiccup: a timeout, a dropped connection between systems, or a momentary processing fault at the issuer or network. It carries no signal about the cardholder, their balance, or fraud.",
    howToFix:
      "This is the clearest case for a fast, automatic retry, since the same charge attempted moments later frequently succeeds once the transient fault clears. There is little reason to involve the customer at all unless the error repeats across several attempts.",
    faqs: [
      {
        question: "Does processing_error mean the card is bad?",
        answer:
          "No. It says nothing about the card or the customer at all, only that something failed on the processing path for this specific attempt.",
      },
      {
        question: "How quickly should a retry happen?",
        answer:
          "Sooner than for balance-related declines, since the fault is usually momentary rather than something that needs days to resolve.",
      },
      {
        question: "Should the customer be notified on the first occurrence?",
        answer:
          "Not usually. A single processing_error is ordinary background noise in card processing and typically clears on the next attempt.",
      },
    ],
  },

  card_error: {
    meaning:
      "card_error is a network- or issuer-side fault reading or validating the card itself during the transaction, separate from a deliberate decision to reject the charge.",
    whyItHappens:
      "This can surface from a malformed response passed back through the card network, a temporary issue at the issuer validating the card details, or a processing hiccup similar in nature to processing_error but specifically tied to the card-validation step.",
    howToFix:
      "Treat it as a transient, retryable fault. A short-delay retry resolves most occurrences without ever involving the customer; only a repeated pattern across multiple attempts justifies an email.",
    faqs: [
      {
        question: "Is card_error different from processing_error?",
        answer:
          "They are closely related transient fault codes. Both indicate a system-level hiccup rather than a considered decision by the issuer.",
      },
      {
        question: "Does this affect only certain card types?",
        answer:
          "No particular card type is more prone to it; it is a processing-path issue, not a property of the card itself.",
      },
      {
        question: "Will the customer notice anything if the retry succeeds quickly?",
        answer:
          "No. A quick, silent retry that succeeds is invisible to the customer, which is exactly the intent.",
      },
    ],
  },

  issuer_not_available: {
    meaning:
      "issuer_not_available means Stripe could not reach the card's issuing bank to authorize the transaction at all. The bank's systems were unreachable at the moment of the attempt.",
    whyItHappens:
      "Issuing banks occasionally have planned maintenance windows or unplanned outages on their authorization systems. During that window, every transaction against cards from that issuer fails the same way, regardless of balance or fraud status.",
    howToFix:
      "This is squarely a retry-later situation. Retrying within minutes often hits the same outage; spacing the retry out by hours is more effective. No customer communication is warranted for an isolated occurrence.",
    faqs: [
      {
        question: "Is this the customer's fault in any way?",
        answer:
          "No. The issuer's own systems were unreachable; nothing about the customer or their card caused this.",
      },
      {
        question: "How long do these outages typically last?",
        answer:
          "It varies by issuer and incident, from minutes to a few hours, which is why spacing retries out works better than an immediate repeat.",
      },
      {
        question: "Should I ever email the customer about this code specifically?",
        answer:
          "Only if it recurs across several separate attempts on different days, since a single occurrence is normal background issuer downtime.",
      },
    ],
  },

  try_again_later: {
    meaning:
      "try_again_later is the issuer explicitly telling Stripe, in effect, exactly what the name says: the transaction did not go through this time, but the issuer is not permanently blocking it.",
    whyItHappens:
      "This usually reflects a temporary condition on the issuer's side, a brief system load spike, a momentary hold, or an internal check that could not complete in time, rather than a considered rejection of the charge.",
    howToFix:
      "A delayed retry is the right response, and it usually works. This code is one of the more literal instructions Stripe passes through: the issuer is asking for patience, not a different card.",
    faqs: [
      {
        question: "Does this ever mean the same as do_not_honor?",
        answer:
          "No. do_not_honor is typically a considered rejection; try_again_later signals a temporary condition the issuer expects to clear.",
      },
      {
        question: "How long should the delay be before retrying?",
        answer:
          "Longer than an immediate retry, short enough that the recurring charge is not needlessly delayed for days when the issuer only meant minutes to hours.",
      },
      {
        question: "Is a card update ever the right move here?",
        answer:
          "Rarely on the first occurrence. This code specifically suggests the same card will likely work again shortly.",
      },
    ],
  },

  service_unavailable: {
    meaning:
      "service_unavailable means the systems needed to process the authorization, at the card network, the issuer, or in between, were not available to complete the request.",
    whyItHappens:
      "This is an infrastructure-level condition similar to issuer_not_available but can originate from more points in the chain: the card network itself, a gateway, or the issuer's authorization service being down or overloaded at that moment.",
    howToFix:
      "Retry after a delay rather than immediately. Because the fault can be broader than a single issuer outage, if it recurs across unrelated cards and issuers at the same time, it is worth checking Stripe's own status page before assuming anything about the individual customer.",
    faqs: [
      {
        question: "Is this specific to one bank?",
        answer:
          "Not necessarily. Unlike issuer_not_available, this can originate anywhere in the authorization chain, not only at the cardholder's bank.",
      },
      {
        question: "Should the customer be told anything?",
        answer:
          "No, not for an isolated occurrence. This is infrastructure noise, not a signal about their card or account.",
      },
      {
        question: "Does this ever cluster across many customers at once?",
        answer:
          "It can, during a wider processing-network incident, which is a different situation from an individual customer's charge failing repeatedly.",
      },
    ],
  },

  card_not_supported: {
    meaning:
      "card_not_supported means the card, as presented, is not supported for this type of transaction by the issuer, the card network, or occasionally the specific processing route Stripe used.",
    whyItHappens:
      "This can happen with certain card products that are not enabled for online or recurring transactions, cards from networks or regions with limited support for a given transaction type, or corporate and virtual cards with narrow use-case restrictions.",
    howToFix:
      "A retry against the same card is unlikely to change the outcome since the limitation is structural. The more effective path is a dunning email asking the customer to use a different card, since this decline is not about funds or fraud at all.",
    faqs: [
      {
        question: "Will retrying fix card_not_supported?",
        answer:
          "Usually not. The restriction is a property of the card or route, not a temporary condition that clears with time.",
      },
      {
        question: "Is this related to international cards?",
        answer:
          "It can be, since some card products and networks have narrower support for certain transaction types depending on region.",
      },
      {
        question: "What should the customer do?",
        answer:
          "Switching to a different card is typically the fastest fix, since the current card is unsupported for this transaction type rather than temporarily blocked.",
      },
    ],
  },

  reenter_transaction: {
    meaning:
      "reenter_transaction is the issuer or network asking for the transaction to be submitted again, typically because something in the original submission did not process cleanly the first time.",
    whyItHappens:
      "This is usually a transient, mechanical issue in how the transaction was transmitted or received, closer in nature to processing_error and card_error than to a deliberate decline of the charge itself.",
    howToFix:
      "A prompt retry is exactly what the code is asking for, and it frequently succeeds. This is not a signal to contact the customer or suggest a different card unless the same result repeats several times.",
    faqs: [
      {
        question: "Does reenter_transaction mean I did something wrong?",
        answer:
          "No. It reflects a transmission-level hiccup in the original attempt, not an error in how the charge was set up.",
      },
      {
        question: "How is this different from processing_error?",
        answer:
          "They are close cousins. Both are transient, infrastructure-level conditions rather than considered declines of the charge.",
      },
      {
        question: "Is customer communication ever needed for this code?",
        answer:
          "Only if it recurs across multiple separate attempts, which would suggest something more persistent than a one-off transmission issue.",
      },
    ],
  },

  expired_card: {
    meaning:
      "expired_card means the card's expiration date has passed. The issuer is not evaluating balance or fraud at all; the card itself is no longer valid for new charges.",
    whyItHappens:
      "Cards expire on a fixed schedule printed on the card itself, and issuers typically mail a replacement before the old one expires. The gap between the old card expiring and the customer updating their payment method on file is the entire cause of this decline.",
    howToFix:
      "Retrying the identical card number and expiration will never succeed; the fix has to be a new card. The most effective response is a hosted, no-login card-update link sent by email, plus flagging the account before expiration when the expiration date is already on file, so the update happens before the charge ever fails.",
    faqs: [
      {
        question: "Will a silent retry ever recover an expired_card decline?",
        answer:
          "No. An expired card cannot be charged again under any circumstances; the only fix is updating the card on file.",
      },
      {
        question: "Can this be caught before the charge fails?",
        answer:
          "Yes, when the expiration date is already visible on the stored card, which is why an expiring-card alert ahead of the renewal date is more valuable than a reactive email after the decline.",
      },
      {
        question: "Is this the most common reason for involuntary churn?",
        answer:
          "Along with insufficient_funds, expired cards are one of the two most common causes of failed subscription renewals industry-wide.",
      },
    ],
  },

  invalid_expiry_month: {
    meaning:
      "invalid_expiry_month means the expiration month submitted with the charge does not match what the issuer has on file, or is not a valid month value at all.",
    whyItHappens:
      "This is most often a stale stored card record: the customer received a replacement card with a new expiration date, but the merchant's stored payment method still has the old month on file. It can also result from a data-entry error when the card was first added.",
    howToFix:
      "A retry with the same stored value will fail identically every time. The fix is always a card update, ideally through a hosted card-update page rather than asking the customer to somehow correct a field they cannot see.",
    faqs: [
      {
        question: "Is this the customer's fault?",
        answer:
          "Rarely. It is almost always a stored-record mismatch after a card renewal, not something the customer did incorrectly.",
      },
      {
        question: "Will retrying with the same details ever work?",
        answer:
          "No. The stored expiration month does not change on its own; only re-entering the card resolves it.",
      },
      {
        question: "How is this different from expired_card?",
        answer:
          "expired_card means the actual card has passed its expiration date. invalid_expiry_month usually means the stored month is simply wrong, often for a card that may still be valid.",
      },
    ],
  },

  invalid_expiry_year: {
    meaning:
      "invalid_expiry_year means the expiration year submitted with the charge does not match the issuer's records, or is not a valid year value.",
    whyItHappens:
      "As with invalid_expiry_month, this is typically a stale stored payment method after a card renewal, or an entry error when the card details were first captured, rather than anything about the cardholder's current standing.",
    howToFix:
      "The only real fix is a card update; a repeat charge against the same stored year will keep failing. A hosted card-update link removes the guesswork of asking a customer to diagnose which stored field is wrong.",
    faqs: [
      {
        question: "Could this indicate the card is fraudulent?",
        answer:
          "No. It is a data-mismatch condition on a specific field, unrelated to fraud.",
      },
      {
        question: "Does this often happen alongside invalid_expiry_month?",
        answer:
          "It can, particularly after a full card reissue where both the month and year on file are stale.",
      },
      {
        question: "Is a silent retry worth attempting first?",
        answer:
          "No. Unlike a balance-related decline, this will not resolve itself between attempts.",
      },
    ],
  },

  fraudulent: {
    meaning:
      "fraudulent means the issuer's fraud systems flagged this specific transaction and blocked it. This is one of the four fraud-adjacent decline codes that Foxhound never silently retries.",
    whyItHappens:
      "Issuer fraud models weigh signals like unusual transaction patterns, mismatched billing details, or a charge that looks out of character for the account. A flag here does not always mean the customer did anything wrong; it means the issuer's model scored this attempt as risky enough to block.",
    howToFix:
      "Retrying the identical charge will typically trip the same fraud flag again and can make the account look more suspicious, not less. The right response is a single, clearly worded email that names the specific situation (a payment was blocked by the customer's bank) and directs them to contact their issuer, rather than repeatedly attempting the same charge.",
    faqs: [
      {
        question: "Does Foxhound ever silently retry a fraudulent decline?",
        answer:
          "No. Fraud-classified declines are never retried without the customer's awareness. Repeated blind attempts against a fraud flag is exactly the pattern that makes accounts look worse to issuers, not better.",
      },
      {
        question: "Is the customer necessarily doing something wrong?",
        answer:
          "No. Fraud models produce false positives on legitimate charges regularly; a flag here is the issuer's risk score, not a verdict.",
      },
      {
        question: "What should the customer actually do?",
        answer:
          "Contact their card issuer directly using the number on the back of the card and confirm the charge as legitimate, which clears many fraud flags on the issuer's side.",
      },
    ],
  },

  lost_card: {
    meaning:
      "lost_card means the issuer has this specific card marked as reported lost. The card is deactivated from the issuer's side, independent of the merchant or Stripe.",
    whyItHappens:
      "The cardholder (or someone using their account) reported the physical card lost, and the issuer deactivated the card number entirely as a security measure. Every subsequent charge attempt against that number will fail identically until a new card is issued.",
    howToFix:
      "There is nothing to retry: a lost card cannot be charged again under any circumstance. The only path forward is the customer providing a new card, so the response here is a card-update prompt, not a repeat attempt.",
    faqs: [
      {
        question: "Will retrying ever work for a lost_card decline?",
        answer:
          "No, never. The card is deactivated at the issuer level and stays that way until replaced.",
      },
      {
        question: "Is this classified as fraud even though the customer reported it themselves?",
        answer:
          "It sits in the same fraud/security bucket as stolen_card because the response and the correct handling, no retries, ever, are identical regardless of who reported it.",
      },
      {
        question: "What should the email to the customer say?",
        answer:
          "A plain note that the card on file appears to have been reported lost, with a direct link to add a new card.",
      },
    ],
  },

  stolen_card: {
    meaning:
      "stolen_card means the issuer has this card marked as reported stolen. Like lost_card, the card number itself is deactivated at the issuer level.",
    whyItHappens:
      "The cardholder or the issuer identified the card as stolen and deactivated it. Every charge attempt against the number fails the same way going forward, regardless of the amount or merchant.",
    howToFix:
      "Never retry a stolen_card decline. The card cannot be reactivated by any means available to a merchant. A single, clear message asking the customer to update their payment method is the only useful next step.",
    faqs: [
      {
        question: "Could a stolen_card decline actually be a false positive?",
        answer:
          "Unlike fraudulent, this code specifically means the card was reported stolen, not merely flagged as risky. It is not a scoring judgment call.",
      },
      {
        question: "Is retrying ever safe to attempt once, just in case?",
        answer:
          "No. There is no scenario where retrying a stolen_card decline succeeds or is advisable.",
      },
      {
        question: "Does this affect the customer's other payment methods?",
        answer:
          "No. Only the specific reported card is deactivated; a different card on the same customer's account is unaffected.",
      },
    ],
  },

  pickup_card: {
    meaning:
      "pickup_card is an issuer instruction historically meaning the merchant should physically retain the card, a holdover from in-person card processing. In an online context it functions as a hard block: the card is flagged and the charge is refused.",
    whyItHappens:
      "The issuer has placed a serious restriction on this card, often tied to a lost, stolen, or otherwise compromised card report, similar in effect to lost_card and stolen_card even though the original network instruction predates card-not-present commerce.",
    howToFix:
      "Treat it identically to lost_card and stolen_card: never retry, and ask the customer for a different payment method. This code carries no ambiguity about whether the card can be used again.",
    faqs: [
      {
        question: "Does 'pickup' mean anything in an online subscription context?",
        answer:
          "Not literally. It is a legacy in-person instruction; online, it functions purely as a signal that this card is blocked and should not be retried.",
      },
      {
        question: "Is this rare for subscription billing?",
        answer:
          "Yes, it is one of the least common codes in normal recurring billing, since it typically indicates a card already flagged before this specific charge was attempted.",
      },
      {
        question: "What should the customer see?",
        answer:
          "A plain notice that their card was declined by the issuer, with a link to add a different payment method.",
      },
    ],
  },

  restricted_card: {
    meaning:
      "restricted_card means the issuer has placed a restriction on the card that blocks this transaction, separate from a straightforward fraud flag or a reported loss.",
    whyItHappens:
      "Restrictions can come from the issuer's own risk controls, regulatory limits on certain card products, or account-level holds the cardholder may not even be aware of. The common thread is that the restriction is set by the issuer, not something the merchant or Stripe can see the reason for.",
    howToFix:
      "Do not retry. Because the underlying restriction is opaque and issuer-controlled, the safest and most respectful response is a message asking the customer to contact their bank directly or provide a different card.",
    faqs: [
      {
        question: "Is restricted_card the same as fraudulent?",
        answer:
          "They are related but distinct; restricted_card points at an account-level or product-level restriction rather than a per-transaction fraud score.",
      },
      {
        question: "Can the customer resolve the restriction themselves?",
        answer:
          "Often yes, by contacting their issuer, since many restrictions are liftable account controls rather than a permanent block.",
      },
      {
        question: "Should this ever be retried after a delay, the way insufficient_funds is?",
        answer:
          "No. Unlike a balance issue, a restriction does not typically clear on its own between attempts.",
      },
    ],
  },

  security_violation: {
    meaning:
      "security_violation means the issuer or network detected something in the transaction that violated a security check, separate from a routine fraud score. It is one of the more serious declines in the fraud/security category.",
    whyItHappens:
      "This can reflect a mismatch in security data expected by the issuer (such as verification details not matching what they have on file) or a network-level security rule being triggered by the specific attempt.",
    howToFix:
      "Never retry automatically. As with the other fraud-classified codes, the correct response is a single clear message to the customer explaining that their bank blocked the charge for security reasons, directing them to their issuer rather than attempting the same charge again.",
    faqs: [
      {
        question: "Is this worse than a fraudulent decline?",
        answer:
          "Both sit in the same fraud/security category and get the identical handling: no silent retries, ever, and a direct request for the customer to involve their bank.",
      },
      {
        question: "Could this be triggered by a mismatched billing address?",
        answer:
          "It can be one contributing factor among several security checks the issuer or network runs, though the exact trigger is rarely disclosed.",
      },
      {
        question: "Should the customer try a completely different card?",
        answer:
          "That is often the fastest path forward if contacting the issuer does not quickly resolve the block.",
      },
    ],
  },

  card_velocity_exceeded: {
    meaning:
      "card_velocity_exceeded means the issuer or network has detected too many transaction attempts against this card in a short window and is blocking further attempts temporarily, a velocity control rather than a balance or fraud judgment on this specific charge.",
    whyItHappens:
      "Velocity limits exist to catch rapid-fire fraudulent testing of stolen card numbers, but they also catch legitimate patterns: a merchant retrying too aggressively, or a customer's card being charged by several unrelated services in quick succession.",
    howToFix:
      "This code is not in app/lib/recovery/decline.ts's classification sets today. classifyDecline() falls through to its documented safe default and treats it as a soft decline, which happens to be a reasonable default here too: the block is usually temporary, so spacing out any retry attempt well beyond the immediate window, rather than compounding the velocity trigger with more attempts, is the safest path until this code gets its own dedicated bucket.",
    faqs: [
      {
        question: "Is card_velocity_exceeded a dedicated category in Foxhound's recovery engine?",
        answer:
          "Not yet. It falls through classifyDecline()'s safe default and is treated as a soft, retryable decline, the same path most ordinary declines take.",
      },
      {
        question: "Will an immediate retry make this worse?",
        answer:
          "Likely yes. Retrying quickly adds to the same velocity count that triggered the block in the first place.",
      },
      {
        question: "Does this reflect badly on the customer?",
        answer:
          "No. Velocity limits are frequently tripped by unrelated legitimate activity on the same card, not by the customer doing anything wrong.",
      },
    ],
  },

  incorrect_cvc: {
    meaning:
      "incorrect_cvc means the security code (the 3 or 4 digit code on the card) submitted with the charge did not match what the issuer has on file.",
    whyItHappens:
      "For a stored payment method being charged automatically on a subscription renewal, this most often means the CVC was never actually re-validated (Stripe does not always re-submit a live CVC on every recurring charge), or the card was reissued with a new security code that the merchant's stored record does not reflect.",
    howToFix:
      "This code is not in app/lib/recovery/decline.ts's classification sets today. classifyDecline() falls through to its documented safe default and treats it as a soft decline. In practice a card update is frequently what actually resolves it, since a mismatched CVC after a card reissue behaves like a stale stored record rather than a transient balance issue, which is worth keeping in mind until this code gets its own dedicated bucket in the engine.",
    faqs: [
      {
        question: "Is incorrect_cvc classified as its own category in Foxhound's engine?",
        answer:
          "Not yet. It rides classifyDecline()'s safe default (soft) rather than a bespoke bucket, which is stated here plainly rather than glossed over.",
      },
      {
        question: "Will retrying the same stored card fix this?",
        answer:
          "Only if the CVC mismatch was a one-off processing quirk. If the card was reissued with a new code, only an updated card on file resolves it.",
      },
      {
        question: "Does this mean the card number itself is wrong?",
        answer:
          "No. The card number can be entirely valid; only the security code check failed on this attempt.",
      },
    ],
  },
};
