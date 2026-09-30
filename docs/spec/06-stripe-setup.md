## Stripe setup

Each venue gets its own Stripe account under our platform. We create it, the owner finishes Stripe's onboarding, and from then on every payment, reader and refund is an API call with one of our restricted keys plus the venue's account id in the `Stripe-Account` header, the pattern Stripe documents for [Terminal with direct charges](https://docs.stripe.com/terminal/features/connect?connect-charge-type=direct).

**1. Create the venue's account.** Stripe tells new platforms to use [Accounts v2](https://docs.stripe.com/connect/accounts-v2). The venue pays Stripe's fees and Stripe covers losses, as decided:

```json
POST /v2/core/accounts
{
  "display_name": "West 4 Boho Karaoke",
  "contact_email": "<owner email>",
  "dashboard": "full",
  "identity": {
    "country": "us",
    "entity_type": "company",
    "business_details": { "registered_name": "<legal name>" }
  },
  "configuration": {
    "merchant": { "capabilities": { "card_payments": { "requested": true } } }
  },
  "defaults": {
    "currency": "usd",
    "responsibilities": { "fees_collector": "stripe", "losses_collector": "stripe" }
  }
}
```

Stripe's own example pins a preview API version, so pin one version for the whole codebase and upgrade on purpose. With the venue paying fees directly, [Stripe files its 1099-K](https://docs.stripe.com/connect/tax-reporting).

**2. Onboarding.** Setup step 7's "Connect with Stripe" button opens Stripe's hosted or embedded onboarding, so bank details and IDs never pass through us. The `account.updated` webhook tells us when card payments are enabled, and Admin shows a banner whenever Stripe needs more information.

**3. Merchant category.** Set each account's category to match the business: drinking places for a bar, eating places for a restaurant. [Tips added on the receipt](https://docs.stripe.com/terminal/features/collecting-tips/on-receipt) and Discover's [growing holds](https://docs.stripe.com/terminal/features/incremental-authorizations) depend on it, so Setup checks the category before bar tabs can be turned on.

**4. Card readers.** Create one Terminal Configuration per venue, with its tip choices and cellular turned on, then a Terminal Location that uses it, then register each reader to that Location with the code the reader shows. The tip choices are 18, 20 and 22%, and fixed amounts of $1, $2 and $3 on anything under $10, Stripe's smart tip threshold. Room checks carry the gratuity, so their taps pass `process_config[skip_tipping]=true`; a quick sale's tap passes `process_config[tipping][amount_eligible]` as the drinks before tax, so its percentages are worked out the way a bar tab's are; and a bar tab's close asks through `collect_inputs` with the same choices (Payment flows). West 4 has two S710 readers, labeled "Bar S710" and "Front desk S710", the names staff pick from, both with cellular on. Supported readers are the S710, S700 and WisePOS E. The M2 works only through Stripe's mobile SDKs, so Setup doesn't offer it, and Setup shows each reader's monthly cellular fee. Readers can take [up to 5 minutes](https://docs.stripe.com/terminal/features/collecting-tips/on-reader) to pick up a change, and they're enrolled in Stripe's P2PE program where Stripe lists the model (Security and data retention).

```http
POST /v1/terminal/configurations   Stripe-Account: acct_venue   tipping[usd][percentages][]=18, 20, 22; tipping[usd][smart_tip_threshold]=1000; tipping[usd][fixed_amounts][]=100, 200, 300; cellular[enabled]=true
POST /v1/terminal/locations        Stripe-Account: acct_venue   display_name, address, configuration_overrides=tmc_…
POST /v1/terminal/readers          Stripe-Account: acct_venue   registration_code, label ("Bar S710", "Front desk S710"), location
```

**5. Every call is safe to repeat.** Each POST to Stripe carries its attempt's [idempotency key](https://docs.stripe.com/api/idempotent_requests), `<payment_id>:<action>:<attempt_no>`; an increment's key also names its target amount, and a capture's its amount. Stripe saves the first answer to a key for 24 hours, errors included, and rejects a key reused with different parameters, so a retry after a decline is a new attempt with a new key. After any unclear error, the server reads the reader and the PaymentIntent before starting a new attempt (Payment flows).

**6. Webhooks.** Three endpoints. The two that carry venue events must be [Connect endpoints](https://docs.stripe.com/connect/webhooks), or events from the venues' accounts, reader events included, never arrive:

| Endpoint | Listens to | Events | Why |
| --- | --- | --- | --- |
| Reader actions | Connected accounts | `terminal.reader.action_succeeded`, `action_failed`, `action_updated` | On the payment's critical path, with its own worker pool |
| Venue payments | Connected accounts | `payment_intent.succeeded`, `amount_capturable_updated`, `payment_failed`, `requires_action`, `canceled`; `charge.refunded`; `refund.updated`, `refund.failed`; `charge.dispute.created`, `closed`, `funds_withdrawn`, `funds_reinstated`; `payout.reconciliation_completed`; `account.updated` | Keeps our payments in step with Stripe |
| Our billing | Our platform account | `customer.subscription.updated`, `deleted`; `invoice.paid`, `payment_failed` | Plan billing |

Each handler checks its endpoint's own signing secret, rejects an event whose `livemode` doesn't match the environment, stores the event id once in `webhook_events` and hands off to a job, so Stripe gets a 200 right away. The job resolves the venue from `event.account` and finds the payment by `stripe_pi_id`, never by metadata, which a venue owner can edit in their own Stripe Dashboard. It reads the object again from Stripe and applies the payment state machine under a row lock. [Stripe doesn't guarantee event order](https://docs.stripe.com/webhooks), so states only move forward, and a late or repeated event changes nothing. The webhook job, the screens' "check status" action and a reconciler that runs every 5 minutes all go through the same state machine. Staging uses a connected sandbox account, so reader events arrive exactly as they will in production.

**7. Keys.** Each service has a [restricted key](https://docs.stripe.com/keys/restricted-api-keys) with only what it needs, Connect access included: payments and Terminal; refunds; read-only reporting; and a billing key used only on our own account. The keys work only from our outbound IP addresses, live in the secrets manager, and rotate with at most 7 days of overlap. `Stripe-Account` comes only from `organizations.stripe_account_id` for the request's venue, and a `readerId` must belong to that venue.

**8. Payouts.** On `payout.reconciliation_completed`, list the payout's [balance transactions](https://docs.stripe.com/payouts/reconciliation) (`GET /v1/balance_transactions?payout=po_…&expand[]=data.source`, on the venue's account) and match each one's PaymentIntent to our payments row, taking the venue from that row. Payouts belong to the organization's account, but matching runs as a job with no user: a definer resolver maps each PaymentIntent to its venue from our payments row, and each venue's lines are written under that venue's scope into `payout_lines` by venue: each venue sees its own lines and its share of Stripe's fees, and the owner sees the whole payout. Anything unmatched, including activity made directly in the Stripe Dashboard, goes to Unmatched payments for a manager to match (step 11). Each payout gets its own journal entry: bank, Stripe fees and Stripe clearing.

**9. Disputes.** `charge.dispute.created` opens an item in Admin with evidence already gathered: the itemized receipt as a PDF, the room clock times, the booking with the policy version the guest accepted and when, damage photos, and who served. The files go up through Stripe's [Files API](https://docs.stripe.com/disputes/api) as dispute evidence, and the manager submits before Stripe's due date. Funds withdrawn and reinstated post to the journal.

**10. Online payments.** Booking deposits, payment links and Pay my share use Stripe's Payment Element on our payment page, which runs on its own origin ([Security and data retention](12-security-retention.md)). The page loads Stripe.js with our publishable key and the venue's account (`stripeAccount`), and the API creates each PaymentIntent on the venue's account, so these are direct charges like the readers' payments. Setup [registers the payment page's domain](https://docs.stripe.com/payments/payment-methods/pmd-registration) on each venue's account (`POST /v1/payment_method_domains` with `Stripe-Account`), without which Apple Pay and Google Pay don't show. A deposit saves the card for the later charges its policy names (`setup_future_usage=off_session`, with a Customer on the venue's account); a share paid with Pay my share saves nothing. These are online card payments at the online price (2.9% + 30¢), which is why Pay my share is a venue setting ([Payment flows](07-payment-flows.md)).

**11. Break-glass card taking.** When our cloud is down, a manager takes cards with Tap to Pay in [Stripe's Dashboard app](https://docs.stripe.com/no-code/in-person) on their own phone, signed in to the venue's Stripe account. Setup checks, and the outage drill uses, that every manager has a Dashboard login on the venue's account that can take payments, and a phone that supports Tap to Pay (an iPhone XS or later, or a supported Android phone). These payments have no row of ours, so when one arrives on the Venue payments endpoint or the reconciler finds it, it lands in Unmatched payments, a list a manager works through from Close the night: each payment shows its amount, card and time, and the manager picks the check it belongs to. Payout matching (step 8) sends anything still unmatched to the same list. If Stripe itself is down, Tap to Pay is down too, and the venue takes cash ([Devices, printing and offline](09-devices-printing-offline.md)).
