# Texts live on the 10DLC campaign (M8-22)

US carriers only deliver business texts from a local number once the business (the "brand") and what it sends (the "campaign") are registered through 10DLC and approved. Until West 4's service campaign reads **Approved**, production sends no text at all: the API refuses with `campaign_not_approved`, and Admin → Phone & texts says "Texts don't go out until the campaign is approved". Staging never waits for a campaign, but texts only our own test phones (`TEXT_ALLOW_LIST`).

**Who:** the founder, in Twilio's console with our platform login. Registration itself happens only through Twilio's own 10DLC process; we never register or edit anything on a carrier's site.

## Before you register

1. West 4's subaccount exists with its number (`pnpm --filter @west4/api twilio:subaccount`, M2-09).
2. In the subaccount's Messaging settings, **SMS pumping protection** is on, and Geo permissions allow the United States only (we text +1 numbers only; the API refuses anything else).
3. Have West 4's legal business name, EIN, address and website ready, exactly as on its tax registration. Nothing here is filled in from our seed; ask West 4.

## Register (Twilio console, West 4's subaccount)

1. **Brand:** Messaging → Regulatory compliance → create West 4's brand with the details above.
2. **Service campaign** (one campaign for every text except Review ask and Birthday):
   - Use case: the closest service type Twilio offers (for example "Customer care" or "Mixed"); describe booking confirmations, room-ready and wrap-up notices, receipts and payment links.
   - Sample messages: copy two or three from Admin → Texts as they read at West 4.
   - Opt-in: the guest gives their number for their own booking or waitlist spot, on the booking form or to staff.
   - Opt-out and help: STOP stops every text at once with one confirmation; HELP answers with West 4's name and number. Both are built (M2-23).
3. Make a **messaging service** for the campaign and put West 4's number in it. Copy its SID (it starts `MG`).
4. **Marketing campaign:** don't register one. Marketing texts is off at West 4, and both marketing texts (Review ask, Birthday) stay off until the lawyer answers whether they're marketing (spec 14).

## Record it, and again once approved

```
pnpm --filter @west4/api twilio:campaign -- --venue west4karaoke --service MG…
```

It reads the campaign's status from Twilio and stores it with the messaging service. Run it again when Twilio emails that the campaign is approved; Admin → Phone & texts then shows **Approved** and "Texts are going out". From then on every text goes through the messaging service. If Marketing texts is ever turned on, register its own campaign and run the command with `--marketing`.

## Go-live checks (production)

- [ ] Admin → Phone & texts shows the texting campaign **Approved**.
- [ ] Make a real booking with your own phone: the Booking confirmed text arrives.
- [ ] Text **HELP** to West 4's number: the answer names West 4 and its number.
- [ ] Text **STOP**: one confirmation comes back, and the next text to your phone (for example a second booking's confirmation) doesn't arrive.
- [ ] Marketing texts still reads Off in Admin → Modules.

## What the marketing rules do (built, waiting behind the module)

A marketing text needs Marketing texts on, its own approved campaign, the guest's own marketing opt-in stored with proof (the form, its wording, the IP address and the time), and a send time between 8 AM and 9 PM in the guest's time zone, taken from the area code and checked against the venue's. An area code that spans zones must fit all of them; an area code we can't place is refused. Any opt-out stops it at once, even one already queued.
