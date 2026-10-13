# Texts from your own Twilio account: the venue's guide

Oct 12, 2026 · for a venue's owner or manager ([D123](../decisions.md)). Your venue's texts (booking confirmations, Room ready, receipts, sign-in codes for your staff) go from **your own Twilio account and your own number**. You are Twilio's customer: you pay Twilio for the number and the texts, and you register your business with the US carriers through Twilio. We never hold a Twilio account for you and never stand in between; the app only uses the keys you give it.

Until your texts are live, nothing is lost: sign-in codes, PIN-reset links and staff invites go **by email**, the manager's "order waiting" alert goes to their phone as a notification, and staff add singers at the bar.

**Who:** the venue's owner (or a manager), at a computer, with the business's legal name, EIN, address and website at hand, exactly as on its tax registration. Allow about an hour, then a few days to two weeks while the carriers approve.

## 1. Open a Twilio account

1. Sign up at twilio.com with the business's email. Choose SMS, and say you're texting customers about bookings.
2. **Upgrade the account** (Admin → Account billing → add a card). A trial account texts only phones you verify yourself and puts "Sent from your Twilio trial account" in front of every text; the app warns you while it's a trial.
3. One Twilio account (or a Twilio subaccount you make yourself) per venue. Two venues can't share one account in the app, because each venue's replies must reach the right venue.

## 2. Buy a number

Phone Numbers → Buy a number → United States, a local number with **SMS**. Pick one near the venue. Write it down.

## 3. Turn on the protections

- Messaging → Settings → **SMS pumping protection**: on. It stops fraud that sends texts to expensive numbers.
- Messaging → Settings → **Geo permissions**: the **United States** only. The app texts +1 numbers only and refuses anything else, so nothing else needs to be allowed.

## 4. Register your brand and campaign (10DLC)

US carriers only deliver business texts from a local number once the business (the "brand") and what it texts (the "campaign") are registered and approved. In Twilio's console, Messaging → Regulatory compliance (A2P 10DLC), register as a **direct customer** (your own business, not on behalf of others):

1. **Customer profile and brand:** the legal business name, EIN, business type, address, website and an authorized representative, exactly as on the tax registration. Standard brand registration is the usual choice for a venue.
2. **Service campaign** (one campaign for every text the app sends except Review ask and Birthday):
   - Use case: the closest service type Twilio offers ("Customer care" or "Mixed"). Describe booking confirmations, reminders, room-ready and wrap-up notices, receipts, payment links and sign-in codes for staff.
   - Sample messages: copy two or three from the app's Admin → Texts as they read at your venue.
   - How people opt in: the guest gives their number for their own booking or waitlist spot, on the booking form or to staff; staff give theirs when they join the team.
   - Opt-out and help: STOP stops every text at once with one confirmation; HELP answers with the venue's name and phone number. The app does both for you.
3. **Marketing campaign:** don't register one. Marketing texts (Review ask, Birthday) stay off until the lawyer answers whether they're marketing (spec 14).

## 5. Make a messaging service

Messaging → Services → Create. Name it after the venue, add **your number** to it (Sender Pool) and attach the **service campaign** to it (Twilio links the campaign to a service). Its ID starts with `MG`. You don't need to set any web addresses: the app sets them when you connect.

## 6. Connect it in the app

1. In the staff app, **Admin → Phone & texts** (or step 11 of Set up your venue) → **Connect your Twilio account**.
2. From Twilio's console home (Account Info), copy the **Account SID** (starts `AC`) and the **Auth Token** (press Show). Paste both and press **Check**. The app reads your account with a read-only call; nothing is saved yet.
3. Pick your **number** and your **messaging service**, then **Connect**. The app points the number's incoming texts at the app (so replies, STOP and HELP reach Messages), puts the number in the messaging service and reads the campaign's status.
4. The panel now reads **Connected · waiting for approval**. When Twilio emails that the campaign is approved, press **Check again**: it reads **Approved** and "Texts are going out".

Your Auth Token is stored encrypted and never shown again. If you change it in Twilio (Account → API keys & tokens → rotate), connect again with the new one, or texts and incoming replies stop. **Disconnect** makes the app forget the keys at once; texts then stop and codes go by email again.

## Go-live checks (production)

- [ ] Admin → Phone & texts shows **Approved**, with your number.
- [ ] Make a real booking with your own phone: the Booking confirmed text arrives from your number.
- [ ] Text **HELP** to your number: the answer names the venue and its phone number.
- [ ] Text **STOP**: one confirmation comes back, and the next text to your phone (for example a second booking's confirmation) doesn't arrive.
- [ ] Marketing texts still reads Off in Admin → Modules.

## What stays the same on every server

- Production texts nobody until the venue's service campaign reads **Approved** (the API refuses with `campaign_not_approved`). Staging never waits for a campaign but texts only our own test phones (`TEXT_ALLOW_LIST`). Locally and in the demo nothing is sent: the app accepts any well-formed test keys, an Auth Token of 32 zeros is refused as wrong, and texts show only in Messages.
- A marketing text needs Marketing texts on, its own approved campaign, the guest's own marketing opt-in stored with proof (the form, its wording, the IP address and the time), and a send time between 8 AM and 9 PM in the guest's time zone, taken from the area code and checked against the venue's. An area code that spans zones must fit all of them; an area code we can't place is refused. Any opt-out stops it at once, even one already queued.
- Our own team: nothing to set up in Twilio for a venue. `pnpm --filter @west4/api twilio:campaign -- --venue <slug>` re-reads a connected venue's campaign status from the server, the same as Check again.
