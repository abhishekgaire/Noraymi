# Live payment drill (M4-30)

The last check before West 4 takes real money: small live payments on West 4's own Stripe account, on both S710 readers, each captured and then refunded, including payments where we deliberately lose Stripe's answer. It proves that nothing charges twice when the network fails mid-payment.

**Who:** the owner (Abhishek) runs it with one manager (Andy) as witness. Allow one hour.

**Before you start**

1. The go-live checklist in Admin → Payments passes: the merchant category is checked, and both of you have a Stripe Dashboard login and a Tap to Pay phone confirmed.
2. Both S710s are registered to West 4's Stripe Location and show online in Admin → Devices.
3. Have two real cards of your own: one credit card and one debit card. Every payment is refunded at the end, but your bank may show it for a few days.
4. Open Stripe's live Dashboard on a laptop: Payments, filtered to today.

**The payments** (each about $1.00, on a test check you open for the drill)

| # | Reader | What happens |
| --- | --- | --- |
| 1 | Bar S710 | A normal tap with the credit card: Paid. |
| 2 | Front desk S710 | A normal tap with the debit card: Paid. |
| 3 | Bar S710 | Pull the reader's network cable (or turn off its Wi-Fi) after "Waiting for a tap", tap the card, plug it back in. The screen says "Checking with Stripe · don't retry". Don't tap again. Within a few minutes it reads Paid. |
| 4 | Front desk S710 | With the drill flag on (below), tap once. The screen says "Checking with Stripe · don't retry"; within a few minutes it reads Paid. |

**The drill flag** (only for payment 4, and only during the drill's hour)

The flag makes our server drop its own copy of Stripe's answer for that venue's taps, so the "Checking with Stripe" path runs on live readers. It turns itself off at the time you give it, and it must never be left on.

- Set it (an engineer, on the production database, with the owner watching): `update venues set drill_drop_until = now() + interval '30 minutes' where slug = 'west4karaoke';`
- Clear it straight after payment 4: `update venues set drill_drop_until = null where slug = 'west4karaoke';`
- Write the times you set and cleared it in the record.

**Afterwards**

1. Refund each drill payment from the check (Refund from check, sent to the other person to approve on their own phone). Each reads "Refund pending" and then "Refunded" once Stripe confirms.
2. In Stripe's live Dashboard, check each PaymentIntent: exactly one charge, and refunded. Payments 3 and 4 must show one charge each, not two.
3. Make the record: `pnpm --filter @west4/api drill:record -- --date <the night's business date>` and paste its output into `docs/drills/<date>.md`. Fill in who ran it, who witnessed, and the flag times. Commit it.

If anything charged twice, stop. Don't take live payments until it's understood and fixed.
