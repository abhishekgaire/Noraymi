# Everyone their own PIN and badge (M9-08)

Before the first live night, everyone on the team has set a new PIN on their own phone, turned alerts on, and paired a badge, and no PIN from the seed or the old system exists anywhere ([spec 02](../spec/02-tenancy-access.md) · PINs, Badges; [screens](../screens.md#n25-set-your-pin) N25). A PIN is never texted, emailed or shown to anyone, a manager included.

The team arrives from the import (M9-05) as invited people with no PIN and no badge.

## For each person

1. **The invite.** In Admin → Team, the owner sends the invite (or "Send the link again"). It goes to the person's own phone.
2. **On their phone:** they open the link, confirm their number once with the texted code, choose their PIN (4 digits; 6 for managers and the owner; common PINs like 1234 are refused) and pick English or Español.
3. **Alerts:** they add the staff app to the home screen and turn alerts on (on an iPhone the app walks them through Add to Home Screen first; push works only from there).
4. **Badge:** at the bar or front-desk computer, in Admin → Team, "Pair (tap the reader)" on their row, then they tap their badge on the USB reader. Check that a tap takes over the bar computer in under 2 seconds.

A forgotten PIN is a "Reset PIN" in Admin → Team, which sends a new link; nobody else sets it.

## Check

- **Admin → Team** shows "Nobody waiting" above the table. Otherwise each person's "Waiting for" column says what's left: Invite not accepted, No PIN, No badge (only once the venue has a badge reader), Alerts off.
- **The PIN check**, against production, from the ops laptop with the API's own `AUTH_SECRET_KEY` and `WEST4_ENV=production`:

  ```
  pnpm --filter @west4/api pins:check -- --venue west4karaoke
  ```

  It passes when none of the demo seed's PINs verifies for anyone and every PIN's newest audit row shows its own person set it (an invite's or a reset's Set your PIN). It names anyone else and never prints a PIN; send that person a PIN reset. Run it once everyone is set up and **again the day before the first live night**, and keep both outputs in `docs/gate/pins-<date>.md`.
