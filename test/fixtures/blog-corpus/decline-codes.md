Every failed charge on Stripe comes back with a reason. Most teams read the top-level `card_declined` and stop there, but the useful part is the `decline_code` underneath it. This guide walks through the ones that matter and what to do about each. If you want the recovery playbook first, start with ::postlink[stripe-failed-payment-recovery].

:::diagram[decline-code-tree]

## What a decline code is

When a charge fails, Stripe returns an error object. The field to read is `decline_code`, not `code`. A charge that fails with `code: card_declined` and `decline_code: insufficient_funds` is a very different problem from one that fails with `decline_code: stolen_card`.

There are two families:

1. **Soft declines**: the bank said no *for now*. Retrying later often works.
2. **Hard declines**: the bank said no *for good*. Retrying wastes a network attempt and can hurt your authorization rate.

## The codes you will see most

| Decline code | Soft or hard | What to do |
|---|---|---|
| `insufficient_funds` | Soft | Retry after payday, usually the 1st or 15th |
| `generic_decline` | Soft | Retry once, then email the customer |
| `do_not_honor` | Soft | Ask the customer to call their bank |
| `expired_card` | Hard | Ask for a new card; see ::postlink[expiring-cards-silent-mrr-killer] |
| `stolen_card` | Hard | Never retry |

## Retry timing: what works

Retrying `insufficient_funds` at 9:00 on the 1st recovers far more than retrying at a random hour. A failed $49 charge retried on payday has a much better chance than the same $49 retried the next morning, and a $1,200 annual plan is worth a phone call.

Note: Stripe's Smart Retries already handles some of this. The question is what it misses.

### What's a soft decline, really?

A soft decline is the issuer saying the charge *could* succeed later. The ratio of soft to hard declines on a typical SaaS account is roughly 3:1.

### What's a soft decline, really?

The same heading twice is legal markdown, and each gets its own anchor.

## Further reading

- ::postlink[stripe-decline-codes|The full decline code reference]
- ::postlink[dunning-email-sequence]
- [Stripe's own decline code list](https://stripe.com/docs/declines/codes)
- [Our old guide on recovamrr.com](https://recovamrr.com/blog/stripe-decline-codes)
