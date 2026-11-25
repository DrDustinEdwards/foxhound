import type { DeclineCodeContent } from "./content";

export const NETWORK_DECLINE_CONTENT: Record<string, DeclineCodeContent> = {
  processing_error: {
    meaning:
      "`processing_error` means Stripe's official definition is direct: an error occurred while processing the card. This is not a fraud flag, not a declined-for-insufficient-funds message, and not an expired card. Something in the technical chain between Stripe and the issuing bank broke down mid-transaction. The charge failed because a system hiccup interrupted it, not because the card itself was rejected.",
    whyItHappens:
      "The most common cause is a bank system outage or maintenance window on the issuing side. These are usually short, minutes to a few hours, and resolve on their own. A second cause is a network timeout between Stripe and the issuing bank: if the authorization request doesn't get a response within the timeout threshold, Stripe returns a processing error instead of leaving the charge in limbo. A less common cause is load on Stripe's own infrastructure during peak processing windows, which affects a small percentage of requests and clears up once volume normalizes. For a recurring subscription charge, none of these causes have anything to do with the customer's card, balance, or account standing. The timing is just unlucky.",
    howToFix:
      'Yes. This is a soft, technical decline, and retrying after a short delay resolves it in the large majority of cases. There is no reason to treat it like a card problem or ask the customer to update their payment method, at least not on the first pass.\n\nA retry window of 2 to 6 hours catches most instances, since that covers typical bank maintenance windows and transient network issues. A second retry at roughly 24 hours catches anything that lingered past the first attempt. Because this decline is never the customer\'s fault, best practice is to hold off on any customer-facing email until retries are exhausted. Sending a "please update your card" message for a problem that had nothing to do with their card creates confusion and unnecessary support tickets.',
    faqs: [
      {
        question: "Does `processing_error` mean the customer's card was declined?",
        answer:
          "Not in the usual sense. The card itself wasn't rejected for fraud, funds, or expiration. A technical fault interrupted the transaction before it could complete, most often on the bank's side or in the network path between Stripe and the issuer.",
      },
      {
        question: "Should I email the customer right away when I see `processing_error`?",
        answer:
          "No. Since the cause is technical and usually resolves within hours, an immediate email asking them to update their card is misleading and can create support friction. Wait until retries have run their course.",
      },
      {
        question:
          "How long should I wait before retrying a charge that failed with `processing_error`?",
        answer:
          "A first retry between 2 and 6 hours after the failure covers most bank maintenance windows and network timeouts. A second retry around the 24 hour mark catches slower-resolving issues.",
      },
      {
        question: "Is `processing_error` the same thing as a card being declined for fraud?",
        answer:
          "No. Fraud declines come from the issuer's risk systems flagging the transaction. `processing_error` comes from a breakdown somewhere in the technical processing chain, unrelated to the transaction's legitimacy.",
      },
      {
        question:
          "Will retrying the same charge repeatedly eventually work if `processing_error` keeps recurring?",
        answer:
          "Usually the first or second retry succeeds once the underlying outage or network issue clears. If a charge keeps failing with this code across multiple retries over several days, it's worth treating it more like a persistent card issue and reaching out to the customer.",
      },
    ],
  },

  card_error: {
    meaning:
      "`card_error` is Stripe's code for a fault that occurs while reading or validating the card itself during a transaction attempt, distinct from `processing_error`'s broader network-and-system framing. Stripe's own documentation describes it plainly: an error occurred while processing the card. Nothing about this code reflects a considered decision by the issuing bank to reject the charge; the transaction failed before it ever reached that decision point.",
    whyItHappens:
      "This surfaces most often from a malformed or incomplete response passed back through the card network while Stripe or the issuer's system was reading the card's stored data, a timing gap in that same read-and-validate step, or a transient fault on the issuer's side specifically tied to validating the card details rather than evaluating the charge itself. It sits close to `processing_error` in cause, both are technical rather than a decision, but it is scoped tighter: to the card-reading and validation step specifically, rather than the transaction pipeline as a whole. For a recurring subscription charge, none of this has anything to do with the customer's balance, standing, or the card's legitimacy.",
    howToFix:
      "Treat it the same way as other soft, technical declines: a short-delay retry resolves the large majority of occurrences without ever involving the customer. A first retry within a few hours catches most transient card-read faults. If the same charge keeps failing with this exact code across several spaced-out attempts, that pattern is worth escalating to a direct customer message rather than continuing to retry indefinitely, since a card that consistently fails validation can reflect a genuine underlying data problem, a corrupted card-on-file record, for instance, that only a fresh card entry actually fixes.",
    faqs: [
      {
        question: "Is `card_error` different from `processing_error`?",
        answer:
          "They're closely related technical fault codes, both reflect a system-level hiccup rather than a considered decision by the issuer, but `card_error` is scoped specifically to the card-reading and validation step, while `processing_error` covers a broader range of technical breakdowns across the transaction pipeline.",
      },
      {
        question: "Does this affect only certain card types?",
        answer:
          "No particular card type is inherently more prone to it. It's a processing-path issue tied to how the card data was read or validated during that specific attempt, not a property of the card itself.",
      },
      {
        question: "Will the customer notice anything if a retry succeeds quickly?",
        answer:
          "No. A quick, silent retry that succeeds is invisible to the customer, which is exactly the intent behind treating this as a soft, retryable decline rather than an immediate customer-facing failure.",
      },
      {
        question:
          "Should repeated `card_error` failures against the same card ever be treated as a sign the stored card data is bad?",
        answer:
          "Yes. If it keeps recurring against the same card across multiple spaced-out retries rather than clearing after one or two attempts, that pattern is worth a direct customer message asking them to re-enter their card, rather than continuing to retry against a record that may be the actual problem.",
      },
      {
        question: "Is `card_error` a fraud signal?",
        answer:
          "No. It reflects a technical fault in reading or validating the card during the attempt, not a risk-based decision by the issuer or by Stripe's own fraud systems.",
      },
    ],
  },

  issuer_not_available: {
    meaning:
      "`issuer_not_available` is Stripe's decline code for a specific, well-defined situation: the card issuer couldn't be reached, so the payment couldn't be authorized. Stripe never got a yes or no answer from the bank. The charge didn't fail because the bank said no, it failed because the bank never responded at all.",
    whyItHappens:
      "This is an availability problem on the issuer's end. Banks run maintenance windows, have occasional system outages, or experience connectivity issues on their authorization networks, and any of those can leave Stripe's request unanswered. For subscription billing specifically, this means a perfectly healthy card with plenty of available balance can still fail a renewal charge purely because the bank's systems were briefly unreachable at the exact moment the charge went out. There's no signal here about the cardholder's creditworthiness, balance, or intent. It's purely a connectivity gap.",
    howToFix:
      "Yes, and it's one of the more clearly retryable codes in the network category precisely because the definition rules out any card-condition explanation. Once the issuer's systems are back online or reachable, a retry of the same charge typically goes through without issue.\n\nTreat it with the same tiered retry approach as other network declines: an early attempt a few hours out to catch short outages, and a second attempt around 24 hours later to catch longer maintenance windows. Because this decline says nothing about the card or the customer's account, there is no reason to contact the customer before retries have run. A dunning email asking someone to fix their payment method when their bank was simply offline for an hour creates unnecessary friction and looks like a mistake on the merchant's part.",
    faqs: [
      {
        question: "Does `issuer_not_available` mean my customer's card was rejected?",
        answer:
          "No. It means Stripe's request never reached the bank, or the bank never responded. There was no yes or no answer from the issuer at all, so nothing about the card was actually evaluated.",
      },
      {
        question:
          "Is `issuer_not_available` connected to the customer's account balance or credit standing?",
        answer:
          "No. It's a connectivity and availability issue on the issuing bank's side, unrelated to whether the customer has enough funds or good standing on the account.",
      },
      {
        question: "How quickly does `issuer_not_available` usually resolve?",
        answer:
          "Most instances clear within a few hours as the bank's systems come back online. A small number take closer to a day if the outage or maintenance window runs long.",
      },
      {
        question:
          "Should I flag the account or restrict access after an `issuer_not_available` decline?",
        answer:
          "No. Since the cause sits entirely on the bank's side, there's no reason to treat the account as risky or the card as invalid. Retry and move on.",
      },
      {
        question:
          "Does Foxhound treat `issuer_not_available` differently from a card-declined-for-funds error?",
        answer:
          "Yes. Foxhound's classifier routes it into the network bucket rather than the card-condition bucket, which means faster automatic retries and no customer email while those retries are in progress.",
      },
    ],
  },

  try_again_later: {
    meaning:
      "`try_again_later` is Stripe's decline code for a card declined for an unknown reason. The bank isn't providing a specific reason (no funds message, no fraud flag, no closed-account signal), just a generic rejection that functions, in practice, as a temporary block rather than a permanent one. Stripe's guidance and the naming itself point in the same direction: this is not a final verdict on the card.",
    whyItHappens:
      "Recurring billing runs largely unattended, so it surfaces every category of decline an issuer can produce, including the vague ones. `try_again_later` often shows up when an issuer's system had a momentary issue authorizing the request: an internal system check timed out, a risk-scoring step returned an inconclusive result, or a temporary hold was in place at the moment of the charge attempt for reasons unrelated to the cardholder's actual balance or standing. Because the code carries no specific reason, it gets treated functionally the same as `processing_error`: a transient block rather than a rejection based on the card's condition.",
    howToFix:
      "Yes. Stripe's own framing (an unknown reason, not a specific hard rejection) combined with how it behaves in practice supports treating it as retryable rather than final. Waiting a short period and attempting the charge again resolves the issue in most cases.\n\nGive it the same retry cadence as other transient technical declines: an early retry in the 2 to 6 hour range, then a follow-up around 24 hours if the first attempt doesn't clear it. Skip the customer email until after retries have been exhausted. Since the decline gives no specific reason and the card itself likely isn't at fault, asking a customer to re-enter their card details prematurely tends to produce confused replies and wasted support time.",
    faqs: [
      {
        question: 'What does it mean when Stripe declines a card for an "unknown reason"?',
        answer:
          "It means the issuing bank didn't supply Stripe with a specific rejection reason like insufficient funds or a fraud flag. `try_again_later` is Stripe's label for that generic, non-specific decline.",
      },
      {
        question: "Is `try_again_later` a sign the card is no longer valid?",
        answer:
          "Not by itself. Nothing in the code indicates the card is closed, expired, or otherwise permanently unusable. It behaves as a temporary block far more often than a permanent one.",
      },
      {
        question:
          "Should I ask the customer to switch payment methods after one `try_again_later` decline?",
        answer:
          "Not immediately. Since the code gives no specific reason and often resolves on retry, it's better to attempt a background retry first and only involve the customer if retries don't succeed.",
      },
      {
        question: "How is `try_again_later` different from `processing_error`?",
        answer:
          "They're functionally close. `processing_error` points more directly at a technical failure during processing, while `try_again_later` is a vaguer, no-reason-given decline. Both are treated as transient and retryable rather than card-condition problems.",
      },
      {
        question: "Does Foxhound wait before retrying a `try_again_later` decline?",
        answer:
          "Foxhound classifies it as a network decline, which it can retry sooner than card-condition declines, since the issue is presumed to be transient rather than something wrong with the card itself.",
      },
    ],
  },

  service_unavailable: {
    meaning:
      "`service_unavailable` signals that the payment network or processor's service was temporarily unavailable at the moment the charge was attempted. Stripe doesn't publish a single official one-line definition for this code beyond the general decline reason, but the pattern is consistent: this is a systems-availability issue, not a judgment on the card or the cardholder. Something on the infrastructure side wasn't up and ready to process the request.",
    whyItHappens:
      "Payment processing runs through a chain of systems: the merchant's payment gateway, Stripe's infrastructure, card networks like Visa or Mastercard, and the issuing bank. `service_unavailable` points to a gap somewhere in that chain being temporarily down or overloaded rather than actively rejecting the request. For recurring billing, this often clusters around known high-volume periods, batch renewal runs where many subscriptions bill on the same day or the same hour, which can occasionally strain a link in that chain. It can also occur during scheduled maintenance on any system in the path. None of this reflects anything about the specific customer or card being charged.",
    howToFix:
      "Yes. This is a systems-level, transient condition, and by the time a retry is attempted the unavailable service has typically come back up. There's nothing about the card to fix here, just a window of time to wait out.\n\nSpace retries out similarly to other network declines: a first attempt within a few hours of the failure, and a second attempt around the one day mark if the first one doesn't clear it. If the merchant knows their subscription renewals cluster at a particular time of day or month, it's worth checking whether `service_unavailable` clusters around those same windows, since that points to volume-related strain rather than a random outage. As with other network-category declines, hold off on customer emails until retries have been tried. The customer did nothing wrong and telling them otherwise erodes trust.",
    faqs: [
      {
        question: "Is `service_unavailable` the same as the customer's bank being down?",
        answer:
          "Not necessarily. It can point to any part of the processing chain, the gateway, the card network, or the issuing bank, being temporarily unavailable rather than pinpointing the bank specifically.",
      },
      {
        question: "Does `service_unavailable` mean there's a problem with the customer's card?",
        answer:
          "No. It's a systems-availability issue in the payment infrastructure, not a statement about the card's condition, balance, or standing.",
      },
      {
        question: "Why would `service_unavailable` cluster around certain times of day or month?",
        answer:
          "If a merchant's subscription renewals batch together at a particular hour or date, the resulting volume spike can occasionally strain part of the processing chain, producing more `service_unavailable` declines in that window.",
      },
      {
        question: "Should I retry immediately after seeing `service_unavailable`?",
        answer:
          "An immediate retry sometimes works, but spacing the first attempt out by a few hours gives the affected system more time to recover, which improves the odds of success.",
      },
      {
        question:
          "Does Foxhound distinguish `service_unavailable` from a hard decline like an expired card?",
        answer:
          "Yes. Foxhound's classifier routes `service_unavailable` into the retryable network bucket, while expired cards go into their own bucket, which skips the early silent retries and retries once, late in the sequence, only if the card has been updated.",
      },
    ],
  },

  card_not_supported: {
    meaning:
      "`card_not_supported` is Stripe's decline code for a card that doesn't support the type of purchase being attempted. In practice this shows up on some prepaid cards, certain international card products, or card types that aren't set up to handle recurring or subscription billing at all. The card itself may work fine for other kinds of purchases, it just isn't built for this particular transaction type.",
    whyItHappens:
      "This one is worth calling out because it behaves a little differently from the purely technical declines above. Recurring billing is a specific transaction type, and not every card product is provisioned to support it. Some prepaid cards are issued only for one-time point-of-sale purchases and reject recurring authorization attempts by design. Certain cards issued outside the merchant's primary market carry network restrictions that block subscription-style charges even though the card works for standard purchases. And some card products, regardless of country, are simply configured by the issuing bank to not permit recurring charges. It is not a fraud signal and not a closed-account signal, but the underlying cause is a card capability limitation rather than a bank outage, so Foxhound does not file it with the technical network declines.",
    howToFix:
      "Stripe's guidance for this code is that the customer should use a different card. Retrying the same card asks the same card product to do something it isn't set up to do, so switching payment methods is the real fix.\n\nFoxhound sends no silent retry for this code and goes straight to customer outreach. The ask to the customer should be specific: this card doesn't support recurring charges, please add a different card, rather than a generic \"your payment failed\" message that doesn't explain what's actually needed.",
    faqs: [
      {
        question: "Why would a working credit card get declined with `card_not_supported`?",
        answer:
          "The card product itself may not be provisioned for recurring or subscription-style charges, even though it works fine for one-time purchases. This is common with certain prepaid and international cards.",
      },
      {
        question: "Is `card_not_supported` a sign of fraud?",
        answer:
          "No. It's a capability limitation on the card product, unrelated to fraud screening or the legitimacy of the transaction.",
      },
      {
        question: "Will retrying a `card_not_supported` decline eventually work?",
        answer:
          "Sometimes, if the block was a temporary network-level restriction. But if the card product structurally doesn't support recurring billing, retries will keep failing and a different payment method is needed.",
      },
      {
        question:
          "How should the customer email differ for `card_not_supported` versus a technical network decline?",
        answer:
          "It should be specific: explain that the card doesn't support recurring charges and ask for an alternative payment method, rather than a generic payment failure notice.",
      },
      {
        question:
          "Does Foxhound retry `card_not_supported` the same way it retries a technical decline like `processing_error`?",
        answer:
          "No. A technical decline gets a background retry before any customer email, but `card_not_supported` gets no silent retry: retrying the same card rarely helps, so Foxhound starts with the email asking the customer for a different card.",
      },
    ],
  },

  reenter_transaction: {
    meaning:
      "`reenter_transaction` is Stripe's decline code for a payment the issuer couldn't process for an unknown reason. Like other codes in this family, it carries no specific rejection reason such as insufficient funds, fraud, or an expired card. The name itself suggests the underlying signal from the card network: something about how the transaction was submitted or processed didn't go through cleanly on the issuer's end, and resubmitting it is the expected next step.",
    whyItHappens:
      "For recurring charges, this typically surfaces when the issuer's processing systems hit a snag handling the specific authorization request, without anything wrong with the card or account behind it. It can result from a momentary glitch in how the transaction data moved through the issuer's systems, a brief internal processing fault on their end, or a transient state that cleared shortly after. Subscription billing systems submit these charges without a human present to notice or immediately retry, so a code like this can sit unresolved until the merchant's own retry logic picks it up.",
    howToFix:
      "Yes. Both the code's name and Stripe's definition point toward a transient issue rather than a final rejection. Submitting the charge again, typically after a short wait, is the correct and expected response.\n\nApply the same tiered retry timing used for other unknown-reason and technical declines: an initial retry a few hours after the failure, and a second one around 24 hours later if needed. Because the decline gives no indication of a card or account problem, avoid sending a payment update request to the customer until the retry attempts have run their course. Prematurely asking someone to change their card for an issue that was entirely on the processing side tends to generate confused replies rather than resolved payments.",
    faqs: [
      {
        question: 'What does "reenter transaction" actually mean in plain terms?',
        answer:
          "The issuer's systems couldn't process the payment request as submitted, for reasons that aren't specified, and the expected fix is to submit the transaction again.",
      },
      {
        question: "Does `reenter_transaction` indicate a problem with the customer's card?",
        answer:
          "No. Stripe's definition attributes the failure to the issuer's inability to process the transaction, not to anything about the card's funds, validity, or standing.",
      },
      {
        question: "How is `reenter_transaction` different from `try_again_later`?",
        answer:
          "Both are unknown-reason declines treated as transient, but `try_again_later` reads as a generic card decline while `reenter_transaction` points more specifically at a processing hiccup on the issuer's side during the transaction itself.",
      },
      {
        question: "How soon should a retry happen after a `reenter_transaction` decline?",
        answer:
          "A few hours after the initial failure is a reasonable first attempt, with a second retry around the one day mark if the charge still hasn't gone through.",
      },
      {
        question:
          "Will Foxhound email the customer right away about a `reenter_transaction` decline?",
        answer:
          "No. Since it's classified as a network decline, Foxhound retries automatically in the background first and only starts the merchant's email sequence if those retries don't succeed.",
      },
    ],
  },
};
