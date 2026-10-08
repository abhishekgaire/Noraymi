# Cellular signal check at every pay point (M9-07)

Proves each pay point's Stripe Reader S710 can take a payment over its own cellular connection when the venue's internet is gone ([spec 01](../spec/01-scope-architecture.md) · When the venue's internet drops, item 1; [spec 09](../spec/09-devices-printing-offline.md) · Supported hardware). Run it after the hardware install (`hardware-install.md`) and before the first live night, at a busy hour (a Friday or Saturday night), at the **bar** and at the **front desk**.

**What "passes" means** (spec gap; cautious default until the founder sets another): three live payments in a row complete over cellular at that pay point, each refunded, with no unknown result ("Checking with Stripe · don't retry"). One failure, or one unknown result, fails that pay point: fix it and start its three again.

## Before you start

- A manager is signed in at the pay point. The reader is labeled "Bar S710" or "Front desk S710", and `pnpm --filter @west4/api devices:check` shows it with "cellular on, online".
- Have a real card of your own (a manager's or the owner's). Never a guest's. Card details stay on the reader; nothing is written down but the last four digits the receipt shows.
- Use a small amount, $1.00, as a bar sale with a note ("cellular check").

## At each pay point, three times

1. On the reader: Settings → Network, turn **Wi-Fi off**. Wait until the reader shows it's on cellular.
2. Note the reader's cellular signal as the reader shows it (its bars, or the signal value on its network screen). Write exactly what it shows; don't estimate.
3. Take the $1.00 payment on that reader from the bar POS or DeskRoom. Note how many seconds it took and whether it completed.
4. Refund it at once from the check (manager's PIN). Note that the refund completed.
5. If the screen shows "Checking with Stripe · don't retry", **don't take the payment again**: wait for the reconciler to settle it, mark that try failed, and tell the founder.

Afterwards, turn the reader's Wi-Fi back on and check it shows online in Admin → Printers & devices.

## The record

Copy this into `docs/gate/cellular-check-<date>.md` and fill it in on the night. Leave nothing blank: write "not shown" if the reader shows no value.

| Pay point | Try | Time | Reader's signal | Paid over cellular? | Seconds | Refunded? | Who |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bar | 1 | | | | | | |
| Bar | 2 | | | | | | |
| Bar | 3 | | | | | | |
| Front desk | 1 | | | | | | |
| Front desk | 2 | | | | | | |
| Front desk | 3 | | | | | | |

Result: Bar passes / fails · Front desk passes / fails. Signed by the manager who ran it, with the date.

If a pay point fails on signal, move the reader (or ask the founder about a cellular booster) and run its three again. The router's own cellular backup is a different carrier from the readers' and is checked by the outage drill (`outage-drill.md`), not here.
