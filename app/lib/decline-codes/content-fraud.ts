// Per-code marketing copy for the /decline-codes library.
//
// Two codes needed correction against the source doc rather than a verbatim
// copy: revocation_of_authorization and do_not_try_again were researched and
// written while decline.ts's classifier still defaulted an unrecognized code to
// a silent soft retry (an open, since-fixed safety gap, see
// foxhound-decline-classifier-gap.md). decline.ts now fails closed (an
// unrecognized code resolves to "unknown", never auto-retried) and both codes
// are explicitly classified as fraud (never retried, same bucket as a reported
// lost or stolen card), so their copy here reflects that current, safer reality
// rather than the doc's original gap-disclosure framing.
import type { DeclineCodeContent } from "./content";

export const FRAUD_DECLINE_CONTENT: Record<string, DeclineCodeContent> = {
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
      'Stripe declined this payment because the cardholder has reported the card lost. The card is gone, the bank has been told, and the card is dead as a payment instrument regardless of who is presenting the number.\n\nStripe\'s official definition is direct: "the payment was declined because the card is reported lost." The cardholder (or someone with access to their account) told the issuing bank that the physical card is missing, and the bank shut it down. This is not a temporary hold and not a balance issue. It is a permanent block on that specific card number.',
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
        question:
          "Does Foxhound treat `lost_card` the same as an obvious fraud code like `stolen_card`?",
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
        question:
          "Why would an online subscription business ever see a point-of-sale code like this?",
        answer:
          'Card networks reuse the same response codes across in-person and online transactions. `pickup_card` is a network-level instruction tied to lost or stolen cards, and it can surface on an online charge even though there\'s no terminal to act on the "pickup" part.',
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
        question: 'Is it safe to send the customer a normal "update your card" email?',
        answer:
          "Yes, this code doesn't carry the same account-fraud risk as a stolen or restricted card, so a straightforward request to verify or update the payment method is reasonable.",
      },
      {
        question:
          "Why does Foxhound still classify this as fraud rather than a routine soft decline?",
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
};
