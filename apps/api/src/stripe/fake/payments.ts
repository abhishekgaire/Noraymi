import { FakeError, fakeId, fakeRouteSets, type FakeStripe } from "./server.js";

/**
 * The fake's PaymentIntents and reader actions (M4-05), as Stripe's sandbox
 * runs them: a PaymentIntent waits for a card; process_payment_intent puts it
 * on a reader (refused while the reader is offline or busy); Stripe's own test
 * helper present_payment_method "taps" a card, a decline with
 * 4000000000000002; cancel_action and cancel end it. Each outcome sends the
 * reader event to /readers and the PaymentIntent event to /connect.
 */
const DECLINE = "4000000000000002";
/** Stripe's test PaymentMethods by brand, and the last four of their test cards. */
const TEST_CARDS: Record<string, { brand: string; last4: string }> = {
  pm_card_visa: { brand: "visa", last4: "4242" },
  pm_card_amex: { brand: "amex", last4: "0005" },
  pm_card_mastercard: { brand: "mastercard", last4: "4444" },
  pm_card_discover: { brand: "discover", last4: "1117" },
  // 4000 0000 0000 0341: attaches to a Customer, then declines every later charge (M4-17).
  pm_card_chargeCustomerFail: { brand: "visa", last4: "0341" },
  // 4000 0000 0000 5126: pays, then any refund fails (M4-21).
  pm_card_refundFail: { brand: "visa", last4: "5126" },
};

const needAccount = (account: string | null): string => {
  if (!account)
    throw new FakeError(
      400,
      "invalid_request_error",
      null,
      "PaymentIntents live on the venue's account",
    );
  return account;
};

function withCharge(
  fake: FakeStripe,
  pi: Record<string, unknown>,
  expand: unknown,
): Record<string, unknown> {
  const wanted = Array.isArray(expand)
    ? expand.map(String)
    : expand
      ? Object.values(expand as object).map(String)
      : [];
  const charge = pi["latest_charge"];
  if (typeof charge === "string" && wanted.includes("latest_charge"))
    return { ...pi, latest_charge: fake.objects.get(charge) ?? charge };
  return pi;
}

fakeRouteSets.push((fake) => {
  // Customers on the venue's account (deposits save the card for later charges).
  fake.route("POST", "/v1/customers", (req) => ({
    body: fake.put({
      id: fakeId("cus"),
      object: "customer",
      _account: needAccount(req.account),
      name: req.body["name"] ?? null,
      email: req.body["email"] ?? null,
      metadata: req.body["metadata"] ?? {},
    }),
  }));

  // The payment page's domain, registered for Apple Pay and Google Pay (M4-15).
  fake.route("POST", "/v1/payment_method_domains", (req) => {
    const account = needAccount(req.account);
    const domain = String(req.body["domain_name"] ?? "");
    const known = fake.list("payment_method_domain", account, (d) => d["domain_name"] === domain);
    if (known[0]) return { body: known[0] };
    return {
      body: fake.put({
        id: fakeId("pmd"),
        object: "payment_method_domain",
        _account: account,
        domain_name: domain,
        enabled: true,
        apple_pay: { status: "active" },
        google_pay: { status: "active" },
      }),
    };
  });

  fake.route("POST", "/v1/payment_intents", (req) => {
    const account = needAccount(req.account);
    const amount = Number(req.body["amount"]);
    if (!Number.isInteger(amount) || amount <= 0)
      throw new FakeError(
        400,
        "invalid_request_error",
        "parameter_invalid_integer",
        "amount must be a positive integer",
      );
    const pm = req.body["payment_method"];
    // Stripe's test payment methods, confirmed at once: the deposit a guest paid online.
    if (typeof pm === "string" && req.body["confirm"] === "true") {
      const card = TEST_CARDS[pm];
      if (!card)
        throw new FakeError(
          400,
          "invalid_request_error",
          "resource_missing",
          `No such PaymentMethod: '${pm}'`,
        );
      // A later charge on a card that attaches but declines: the PaymentIntent stays, and the error carries it.
      if (pm === "pm_card_chargeCustomerFail" && req.body["off_session"] === "true") {
        const failed = fake.put({
          id: fakeId("pi"),
          object: "payment_intent",
          _account: account,
          amount,
          currency: req.body["currency"] ?? "usd",
          status: "requires_payment_method",
          capture_method: "automatic",
          payment_method: null,
          customer: req.body["customer"] ?? null,
          amount_received: 0,
          amount_capturable: 0,
          amount_details: {},
          last_payment_error: {
            code: "card_declined",
            decline_code: "generic_decline",
            message: "Your card was declined.",
          },
          latest_charge: null,
          metadata: req.body["metadata"] ?? {},
        });
        fake.emit("connect", "payment_intent.payment_failed", failed, account);
        return {
          status: 402,
          body: {
            error: {
              type: "card_error",
              code: "card_declined",
              decline_code: "generic_decline",
              message: "Your card was declined.",
              payment_intent: failed,
            },
          },
        };
      }
      const charge = fake.put({
        id: fakeId("ch"),
        object: "charge",
        _account: account,
        amount,
        payment_method_details: {
          type: "card",
          card: { brand: card.brand, last4: card.last4, funding: "credit" },
        },
      });
      const succeeded = fake.put({
        id: fakeId("pi"),
        object: "payment_intent",
        _account: account,
        amount,
        currency: req.body["currency"] ?? "usd",
        status: "succeeded",
        capture_method: "automatic",
        payment_method: pm,
        customer: req.body["customer"] ?? null,
        setup_future_usage: req.body["setup_future_usage"] ?? null,
        payment_method_types: req.body["payment_method_types"] ?? ["card"],
        amount_received: amount,
        amount_capturable: 0,
        amount_details: {},
        last_payment_error: null,
        latest_charge: charge["id"],
        metadata: req.body["metadata"] ?? {},
      });
      (charge as Record<string, unknown>)["payment_intent"] = succeeded["id"];
      if (req.body["off_session"] === "true")
        fake.emit("connect", "payment_intent.succeeded", succeeded, account);
      return { body: withCharge(fake, succeeded, req.body["expand"]) };
    }
    return {
      body: fake.put({
        id: fakeId("pi"),
        object: "payment_intent",
        _account: account,
        client_secret: `pi_secret_${fakeId("cs")}`,
        amount,
        currency: req.body["currency"] ?? "usd",
        status: "requires_payment_method",
        capture_method: req.body["capture_method"] ?? "automatic",
        automatic_payment_methods: req.body["automatic_payment_methods"] ?? null,
        setup_future_usage: req.body["setup_future_usage"] ?? null,
        customer: req.body["customer"] ?? null,
        payment_method_types: req.body["payment_method_types"] ?? ["card"],
        amount_received: 0,
        amount_capturable: 0,
        amount_details: {},
        last_payment_error: null,
        latest_charge: null,
        metadata: req.body["metadata"] ?? {},
      }),
    };
  });

  // The account's PaymentIntents, newest first (the reconciler's list).
  fake.route("GET", "/v1/payment_intents", (req) => {
    const account = needAccount(req.account);
    const gte = Number((req.query["created"] as { gte?: string } | undefined)?.gte ?? 0);
    const expand = req.query["expand"];
    const wantsCharge = (
      Array.isArray(expand) ? expand : expand ? Object.values(expand as object) : []
    )
      .map(String)
      .includes("data.latest_charge");
    const data = fake
      .list(
        "payment_intent",
        account,
        (pi) => Number(pi["created"] ?? Math.floor(Date.now() / 1000)) >= gte,
      )
      .map((pi) => (wantsCharge ? withCharge(fake, pi, ["latest_charge"]) : pi));
    return { body: { object: "list", data, has_more: false } };
  });

  fake.route("GET", "/v1/payment_intents/:id", (req) => ({
    body: withCharge(
      fake,
      fake.get(req.params["id"]!, needAccount(req.account), "payment_intent"),
      req.query["expand"],
    ),
  }));

  // Confirming with a test PaymentMethod, as Stripe.js does after the Payment Element.
  fake.route("POST", "/v1/payment_intents/:id/confirm", (req) => {
    const account = needAccount(req.account);
    const pi = fake.get(req.params["id"]!, account, "payment_intent");
    const pm = String(req.body["payment_method"] ?? "");
    if (pi["status"] !== "requires_payment_method")
      throw new FakeError(
        400,
        "invalid_request_error",
        "payment_intent_unexpected_state",
        `PaymentIntent is ${String(pi["status"])}`,
      );
    if (pm === "pm_card_chargeDeclined") {
      pi["last_payment_error"] = {
        code: "card_declined",
        decline_code: "generic_decline",
        message: "Your card was declined.",
      };
      fake.emit("connect", "payment_intent.payment_failed", pi, account);
      return {
        status: 402,
        body: {
          error: {
            type: "card_error",
            code: "card_declined",
            decline_code: "generic_decline",
            message: "Your card was declined.",
          },
        },
      };
    }
    const card = TEST_CARDS[pm];
    if (!card)
      throw new FakeError(
        400,
        "invalid_request_error",
        "resource_missing",
        `No such PaymentMethod: '${pm}'`,
      );
    const charge = fake.put({
      id: fakeId("ch"),
      object: "charge",
      _account: account,
      amount: pi["amount"],
      payment_intent: pi["id"],
      payment_method_details: {
        type: "card",
        card: { brand: card.brand, last4: card.last4, funding: "credit" },
      },
    });
    Object.assign(pi, {
      status: "succeeded",
      amount_received: pi["amount"],
      latest_charge: charge["id"],
      last_payment_error: null,
      payment_method: pm,
    });
    fake.emit("connect", "payment_intent.succeeded", pi, account);
    return { body: pi };
  });

  // Refunds (M4-21): pending first; Stripe then says succeeded (refund.updated) or, on the refund-fail
  // test card, failed (refund.failed). The event goes out after the answer, as Stripe's does.
  fake.route("POST", "/v1/refunds", (req) => {
    const account = needAccount(req.account);
    const pi = fake.get(String(req.body["payment_intent"] ?? ""), account, "payment_intent");
    if (pi["status"] !== "succeeded")
      throw new FakeError(
        400,
        "invalid_request_error",
        "charge_not_refundable",
        "This PaymentIntent has nothing captured to refund.",
      );
    const received = Number(pi["amount_received"] ?? 0);
    const already = Number(pi["_refunded"] ?? 0);
    const amount =
      req.body["amount"] === undefined ? received - already : Number(req.body["amount"]);
    if (!Number.isInteger(amount) || amount <= 0 || amount > received - already)
      throw new FakeError(
        400,
        "invalid_request_error",
        "amount_too_large",
        `Refund amount is greater than the unrefunded amount on the charge.`,
      );
    pi["_refunded"] = already + amount;
    const fails = pi["payment_method"] === "pm_card_refundFail";
    const refund = fake.put({
      id: fakeId("re"),
      object: "refund",
      _account: account,
      amount,
      currency: "usd",
      payment_intent: pi["id"],
      charge: pi["latest_charge"] ?? null,
      status: "pending",
      failure_reason: null,
      metadata: req.body["metadata"] ?? {},
    });
    const answer = { ...refund };
    setTimeout(() => {
      if (fails) {
        pi["_refunded"] = Number(pi["_refunded"]) - amount;
        Object.assign(refund, { status: "failed", failure_reason: "expired_or_canceled_card" });
        fake.emit("connect", "refund.failed", refund, account);
      } else {
        refund["status"] = "succeeded";
        fake.emit("connect", "refund.updated", refund, account);
      }
    }, 0).unref?.();
    return { body: answer };
  });

  fake.route("GET", "/v1/refunds/:id", (req) => ({
    body: fake.get(req.params["id"]!, needAccount(req.account), "refund"),
  }));

  fake.route("POST", "/v1/payment_intents/:id/cancel", (req) => {
    const pi = fake.get(req.params["id"]!, needAccount(req.account), "payment_intent");
    if (pi["status"] === "succeeded" || pi["status"] === "canceled")
      throw new FakeError(
        400,
        "invalid_request_error",
        "payment_intent_unexpected_state",
        `This PaymentIntent's status is ${String(pi["status"])}, so it can't be canceled.`,
      );
    pi["status"] = "canceled";
    fake.emit("connect", "payment_intent.canceled", pi, req.account!);
    return { body: pi };
  });

  fake.route("POST", "/v1/terminal/readers/:id/process_payment_intent", (req) => {
    const account = needAccount(req.account);
    const reader = fake.get(req.params["id"]!, account, "terminal.reader");
    if (reader["status"] !== "online")
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_offline",
        "Reader is currently offline.",
      );
    const action = reader["action"] as { status?: string } | null;
    if (action?.status === "in_progress")
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_busy",
        "Reader is currently busy.",
      );
    const pi = fake.get(String(req.body["payment_intent"]), account, "payment_intent");
    if (pi["status"] !== "requires_payment_method")
      throw new FakeError(
        400,
        "invalid_request_error",
        "payment_intent_unexpected_state",
        `PaymentIntent is ${String(pi["status"])}`,
      );
    reader["action"] = {
      type: "process_payment_intent",
      status: "in_progress",
      failure_code: null,
      process_payment_intent: {
        payment_intent: pi["id"],
        process_config: req.body["process_config"] ?? {},
      },
    };
    return { body: reader };
  });

  fake.route("POST", "/v1/terminal/readers/:id/cancel_action", (req) => {
    const account = needAccount(req.account);
    const reader = fake.get(req.params["id"]!, account, "terminal.reader");
    if (reader["status"] !== "online")
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_offline",
        "Reader is currently offline.",
      );
    const action = reader["action"] as Record<string, unknown> | null;
    if (!action || action["status"] !== "in_progress")
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_action_not_in_progress",
        "No action in progress.",
      );
    action["status"] = "failed";
    action["failure_code"] = "customer_canceled";
    fake.emit("readers", "terminal.reader.action_failed", reader, account);
    return { body: reader };
  });

  // Stripe's test helper: a card tapped on a simulated reader.
  fake.route("POST", "/v1/test_helpers/terminal/readers/:id/present_payment_method", (req) => {
    const account = needAccount(req.account);
    const reader = fake.get(req.params["id"]!, account, "terminal.reader");
    const action = reader["action"] as Record<string, unknown> | null;
    if (!action || action["status"] !== "in_progress")
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_action_not_in_progress",
        "No action in progress.",
      );
    const piId = (action["process_payment_intent"] as { payment_intent: string }).payment_intent;
    const pi = fake.get(piId, account, "payment_intent");
    const number = String(
      (req.body["card_present"] as { number?: string } | undefined)?.number ?? "4242424242424242",
    );
    if (number === DECLINE) {
      pi["last_payment_error"] = {
        code: "card_declined",
        decline_code: "generic_decline",
        message: "Your card was declined.",
      };
      action["status"] = "failed";
      action["failure_code"] = "card_declined";
      fake.emit("readers", "terminal.reader.action_failed", reader, account);
      fake.emit("connect", "payment_intent.payment_failed", pi, account);
      return { body: reader };
    }
    const tip = Number(req.body["amount_tip"] ?? 0);
    const charge = fake.put({
      id: fakeId("ch"),
      object: "charge",
      _account: account,
      amount: Number(pi["amount"]) + tip,
      payment_intent: pi["id"],
      payment_method_details: {
        type: "card_present",
        card_present: {
          brand: "visa",
          last4: number.slice(-4),
          funding: "credit",
          generated_card: null,
        },
      },
    });
    pi["status"] = pi["capture_method"] === "manual" ? "requires_capture" : "succeeded";
    if (pi["status"] === "succeeded") pi["amount_received"] = Number(pi["amount"]) + tip;
    else pi["amount_capturable"] = Number(pi["amount"]);
    pi["amount_details"] = tip ? { tip: { amount: tip } } : {};
    pi["last_payment_error"] = null;
    pi["latest_charge"] = charge["id"];
    action["status"] = "succeeded";
    fake.emit("readers", "terminal.reader.action_succeeded", reader, account);
    fake.emit(
      "connect",
      pi["status"] === "succeeded"
        ? "payment_intent.succeeded"
        : "payment_intent.amount_capturable_updated",
      pi,
      account,
    );
    return { body: reader };
  });
});
