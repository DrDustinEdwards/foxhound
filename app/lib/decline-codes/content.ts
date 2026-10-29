// Per-code marketing copy for the /decline-codes library (Phase 6).
//
// SOURCING: content is drawn from recova/phase6-content-decline-codes.md (the
// dedicated content pass, 32 codes) plus a hand-written card_error entry
// (not covered by that doc; written in the same style, grounded in ordinary
// payments-industry knowledge, since card_error is a real code in
// decline.ts's NETWORK_CODES). Two codes needed correction against the
// source doc rather than a verbatim copy: revocation_of_authorization and
// do_not_try_again were researched and written while decline.ts's
// classifier still defaulted an unrecognized code to a silent soft retry
// (an open, since-fixed safety gap, see foxhound-decline-classifier-gap.md).
// decline.ts now fails closed (an unrecognized code resolves to "unknown",
// never auto-retried) and both codes are explicitly classified as fraud
// (never retried, same bucket as a reported lost or stolen card), so their
// copy here reflects that current, safer reality rather than the doc's
// original gap-disclosure framing. Every other unclassified code's copy was
// updated the same way: the source doc was written assuming an unmapped
// code silently auto-retries; it now fails closed to the card-update email
// path instead, and the FAQ/how-to-fix language here says so.
//
// No recovery-rate numbers appear anywhere here (hard requirement, no
// platform data exists yet).
//
// Category (soft/network/expired/fraud/unknown) and retryability are NEVER
// hand-authored here: every page reads them live from
// app/lib/decline-codes/codes.ts, which calls classifyDecline()/isRetryable()
// directly. This file only holds the code-specific explanatory prose.

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
      "`do_not_honor` is the card network's oldest and most common decline reason: the issuing bank said no to the charge without telling Stripe why. It is a soft decline. The name sounds serious, but in practice it functions as a catch-all, not a verdict on the card, the account, or the customer.\n\nUnder the ISO 8583 standard that card networks use to move authorization messages, `do_not_honor` maps to response code \"05,\" the single most frequent decline code seen on card-not-present transactions across the industry. Banks route a wide variety of situations through this code: a temporary fraud flag, a spending limit reached, several declines stacking on the same card in a short span, a velocity trigger, or an internal bank system issue. None of those mean the card is closed or the account is fraudulent. The bank is simply declining right now, for a reason it has chosen not to share.",
    whyItHappens:
      "Recurring billing triggers this code more than one-time purchases for reasons rooted in timing and pattern recognition. A subscription charge that fires automatically at 3am as part of a merchant's batch billing run looks statistically different to a bank's fraud model than a purchase a customer makes by hand at 2pm. Add in the fact that a customer's card may already have other charges stacking up around the same billing cycle (other subscriptions, other merchants), and the velocity signals a bank watches for are more likely to trip.",
    howToFix:
      "Yes. This is functionally the twin of `generic_decline`: both are soft, catch-all issuer declines, both correspond to the same underlying \"05\" network response, and the practical difference is only whether the bank returned \"05\" directly or Stripe applied its own broader label over the same underlying signal. The handling is identical. An immediate retry usually fails for the same reason the first attempt did. A retry spaced out by hours, once a temporary hold or fraud flag has had time to clear, succeeds far more often.\n\nTreat it the same way as `generic_decline`: retry on a delay rather than instantly, respect network-imposed retry caps, and reserve customer-facing emails for cases where automated retries have already failed. Sending an alarming \"your payment was declined\" email the moment this code appears, before giving a delayed retry a chance to work, creates unnecessary customer anxiety over what is usually a same-day or next-day resolution.",
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
        question: "Why do subscription charges hit `do_not_honor` more than a one-time purchase would?",
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
      "Yes, but not immediately. Retrying the instant a `generic_decline` comes back rarely works, because the condition that caused the decline (a fraud hold, a limit, a system issue) is usually still present a few seconds or minutes later. Waiting gives those temporary conditions time to clear. Card networks also enforce hard caps on retry volume: Mastercard allows up to 35 retry attempts per card within 30 days, and Visa allows up to 15. Exceeding either threshold triggers network penalty fees, so retry timing and count both matter, not just persistence.\n\nSpace retries out over hours or days rather than firing them back to back. Track how many attempts have been made against network limits. If retries are exhausted without success, move to a direct, low-friction message to the customer asking them to update or confirm their payment method, rather than a generic \"payment failed\" notice that gives them no path forward.",
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
        question: "Why did my subscription renewal fail with this code when my one-time purchase last month went through fine?",
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

  processing_error: {
    meaning:
      "`processing_error` means Stripe's official definition is direct: an error occurred while processing the card. This is not a fraud flag, not a declined-for-insufficient-funds message, and not an expired card. Something in the technical chain between Stripe and the issuing bank broke down mid-transaction. The charge failed because a system hiccup interrupted it, not because the card itself was rejected.",
    whyItHappens:
      "The most common cause is a bank system outage or maintenance window on the issuing side. These are usually short, minutes to a few hours, and resolve on their own. A second cause is a network timeout between Stripe and the issuing bank: if the authorization request doesn't get a response within the timeout threshold, Stripe returns a processing error instead of leaving the charge in limbo. A less common cause is load on Stripe's own infrastructure during peak processing windows, which affects a small percentage of requests and clears up once volume normalizes. For a recurring subscription charge, none of these causes have anything to do with the customer's card, balance, or account standing. The timing is just unlucky.",
    howToFix:
      "Yes. This is a soft, technical decline, and retrying after a short delay resolves it in the large majority of cases. There is no reason to treat it like a card problem or ask the customer to update their payment method, at least not on the first pass.\n\nA retry window of 2 to 6 hours catches most instances, since that covers typical bank maintenance windows and transient network issues. A second retry at roughly 24 hours catches anything that lingered past the first attempt. Because this decline is never the customer's fault, best practice is to hold off on any customer-facing email until retries are exhausted. Sending a \"please update your card\" message for a problem that had nothing to do with their card creates confusion and unnecessary support tickets.",
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
        question: "How long should I wait before retrying a charge that failed with `processing_error`?",
        answer:
          "A first retry between 2 and 6 hours after the failure covers most bank maintenance windows and network timeouts. A second retry around the 24 hour mark catches slower-resolving issues.",
      },
      {
        question: "Is `processing_error` the same thing as a card being declined for fraud?",
        answer:
          "No. Fraud declines come from the issuer's risk systems flagging the transaction. `processing_error` comes from a breakdown somewhere in the technical processing chain, unrelated to the transaction's legitimacy.",
      },
      {
        question: "Will retrying the same charge repeatedly eventually work if `processing_error` keeps recurring?",
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
        question: "Should repeated `card_error` failures against the same card ever be treated as a sign the stored card data is bad?",
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
        question: "Is `issuer_not_available` connected to the customer's account balance or credit standing?",
        answer:
          "No. It's a connectivity and availability issue on the issuing bank's side, unrelated to whether the customer has enough funds or good standing on the account.",
      },
      {
        question: "How quickly does `issuer_not_available` usually resolve?",
        answer:
          "Most instances clear within a few hours as the bank's systems come back online. A small number take closer to a day if the outage or maintenance window runs long.",
      },
      {
        question: "Should I flag the account or restrict access after an `issuer_not_available` decline?",
        answer:
          "No. Since the cause sits entirely on the bank's side, there's no reason to treat the account as risky or the card as invalid. Retry and move on.",
      },
      {
        question: "Does Foxhound treat `issuer_not_available` differently from a card-declined-for-funds error?",
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
        question: "What does it mean when Stripe declines a card for an \"unknown reason\"?",
        answer:
          "It means the issuing bank didn't supply Stripe with a specific rejection reason like insufficient funds or a fraud flag. `try_again_later` is Stripe's label for that generic, non-specific decline.",
      },
      {
        question: "Is `try_again_later` a sign the card is no longer valid?",
        answer:
          "Not by itself. Nothing in the code indicates the card is closed, expired, or otherwise permanently unusable. It behaves as a temporary block far more often than a permanent one.",
      },
      {
        question: "Should I ask the customer to switch payment methods after one `try_again_later` decline?",
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
        question: "Does Foxhound distinguish `service_unavailable` from a hard decline like an expired card?",
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
        question: "How should the customer email differ for `card_not_supported` versus a technical network decline?",
        answer:
          "It should be specific: explain that the card doesn't support recurring charges and ask for an alternative payment method, rather than a generic payment failure notice.",
      },
      {
        question: "Does Foxhound retry `card_not_supported` the same way it retries a technical decline like `processing_error`?",
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
        question: "What does \"reenter transaction\" actually mean in plain terms?",
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
        question: "Will Foxhound email the customer right away about a `reenter_transaction` decline?",
        answer:
          "No. Since it's classified as a network decline, Foxhound retries automatically in the background first and only starts the merchant's email sequence if those retries don't succeed.",
      },
    ],
  },

  expired_card: {
    meaning:
      "`expired_card` means Stripe declined the charge because the expiration date on file for the card has already passed. Stripe's own definition is blunt: \"The card has expired.\" The card is not being rejected for fraud, insufficient funds, or a bank-side hold. It is being rejected because the expiration date stored on the payment method is no longer valid.",
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
        question: "Should a merchant keep retrying an `expired_card` decline hoping it eventually clears?",
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
      "`invalid_expiry_month` means Stripe rejected the charge because the expiration month submitted with the card is not a valid value, not a real month between 01 and 12, or not formatted the way Stripe expects. Stripe's own definition: \"The expiration month is invalid.\" This is usually a form or entry problem rather than proof that the physical card itself is bad.",
    whyItHappens:
      "Most subscription businesses collect card details once at signup and again whenever a customer updates payment info. `invalid_expiry_month` tends to show up right after one of those update moments: a customer retypes their card into an update-payment form and mistypes the month field, transposes month and year, or a checkout integration passes the expiration data in the wrong format to Stripe. Because the value never reaches the issuing bank for a real authorization check, this decline happens on Stripe's own validation before the transaction gets that far.",
    howToFix:
      "Retrying the exact same submitted month will fail the exact same way every time, since the problem is the value itself, not network congestion or a temporary bank hold. That said, this is fundamentally a correctable data-entry issue: once the customer or the checkout form supplies a real, correctly formatted month, the charge can succeed immediately. The fix is correction, not persistence.\n\nTreat this as a form problem first. Check whether your checkout or payment-update flow is passing expiration data in the format Stripe's API expects, and whether client-side validation catches an out-of-range month before submission. On the customer-facing side, ask them to re-enter their card details rather than assuming the card is expired or invalid. Because this is squarely a data problem, a fast, specific nudge to fix the input gets more of these resolved than a generic \"payment failed\" message.",
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
      "This decline clusters around moments when card details get re-entered: a customer updating an expiring card, a manual card-on-file correction after a failed charge, or a migration of stored payment methods between systems. A common cause is a two-digit versus four-digit year mismatch, where a form field expects \"28\" and receives \"2028\" or vice versa, or where a customer simply mistypes the year while updating other fields. Because Stripe validates the year format before the charge reaches the issuing bank, the decline happens early and doesn't reflect anything about the bank's actual records.",
    howToFix:
      "Resubmitting the same bad year value will not change the outcome. The charge fails for the same reason on the first attempt and every attempt after it. Automated retries add delay without adding any chance of success. Once a correct, properly formatted year is submitted, though, the charge can proceed normally, so the underlying situation is fixable, just not through persistence.\n\nStart by checking your own integration: confirm that whatever collects or updates card details passes the year to Stripe in the expected format, and that any client-side validation rejects obviously wrong years (a year in the past, or a year decades in the future) before submission. On the customer side, the practical move is a direct request to re-enter payment details, framed simply rather than technically. Customers do not need to know the exact validation rule that failed. They need a clear path to fix it.",
    faqs: [
      {
        question: "Does `invalid_expiry_year` mean the customer's card has expired?",
        answer:
          "Not necessarily. It means the year value submitted with the charge failed Stripe's validation, which is often a formatting mismatch or typo rather than proof the card is actually past its expiration date.",
      },
      {
        question: "Is there any benefit to retrying a charge that failed with `invalid_expiry_year`?",
        answer:
          "No. The same invalid year produces the same decline on every attempt. Nothing changes until the value itself is corrected.",
      },
      {
        question: "What commonly causes this specific decline in a checkout or update-payment form?",
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

  fraudulent: {
    meaning:
      "Stripe declined this payment because its fraud detection flagged the transaction as suspicious. This is Stripe's own risk system speaking, not the issuing bank. Stripe's systems look at the card details, the device, the IP address, the transaction pattern, and a range of other signals before a charge ever reaches the bank, and when enough of those signals line up wrong, Stripe blocks the charge itself.\n\nThe decline code `fraudulent` is Stripe stating, in its own words, that \"the payment was declined because Stripe suspects that it's fraudulent.\" That distinction matters. Most decline codes on this list come from the cardholder's bank. This one comes from Stripe's Radar fraud engine sitting in front of the transaction. The card itself might be perfectly valid and the cardholder might be the legitimate account owner, but something about the attempt (a mismatched billing address, a device with a bad reputation, a velocity pattern that looks like card testing) tripped a rule.",
    whyItHappens:
      "For a SaaS business, `fraudulent` usually shows up in one of two contexts. First, at signup: someone is testing a stolen card number against your checkout page, often as part of a larger card-testing operation hitting many merchants at once. Second, on a renewal charge for an account that has been active for a while, where a compromised card was used at signup and the fraud signal only becomes clear once Stripe accumulates more data on the pattern. Recurring billing without three-D Secure at signup gives fraudsters a way to validate stolen cards cheaply, and Stripe's fraud scoring is one of the mechanisms that catches this after the fact.",
    howToFix:
      "No. Retrying a charge that Stripe itself flagged as fraudulent does not fix anything, because the block is coming from Stripe's own risk assessment, not a temporary issue at the bank. Retrying repeatedly against a Stripe fraud block can also hurt your account's standing with Stripe, since it looks like the kind of behavior fraud systems are built to catch.\n\nDo not automatically retry. Do not automatically re-email the customer asking them to update their card, since if the account itself was created fraudulently, that email goes to the wrong person or invites the fraudster to try a different card. Pull up the account: how old is it, does the billing name match anything else on file, were other cards on the same account also declined, is the usage pattern consistent with a real customer. If the signals look legitimate (an established customer whose card just got caught by an overzealous rule), a human can review and decide whether to ask the customer to retry the charge themselves through a hosted payment page, which carries its own fresh risk signals. If the signals look bad, the right move is to lock the account and stop billing, not to keep trying.",
    faqs: [
      {
        question: "Does `fraudulent` mean the customer did something wrong?",
        answer:
          "Not necessarily. It means Stripe's fraud detection flagged the transaction. The cardholder may be completely legitimate and simply got caught by a rule tuned for a broader pattern of abuse.",
      },
      {
        question: "Can I just retry the charge later?",
        answer:
          "You can, but it is unlikely to succeed and repeated attempts against a Stripe fraud block can affect your account's risk standing. Treat it as a signal to review, not a signal to retry.",
      },
      {
        question: "Should I email the customer to fix their card?",
        answer:
          "Only after checking that the account looks legitimate. If the account was created recently, has other declined cards, or shows unusual usage, hold off and review manually first.",
      },
      {
        question: "Why doesn't Foxhound send its normal dunning email for this code?",
        answer:
          "Because `fraudulent` sits in Foxhound's fraud classification bucket, which never retries the charge and sends the fraud bucket's own email sequence instead of the normal one, asking the customer to approve the charge with their bank or use a different card.",
      },
      {
        question: "Is this the same as a chargeback?",
        answer:
          "No. A chargeback happens after a successful charge, when the cardholder disputes it with their bank. `fraudulent` happens before the charge succeeds, when Stripe's own systems block it up front.",
      },
    ],
  },

  lost_card: {
    meaning:
      "Stripe declined this payment because the cardholder has reported the card lost. The card is gone, the bank has been told, and the card is dead as a payment instrument regardless of who is presenting the number.\n\nStripe's official definition is direct: \"the payment was declined because the card is reported lost.\" The cardholder (or someone with access to their account) told the issuing bank that the physical card is missing, and the bank shut it down. This is not a temporary hold and not a balance issue. It is a permanent block on that specific card number.",
    whyItHappens:
      "On a recurring billing product, `lost_card` almost always shows up on a renewal charge for a card that worked fine in the past. The customer lost their wallet, called their bank, and the bank killed the card the same day, sometimes without the customer remembering every subscription tied to it. The customer usually still wants your product. They just have a new card number they haven't gotten around to updating everywhere yet.",
    howToFix:
      "No. The card is closed. Retrying the same card number will fail every time and offers no benefit, since the bank has already made the decision permanent from its side.\n\nThis is one of the more customer-friendly declines on this list, because the underlying story is usually mundane: a lost wallet, not fraud on the account itself. The right response is to ask the customer for an updated card, since they are very likely to have one soon if they don't already. Stop retrying the old card number immediately, since there's no reason to keep hitting a card the bank has already killed. A clear, low-pressure email explaining that their card was reported lost and asking them to update their payment method tends to work well here, because it is factual and not accusatory.",
    faqs: [
      {
        question: "Is `lost_card` a sign of fraud on my customer's account?",
        answer:
          "Usually not. It typically means the customer's physical card was lost and they reported it to their bank, which is a routine event unrelated to their standing with you.",
      },
      {
        question: "Should I keep retrying the same card?",
        answer:
          "No. The bank has permanently closed that card number. Retries will keep failing and waste a dunning attempt that could go toward getting an updated card instead.",
      },
      {
        question: "What should the customer email say?",
        answer:
          "Something plain and non-alarming: their card on file was reported lost, and they need to add a new payment method to keep their subscription active.",
      },
      {
        question: "Does Foxhound treat `lost_card` the same as an obvious fraud code like `stolen_card`?",
        answer:
          "For retry and automation purposes, yes, both sit in Foxhound's fraud bucket: no automated retries, and the fraud bucket's own email sequence in place of the standard dunning sequence. The underlying customer story is usually very different, which is why careful handling rather than a form email matters here.",
      },
      {
        question: "Will the customer's subscription just cancel automatically?",
        answer:
          "That depends on your dunning and cancellation settings, not on the decline code itself. The decline code only tells you the card is dead, not what your billing system should do next.",
      },
    ],
  },

  stolen_card: {
    meaning:
      "Stripe declined this payment because the card on file has been reported stolen. The issuing bank has permanently blocked the card, and no charge against it will succeed, regardless of how many times it is retried.\n\nStripe's official definition states plainly that the payment was declined because the card is reported stolen. Unlike a lost card, which usually points to a customer's own mishap, a stolen card carries a real possibility that the card number itself was compromised or that the subscription was set up using someone else's payment details in the first place. Both explanations are possible, and telling them apart matters before you do anything else.",
    whyItHappens:
      "Two very different situations produce this code on a recurring charge. In the first, a legitimate long-time customer's card was stolen (wallet theft, a data breach, a skimmer) and the bank shut it down, the same way a lost card would be shut down, just with a theft report instead of a loss report. In the second, the subscription itself was created using a stolen card, and the decline is the first sign that the account was never legitimate to begin with. These two situations call for opposite responses, so the account context needs to be checked before reaching out to anyone.",
    howToFix:
      "No. The card is permanently blocked by the issuing bank. Retrying does nothing except waste a dunning attempt, and repeated charge attempts against a card flagged as stolen can draw negative attention from card networks toward the merchant account making the attempts.\n\nStop all retries immediately, since the card is blocked and repeated attempts increase the risk of network penalties against your Stripe account. Before sending any recovery email, check the account for fraud signals: was it created recently, did the subscription start shortly before the decline, is the usage pattern unusual, were other cards on the account also declined. If those signals are present, flag the account for manual review before reaching out, rather than emailing the address on file, since that address may not belong to the legitimate cardholder at all. If the account looks established and ordinary, a low-key request to update the payment method is reasonable, framed the same way you would for a lost card.",
    faqs: [
      {
        question: "Should I retry the charge if I think it might just be a mix-up?",
        answer:
          "No. The card is blocked by the bank regardless of the reason behind the theft report, so retrying will not succeed and can create additional risk for your merchant account.",
      },
      {
        question: "Is it safe to email the customer right away?",
        answer:
          "Not without checking the account first. If the subscription was created recently or shows other fraud signals, the email address on file may not belong to the real cardholder.",
      },
      {
        question: "What fraud signals should I look for before reaching out?",
        answer:
          "Recent account creation, a subscription that started shortly before the decline, unusual usage patterns, and other cards on the account that were also declined.",
      },
      {
        question: "How does this differ from `lost_card` in terms of risk?",
        answer:
          "Both result in a permanently blocked card, but a stolen-card report carries a higher chance the card details were compromised or the account itself is fraudulent, so more caution is warranted before contacting anyone.",
      },
      {
        question: "Does Foxhound send its usual payment-failed email for `stolen_card`?",
        answer:
          "No. It falls in Foxhound's fraud bucket, which never retries the charge and sends the fraud bucket's own email sequence instead, asking the customer to approve the charge with their bank or use a different card.",
      },
    ],
  },

  pickup_card: {
    meaning:
      "Stripe declined this payment with an instruction that in card-network terms means the card should be physically retrieved from the customer. It is one of the more unusual codes a SaaS merchant will ever see, since it originates from point-of-sale card handling rather than anything relevant to an online subscription charge.\n\nStripe's official definition is: \"the customer can't use this card to make this payment (it's possible it was reported lost or stolen).\" Under the hood, `pickup_card` is a card-network response code that historically instructed a merchant's payment terminal to physically confiscate the card during a swipe or dip, on the theory that the card is stolen, lost, or otherwise compromised badly enough that the network wants it out of circulation. For an online business with no physical terminal, there is obviously no card to retrieve. What matters is the underlying signal: the network considers this card unsafe to use.",
    whyItHappens:
      "This code is genuinely rare in an online SaaS context, since it is fundamentally a point-of-sale signal. When it does show up on a recurring charge, it usually means the same underlying problem as `lost_card` or `stolen_card`: the card has been reported to the network as compromised, and the network's response code happens to be one built for physical retrieval rather than one of the more common online-decline variants. Treat it as seriously as those two codes.",
    howToFix:
      "No. This is a hard block from the card network reflecting a card the network wants out of use. Retrying is pointless and, as with other permanently-blocked-card codes, repeated attempts can draw unwanted attention from the network toward the merchant account making them.\n\nStop retrying the card immediately. Because the underlying signal overlaps heavily with lost or stolen cards, apply the same account review before reaching out to the customer: check how old the account is, whether the subscription started shortly before the decline, and whether other cards on file were also declined. If the account looks legitimate, ask the customer for a new payment method with a plain, factual message. If the account looks new or shows other red flags, hold off on outreach and get a human to look at it first.",
    faqs: [
      {
        question: "Why would an online subscription business ever see a point-of-sale code like this?",
        answer:
          "Card networks reuse the same response codes across in-person and online transactions. `pickup_card` is a network-level instruction tied to lost or stolen cards, and it can surface on an online charge even though there's no terminal to act on the \"pickup\" part.",
      },
      {
        question: "Is this more serious than a typical decline?",
        answer:
          "Yes. It signals the card network considers the card compromised enough that it wanted it physically removed from circulation in an in-person context, which is a strong signal in an online context too.",
      },
      {
        question: "Can support just tell the customer to retry with the same card?",
        answer:
          "No. The card is not going to work again. The customer needs a different payment method entirely.",
      },
      {
        question: "Should this trigger the same account review as `stolen_card`?",
        answer:
          "Yes. Given the overlapping signal, check account age, subscription timing, and other declined cards before reaching out to the customer.",
      },
      {
        question: "Does Foxhound's dunning sequence run for this code?",
        answer:
          "Not the standard one. It's in the fraud bucket, so Foxhound never retries the charge and runs the fraud bucket's own email sequence instead, asking the customer to approve the charge with their bank or use a different card.",
      },
    ],
  },

  restricted_card: {
    meaning:
      "Stripe declined this payment because the card carries a restriction placed on it by the issuing bank, closely related to a lost or stolen card block but framed as a card-level limitation rather than a physical pickup instruction.\n\nStripe's official definition reads: \"the customer can't use this card to make this payment (it's possible it was reported lost or stolen).\" Functionally, `restricted_card` and `pickup_card` describe the same underlying situation from slightly different angles. Where `pickup_card` is the network's instruction to physically retrieve the card, `restricted_card` is the issuing bank saying the card itself is restricted from further use. The practical result is identical: this card will not work.",
    whyItHappens:
      "As with `pickup_card`, this shows up on recurring billing when a card that previously worked has since been reported lost or stolen, or has otherwise been flagged by the issuing bank for a restriction (a security concern, a compliance hold, an account-level issue on the cardholder's side). The customer's subscription itself is usually unaffected in intent, they still want the service, but their specific card has been cut off by their own bank.",
    howToFix:
      "No. This is a hard restriction from the issuer, not a temporary hold. Retrying the same card will keep failing and offers no path to success.\n\nStop retrying immediately. Given the overlap with lost and stolen card scenarios, run the same quick account check before reaching out: account age, how recently the subscription started, whether other cards on the account were also declined, and whether usage looks normal. If nothing looks off, ask the customer to add a new card with a straightforward, non-accusatory message. If something looks off, route it to manual review before any customer contact goes out.",
    faqs: [
      {
        question: "How is `restricted_card` different from `pickup_card`?",
        answer:
          "They describe closely related situations. `pickup_card` is the network's instruction tied to physical card retrieval, while `restricted_card` is the issuer describing a restriction on the card itself. Both point to a card that will not work again.",
      },
      {
        question: "Can the restriction be temporary?",
        answer:
          "It's possible in principle, but from the merchant side there is no reliable way to tell a temporary restriction from a permanent one through this code alone. Treat it as a hard stop and ask for a new payment method rather than waiting it out.",
      },
      {
        question: "Should I check the account before emailing the customer?",
        answer:
          "Yes. Because this code overlaps with lost and stolen card scenarios, look at account age, subscription start date, and whether other cards on file were also declined before reaching out.",
      },
      {
        question: "Will retrying with the same card eventually succeed?",
        answer:
          "No. The restriction comes from the issuing bank and won't resolve itself through repeated attempts from the merchant side.",
      },
      {
        question: "Does Foxhound run its usual recovery email for this code?",
        answer:
          "No. `restricted_card` sits in the fraud bucket, so Foxhound never retries the charge and sends the fraud bucket's own email sequence instead of its usual recovery email.",
      },
    ],
  },

  security_violation: {
    meaning:
      "Stripe declined this payment because the issuing bank detected something it treats as a security problem with the transaction, the card, or the pattern surrounding it. Stripe's public label for the underlying reason is generic, but the practical meaning is a bank-side security block, not a balance or limit issue.\n\nStripe's official definition for this code is: \"the card was declined for an unknown reason.\" Banks don't share the specifics behind most of their internal decline reasons, and `security_violation` is one of the codes where the label itself gives more information than the official definition does. In practice, this code generally means the issuing bank believes it detected compromised card data, a fraudulent pattern, or some other security concern serious enough to block the charge outright, distinct from an everyday insufficient-funds or card-expired decline.",
    whyItHappens:
      "On a recurring billing product, `security_violation` can surface for reasons entirely outside your control: the card number appeared in a data breach the bank is now responding to, the bank's own fraud model flagged the transaction pattern, or the card was recently reissued and the old number is being blocked more broadly than usual. It is not typically a sign that the customer did anything wrong, and it is not usually a sign that your business did anything wrong either. It reflects the bank's internal security posture on that specific card.",
    howToFix:
      "Generally no. Because this reflects a security-driven block at the issuing bank rather than a temporary condition like insufficient funds, an immediate retry with the same card is unlikely to succeed and can look like exactly the kind of repeated-attempt pattern that security systems are tuned to catch.\n\nAvoid rapid automated retries on the same card. Since the underlying cause usually sits with the bank's security systems rather than the customer's account standing, a normal customer-facing email asking them to update or verify their payment method is appropriate here, this is not a case requiring the same fraud-account screening you'd apply to a stolen or restricted card. If the customer confirms the card should be fine, they may need to contact their bank directly to clear whatever triggered the block, since the merchant has no visibility into or control over the bank's internal security decision.",
    faqs: [
      {
        question: "Does `security_violation` mean my customer is doing something wrong?",
        answer:
          "Not necessarily. It usually reflects the issuing bank's own security systems reacting to something about the card or transaction, which can happen to a perfectly legitimate cardholder.",
      },
      {
        question: "Should I retry the charge automatically?",
        answer:
          "No. An automatic retry on a bank-security block rarely succeeds and can reinforce whatever pattern triggered the block in the first place.",
      },
      {
        question: "Can the customer fix this themselves?",
        answer:
          "Often yes, by contacting their bank directly, since the block originates from the bank's internal systems and the merchant has no way to clear it from the outside.",
      },
      {
        question: "Is it safe to send the customer a normal \"update your card\" email?",
        answer:
          "Yes, this code doesn't carry the same account-fraud risk as a stolen or restricted card, so a straightforward request to verify or update the payment method is reasonable.",
      },
      {
        question: "Why does Foxhound still classify this as fraud rather than a routine soft decline?",
        answer:
          "Because the code reflects a bank-side security block rather than a simple temporary failure, and Foxhound treats that as reason enough to never retry the charge and to send the fraud bucket's own email sequence instead of the standard one.",
      },
    ],
  },

  revocation_of_authorization: {
    meaning:
      "Stripe declined this payment because the cardholder told their bank to stop authorizing recurring charges from this specific merchant. This is not a card problem or a balance problem. It is the customer's bank acting on an instruction the customer gave directly.\n\nStripe's official definition is: \"the card was declined for an unknown reason.\" What sits behind that generic label is specific and important: the cardholder has explicitly revoked their authorization for your business to charge this card, typically by calling their bank and asking them to block future charges from your merchant ID. The card itself may still work fine everywhere else. It just won't work for you.",
    whyItHappens:
      "This code is almost exclusively a subscription-billing phenomenon, since it requires an existing standing authorization for recurring charges to revoke in the first place. Customers use this route when they want to stop being charged and either couldn't cancel through your product, didn't know how, or decided going through their bank was faster than dealing with your cancellation flow directly. It is a strong, explicit signal of intent to stop paying.",
    howToFix:
      "Not in good faith, and this is the most important point in this entire batch of codes. The cardholder has explicitly told their bank to block recurring charges from your business. Continuing to retry, or continuing to charge through workarounds, creates real chargeback risk and, more basically, ignores a direct instruction from the customer.\n\nStop charging this customer through automated retries. This is a case where industry best practice is unambiguous: treat it as a hard stop and reach out to the customer directly rather than relying on any retry schedule. Find out why they revoked authorization: unwanted charges, a cancellation that didn't go through, a dispute they didn't realize they could resolve with you directly. If they want to continue as a customer, get a fresh, explicit payment method and authorization from them rather than assuming the old relationship can just resume. If they don't want to continue, treat the account as churned and stop billing entirely.",
    faqs: [
      {
        question: "Does `revocation_of_authorization` mean the card is broken?",
        answer:
          "No. The card can still work everywhere else. The cardholder specifically told their bank to block charges from your business.",
      },
      {
        question: "Why would a customer do this instead of canceling through my product?",
        answer:
          "Often because they couldn't find a cancellation flow, didn't trust it, or found calling their bank faster or more reliable than dealing with your app.",
      },
      {
        question: "Does Foxhound automatically stop retrying when it sees this code?",
        answer:
          "Yes. Foxhound's classifier gives `revocation_of_authorization` its own revoked-authorization handling, so no automatic retry ever runs and no multi-step dunning sequence goes out. Instead the customer gets a single, respectful email offering a clean choice: cancel and let the subscription end, or add a fresh payment method if they meant to keep it.",
      },
      {
        question: "What's the risk of retrying anyway?",
        answer:
          "Real chargeback exposure. The customer has already gone to their bank once about this; continuing to charge them after an explicit revocation is likely to produce a dispute rather than a payment.",
      },
      {
        question: "What should I actually do when I see this code?",
        answer:
          "Stop automated billing on that customer and contact them directly to find out whether they want to continue. If they do, collect a fresh payment method and a new authorization rather than assuming the old one still applies.",
      },
    ],
  },

  do_not_try_again: {
    meaning:
      "Stripe declined this payment with the card network's own instruction attached to the response: don't try this charge again. Whatever specific reason sits behind the decline, the network has made the retry decision for you already.\n\nStripe's official definition for this code is: \"the card was declined for an unknown reason.\" That definition is generic, but the code's name is unusually explicit for a Stripe decline code. In practice, `do_not_try_again` functions as the network's own statement that the transaction should not be retried, which effectively makes this a permanent decline even though the exact underlying reason isn't disclosed to the merchant.",
    whyItHappens:
      "Because the specific cause behind this code isn't surfaced, it's hard to say with certainty why any individual `do_not_try_again` decline occurred. What's clear is what the network wants you to do about it. On a recurring billing product, this typically shows up on a renewal for a card where the network has decided, for reasons internal to its own risk or compliance systems, that further attempts against this specific card and transaction combination should stop.",
    howToFix:
      "By the network's own instruction, no. Foxhound's decline classifier explicitly recognizes this code and places it in the fraud and hard-decline bucket, the same bucket used for an explicitly reported lost or stolen card: it is never retried, automatically or otherwise.\n\nGiven the network's explicit instruction, best practice is still to treat this as a permanent decline regardless of how any given system classifies it. Don't schedule further manual retries against the same card for this transaction either. Reach out to the customer directly and ask for an alternate payment method rather than waiting for a scheduled retry to clear things up, since nothing about this code suggests a retry will ever succeed.",
    faqs: [
      {
        question: "Does Stripe explain what triggered a `do_not_try_again` decline?",
        answer:
          "No. Stripe's official definition is generic (\"declined for an unknown reason\"), but the code's name itself is the network's explicit instruction not to attempt the charge again.",
      },
      {
        question: "Does Foxhound automatically stop retrying this code?",
        answer:
          "Yes. Foxhound's classifier places `do_not_try_again` in its fraud and hard-decline bucket, so no automatic retry and no silent background attempt ever runs against it.",
      },
      {
        question: "Is there anything a merchant still needs to do manually for this code?",
        answer:
          "Not for the automated retry risk specifically, since Foxhound already blocks it. It's still worth watching the account: a `do_not_try_again` decline is a strong enough signal that direct outreach for a new payment method, rather than waiting on the standard dunning sequence, tends to resolve it faster.",
      },
      {
        question: "Is this the same as a card being reported lost or stolen?",
        answer:
          "Not necessarily. It's a network-level instruction not to retry, which can stem from several underlying causes the merchant isn't shown, not only lost or stolen card scenarios.",
      },
      {
        question: "Will repeated automatic retries against this code cause problems?",
        answer:
          "They can. Retrying against a network instruction not to try again risks the same kind of scrutiny that repeated attempts on any hard-blocked card can draw.",
      },
    ],
  },

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
        question: "What does \"velocity exceeded\" actually mean?",
        answer:
          "Per Stripe, it covers a card exceeding its balance, credit limit, or transaction amount limit. It's broader than just \"too many transactions.\"",
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
      "Retrying with the same incorrect CVC produces the same decline no matter how many times it runs. The issuing bank will not authorize a charge against a security code that doesn't match its records, and nothing about time or network conditions changes that. The fix is a corrected CVC, not persistence.\n\nThe direct, honest answer here matters. Foxhound's decline classifier sorts recognized declines into one of four named buckets: soft, network, expired, or fraud, with an unknown bucket for anything unrecognized. `incorrect_cvc` does not have a dedicated case in the four named buckets today. A code that isn't specifically recognized falls to the unknown bucket, which fails closed rather than defaulting to a retry: no automatic retry runs against it. In practice, that means an `incorrect_cvc` failure goes straight to a card-update email rather than a silent retry attempt, which happens to be the right outcome anyway, since retrying cannot fix a genuinely wrong security code any more than retrying fixes a wrong password.\n\nThat's exactly why going straight to a card-update prompt, rather than waiting on a retry, is the right approach here: a simple, non-alarming message such as \"we had trouble processing your payment, please confirm your card details\" resolves this faster than any retry could have anyway.",
    faqs: [
      {
        question: "Does `incorrect_cvc` mean the card is stolen or blocked?",
        answer:
          "No. It means the specific security code submitted with the charge didn't match the issuing bank's records. The card and account are otherwise unaffected.",
      },
      {
        question: "Will retrying the same charge eventually get an `incorrect_cvc` decline to succeed?",
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
      "Resubmitting the identical incorrect code will fail again, and again after that. There is no waiting period, no backoff schedule, and no number of attempts that turns a wrong security code into a right one. The only thing that changes the result is the customer supplying the correct code.\n\nBe straightforward about what your systems actually do here before promising customers anything specific. Foxhound's decline classifier sorts declines into four named buckets: soft, network, expired, and fraud, with an unknown bucket for anything unrecognized. `invalid_cvc` is not one of the codes given a dedicated case in the four named buckets. Anything not specifically recognized falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs. So today, an `invalid_cvc` failure goes straight to a card-update email rather than a silent retry, which is the correct outcome here since a retry has no real chance of correcting a submitted security code that simply doesn't match.\n\nThat's the same reason skipping straight to a card-update message, rather than a retry, is the right call: framing the outreach plainly, without over-explaining the CVC mismatch, keeps the ask simple, confirm your card details.",
    faqs: [
      {
        question: "Is `invalid_cvc` different from `incorrect_cvc` in a way that changes how a merchant should respond?",
        answer:
          "Not in practice. Stripe uses the two codes in slightly different situations, but for recovery purposes both mean the submitted security code didn't validate, and both need a corrected code from the customer.",
      },
      {
        question: "Can a customer's bank clear an `invalid_cvc` decline on its own over time?",
        answer:
          "No. There's nothing time-dependent here. The code either matches the bank's records or it doesn't, and that doesn't change without new input from the customer.",
      },
      {
        question: "Does Foxhound currently send an immediate, purpose-built email for `invalid_cvc`?",
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
      "No amount of retrying changes a wrong card number into a right one. Every attempt against the same incorrect digits produces the same decline. The only way forward is the customer re-entering the number correctly.\n\nHere's the honest picture of what actually happens today. Foxhound's decline classifier places recognized declines into one of four named buckets: soft, network, expired, or fraud, with an unknown bucket for anything unrecognized. `incorrect_number` does not have a dedicated case in the four named buckets. Anything the classifier doesn't specifically recognize falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs against it. So an `incorrect_number` failure goes straight to a card-update email rather than a silent retry, which is the right outcome, since a retry has no way of succeeding against a card number that was simply typed wrong.\n\nThat's exactly why going straight to a card-update request works better than a retry ever could: a short, plain message asking the customer to confirm their payment details, without dwelling on the specific reason, tends to get faster action than waiting would.",
    faqs: [
      {
        question: "Does `incorrect_number` mean the customer's card was declined by their bank for a real reason?",
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
      "Retrying the same malformed card number produces the same failure indefinitely. There's no backoff period or attempt count that turns an invalid number into a valid one. Resolution requires the customer to submit a correct number, not more attempts at the same one.\n\nHonesty about current handling matters more than a tidy story here. Foxhound's decline classifier sorts recognized declines into one of four named buckets: soft, network, expired, or fraud, plus an unknown bucket for anything unrecognized, and `invalid_number` isn't given a dedicated case in the four named buckets. Any code the classifier doesn't specifically recognize falls to the unknown bucket, which fails closed rather than retrying: no automatic retry runs. That means an `invalid_number` failure goes straight to a card-update email rather than a silent retry, which is the correct outcome since no retry can succeed against a number that failed basic validation in the first place.\n\nThat's why sending the customer straight to the payment-update page to re-enter their card number is the right fix, not a retry: it works regardless of how the underlying decline gets classified.",
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
        question: "Does Foxhound currently treat `invalid_number` with a dedicated, no-retry email flow?",
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
        question: "If a code isn't explicitly named in the classifier, does that mean it's treated as risky?",
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
        question: "Will a generic \"update your card\" email fix this?",
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
