import type { DeclineCodeContent } from "./content";

export const SOFT_DECLINE_CONTENT: Record<string, DeclineCodeContent> = {
  insufficient_funds: {
    meaning:
      "`insufficient_funds` means the customer's available balance or credit limit was lower than the charge amount at the moment Stripe attempted it. The card is valid, the account is real, and the customer generally intends to pay. The problem is timing, not trust. This is a soft decline and one of the most reliably retryable codes in Stripe's list.",
    whyItHappens:
      "For subscription businesses this code is almost always a scheduling mismatch rather than a genuine ability-to-pay problem. Recurring billing fires on a fixed calendar date set at signup. A customer's income, by contrast, arrives on its own schedule: many US employees on biweekly pay are paid on the 1st and 15th, or on Fridays, while employees paid monthly usually see a deposit around month end. If a subscription renewal date happens to land a day or two before payday, the charge can fail even though the money shows up in the account 48 hours later. The customer isn't refusing to pay. The bill just arrived at an awkward moment relative to their cash flow.",
    howToFix:
      "Yes, and it tends to resolve with nothing more than better timing. A charge that fails on the 3rd of the month because a paycheck hasn't landed yet often clears cleanly if retried on the 5th or after the next payday window. No customer contact is required to fix a timing problem, and reaching out immediately with a \"your card was declined\" email can create friction (and occasional churn) over an issue that would have resolved itself in a couple of days.\n\nAlign retry timing with common payday patterns rather than retrying on a fixed short interval. A retry attempted the same day as the original failure is unlikely to succeed, since the underlying balance problem hasn't changed. A retry attempted a few days later, ideally around the 1st, the 15th, or a Friday, has meaningfully better odds. Avoid emailing the customer on the first failure. Reserve outreach for cases where retries genuinely can't recover the charge after giving payday timing a fair chance to work.",
    faqs: [
      {
        question: "Does `insufficient_funds` mean the customer can't afford the subscription?",
        answer:
          "Not usually. It typically means the charge landed before the customer's next deposit, not that they lack the ability or intent to pay.",
      },
      {
        question: "Why does a charge fail on the 3rd but succeed if retried on the 5th?",
        answer:
          "Many customers get paid around the 1st, the 15th, or on a Friday. A retry timed a few days after the original failure often lands after the customer's balance has replenished.",
      },
      {
        question: "Should merchants email the customer as soon as this code appears?",
        answer:
          "It's usually unnecessary and can create friction over a problem that resolves itself. Retrying with better timing first avoids bothering a customer who was always going to pay.",
      },
      {
        question: "Is `insufficient_funds` more common for subscriptions than one-time purchases?",
        answer:
          "Yes, because subscription billing dates are fixed in advance and don't move with the customer's actual pay schedule, while a one-time purchase is something the customer initiates when they already know they can afford it.",
      },
      {
        question: "How does Foxhound decide when to email the customer?",
        answer:
          "Only after its background retry schedule for the charge is exhausted. Before that point, retries happen silently and no email goes out.",
      },
    ],
  },

  do_not_honor: {
    meaning:
      '`do_not_honor` is the card network\'s oldest and most common decline reason: the issuing bank said no to the charge without telling Stripe why. It is a soft decline. The name sounds serious, but in practice it functions as a catch-all, not a verdict on the card, the account, or the customer.\n\nUnder the ISO 8583 standard that card networks use to move authorization messages, `do_not_honor` maps to response code "05," the single most frequent decline code seen on card-not-present transactions across the industry. Banks route a wide variety of situations through this code: a temporary fraud flag, a spending limit reached, several declines stacking on the same card in a short span, a velocity trigger, or an internal bank system issue. None of those mean the card is closed or the account is fraudulent. The bank is simply declining right now, for a reason it has chosen not to share.',
    whyItHappens:
      "Recurring billing triggers this code more than one-time purchases for reasons rooted in timing and pattern recognition. A subscription charge that fires automatically at 3am as part of a merchant's batch billing run looks statistically different to a bank's fraud model than a purchase a customer makes by hand at 2pm. Add in the fact that a customer's card may already have other charges stacking up around the same billing cycle (other subscriptions, other merchants), and the velocity signals a bank watches for are more likely to trip.",
    howToFix:
      'Yes. This is functionally the twin of `generic_decline`: both are soft, catch-all issuer declines, both correspond to the same underlying "05" network response, and the practical difference is only whether the bank returned "05" directly or Stripe applied its own broader label over the same underlying signal. The handling is identical. An immediate retry usually fails for the same reason the first attempt did. A retry spaced out by hours, once a temporary hold or fraud flag has had time to clear, succeeds far more often.\n\nTreat it the same way as `generic_decline`: retry on a delay rather than instantly, respect network-imposed retry caps, and reserve customer-facing emails for cases where automated retries have already failed. Sending an alarming "your payment was declined" email the moment this code appears, before giving a delayed retry a chance to work, creates unnecessary customer anxiety over what is usually a same-day or next-day resolution.',
    faqs: [
      {
        question: "Is `do_not_honor` worse than a generic decline?",
        answer:
          "No. They are effectively the same underlying issuer behavior. `do_not_honor` maps to the network's \"05\" code directly; `generic_decline` is Stripe's broader catch-all that often covers the same situations.",
      },
      {
        question: "Does this code mean fraud was suspected on my card?",
        answer:
          "Sometimes, but not always. Fraud holds are one of several possible causes, alongside spending limits, velocity triggers, and plain bank system issues.",
      },
      {
        question:
          "Why do subscription charges hit `do_not_honor` more than a one-time purchase would?",
        answer:
          "Overnight batch billing runs and stacked recurring charges across multiple merchants both look different to a bank's automated fraud screening than a single customer-initiated purchase.",
      },
      {
        question: "Should the retry happen right after the decline?",
        answer:
          "No. An immediate retry usually fails because the same condition is still active. Spacing retries out over hours gives temporary holds time to clear.",
      },
      {
        question: "Does Foxhound email the customer as soon as this code appears?",
        answer:
          "No. Foxhound retries silently in the background first. The customer only receives an email if all scheduled retries fail to recover the charge.",
      },
    ],
  },

  generic_decline: {
    meaning:
      "`generic_decline` means the card issuer declined the charge without giving Stripe a specific reason. Stripe's own definition is blunt: the card was declined for an unknown reason, or Stripe's own Radar or Adaptive Acceptance systems blocked the payment before it reached the network. Either way, there is no diagnostic detail attached to the code itself. It is a soft decline, not a signal that the card is closed, stolen, or invalid.\n\nBanks use `generic_decline` as a catch-all for a range of temporary situations: a fraud flag that clears within hours, a spending limit the customer bumped against, a bank system hiccup, or a short hold placed on the account. None of these describe a permanent problem with the card.",
    whyItHappens:
      "Recurring charges hit `generic_decline` more often than one-time purchases for a few reasons. Bank fraud systems apply stricter automated scrutiny to charges that look like recurring billing, and a charge firing at 2am during a batch billing run reads differently to that system than a charge a customer initiates themselves at checkout. Card velocity limits can also contribute: if a customer has been charged several times in a short window across different merchants, the next charge is more likely to get flagged. On top of that, Stripe Radar rules configured by the merchant can themselves produce a `generic_decline` when a transaction matches a risk pattern, even when the bank would have approved it.",
    howToFix:
      'Yes, but not immediately. Retrying the instant a `generic_decline` comes back rarely works, because the condition that caused the decline (a fraud hold, a limit, a system issue) is usually still present a few seconds or minutes later. Waiting gives those temporary conditions time to clear. Card networks also enforce hard caps on retry volume: Mastercard allows up to 35 retry attempts per card within 30 days, and Visa allows up to 15. Exceeding either threshold triggers network penalty fees, so retry timing and count both matter, not just persistence.\n\nSpace retries out over hours or days rather than firing them back to back. Track how many attempts have been made against network limits. If retries are exhausted without success, move to a direct, low-friction message to the customer asking them to update or confirm their payment method, rather than a generic "payment failed" notice that gives them no path forward.',
    faqs: [
      {
        question: "Does `generic_decline` mean my card is blocked?",
        answer:
          "No. It means the issuer declined one charge without stating why. The card itself may work fine on the next attempt or on a different merchant charge.",
      },
      {
        question: "Should I contact my bank when I see this code?",
        answer:
          "It rarely helps. Banks typically will not disclose the specific reason behind a `generic_decline`, since the code exists precisely because they chose not to share detail with Stripe.",
      },
      {
        question:
          "Why did my subscription renewal fail with this code when my one-time purchase last month went through fine?",
        answer:
          "Recurring charges get more automated scrutiny from bank fraud systems, and batch billing runs (often overnight) can look unusual compared to a customer-initiated purchase.",
      },
      {
        question: "How many times can a merchant retry a `generic_decline` charge?",
        answer:
          "Network rules cap it at 35 attempts per card in 30 days for Mastercard and 15 for Visa. Going over either limit brings penalty fees, so retry pacing matters as much as retry count.",
      },
      {
        question: "Will I get an email every time a retry fails?",
        answer:
          "Not under Foxhound's handling. Retries run silently in the background first. A customer only hears from the merchant if the full retry schedule runs out without recovering the charge.",
      },
    ],
  },

  card_declined: {
    meaning:
      "`card_declined` is Stripe's bare, no-detail decline outcome: the card was declined and no more specific reason code came back with it. It is a soft decline. Stripe sometimes returns this outcome alongside a Radar risk_level flag in the raw event data, but that risk_level is separate metadata, not part of the decline code itself.\n\nIt helps to know how this differs from `generic_decline`. Both describe an unspecified decline, but `generic_decline` is the label Stripe applies when it has identified a broader unknown-reason scenario (including cases where Stripe's own Radar or Adaptive Acceptance system made the call). `card_declined` is the plainer, more literal \"the card was declined\" outcome, used when the network or issuer hands back a decline with essentially nothing attached beyond the fact of the decline. The distinction matters for engineers reading raw Stripe events, but for a merchant deciding what to do next, the practical response is the same either way: treat it as a soft, retryable decline rather than a dead end.",
    whyItHappens:
      "As with other soft, unspecified decline codes, recurring billing sees this more often than one-time checkout because automated bank fraud screening treats scheduled, merchant-initiated charges differently from customer-initiated ones. A charge that arrives at an odd hour as part of a batch billing run, or one that follows closely after other charges on the same card, is statistically more likely to get flagged without explanation. Because the code carries no specific detail, there's no way to distinguish a fraud-related decline from a limit-related one just by looking at the code string.",
    howToFix:
      "Yes. Without more specific information, the safe assumption is that whatever triggered the decline is transient: a momentary risk flag, a system-level check, a limit brushed up against. Retrying immediately rarely helps for the same reason it doesn't help with other soft codes: the condition that caused the first decline is usually unchanged seconds later. A delayed retry gives whatever triggered the block time to clear.\n\nBecause this code carries no diagnostic detail, avoid building retry logic that assumes a specific cause. Treat it as a general soft decline: retry on a delay, watch card network retry caps, and don't jump straight to a customer email before giving at least one spaced-out retry attempt a chance to succeed.",
    faqs: [
      {
        question: "What's the difference between `card_declined` and `generic_decline`?",
        answer:
          "Both are unspecified soft declines. `generic_decline` covers Stripe's broader unknown-reason category, including cases where Stripe's own risk systems intervened. `card_declined` is the plainer bare-decline outcome with even less attached detail.",
      },
      {
        question: "Does a Radar risk_level attached to this decline change how it's handled?",
        answer:
          "Foxhound's classifier keys on the code string alone, not on risk_level, so this code is treated the same regardless of what risk_level shows up in the raw event.",
      },
      {
        question: "Is `card_declined` retryable?",
        answer:
          "Yes. It's treated as a soft decline, meaning a delayed automatic retry is the right first move rather than treating it as a permanent block.",
      },
      {
        question: "Should I email the customer the moment I see `card_declined`?",
        answer:
          "No. Give a spaced-out retry a chance first. An immediate email over a decline that resolves itself on retry creates unnecessary customer friction.",
      },
      {
        question: "How quickly does Foxhound try again after this code?",
        answer:
          "Retries run automatically in the background on a spaced schedule. The customer only hears from the merchant if that schedule finishes without a successful charge.",
      },
    ],
  },

  transaction_not_allowed: {
    meaning:
      "`transaction_not_allowed` is Stripe's label for a decline the issuing bank returned without a specific stated reason, though in practice this code shows up more often than most for a particular pattern: the cardholder's bank has restricted the type of transaction being attempted, or the card itself doesn't support it. It is not a sign of a closed account.",
    whyItHappens:
      "This code carries a stronger subscription-specific signal than most soft declines. Some banks apply restrictions to recurring or online transactions specifically, meaning a card that works fine for an in-person purchase or even a one-time online checkout can still get blocked when the same card is charged as part of a recurring billing arrangement. Certain card types compound this: some prepaid cards, some debit cards, and some corporate or virtual cards are issued without recurring-payment support enabled at all, either by design or because the cardholder never opted in to that transaction type with their bank. A charge that would succeed as a one-time purchase can fail every time as a subscription renewal on the exact same card.",
    howToFix:
      "Yes, generally, though the odds of a plain retry succeeding are lower here than with a pure timing-driven code like `insufficient_funds`. If the underlying cause is a bank-side restriction on recurring charges specifically, retrying the identical charge type again will often hit the same wall. If the cause is closer to a temporary flag or a one-off restriction, a delayed retry has a real chance. Because the code doesn't distinguish between these two situations, the safe default is still to retry rather than give up immediately.\n\nTreat the first attempt as a soft decline and retry on a delay, same as other codes in this category. If repeated retries keep failing, that's a stronger signal than usual that the issue may be structural (a card that genuinely doesn't support recurring billing with that bank) rather than transient, which makes a direct customer message asking for an alternate payment method more useful here than with codes that are purely timing-related.",
    faqs: [
      {
        question: "Does `transaction_not_allowed` mean my card is blocked entirely?",
        answer:
          "Not necessarily. It often means the specific transaction type (recurring or online billing) isn't permitted on that card by the issuing bank, while other transaction types on the same card work fine.",
      },
      {
        question: "Why would a card work for a one-time purchase but fail as a subscription?",
        answer:
          "Some banks and some card types (certain prepaid or debit cards in particular) restrict or exclude recurring transaction support even when general purchases go through without issue.",
      },
      {
        question: "Is it worth retrying a `transaction_not_allowed` decline?",
        answer:
          "Yes, at least once with a delay. If it keeps failing on repeated retries, that's a signal the restriction may be structural rather than temporary.",
      },
      {
        question: "What should a customer do if this keeps happening on their subscription?",
        answer:
          "Try a different card, ideally a standard credit or full-service debit card, since some restrictions are tied to the card type rather than the account holder.",
      },
      {
        question: "Does Foxhound treat this differently from other soft declines?",
        answer:
          "Yes. Stripe lists `transaction_not_allowed` among the hard declines it does not retry until a new payment method appears, so Foxhound does not retry it either. It goes to the fraud and hard-decline bucket: no silent retry, and the email sequence asks the customer to approve the charge with their bank or use a different card.",
      },
    ],
  },

  withdrawal_count_limit_exceeded: {
    meaning:
      "`withdrawal_count_limit_exceeded` is a decline Stripe returns when, per its official definition, the customer has exceeded the balance or credit limit available on their card. The name is a holdover from debit and prepaid card terminology, where issuers track a count or limit on withdrawal-style transactions, but functionally it lands the charge in the same place as a plain limit-exceeded decline: the customer's card can't cover the charge right now. It's a soft decline.",
    whyItHappens:
      "The naming is a common source of confusion. It sounds like it's about how many times a card has been used, but Stripe's stated definition ties it to balance and credit limit, not a literal transaction count. For subscription billing, this shows up in the same situations that produce other limit-related declines: a prepaid or debit card with a preset balance that a recurring charge exceeds, or a credit card sitting close to its limit when a monthly renewal comes due. Because the code is more common on prepaid and debit cards than traditional credit cards, subscription businesses with a customer base skewing toward those card types see it somewhat more often than businesses whose customers pay mostly with standard credit cards.",
    howToFix:
      "Yes. Since the underlying issue is a balance or limit constraint, the same logic that applies to `insufficient_funds` applies here: a retry timed after a likely balance replenishment (a payday, a prepaid card reload, a statement cycle reset) has real odds of succeeding, while an immediate retry right after the decline usually just hits the same limit again.\n\nRetry on a delay rather than immediately, and where possible bias the retry timing toward common income or reload cycles the same way you would for a straightforward insufficient-funds decline. If retries keep failing over multiple cycles, that's a signal the card's limit may be permanently too low for the subscription amount, at which point a direct message asking the customer to add a different card is more useful than continuing to retry indefinitely.",
    faqs: [
      {
        question: "Does this code mean the card has been used too many times?",
        answer:
          "Not according to Stripe's own definition. Despite the name, it refers to the balance or credit limit available on the card being exceeded by the charge amount, not a transaction count.",
      },
      {
        question: "Is this decline more common on certain card types?",
        answer:
          "Yes. It shows up more on prepaid and debit cards, which carry hard balance ceilings, than on standard credit cards.",
      },
      {
        question: "Should a merchant retry immediately after this decline?",
        answer:
          "No. An immediate retry usually hits the same limit. Timing the retry around a likely balance replenishment (payday, reload, statement cycle) gives it a real chance.",
      },
      {
        question: "What if the same card keeps failing with this code every billing cycle?",
        answer:
          "That's a sign the card's limit may be structurally too low for the subscription amount, and it's worth prompting the customer directly to switch to a different card.",
      },
      {
        question: "Does Foxhound notify the customer right away when this code appears?",
        answer:
          "No. It runs a silent background retry first and only sends the merchant's branded recovery email if the retry schedule doesn't recover the charge.",
      },
    ],
  },
};
