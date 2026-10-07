# Outage drill (M8-07)

Four drills at West 4, during closed hours, that prove the venue keeps working when the internet, the Wi-Fi or our cloud goes down: the right banner on every screen, orders queued behind an offline code and replayed as asked to wait with nothing charged twice, and break-glass Tap to Pay payments matched afterwards. Drill 1 also answers the open Stripe question: does a reader switch to cellular when the Wi-Fi stays up but the internet behind it is dead? ([Open technical questions](../spec/14-open-questions.md))

**Who:** the owner (Abhishek) and one manager (Andy), plus whoever installed the router if they can be there. Allow two hours. One person runs the steps, the other keeps the clock and takes screenshots.

## Rehearse it first (no venue needed)

The drills' software side runs locally against the simulated router, the bar computer's signed replay and the fake Stripe:

```
pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/ops/outage-drill.int.test.ts
```

It puts the venue on backup internet and back, replays a queue twice (it lands once), sends a round for a paid check to Review after outage, records two break-glass taps as Unmatched payments, then decides and matches everything and checks the report has no findings. The screens' banners, queue mode and replay are covered by the smoke tests (`pnpm e2e`: the staff app's banners and Review after outage, the desktop app's read-only view and queue mode).

## Before you start

1. The router and both S710 readers are installed at West 4 (pulled forward from M9-07's install). Admin → Devices shows the router, the bar computer, the front-desk computer and both readers online.
2. The router's LTE backup is ready: Admin → Devices shows the router's backup as ready, and the monthly failover test (M8-02) has passed.
3. West 4's Terminal Configuration has cellular on for both readers ([Stripe setup](../spec/06-stripe-setup.md)).
4. The bar computer has its offline secret (it gets one while online, M8-04), and Andy's and Abhishek's phones have opened the offline codes while online so they're cached. Print the sealed card of one-time codes for tonight's date as a spare.
5. The break-glass card is printed (Close the night → Break-glass card), and the go-live checklist in Admin → Payments shows both Andy and Abhishek ready for Tap to Pay: a Stripe Dashboard login on West 4's account and a supported phone.
6. Put the bar computer in device training. Every round queued in the drills goes on practice checks (T-…).
7. Open one live check for the drill's card payments (a bar tab named "Outage drill"). Every card payment is a small live one (about $1.00) on the real readers, from a live staff phone or by Tap to Pay, refunded at the end. Have your own cards ready; your bank may show the charges for a few days.
8. Write the start time and the business date. Take a screenshot of each screen before you begin.

## Drill 1: the internet down with the Wi-Fi up

1. Unplug the internet line from the router. Leave the router's LTE on and the Wi-Fi on.
2. Expect within about 2 minutes, on the bar computer and every staff phone on the Wi-Fi: the amber banner "On backup internet · card readers may take up to 2 min to switch".
3. On each reader, start a $1.00 payment from a staff phone and tap a card. Record for **each reader**: did it keep taking cards, did it move to cellular (the reader's status screen, or Admin → Devices), and how many seconds it took. A payment in those minutes may show "Checking with Stripe · don't retry": don't retry, wait for it to settle.
4. Plug the line back in. The banner clears.

**The open question:** if a reader kept taking cards over the Wi-Fi through LTE, it did not need cellular; if the router's LTE was off it would have to switch on its own. Write exactly what each reader did; the founder closes the question in the spec from that.

## Drill 2: the access point off

1. Turn the Wi-Fi access point off. The line stays plugged in.
2. Expect: both readers move to cellular and keep taking cards (take one $1.00 payment on each from a staff phone on cellular); room tablets go offline and the manager gets the device alert; screens on the Wi-Fi show their offline banner.
3. Turn the access point back on and wait until Admin → Devices shows everything online.

## Drill 3: the router's LTE off too

1. Unplug the line and turn the router's LTE off (or pull its SIM). The Wi-Fi stays on, with no internet behind it.
2. Expect on the bar computer the pink banner "Offline · read-only · orders queue with an offline code", and the board, open tabs and menu still readable.
3. Andy reads the offline code from his phone (it works from the cache). Enter it on the bar computer: queue mode opens.
4. Queue three rounds on practice checks. Each shows "queued · not charged". Ring one of the same rounds online on a staff phone on cellular too, so replay has a duplicate to catch.
5. Take a $1.00 tap on a reader, driven from a staff phone on cellular.
6. Plug the line back in and turn LTE on. Expect "Confirm replayed orders (N)" on the bar computer: every replayed round is asked to wait. Accept the ones that are real, cancel the duplicate. Nothing is charged twice.

## Drill 4: our cloud down

1. Block our API's and staff app's hostnames (the ones the staff app loads from, in `infra/README.md`'s outputs) with the router's own domain block list. Keep every staff phone on the venue Wi-Fi with its cellular data off, so the router's block applies to it too. Stripe's hostnames must stay reachable: check that a reader still shows online.
2. Expect the pink banner on the bar computer and queue mode behind a code, as in drill 3. Queue one round.
3. Following the break-glass card, take a $1.00 Tap to Pay payment in Stripe's Dashboard app on Andy's phone, and another on Abhishek's. Note the time, the amount and "Outage drill" on the card's log.
4. Remove the blocks. Expect the replay to land as asked to wait, and both taps in Unmatched payments.
5. A manager matches each tap to the "Outage drill" check (Unmatched payments → Match), and decides every offline order on Confirm replayed orders or Review after outage.

## Afterwards

1. Refund every live drill payment from the "Outage drill" check (Refund from check, approved on the other person's phone). Each reads "Refund pending", then "Refunded".
2. In Stripe's live Dashboard, check every PaymentIntent from tonight: one charge each, refunded.
3. Take the bar computer out of device training.
4. Make the report: `pnpm --filter @west4/api outage:record -- --date <the business date>` and save its output as `docs/drills/<date>-outage.md`. It prints a table per drill to fill in (times, what each screen and reader showed, the screenshot file names) and what the system recorded: the connection events, the offline queue and how replay landed it, and the break-glass payments with their matches. It exits non-zero while anything is open (an offline order still waiting, offline cash not posted, a break-glass payment unmatched, an order that landed twice); fix those and run it again. Fill in whose phone took each break-glass payment.
5. Put the screenshots in `docs/drills/<date>-outage/` and commit them with the report.
6. Write drill 1's answer in the report's "Open Stripe question" line and send it to the founder to close in the spec.

If anything charged twice, or a replayed order landed on a tab without a bartender accepting it, stop. Don't go live until it's understood and fixed.
