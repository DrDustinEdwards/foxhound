import type { DeclineCodeContent } from "./content";

export const OTHER_DECLINE_CONTENT: Record<string, DeclineCodeContent> = {
  card_velocity_exceeded: {
    meaning:
      "`card_velocity_exceeded` is Stripe's decline code for a card that has hit a balance, credit limit, or transaction amount limit set by the issuer. Per Stripe's own definition, it covers all three: available balance, credit ceiling, and per-transaction amount caps. It is often handled as a soft decline elsewhere, since the limit behind it can reset.\n\nWorth stating plainly: Foxhound's decline classifier doesn't have a named rule specifically for `card_velocity_exceeded`. It isn't one of the codes the classifier singles out for particular handling. Any code the classifier doesn't recognize by name falls through to the unknown category, which fails closed: no automatic retry runs, and recovery goes straight to a card-update email. That's exactly what happens here. This isn't a case of Foxhound doing something bespoke for velocity-related declines specifically. It's the classifier's fallback behavior doing its job on a code it doesn't have special logic for.",
    whyItHappens:
      "The name suggests a count of transactions in a time window, and that reading isn't wrong: velocity limits are exactly the kind of check that catches a card getting charged repeatedly in a short span, whether from one merchant with retry logic or several merchants firing charges close together. Subscription businesses can trigger this in either direction: a merchant's own retry attempts stacking up too quickly, or a customer's card being charged by several different recurring services within the same billing window. A charge amount well beyond a card's typical transaction size can also trip a per-transaction limit even when the account's overall balance would otherwise cover it.",
    howToFix:
      "Yes, with the same caveat that applies to any velocity-related decline: retrying too soon, or retrying too many times in a short window, can make the underlying problem worse rather than better, since velocity limits are specifically designed to catch repeated attempts. A retry spaced further apart than usual, giving the velocity window time to reset, is more likely to succeed than a quick second attempt.\n\nSpace retries out generously rather than firing them close together, since a tight retry pattern is the exact behavior a velocity limit is built to catch. Keep retry counts within card network caps (35 attempts per 30 days for Mastercard, 15 for Visa), and don't escalate retry frequency just because the first attempt failed. If repeated spaced-out retries still fail, a direct customer message is a reasonable next step.",
    faqs: [
      {
        question: "Does Foxhound have special handling built for `card_velocity_exceeded`?",
        answer:
          "No. It isn't one of the codes the classifier names specifically, so it falls through to the classifier's unknown category. That category fails closed rather than defaulting to a silent retry: no automatic retry runs, and recovery goes straight to a card-update email instead.",
      },
      {
        question: 'What does "velocity exceeded" actually mean?',
        answer:
          'Per Stripe, it covers a card exceeding its balance, credit limit, or transaction amount limit. It\'s broader than just "too many transactions."',
      },
      {
        question: "Can retrying too quickly make this decline worse?",
        answer:
          "Yes. Rapid retries look like exactly the pattern a velocity limit is designed to catch, so spacing retries further apart works better than firing them back to back.",
      },
      {
        question: "Is this decline retryable at all?",
        answer:
          "In principle, yes: a delayed retry once the velocity window resets is a reasonable approach. In Foxhound's classifier specifically, this code doesn't have a dedicated bucket yet, so it currently fails closed to the unknown category instead of auto-retrying, and goes straight to a card-update email.",
      },
      {
        question: "Should I worry that an unclassified code gets less careful treatment?",
        answer:
          "No, if anything the opposite. The classifier's default for an unrecognized code is to fail closed rather than retry silently, so an unclassified code gets more caution, not less. It just means no bespoke retry rule exists yet for this specific code string.",
      },
    ],
  },

  incorrect_cvc: {
    meaning:
      "`incorrect_cvc` means the CVC or CVV security code submitted with the charge does not match what the card's issuing bank has on file. Stripe's own definition: \"The CVC number is incorrect.\" The card itself is fine and the account is in good standing. What failed is a single piece of submitted data.",
    whyItHappens:
      "Every card carries a security code, typically three digits on the back for Visa and Mastercard, four digits on the front for American Express. When a charge runs, Stripe passes that value to the issuing bank for verification. If it doesn't match, the charge fails with `incorrect_cvc`. On subscriptions, this shows up most often right after a customer updates their card details and mistypes the code, or copies it down wrong from the card itself. It is a small, human data-entry slip, not a sign of a compromised or invalid card.",
    howToFix:
      "Retrying with the same incorrect CVC produces the same decline no matter how many times it runs. The issuing bank will not authorize a charge against a security code that doesn't match its records, and nothing about time or network conditions changes that. The fix is a corrected CVC, not persistence.\n\nThe direct, honest answer here matters. Foxhound's decline classifier sorts every decline into one of six categories: soft, network, expired, fraud, revoked, or unknown. `incorrect_cvc` does not have a dedicated case in the five named categories today. A code that isn't specifically recognized falls to the unknown bucket, which fails closed rather than defaulting to a retry: no automatic retry runs against it. In practice, that means an `incorrect_cvc` failure goes straight to a card-update email rather than a silent retry attempt, which happens to be the right outcome anyway, since retrying cannot fix a genuinely wrong security code any more than retrying fixes a wrong password.\n\nThat's exactly why going straight to a card-update prompt, rather than waiting on a retry, is the right approach here: a simple, non-alarming message such as \"we had trouble processing your payment, please confirm your card details\" resolves this faster than any retry could have anyway.",
    faqs: [
      {
        question: "Does `incorrect_cvc` mean the card is stolen or blocked?",
        answer:
          "No. It means the specific security code submitted with the charge didn't match the issuing bank's records. The card and account are otherwise unaffected.",
      },
      {
        question:
          "Will retrying the same charge eventually get an `incorrect_cvc` decline to succeed?",
        answer:
          "No. The same wrong CVC produces the same decline every time. Only a corrected code changes the outcome.",
      },
      {
        question: "Does Foxhound automatically email the customer for this code today?",
        answer:
          "Yes. `incorrect_cvc` isn't specifically classified in Foxhound's decline handling, so it falls to the unknown bucket, which fails closed: no automatic retry runs, and it goes straight to a card-update email instead.",
      },
      {
        question: "What should a customer do if they see this decline on their subscription?",
        answer:
          "Go straight to the payment-update page and re-enter their card's security code carefully, rather than waiting for an automatic retry to sort itself out.",
      },
      {
        question: "What's the most common real-world cause of `incorrect_cvc`?",
        answer:
          "A simple typo when a customer updates their payment details and mistypes the three or four digit code from their card.",
      },
    ],
  },

  invalid_cvc: {
    meaning:
      "`invalid_cvc` means the security code submitted with the charge failed validation against the issuing bank's records. Stripe's own definition mirrors `incorrect_cvc`: \"The CVC number is incorrect.\" Stripe applies the two codes in slightly different contexts internally, but for a merchant trying to recover the payment, the practical meaning is the same: the code the customer entered did not check out.",
    whyItHappens:
      "As with its close relative `incorrect_cvc`, this shows up most often around a payment-details update: a customer re-entering their card after a prompt to fix a failed payment, switching to a different card, or simply retyping information and getting the security code wrong. Nothing about the customer's underlying account or card standing is in question. A single field submitted with the charge didn't pass the bank's check.",
    howToFix:
      "Resubmitting the identical incorrect code will fail again, and again after that. There is no waiting period, no backoff schedule, and no number of attempts that turns a wrong security code into a right one. The only thing that changes the result is the customer supplying the correct code.\n\nBe straightforward about what your systems actually do here before promising customers anything specific. Foxhound's decline classifier sorts every decline into one of six categories: soft, network, expired, fraud, revoked, or unknown. `invalid_cvc` is not one of the codes given a dedicated case in the five named categories. Anything not specifically recognized falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs. So today, an `invalid_cvc` failure goes straight to a card-update email rather than a silent retry, which is the correct outcome here since a retry has no real chance of correcting a submitted security code that simply doesn't match.\n\nThat's the same reason skipping straight to a card-update message, rather than a retry, is the right call: framing the outreach plainly, without over-explaining the CVC mismatch, keeps the ask simple, confirm your card details.",
    faqs: [
      {
        question:
          "Is `invalid_cvc` different from `incorrect_cvc` in a way that changes how a merchant should respond?",
        answer:
          "Not in practice. Stripe uses the two codes in slightly different situations, but for recovery purposes both mean the submitted security code didn't validate, and both need a corrected code from the customer.",
      },
      {
        question: "Can a customer's bank clear an `invalid_cvc` decline on its own over time?",
        answer:
          "No. There's nothing time-dependent here. The code either matches the bank's records or it doesn't, and that doesn't change without new input from the customer.",
      },
      {
        question:
          "Does Foxhound currently send an immediate, purpose-built email for `invalid_cvc`?",
        answer:
          "Yes, functionally. This code isn't specifically classified in Foxhound's decline handling, so it falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs, and recovery goes straight to a card-update email instead.",
      },
      {
        question: "What's the fastest fix a merchant can suggest to a customer?",
        answer:
          "A direct link to update payment details, with a plain ask to re-enter the card and its security code, works faster than waiting on an automatic retry that cannot succeed against a mismatched CVC.",
      },
      {
        question: "Should a merchant be worried this decline signals fraud?",
        answer:
          "No. A mismatched security code on its own is most often a data-entry slip during a routine update, not evidence of fraudulent activity.",
      },
    ],
  },

  incorrect_number: {
    meaning:
      "`incorrect_number` means the card number submitted with the charge doesn't pass validation or doesn't match a real, issuable card. Stripe's own definition: \"The card number is incorrect.\" Almost always this comes down to a typo: a digit transposed, dropped, or misread while entering the card.",
    whyItHappens:
      "This decline shows up heavily around manual entry moments: a new customer signing up and typing their card number by hand, or an existing customer updating their payment method after a prior failure. Long card numbers, usually sixteen digits, are easy to mistype, especially on mobile keyboards or when reading the number off a physical card. Because the number itself fails basic validation before it even reaches the issuing bank in a meaningful way, this is a submission problem, not a reflection of the customer's actual card or account.",
    howToFix:
      "No amount of retrying changes a wrong card number into a right one. Every attempt against the same incorrect digits produces the same decline. The only way forward is the customer re-entering the number correctly.\n\nHere's the honest picture of what actually happens today. Foxhound's decline classifier places every decline into one of six categories: soft, network, expired, fraud, revoked, or unknown. `incorrect_number` does not have a dedicated case in the five named categories. Anything the classifier doesn't specifically recognize falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs against it. So an `incorrect_number` failure goes straight to a card-update email rather than a silent retry, which is the right outcome, since a retry has no way of succeeding against a card number that was simply typed wrong.\n\nThat's exactly why going straight to a card-update request works better than a retry ever could: a short, plain message asking the customer to confirm their payment details, without dwelling on the specific reason, tends to get faster action than waiting would.",
    faqs: [
      {
        question:
          "Does `incorrect_number` mean the customer's card was declined by their bank for a real reason?",
        answer:
          "No. The number typically never gets far enough for a genuine bank-side decision. It fails Stripe's own check because the digits don't form a valid, real card number, almost always from a typo.",
      },
      {
        question: "Will retrying the charge with the same card number eventually succeed?",
        answer:
          "No. The wrong number stays wrong across every attempt. Only a corrected number changes the result.",
      },
      {
        question: "Does Foxhound handle `incorrect_number` with an immediate no-retry email today?",
        answer:
          "Yes. This code isn't specifically classified in Foxhound's decline handling, so it falls to the unknown bucket, which fails closed: no automatic retry runs, and it goes straight to a card-update email instead.",
      },
      {
        question: "What should a merchant tell a customer who hits this decline?",
        answer:
          "Ask them to re-enter their card number carefully on the payment-update page. That resolves it faster than any automatic retry can.",
      },
      {
        question: "Is `incorrect_number` more common on any particular device or entry method?",
        answer:
          "It tends to cluster around manual entry, especially on mobile keyboards, where a long card number is easy to mistype or misread.",
      },
    ],
  },

  invalid_number: {
    meaning:
      "`invalid_number` means the card number submitted with the charge failed basic format or checksum validation. Stripe's own definition: \"The card number is incorrect.\" It carries the same practical meaning as `incorrect_number`, a submitted card number that doesn't check out, though Stripe may surface it in slightly different circumstances depending on where in the validation process the number gets rejected.",
    whyItHappens:
      "Like its close sibling, this decline clusters around moments of manual card entry: initial signup, a payment-method update after a failed charge, or a customer switching cards. A single mistyped or transposed digit, an extra digit, a missing digit, any of these can cause a card number to fail Stripe's format check before the transaction goes anywhere near the issuing bank. This is a data-entry issue, not a statement about whether the customer's actual card works.",
    howToFix:
      "Retrying the same malformed card number produces the same failure indefinitely. There's no backoff period or attempt count that turns an invalid number into a valid one. Resolution requires the customer to submit a correct number, not more attempts at the same one.\n\nHonesty about current handling matters more than a tidy story here. Foxhound's decline classifier sorts every decline into one of six categories: soft, network, expired, fraud, revoked, or unknown, and `invalid_number` isn't given a dedicated case in the five named categories. Any code the classifier doesn't specifically recognize falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs. That means an `invalid_number` failure goes straight to a card-update email rather than a silent retry, which is the correct outcome since no retry can succeed against a number that failed basic validation in the first place.\n\nThat's why sending the customer straight to the payment-update page to re-enter their card number is the right fix, not a retry: it works regardless of how the underlying decline gets classified.",
    faqs: [
      {
        question: "Is `invalid_number` the same problem as `incorrect_number`?",
        answer:
          "For recovery purposes, yes. Both mean the card number submitted with the charge didn't validate. Stripe applies them in slightly different situations, but the fix is identical: the customer needs to re-enter a correct card number.",
      },
      {
        question: "Can this decline be fixed by simply waiting and letting a retry run?",
        answer:
          "No. A malformed card number stays malformed no matter how many times the same charge runs.",
      },
      {
        question:
          "Does Foxhound currently treat `invalid_number` with a dedicated, no-retry email flow?",
        answer:
          "Yes. It isn't specifically classified in Foxhound's decline handling today, so it falls to the unknown bucket, which fails closed: no automatic retry runs, and it goes straight to a card-update email instead.",
      },
      {
        question: "What's the most reliable way to resolve `invalid_number` for a customer?",
        answer:
          "Send them straight to the payment-update page to re-enter their card number. That's the only action that actually changes the outcome.",
      },
      {
        question: "Should a merchant treat `invalid_number` as a sign of fraud or a stolen card?",
        answer:
          "Generally no. This decline usually reflects a formatting or entry error at submission, not evidence of a compromised card or fraudulent activity.",
      },
    ],
  },

  no_action_taken: {
    meaning:
      "`no_action_taken` is Stripe's decline code for a card declined for an unknown reason, and in practice it typically means the bank did not act on the authorization request, often because the request was incomplete or the bank's own processing system had an issue at that moment. This code isn't specifically named in Foxhound's decline classifier. It falls through to the classifier's unknown category, which fails closed: no automatic retry runs, unlike the named network codes.",
    whyItHappens:
      "Recurring billing systems submit authorization requests automatically, and if any piece of that request is malformed, incomplete, or arrives while the bank's own systems are having a processing issue, the bank can respond by simply not acting on it rather than issuing a clear approval or denial. That's distinct from an active rejection: nobody at the bank looked at the request and said no. The request just didn't get processed. For a subscription renewal, this means a customer's healthy, funded account can still produce a `no_action_taken` decline purely because of a hiccup in how the request was handled on the bank's side.",
    howToFix:
      "Yes. Because the bank never actually acted on the request, there's nothing to reverse or correct, just a request that needs to be resent, ideally formed the same way and given a bit of time before the resend. Treating it as a hard decline would be a mistake given what the code actually describes.\n\nInside Foxhound specifically, this code doesn't have a dedicated bucket in the classifier today, so it fails closed rather than retrying automatically: no repeat charge runs, and recovery goes straight to the same card-update email expired-card declines get. That email framing is an imperfect fit here since the card itself is usually fine, so treat the automated email as a safety-net nudge, and follow up directly on an account if the pattern repeats.",
    faqs: [
      {
        question: "Does `no_action_taken` mean the bank rejected the payment?",
        answer:
          "Not exactly. It means the bank didn't act on the authorization request at all, often due to an incomplete request or a processing issue on the bank's side, rather than issuing an active rejection.",
      },
      {
        question: "Is `no_action_taken` specifically named in Foxhound's decline classifier?",
        answer:
          "No. It isn't one of the codes the classifier explicitly recognizes, so it falls through to the classifier's unknown category, which fails closed: no automatic retry runs, and recovery goes straight to a card-update email instead.",
      },
      {
        question:
          "If a code isn't explicitly named in the classifier, does that mean it's treated as risky?",
        answer:
          "Not risky exactly, but cautious. The classifier's default for an unrecognized code is to fail closed rather than retry it silently, which is a more conservative treatment than the named, provenly-retryable network codes get.",
      },
      {
        question: "Should I contact the customer right after a `no_action_taken` decline?",
        answer:
          "In principle, not immediately. Since the request likely wasn't fully processed by the bank rather than actively denied, a retry would be the better first step. Foxhound doesn't retry this code yet: it fails closed to the unknown category, so the card-update email is the first step.",
      },
      {
        question: "How does `no_action_taken` differ from a hard decline like a closed account?",
        answer:
          "A hard decline reflects a definite, unretryable state of the account or card. `no_action_taken` reflects a request the bank never fully processed, which is why it's retryable in principle rather than final, even though Foxhound does not retry it yet.",
      },
    ],
  },

  currency_not_supported: {
    meaning:
      "Stripe declined this payment because the card cannot be charged in the currency the transaction was submitted in. This is a currency-mismatch problem, not a problem with the card's balance, status, or standing.\n\nStripe's official definition is: \"the card doesn't support the specified currency.\" Some cards, particularly certain prepaid, debit, or region-restricted cards, are only able to process transactions in specific currencies, often just the cardholder's home currency. If a charge is submitted in a currency the card isn't set up to handle, the issuing bank rejects it outright, regardless of available balance or the card's standing.",
    whyItHappens:
      "This shows up most often when a business changes its billing currency, expands into a new region, or when a customer's card was issued in a country whose currency differs from the currency the subscription is billed in. It can also appear after a customer's card was reissued (a replacement after expiration or a security event) with a narrower set of supported currencies than the original card had. The card itself may be perfectly valid and funded. It just isn't configured for this particular currency.",
    howToFix:
      "Not usefully in the same currency. Retrying the identical charge, in the identical currency, against the identical card will produce the identical decline every time, since nothing about the retry changes the fundamental mismatch.\n\nIf your billing system supports multiple settlement currencies, the most direct fix is offering the customer a way to pay in a currency their card does support. If you bill in a single currency only, the practical options are asking the customer for a different card that does support your billing currency, since a same-currency retry cannot fix a currency mismatch. This is worth flagging to a human on your team too, since a cluster of this code appearing together can indicate a business is undercharging or overcharging customers by billing in the wrong currency for a given market, not just an issue on any one customer's card.",
    faqs: [
      {
        question: "Does `currency_not_supported` mean the card is out of money?",
        answer:
          "No. It has nothing to do with balance. The card simply isn't configured to process charges in the currency the transaction was submitted in.",
      },
      {
        question: "Will retrying the same charge eventually work?",
        answer:
          "No, not in the same currency. The mismatch between the card and the billing currency doesn't change with time or repeated attempts.",
      },
      {
        question: "What's the actual fix?",
        answer:
          "Either bill the customer in a currency their card supports, if your system allows multiple settlement currencies, or ask them for a different card that does support your billing currency.",
      },
      {
        question: "Does Foxhound retry this code automatically today?",
        answer:
          "No. Foxhound's classifier has no named case for `currency_not_supported`, so it falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs, and recovery goes straight to a card-update email instead, a coarse fit for a currency mismatch but one that at least prompts a human look at the account.",
      },
      {
        question: "Should I be concerned if I see a cluster of this code across many customers?",
        answer:
          "Worth a look. A cluster can point to a broader currency-support issue in a particular market or a recent card-reissuance pattern among your customer base, not just isolated individual card problems.",
      },
    ],
  },

  call_issuer: {
    meaning:
      "Stripe declined this payment with an instruction for the cardholder to call their bank before the charge can go through. This code puts the next step in the cardholder's hands, not the merchant's.\n\nStripe's official definition is: \"the card was declined for an unknown reason.\" In practice, this code typically means the issuing bank wants to speak with the cardholder directly before allowing the charge, often tied to a security hold, a verification step, or something on the account that only the cardholder can clear by contacting the bank themselves. The merchant has no visibility into what specifically triggered the hold and no way to resolve it directly.",
    whyItHappens:
      "On recurring billing, `call_issuer` can surface for reasons like a bank's security system flagging the transaction for extra verification, a card that was recently reissued and needs a confirmation call, or an account-level hold the bank placed for reasons unrelated to this specific merchant at all. It's frustrating precisely because the fix sits entirely outside the merchant's control: only the cardholder, on the phone with their own bank, can typically clear it.",
    howToFix:
      "Not productively until the cardholder has actually contacted their bank. An automated retry with no change in circumstances will most likely hit the same hold again, since nothing about a repeated charge attempt satisfies whatever verification the bank is waiting on.\n\nThe customer needs to be told, clearly, that their bank wants to hear from them directly. A vague \"your payment failed, please update your card\" message is the wrong message here, since updating the card won't help if the same bank places the same hold on the replacement. Be specific in the customer communication: their bank has asked them to call, and once they've done that, the charge (or a retry of it) should go through normally. Giving a specific, accurate explanation here tends to produce faster resolution than a generic dunning message would.",
    faqs: [
      {
        question: "What does the customer actually need to do?",
        answer:
          "Call their bank. The issuer has placed a hold that typically requires the cardholder to verify something directly with them before the charge will go through.",
      },
      {
        question: 'Will a generic "update your card" email fix this?',
        answer:
          "Usually not. If the customer just adds a new card without calling their bank, the same kind of hold can reappear, since the issue is with the bank's verification process, not the card number itself.",
      },
      {
        question: "Does Foxhound know to send a different message for this code?",
        answer:
          "Not a purpose-built one yet. Foxhound's classifier has no named case for `call_issuer`, so it falls to the unknown bucket, which fails closed rather than retrying automatically: no repeat charge runs, and recovery goes straight to the standard card-update email instead of a message asking the customer to call their bank specifically.",
      },
      {
        question: "Can a scheduled retry ever succeed for this code?",
        answer:
          "Yes, if the customer has contacted their bank in the meantime and the hold has been cleared, a later retry with the same card can succeed without needing a new payment method at all.",
      },
      {
        question: "Is this a sign of fraud on the account?",
        answer:
          "Not necessarily. It's often a routine security or verification hold from the issuing bank rather than any indication of wrongdoing by the cardholder or the merchant.",
      },
    ],
  },

  duplicate_transaction: {
    meaning:
      "Stripe declined this payment because it looks like a duplicate: a transaction with the identical amount and card details was submitted very recently. This is most often a sign of something happening on the merchant's side of the integration, not a problem with the customer's card.\n\nStripe's official definition is: \"a transaction with identical amount and credit card information was submitted very recently.\" Card networks and issuing banks include duplicate detection specifically to prevent accidental double-charging, and this code is that protection kicking in. It compares the amount and card details of an incoming charge against very recent activity and blocks anything that looks like an accidental repeat.",
    whyItHappens:
      "For recurring billing, `duplicate_transaction` usually points to something in the billing integration rather than anything about the customer. Common causes include a webhook firing more than once for the same invoice and triggering two charge attempts, an automated retry system overlapping with a manual retry a support agent triggered separately, or a race condition where two processes both try to collect on the same invoice around the same time. The customer's card is very likely fine. The charge attempt itself was simply submitted twice.",
    howToFix:
      "Not in the sense of retrying the identical charge again immediately, since that will likely trigger the same duplicate check a second time. The more useful question isn't whether to retry the charge, it's why two nearly identical charge attempts happened in the first place.\n\nCheck your own integration before assuming anything is wrong with the customer's payment method. Look at whether a webhook fired multiple times for the same invoice, whether an automated dunning retry overlapped with a manual one, or whether two separate systems both attempted to collect on the same invoice around the same time. Once the duplicate submission is understood, a single, cleanly spaced retry after the network's own duplicate-detection window has passed will usually succeed without issue, since the card and the amount were never actually the problem.",
    faqs: [
      {
        question: "Is `duplicate_transaction` usually the customer's fault?",
        answer:
          "No. It almost always reflects two nearly identical charge attempts submitted close together from the merchant side, not an issue with the customer's card.",
      },
      {
        question: "Should I retry immediately?",
        answer:
          "Not right away. An immediate retry with the same amount and card can trigger the same duplicate check again. Space the retry out, and figure out why two attempts happened in the first place.",
      },
      {
        question: "What should I check in my own systems?",
        answer:
          "Look for webhooks firing more than once for the same invoice, overlapping automated and manual retries, or two processes both trying to collect on the same invoice at once.",
      },
      {
        question: "Does Foxhound handle this differently from other unclassified codes?",
        answer:
          "Not specially. It falls to the same unknown bucket every other unrecognized code does, which fails closed rather than retrying automatically. For `duplicate_transaction` specifically that email-based fallback is an imperfect fit, since the card was never actually the problem, so this is a good code to review manually if it recurs rather than relying on the automated path alone.",
      },
      {
        question: "If I see this code repeatedly, what does that mean?",
        answer:
          "It's a strong signal to audit your billing integration for overlapping retries or duplicate webhook firing, rather than a sign that something is wrong with your customers' cards.",
      },
    ],
  },
};
