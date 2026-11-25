import type { DeclineCodeContent } from "./content";

export const EXPIRED_DECLINE_CONTENT: Record<string, DeclineCodeContent> = {
  expired_card: {
    meaning:
      '`expired_card` means Stripe declined the charge because the expiration date on file for the card has already passed. Stripe\'s own definition is blunt: "The card has expired." The card is not being rejected for fraud, insufficient funds, or a bank-side hold. It is being rejected because the expiration date stored on the payment method is no longer valid.',
    whyItHappens:
      "Subscription billing charges the same stored card weeks or months after the customer first entered it. In that window, cards routinely get reissued: banks send new physical cards with new expiration dates (and sometimes new numbers) ahead of the old card's expiry, for security reasons or simple card-program refreshes. A customer may already be using their new card everywhere else while the old, expired one is still the only payment method on file with your subscription.",
    howToFix:
      "No. This is not a soft decline that clears up with time, and it is not a network hiccup. The expiration date is objectively wrong. Submitting the identical charge again, an hour later or a week later, produces the identical decline every time. No retry schedule fixes a data problem.\n\nThe card networks run updater services, Visa's Account Updater and Mastercard's Automatic Billing Updater, that push new card details to merchants when a card is reissued or renewed. When it works, the card on file gets refreshed quietly before a charge ever fails. Coverage is real but uneven: it is strongest for major US-issued Visa and Mastercard cards, and noticeably weaker for cards issued outside the US, American Express cards, and smaller regional issuers. The `expired_card` failures you actually see are concentrated in that coverage gap.\n\nBecause retrying wastes a charge attempt and delays the fix, the right response is to stop retrying and ask the customer directly. A message sent close to the known expiration date, before the next billing cycle even runs, prevents most of these failures outright. For the ones that still happen, a fast, clear request to update payment details is the only lever that works.",
    faqs: [
      {
        question: "Does `expired_card` mean the customer's account is in bad standing?",
        answer:
          "No. It only means the specific card on file is past its expiration date. The customer's billing relationship and payment history are unaffected.",
      },
      {
        question: "Will Stripe automatically pick up a customer's new card number?",
        answer:
          "Sometimes, through card network updater services, but coverage varies by card brand and issuing country. Many expired cards are never silently refreshed, which is why some charges still fail with this code.",
      },
      {
        question:
          "Should a merchant keep retrying an `expired_card` decline hoping it eventually clears?",
        answer:
          "No. The expiration date does not change on its own between retry attempts, so repeated charges just repeat the decline and delay getting the customer to fix it.",
      },
      {
        question: "What is the single most effective fix for `expired_card` failures?",
        answer:
          "Reaching the customer before the charge fails, with a reminder timed around the card's known expiration date, so they update their payment method ahead of the next billing cycle.",
      },
      {
        question: "Is `expired_card` more common with certain card types?",
        answer:
          "It shows up more often where account updater coverage is weaker, including cards issued outside the US, American Express cards, and smaller regional card issuers.",
      },
    ],
  },

  invalid_expiry_month: {
    meaning:
      '`invalid_expiry_month` means Stripe rejected the charge because the expiration month submitted with the card is not a valid value, not a real month between 01 and 12, or not formatted the way Stripe expects. Stripe\'s own definition: "The expiration month is invalid." This is usually a form or entry problem rather than proof that the physical card itself is bad.',
    whyItHappens:
      "Most subscription businesses collect card details once at signup and again whenever a customer updates payment info. `invalid_expiry_month` tends to show up right after one of those update moments: a customer retypes their card into an update-payment form and mistypes the month field, transposes month and year, or a checkout integration passes the expiration data in the wrong format to Stripe. Because the value never reaches the issuing bank for a real authorization check, this decline happens on Stripe's own validation before the transaction gets that far.",
    howToFix:
      'Retrying the exact same submitted month will fail the exact same way every time, since the problem is the value itself, not network congestion or a temporary bank hold. That said, this is fundamentally a correctable data-entry issue: once the customer or the checkout form supplies a real, correctly formatted month, the charge can succeed immediately. The fix is correction, not persistence.\n\nTreat this as a form problem first. Check whether your checkout or payment-update flow is passing expiration data in the format Stripe\'s API expects, and whether client-side validation catches an out-of-range month before submission. On the customer-facing side, ask them to re-enter their card details rather than assuming the card is expired or invalid. Because this is squarely a data problem, a fast, specific nudge to fix the input gets more of these resolved than a generic "payment failed" message.',
    faqs: [
      {
        question: "Does `invalid_expiry_month` mean the card itself is expired?",
        answer:
          "Not necessarily. It usually means the month value submitted with the charge is not a valid month, often a typo or formatting issue from a checkout or update-payment form, rather than proof the physical card has expired.",
      },
      {
        question: "Can this decline resolve itself if Foxhound just keeps retrying?",
        answer:
          "No. The same invalid month value produces the same rejection on every attempt. The value has to be corrected before the charge can go through.",
      },
      {
        question: "What's the fastest way to fix `invalid_expiry_month` for a customer?",
        answer:
          "Have them re-enter their card details through your payment-update page, since a fresh, correctly validated submission usually clears the problem immediately.",
      },
      {
        question: "Should merchants suspect a checkout bug when this code appears often?",
        answer:
          "If it shows up at unusual volume, it can be worth checking whether the checkout or update form is sending expiration data in the format Stripe's API expects, since a form bug can generate `invalid_expiry_month` across many customers at once.",
      },
      {
        question: "How is `invalid_expiry_month` different from `expired_card`?",
        answer:
          "`expired_card` means the stored expiration date is real but has passed. `invalid_expiry_month` means the month value itself doesn't parse as a valid month at all, which points more toward a data-entry or format problem than an actually expired card.",
      },
    ],
  },

  invalid_expiry_year: {
    meaning:
      "`invalid_expiry_year` means Stripe rejected the charge because the expiration year submitted with the card is not a valid value, an unreasonable year, a badly formatted one, or one that doesn't match what Stripe's validation expects. Stripe's own definition: \"The expiration year is invalid.\" Like its sibling code for the month field, this points to a submitted-data problem rather than confirmation that the card is dead.",
    whyItHappens:
      'This decline clusters around moments when card details get re-entered: a customer updating an expiring card, a manual card-on-file correction after a failed charge, or a migration of stored payment methods between systems. A common cause is a two-digit versus four-digit year mismatch, where a form field expects "28" and receives "2028" or vice versa, or where a customer simply mistypes the year while updating other fields. Because Stripe validates the year format before the charge reaches the issuing bank, the decline happens early and doesn\'t reflect anything about the bank\'s actual records.',
    howToFix:
      "Resubmitting the same bad year value will not change the outcome. The charge fails for the same reason on the first attempt and every attempt after it. Automated retries add delay without adding any chance of success. Once a correct, properly formatted year is submitted, though, the charge can proceed normally, so the underlying situation is fixable, just not through persistence.\n\nStart by checking your own integration: confirm that whatever collects or updates card details passes the year to Stripe in the expected format, and that any client-side validation rejects obviously wrong years (a year in the past, or a year decades in the future) before submission. On the customer side, the practical move is a direct request to re-enter payment details, framed simply rather than technically. Customers do not need to know the exact validation rule that failed. They need a clear path to fix it.",
    faqs: [
      {
        question: "Does `invalid_expiry_year` mean the customer's card has expired?",
        answer:
          "Not necessarily. It means the year value submitted with the charge failed Stripe's validation, which is often a formatting mismatch or typo rather than proof the card is actually past its expiration date.",
      },
      {
        question:
          "Is there any benefit to retrying a charge that failed with `invalid_expiry_year`?",
        answer:
          "No. The same invalid year produces the same decline on every attempt. Nothing changes until the value itself is corrected.",
      },
      {
        question:
          "What commonly causes this specific decline in a checkout or update-payment form?",
        answer:
          "A two-digit versus four-digit year mismatch is a frequent cause, along with plain typos when a customer re-enters their card during a payment update.",
      },
      {
        question: "How should a merchant word the customer-facing message for this decline?",
        answer:
          "Keep it simple and non-technical: ask the customer to re-enter their payment details rather than describing the specific validation failure.",
      },
      {
        question: "How is `invalid_expiry_year` different from `invalid_expiry_month`?",
        answer:
          "Both are data-validation failures on the expiration field rather than issuer-side declines, but one flags a bad month value and the other flags a bad year value. Either can stem from the same root cause: a mistyped or mis-formatted expiration date during entry or update.",
      },
    ],
  },
};
