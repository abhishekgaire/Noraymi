import { fakeId, fakeRouteSets, type FakeStripe } from "./server.js";

/**
 * Payouts and their balance transactions in the fake Stripe (M7-14): enough
 * for payout matching. `POST /fake/accounts/{a}/payout-run` pays out the
 * PaymentIntents named (each as a charge with Stripe's fee, 2.7% + 5¢),
 * any refunds named, a separate Stripe fee, and a Tap to Pay payment taken in
 * Stripe's Dashboard app that has no row of ours; it makes the payout and
 * sends `payout.reconciliation_completed`.
 */
const fee = (amount: number) => Math.floor((amount * 27 + 500) / 1000) + 5;

fakeRouteSets.push((fake: FakeStripe) => {
  fake.route("POST", "/fake/accounts/:id/payout-run", (req) => {
    const account = req.params["id"]!;
    const txns: Record<string, unknown>[] = [];
    const add = (
      type: string,
      amount: number,
      fees: number,
      source: Record<string, unknown> | null,
    ) =>
      txns.push(
        fake.put({
          id: fakeId("txn"),
          object: "balance_transaction",
          _account: account,
          type,
          amount,
          fee: fees,
          net: amount - fees,
          source,
        }),
      );
    const list = (key: string) =>
      String(req.body[key] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    for (const id of list("payment_intents")) {
      const pi = fake.get(id, account, "payment_intent");
      const amount = Number(pi["amount_received"] ?? pi["amount"] ?? 0);
      add("charge", amount, fee(amount), {
        id: String(pi["latest_charge"] ?? fakeId("ch")),
        object: "charge",
        payment_intent: id,
      });
    }
    for (const id of list("refunds")) {
      const r = fake.get(id, account, "refund");
      add("refund", -Number(r["amount"] ?? 0), 0, {
        id,
        object: "refund",
        payment_intent: r["payment_intent"],
      });
    }
    const feeCents = Number(req.body["fee_cents"] ?? 0);
    if (feeCents > 0) add("stripe_fee", -feeCents, 0, null);
    const tap = Number(req.body["tap_to_pay_cents"] ?? 0);
    if (tap > 0) {
      const charge = fake.put({
        id: fakeId("ch"),
        object: "charge",
        _account: account,
        amount: tap,
        payment_method_details: {
          type: "card_present",
          card_present: {
            brand: "visa",
            last4: String(req.body["tap_to_pay_last4"] ?? "4242"),
            funding: "credit",
          },
        },
      });
      const pi = fake.put({
        id: fakeId("pi"),
        object: "payment_intent",
        created: Math.floor(Date.now() / 1000),
        _account: account,
        amount: tap,
        amount_received: tap,
        currency: "usd",
        status: "succeeded",
        latest_charge: charge["id"],
        metadata: {},
      });
      add("charge", tap, fee(tap), {
        id: charge["id"],
        object: "charge",
        payment_intent: pi["id"],
      });
    }
    const net = txns.reduce((s, t) => s + Number(t["net"]), 0);
    const payout = fake.put({
      id: fakeId("po"),
      object: "payout",
      _account: account,
      amount: net + Number(req.body["off_by_cents"] ?? 0),
      arrival_date: Math.floor(Date.now() / 1000),
      status: "paid",
      currency: "usd",
    });
    fake.put({
      id: fakeId("txn"),
      object: "balance_transaction",
      _account: account,
      type: "payout",
      amount: -net,
      fee: 0,
      net: -net,
      source: payout["id"],
      _payout: payout["id"],
    });
    for (const t of txns) t["_payout"] = payout["id"];
    fake.emit("connect", "payout.reconciliation_completed", payout, account);
    return { body: { payout, transactions: txns.map((t) => t["id"]) } };
  });

  fake.route("GET", "/v1/payouts/:id", (req) => ({
    body: fake.get(req.params["id"]!, req.account, "payout"),
  }));

  fake.route("GET", "/v1/balance_transactions", (req) => ({
    body: {
      object: "list",
      data: fake.list(
        "balance_transaction",
        req.account,
        (t) => t["_payout"] === req.query["payout"],
      ),
      has_more: false,
    },
  }));
});
