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
  // 4000 0000 0000 0259: pays, then the cardholder's bank disputes it (M4-24).
  pm_card_createDispute: { brand: "visa", last4: "0259" },
};

/** A card's brand from its number, as a reader reads it. */
const brandOf = (number: string) =>
  number.startsWith("4")
    ? "visa"
    : number.startsWith("5") || number.startsWith("2")
      ? "mastercard"
      : number.startsWith("34") || number.startsWith("37")
        ? "amex"
        : number.startsWith("6")
          ? "discover"
          : "unknown";
/** The same card always reads as the same fingerprint on an account, as Stripe's does. */
export function fakeFingerprint(number: string): string {
  let h = 2166136261;
  for (const ch of number) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `fp_${h.toString(36).padStart(7, "0")}${number.slice(-4)}`;
}

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
  let out = pi;
  const charge = pi["latest_charge"];
  if (typeof charge === "string" && wanted.includes("latest_charge"))
    out = { ...out, latest_charge: fake.objects.get(charge) ?? charge };
  // The collected card on the surcharge path (M4-25), with its funding type.
  const method = pi["payment_method"];
  if (typeof method === "string" && wanted.includes("payment_method") && fake.objects.has(method))
    out = { ...out, payment_method: fake.objects.get(method) };
  return out;
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
        payment_method_options: req.body["payment_method_options"] ?? {},
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
    // The dispute test card: the bank disputes it, with 7 days to answer.
    if (pm === "pm_card_createDispute") {
      const dispute = fake.put({
        id: fakeId("dp"),
        object: "dispute",
        _account: account,
        amount: pi["amount"],
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
        payment_intent: pi["id"],
        charge: charge["id"],
        evidence: {},
        evidence_details: {
          due_by: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
          submission_count: 0,
        },
      });
      setTimeout(
        () => fake.emit("connect", "charge.dispute.created", dispute, account),
        0,
      ).unref?.();
    }
    return { body: pi };
  });

  // Disputes (M4-24): read, and the evidence (submit=true sends it for review).
  fake.route("GET", "/v1/disputes/:id", (req) => ({
    body: fake.get(req.params["id"]!, needAccount(req.account), "dispute"),
  }));
  fake.route("POST", "/v1/disputes/:id", (req) => {
    const dispute = fake.get(req.params["id"]!, needAccount(req.account), "dispute");
    if (dispute["status"] !== "needs_response" && dispute["status"] !== "warning_needs_response")
      throw new FakeError(
        400,
        "invalid_request_error",
        "dispute_already_submitted",
        "This dispute is already under review.",
      );
    dispute["evidence"] = {
      ...(dispute["evidence"] as object),
      ...((req.body["evidence"] as object) ?? {}),
    };
    if (req.body["submit"] === "true") {
      dispute["status"] = "under_review";
      (dispute["evidence_details"] as Record<string, unknown>)["submission_count"] = 1;
    }
    return { body: dispute };
  });
  fake.route("POST", "/v1/files", (req) => ({
    body: fake.put({
      id: fakeId("file"),
      object: "file",
      _account: needAccount(req.account),
      purpose: "dispute_evidence",
    }),
  }));

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
    pi["canceled_at"] = Math.floor(Date.now() / 1000);
    pi["cancellation_reason"] = req.body["cancellation_reason"] ?? null;
    fake.emit("connect", "payment_intent.canceled", pi, req.account!);
    return { body: pi };
  });

  // A bar tab's hold grows (M6-07; Stripe · incremental authorizations): `amount` is the new total,
  // above the current one, on a held PaymentIntent whose card allows it. Stripe allows 10 per hold.
  fake.route("POST", "/v1/payment_intents/:id/increment_authorization", (req) => {
    const account = needAccount(req.account);
    const pi = fake.get(req.params["id"]!, account, "payment_intent");
    if (pi["status"] !== "requires_capture")
      throw new FakeError(
        400,
        "invalid_request_error",
        "payment_intent_unexpected_state",
        `This PaymentIntent's status is ${String(pi["status"])}; only a requires_capture PaymentIntent can be incremented.`,
      );
    const charge = fake.objects.get(String(pi["latest_charge"])) as
      { payment_method_details: { card_present: Record<string, unknown> } } | undefined;
    const present = charge?.payment_method_details.card_present;
    if (!present?.["incremental_authorization_supported"])
      throw new FakeError(
        400,
        "invalid_request_error",
        null,
        "This PaymentIntent doesn't support incremental authorizations.",
      );
    const amount = Number(req.body["amount"]);
    if (!Number.isInteger(amount) || amount <= Number(pi["amount"]))
      throw new FakeError(
        400,
        "invalid_request_error",
        "parameter_invalid_integer",
        "The amount must be greater than the PaymentIntent's current amount.",
      );
    const used = Number(pi["_increments"] ?? 0);
    if (used >= 10)
      throw new FakeError(
        400,
        "invalid_request_error",
        null,
        "This PaymentIntent has reached the maximum number of incremental authorizations.",
      );
    pi["_increments"] = used + 1;
    pi["amount"] = amount;
    pi["amount_capturable"] = amount;
    present["amount_authorized"] = amount;
    fake.emit("connect", "payment_intent.amount_capturable_updated", pi, account);
    return { body: pi };
  });

  // Closing a bar tab (M6-08; Stripe · place a hold, overcapture): `amount_to_capture` may pass the hold
  // on a card whose charge allows overcapture, by 50% of the hold or $50, whichever is greater.
  fake.route("POST", "/v1/payment_intents/:id/capture", (req) => {
    const account = needAccount(req.account);
    const pi = fake.get(req.params["id"]!, account, "payment_intent");
    if (pi["status"] !== "requires_capture")
      throw new FakeError(
        400,
        "invalid_request_error",
        "payment_intent_unexpected_state",
        `This PaymentIntent could not be captured because it has a status of ${String(pi["status"])}. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.`,
      );
    const capturable = Number(pi["amount_capturable"] ?? pi["amount"]);
    const amount =
      req.body["amount_to_capture"] === undefined
        ? capturable
        : Number(req.body["amount_to_capture"]);
    const charge = fake.objects.get(String(pi["latest_charge"])) as
      | {
          amount: number;
          amount_captured?: number;
          captured?: boolean;
          payment_method_details: { card_present: Record<string, unknown> };
        }
      | undefined;
    const over = charge?.payment_method_details.card_present["overcapture_supported"] === true;
    const limit = over ? capturable + Math.max(Math.floor((capturable + 1) / 2), 5000) : capturable;
    if (!Number.isInteger(amount) || amount <= 0 || amount > limit)
      throw new FakeError(
        400,
        "invalid_request_error",
        "amount_too_large",
        "The amount to capture is more than this PaymentIntent can capture.",
      );
    pi["status"] = "succeeded";
    pi["amount_received"] = amount;
    pi["amount_capturable"] = 0;
    pi["_captures"] = Number(pi["_captures"] ?? 0) + 1;
    if (charge) {
      charge.amount_captured = amount;
      charge.captured = true;
    }
    fake.emit("connect", "payment_intent.succeeded", pi, account);
    return { body: pi };
  });

  // Questions on the reader's screen (M6-08; Stripe · collect inputs, server-driven): a selection, a
  // number or a phone number; the answer comes back on the reader's action.
  fake.route("POST", "/v1/terminal/readers/:id/collect_inputs", (req) => {
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
    const inputs = req.body["inputs"];
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new FakeError(400, "invalid_request_error", "parameter_missing", "Missing inputs.");
    reader["action"] = {
      type: "collect_inputs",
      status: "in_progress",
      failure_code: null,
      collect_inputs: { inputs, metadata: req.body["metadata"] ?? {} },
    };
    return { body: reader };
  });

  // Stripe's test helper for a simulated reader's inputs. Which choice the guest taps, or what they
  // type, is fake-only (`selection`, `value`); without them the first choice is taken.
  fake.route("POST", "/v1/test_helpers/terminal/readers/:id/succeed_input_collection", (req) => {
    const account = needAccount(req.account);
    const reader = fake.get(req.params["id"]!, account, "terminal.reader");
    const action = reader["action"] as Record<string, unknown> | null;
    if (!action || action["type"] !== "collect_inputs" || action["status"] !== "in_progress")
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_action_not_in_progress",
        "No input collection in progress.",
      );
    const collect = action["collect_inputs"] as { inputs: Record<string, unknown>[] };
    collect.inputs = collect.inputs.map((input) => {
      if (input["type"] === "selection") {
        const choices = (input["selection"] as { choices: { id: string; text: string }[] }).choices;
        const picked = choices.find((x) => x.id === req.body["selection"]) ?? choices[0]!;
        return {
          ...input,
          skipped: false,
          selection: { choices, id: picked.id, text: picked.text },
        };
      }
      const type = String(input["type"]);
      return { ...input, skipped: false, [type]: { value: String(req.body["value"] ?? "") } };
    });
    action["status"] = "succeeded";
    fake.emit("readers", "terminal.reader.action_succeeded", reader, account);
    return { body: reader };
  });
  fake.route("POST", "/v1/test_helpers/terminal/readers/:id/timeout_input_collection", (req) => {
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
    action["status"] = "failed";
    action["failure_code"] = "terminal_reader_timeout";
    fake.emit("readers", "terminal.reader.action_failed", reader, account);
    return { body: reader };
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

  // The surcharge path (M4-25): collect first, change the amount, then confirm.
  fake.route("POST", "/v1/terminal/readers/:id/collect_payment_method", (req) => {
    const account = needAccount(req.account);
    const reader = fake.get(req.params["id"]!, account, "terminal.reader");
    if (reader["status"] !== "online")
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_offline",
        "Reader is currently offline.",
      );
    const pi = fake.get(String(req.body["payment_intent"]), account, "payment_intent");
    reader["action"] = {
      type: "collect_payment_method",
      status: "in_progress",
      failure_code: null,
      collect_payment_method: {
        payment_intent: pi["id"],
        collect_config: req.body["collect_config"] ?? {},
      },
    };
    return { body: reader };
  });
  fake.route("POST", "/v1/payment_intents/:id", (req) => {
    const pi = fake.get(req.params["id"]!, needAccount(req.account), "payment_intent");
    if (pi["status"] !== "requires_confirmation" && pi["status"] !== "requires_payment_method")
      throw new FakeError(
        400,
        "invalid_request_error",
        "payment_intent_unexpected_state",
        `PaymentIntent is ${String(pi["status"])}`,
      );
    if (req.body["amount"] !== undefined) pi["amount"] = Number(req.body["amount"]);
    const surcharge = (
      req.body["amount_details"] as { surcharge?: { amount?: string } } | undefined
    )?.surcharge?.amount;
    if (surcharge !== undefined)
      pi["amount_details"] = {
        ...(pi["amount_details"] as object),
        surcharge: { amount: Number(surcharge) },
      };
    return { body: pi };
  });
  fake.route("POST", "/v1/terminal/readers/:id/confirm_payment_intent", (req) => {
    const account = needAccount(req.account);
    const reader = fake.get(req.params["id"]!, account, "terminal.reader");
    const pi = fake.get(String(req.body["payment_intent"]), account, "payment_intent");
    if (pi["status"] !== "requires_confirmation")
      throw new FakeError(
        400,
        "invalid_request_error",
        "payment_intent_unexpected_state",
        `PaymentIntent is ${String(pi["status"])}`,
      );
    const collected = pi["_collected"] as {
      number: string;
      funding: string;
      tip: number;
      cardholderName: string | null;
      wallet: boolean;
      noIncrements?: boolean;
    };
    // A bar tab's hold (M6-06): incremental and overcapture support, when it must be captured,
    // and the card saved from the tap (a phone's wallet saves none).
    const manual = pi["capture_method"] === "manual";
    const incremental =
      (pi["payment_method_options"] as { card_present?: Record<string, unknown> } | undefined)
        ?.card_present?.["request_incremental_authorization_support"] === "true" &&
      !collected.noIncrements;
    const charge = fake.put({
      id: fakeId("ch"),
      object: "charge",
      _account: account,
      amount: Number(pi["amount"]) + collected.tip,
      payment_intent: pi["id"],
      payment_method_details: {
        type: "card_present",
        card_present: {
          brand: brandOf(collected.number),
          last4: collected.number.slice(-4),
          funding: collected.funding,
          fingerprint: fakeFingerprint(collected.number),
          cardholder_name: collected.cardholderName,
          generated_card:
            pi["setup_future_usage"] && !collected.wallet
              ? fake.put({
                  id: fakeId("pm"),
                  object: "payment_method",
                  _account: account,
                  type: "card",
                  card: { brand: brandOf(collected.number), last4: collected.number.slice(-4) },
                  customer: pi["customer"] ?? null,
                })["id"]
              : null,
          ...(manual
            ? {
                incremental_authorization_supported: incremental,
                overcapture_supported: true,
                amount_authorized: Number(pi["amount"]),
                capture_before: Math.floor(Date.now() / 1000) + 2 * 24 * 3600,
              }
            : {}),
        },
      },
    });
    pi["status"] = pi["capture_method"] === "manual" ? "requires_capture" : "succeeded";
    if (pi["status"] === "succeeded") pi["amount_received"] = Number(pi["amount"]) + collected.tip;
    else pi["amount_capturable"] = Number(pi["amount"]);
    pi["latest_charge"] = charge["id"];
    reader["action"] = {
      type: "confirm_payment_intent",
      status: "succeeded",
      failure_code: null,
      confirm_payment_intent: { payment_intent: pi["id"] },
    };
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
    const piId = (
      (action["process_payment_intent"] ?? action["collect_payment_method"]) as {
        payment_intent: string;
      }
    ).payment_intent;
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
    // Stripe's debit test cards (4000 0566 5566 5556, 5200 8282 8282 8210) collect as debit.
    const funding = ["4000056655665556", "5200828282828210"].includes(number) ? "debit" : "credit";
    // A collect (M4-25): the card is read and attached; nothing is charged until confirm.
    if (action["type"] === "collect_payment_method") {
      // A dip or swipe brings the cardholder's name; a tap or a phone doesn't (M6-06).
      const present = req.body["card_present"] as
        | {
            cardholder_name?: string;
            wallet?: string;
            fingerprint_on_confirm?: string;
            incremental?: string;
          }
        | undefined;
      // Whether a collected card carries its fingerprint before confirm is an open question
      // (M6-06): this fake-only switch reads it only once the hold is placed.
      const laterFingerprint = present?.fingerprint_on_confirm === "true";
      const cardholderName = present?.cardholder_name ?? null;
      const wallet = present?.wallet === "true";
      pi["status"] = "requires_confirmation";
      pi["payment_method"] = fake.put({
        id: fakeId("pm"),
        object: "payment_method",
        _account: account,
        type: "card_present",
        card_present: {
          brand: brandOf(number),
          last4: number.slice(-4),
          funding,
          fingerprint: laterFingerprint ? null : fakeFingerprint(number),
          cardholder_name: cardholderName,
          read_method: cardholderName ? "contact_emv" : "contactless_emv",
          ...(wallet ? { wallet: { type: "apple_pay" } } : {}),
        },
      })["id"];
      // Which cards' holds can grow is the issuer's call (M6-07): this fake-only switch reads a card
      // whose hold can't (`card_present[incremental]=false`).
      const noIncrements = present?.incremental === "false";
      pi["_collected"] = { number, funding, tip, cardholderName, wallet, noIncrements };
      action["status"] = "succeeded";
      (action["collect_payment_method"] as Record<string, unknown>)["payment_method"] =
        pi["payment_method"];
      fake.emit("readers", "terminal.reader.action_succeeded", reader, account);
      return { body: reader };
    }
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
          funding,
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
