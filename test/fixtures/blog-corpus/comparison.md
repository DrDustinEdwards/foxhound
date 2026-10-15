Choosing a recovery tool comes down to three questions: what it costs, what it recovers that Stripe would not, and how much of your brand it puts in front of customers. This comparison uses example figures; plug in your own. For background, read ::postlink[stripe-failed-payment-recovery] and ::postlink[dunning-email-sequence|how the emails work].

## At a glance

| | Tool A | Tool B | Built in |
|---|---|---|---|
| Pricing | 25% of recovered | $249/month flat | Free |
| Silent retry first | Yes | No | Yes |
| Card-update page | Hosted | Hosted | Stripe's |
| Emails | AI-drafted | Templates | Basic |

## Pricing: flat fee vs. percentage

A flat $249/month costs the same whether you recover $500 or $50,000. A percentage costs nothing until something is recovered. At $2,000 recovered a month, 25% is $500; at $800 recovered it is $200, under the flat fee.

## Questions to ask a vendor

1. Do you count recoveries Stripe's Smart Retries would have made anyway?
2. How long before a recovery counts? 30 days absorbs the refund window.
3. Can I see every email before it sends?
4. What happens to my data if I cancel?

## Edge cases

- **Annual plans**: a failed $1,188 renewal is worth a personal email.
- **Trials**: a card that fails on day 15 of a 14-day trial is a conversion problem, not churn.
- **Multiple subscriptions**: retry the oldest invoice first.

## The bottom line

Pick the tool whose incentives match yours. If it is paid on recoveries, it should not be paid for what Stripe already recovers.

Questions? Email support@example.com or read ::postlink[stripe-disputes-guide] next.
