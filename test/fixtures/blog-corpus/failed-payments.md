Failed payments are the quiet half of churn. Nobody decides to leave; a card just stops working. This is the short version of how recovery works, and the longer one is ::postlink[stripe-failed-payment-recovery|our complete guide].

::postlink[dunning-email-sequence]

## Why payments fail

Cards expire, banks flag unusual charges, and balances run low at the end of the month. On a $29/month plan, a 7% monthly failure rate is $2.03 of every $29 at risk, every month.

> A payment that fails is not a customer who left. Treat it like a support ticket, not a cancellation.

## The recovery sequence

1. Retry silently first.
2. If that fails, send the first email within an hour.
   - Keep it short.
   - Link straight to a card-update page.
3. Follow up on day 3, day 7 and day 14.

---

## What to measure

Recovery rate is recovered revenue divided by failed revenue, counted by the date the payment failed. Read more in ::postlink[net-revenue-retention-guide].

A post that no longer exists renders as code, so an editor notices: ::postlink[a-post-that-was-deleted].
