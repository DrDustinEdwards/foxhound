A dispute is a customer asking their bank to reverse a charge. You have a window to respond, usually 7 to 21 days depending on the network. See ::postlink[stripe-disputes-guide] for the full process.

:::diagram[dispute-timeline]

## The evidence that wins

- A receipt that names the product and the amount
- Proof of delivery or of use: logins, API calls, downloads
- Your refund policy, shown at checkout
- Any messages where the customer acknowledged the charge

## Visa Compelling Evidence 3.0

Visa's CE 3.0 rules (effective April 2023) let you win a fraud dispute by showing two prior undisputed transactions from the same customer, 120 to 365 days old, sharing at least two of: IP address, device ID, shipping address, or user account.

| Field | Required | Example |
|:---|:---:|---:|
| IP address | One of two | 203.0.113.7 |
| Device fingerprint | One of two | fp_8c2e |
| User account | One of two | acct_example |

## Friendly fraud vs. true fraud: which is it?

Most "fraud" disputes on subscriptions are friendly fraud: the customer forgot they signed up. The fix is a clear descriptor and a reminder email before renewal.

:::diagram[friendly-fraud-funnel]

## Timing & deadlines

Respond early. A response filed on day 2 reads better than one filed at 11:59 on the last day.
