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
    return {
      body: fake.put({
        id: fakeId("pi"),
        object: "payment_intent",
        _account: account,
        amount,
        currency: req.body["currency"] ?? "usd",
        status: "requires_payment_method",
        capture_method: req.body["capture_method"] ?? "automatic",
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

  fake.route("GET", "/v1/payment_intents/:id", (req) => ({
    body: withCharge(
      fake,
      fake.get(req.params["id"]!, needAccount(req.account), "payment_intent"),
      req.query["expand"],
    ),
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
