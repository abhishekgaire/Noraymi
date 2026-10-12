import {
  FakeError,
  fakeId,
  fakeRouteSets,
  type FakeAnswer,
  type FakeRequest,
  type FakeStripe,
} from "./server.js";

/**
 * Stripe Billing in the fake (M8-15), on our own account with the billing
 * key only: prices with lookup keys, customers, Stripe's test payment
 * methods (`pm_card_visa`, and `pm_card_chargeCustomerFail`, which attaches
 * but fails every charge), subscriptions with items, invoices, the hosted
 * pages, and test clocks: advancing one renews each subscription on it and
 * charges the customer's card, sending `invoice.paid` or
 * `invoice.payment_failed` and `customer.subscription.updated` to our
 * billing endpoint as Stripe does. The fake holds no prices of its own;
 * tests make theirs.
 */
const CARDS: Readonly<Record<string, { brand: string; last4: string; fails: boolean }>> = {
  pm_card_visa: { brand: "visa", last4: "4242", fails: false },
  pm_card_mastercard: { brand: "mastercard", last4: "4444", fails: false },
  pm_card_chargeCustomerFail: { brand: "visa", last4: "0341", fails: true },
};
const MONTH_S = 30 * 24 * 3600;
/** The fake's one promotion code (100% off for a month), for tests and the demo only. */
export const FAKE_PROMO_CODE = "FAKEFIRSTMONTH";

const missing = (what: string) =>
  new FakeError(
    400,
    "invalid_request_error",
    "parameter_missing",
    `Missing required param: ${what}.`,
  );

function billingOnly(service: string): void {
  if (service !== "billing")
    throw new FakeError(
      403,
      "invalid_request_error",
      "secret_key_required",
      "The fake keeps Billing on the billing key alone.",
    );
}

/** A Customer on our own account (the billing key); the venue-account customers route hands these here. */
export function billingCustomer(fake: FakeStripe, req: FakeRequest): FakeAnswer {
  const b = req.body as { name?: string; email?: string; test_clock?: string; metadata?: unknown };
  if (b.test_clock) fake.get(b.test_clock, null, "test_clock");
  return {
    body: fake.put({
      id: fakeId("cus"),
      object: "customer",
      name: b.name ?? null,
      email: b.email ?? null,
      metadata: b.metadata ?? {},
      test_clock: b.test_clock ?? null,
      invoice_settings: { default_payment_method: null },
    }),
  };
}

fakeRouteSets.push((fake: FakeStripe) => {
  const now = (customer: Record<string, unknown>): number => {
    const clock = customer["test_clock"];
    if (typeof clock === "string")
      return Number(fake.get(clock, null, "test_clock")["frozen_time"]);
    return Math.floor(Date.now() / 1000);
  };
  const pmOf = (customer: Record<string, unknown>): string | null => {
    const s = customer["invoice_settings"] as
      { default_payment_method?: string | null } | undefined;
    return s?.default_payment_method ?? null;
  };
  const total = (sub: Record<string, unknown>): number =>
    ((sub["items"] as { data: Record<string, unknown>[] }).data ?? []).reduce((sum, item) => {
      const price = item["price"] as { unit_amount?: number | null };
      return sum + Number(price.unit_amount ?? 0) * Number(item["quantity"] ?? 1);
    }, 0);
  const subView = (sub: Record<string, unknown>) => sub;

  /** Charge an invoice to a card: paid, or left open with an attempt counted. */
  const charge = (invoice: Record<string, unknown>, pm: string | null): boolean => {
    const card = pm ? CARDS[pm] : undefined;
    invoice["attempt_count"] = Number(invoice["attempt_count"] ?? 0) + 1;
    invoice["attempted"] = true;
    // A $0.00 invoice (a 100%-off month) is paid without a card, as in Stripe.
    if (Number(invoice["amount_due"]) === 0 || (card && !card.fails)) {
      invoice["status"] = "paid";
      invoice["amount_paid"] = invoice["amount_due"];
      invoice["amount_remaining"] = 0;
      invoice["next_payment_attempt"] = null;
      return true;
    }
    return false;
  };

  /** The coupon's part of this invoice, and one month used of a repeating one. */
  const discounted = (sub: Record<string, unknown>, full: number): number => {
    const d = sub["_discount"] as
      { percent_off: number | null; amount_off: number | null; left: number | null } | undefined;
    if (!d || d.left === 0) return full;
    if (d.left !== null) d.left -= 1;
    if (d.percent_off) return full - Math.round((full * d.percent_off) / 100);
    return Math.max(0, full - Number(d.amount_off ?? 0));
  };

  const invoiceFor = (sub: Record<string, unknown>, at: number): Record<string, unknown> => {
    const due = discounted(sub, total(sub));
    return fake.put({
      id: fakeId("in"),
      object: "invoice",
      customer: sub["customer"],
      status: "open",
      amount_due: due,
      amount_paid: 0,
      amount_remaining: due,
      currency: "usd",
      attempt_count: 0,
      created: at,
      period_start: at,
      period_end: at,
      next_payment_attempt: at + 3 * 24 * 3600,
      hosted_invoice_url: "",
      parent: { type: "subscription_details", subscription_details: { subscription: sub["id"] } },
    });
  };

  const settle = (
    sub: Record<string, unknown>,
    invoice: Record<string, unknown>,
    paid: boolean,
  ) => {
    const before = sub["status"];
    sub["latest_invoice"] = invoice["id"];
    invoice["hosted_invoice_url"] = `${fake.publicBase}/fake/invoices/${String(invoice["id"])}`;
    if (paid) {
      if (before !== "active") sub["status"] = "active";
      fake.emit("platform", "invoice.paid", invoice);
    } else {
      sub["status"] = before === "incomplete" || before === undefined ? "incomplete" : "past_due";
      fake.emit("platform", "invoice.payment_failed", invoice);
    }
    if (sub["status"] !== before && before !== undefined)
      fake.emit("platform", "customer.subscription.updated", subView(sub));
  };

  fake.route("POST", "/v1/prices", (req) => {
    billingOnly(req.service);
    const b = req.body as {
      unit_amount?: string;
      currency?: string;
      lookup_key?: string;
      product?: string;
    };
    if (!b.currency) throw missing("currency");
    return {
      body: fake.put({
        id: fakeId("price"),
        object: "price",
        active: true,
        currency: b.currency,
        unit_amount: b.unit_amount !== undefined ? Number(b.unit_amount) : null,
        lookup_key: b.lookup_key ?? null,
        recurring: { interval: "month" },
        product: b.product ?? fakeId("prod"),
      }),
    };
  });

  fake.route("GET", "/v1/prices", (req) => {
    billingOnly(req.service);
    const raw = req.query["lookup_keys"];
    const keys = Array.isArray(raw)
      ? raw.map(String)
      : raw
        ? Object.values(raw as object).map(String)
        : null;
    const data = fake.list(
      "price",
      null,
      (p) => p["active"] === true && (!keys || keys.includes(String(p["lookup_key"]))),
    );
    return { body: { object: "list", data, has_more: false } };
  });

  fake.route("POST", "/v1/test_helpers/test_clocks", (req) => {
    billingOnly(req.service);
    const frozen = Number(req.body["frozen_time"]);
    if (!frozen) throw missing("frozen_time");
    return {
      body: fake.put({
        id: fakeId("clock"),
        object: "test_clock",
        frozen_time: frozen,
        status: "ready",
      }),
    };
  });

  fake.route("POST", "/v1/test_helpers/test_clocks/:id/advance", (req) => {
    billingOnly(req.service);
    const clock = fake.get(req.params["id"]!, null, "test_clock");
    const to = Number(req.body["frozen_time"]);
    if (!(to > Number(clock["frozen_time"])))
      throw new FakeError(400, "invalid_request_error", null, "frozen_time must move forward.");
    clock["frozen_time"] = to;
    const customers = new Set(
      fake.list("customer", null, (c) => c["test_clock"] === clock["id"]).map((c) => c["id"]),
    );
    for (const sub of fake.list("subscription", null, (s) => customers.has(s["customer"]))) {
      if (sub["status"] === "canceled") continue;
      while (Number(sub["current_period_end"]) <= to) {
        const start = Number(sub["current_period_end"]);
        sub["current_period_start"] = start;
        sub["current_period_end"] = start + MONTH_S;
        const customer = fake.get(String(sub["customer"]), null, "customer");
        const invoice = invoiceFor(sub, start);
        settle(sub, invoice, charge(invoice, pmOf(customer)));
      }
    }
    return { body: clock };
  });

  const customerView = (c: Record<string, unknown>, expand: unknown) => {
    const wanted = Array.isArray(expand)
      ? expand.map(String)
      : expand
        ? Object.values(expand as object).map(String)
        : [];
    const pm = pmOf(c);
    if (!wanted.includes("invoice_settings.default_payment_method") || !pm) return c;
    return {
      ...c,
      invoice_settings: {
        default_payment_method: {
          id: pm,
          object: "payment_method",
          type: "card",
          card: { brand: CARDS[pm]!.brand, last4: CARDS[pm]!.last4 },
        },
      },
    };
  };

  fake.route("GET", "/v1/customers/:id", (req) => {
    billingOnly(req.service);
    return {
      body: customerView(fake.get(req.params["id"]!, null, "customer"), req.query["expand"]),
    };
  });

  fake.route("POST", "/v1/customers/:id", (req) => {
    billingOnly(req.service);
    const c = fake.get(req.params["id"]!, null, "customer");
    const pm = (req.body["invoice_settings"] as { default_payment_method?: string } | undefined)
      ?.default_payment_method;
    if (pm !== undefined) {
      if (pm && !CARDS[pm])
        throw new FakeError(
          400,
          "invalid_request_error",
          "resource_missing",
          `No such PaymentMethod: '${pm}'`,
        );
      c["invoice_settings"] = { default_payment_method: pm || null };
    }
    return { body: c };
  });

  fake.route("POST", "/v1/payment_methods/:id/attach", (req) => {
    billingOnly(req.service);
    const pm = req.params["id"]!;
    if (!CARDS[pm])
      throw new FakeError(
        400,
        "invalid_request_error",
        "resource_missing",
        `No such PaymentMethod: '${pm}'`,
      );
    fake.get(String(req.body["customer"] ?? ""), null, "customer");
    return {
      body: {
        id: pm,
        object: "payment_method",
        customer: req.body["customer"],
        card: { brand: CARDS[pm]!.brand, last4: CARDS[pm]!.last4 },
      },
    };
  });

  /** A subscription with its first invoice, charged to the customer's card (or $0.00 with a coupon). */
  const subscribe = (
    customerId: string,
    rawItems: unknown,
    metadata: unknown,
    coupon: Record<string, unknown> | null,
  ): Record<string, unknown> => {
    const customer = fake.get(customerId, null, "customer");
    const items = Object.values(
      (rawItems ?? {}) as Record<string, { price?: string; quantity?: string }>,
    );
    if (items.length === 0) throw missing("items");
    const at = now(customer);
    const sub: Record<string, unknown> = fake.put({
      id: fakeId("sub"),
      object: "subscription",
      customer: customerId,
      metadata: metadata ?? {},
      current_period_start: at,
      current_period_end: at + MONTH_S,
      items: {
        object: "list",
        data: items.map((i) => {
          if (!i.price) throw missing("items[][price]");
          const price = fake.get(i.price, null, "price");
          return {
            id: fakeId("si"),
            object: "subscription_item",
            price,
            quantity: Number(i.quantity ?? 1),
          };
        }),
      },
    });
    if (coupon)
      sub["_discount"] = {
        percent_off: coupon["percent_off"] ?? null,
        amount_off: coupon["amount_off"] ?? null,
        left:
          coupon["duration"] === "forever"
            ? null
            : coupon["duration"] === "once"
              ? 1
              : Number(coupon["duration_in_months"] ?? 1),
      };
    const invoice = invoiceFor(sub, at);
    settle(sub, invoice, charge(invoice, pmOf(customer)));
    fake.emit("platform", "customer.subscription.created", sub);
    return sub;
  };

  fake.route("POST", "/v1/subscriptions", (req) => {
    billingOnly(req.service);
    const b = req.body as { customer?: string; items?: unknown; metadata?: unknown };
    if (!b.customer) throw missing("customer");
    return { body: subscribe(b.customer, b.items, b.metadata, null) };
  });

  fake.route("GET", "/v1/subscriptions/:id", (req) => {
    billingOnly(req.service);
    return { body: fake.get(req.params["id"]!, null, "subscription") };
  });

  fake.route("DELETE", "/v1/subscriptions/:id", (req) => {
    billingOnly(req.service);
    const sub = fake.get(req.params["id"]!, null, "subscription");
    sub["status"] = "canceled";
    fake.emit("platform", "customer.subscription.deleted", sub);
    return { body: sub };
  });

  fake.route("POST", "/v1/subscription_items/:id", (req) => {
    billingOnly(req.service);
    const id = req.params["id"]!;
    const sub = fake.list("subscription", null, (s) =>
      (s["items"] as { data: { id: string }[] }).data.some((i) => i.id === id),
    )[0];
    if (!sub)
      throw new FakeError(
        404,
        "invalid_request_error",
        "resource_missing",
        `No such subscription item: '${id}'`,
      );
    const item = (sub["items"] as { data: Record<string, unknown>[] }).data.find(
      (i) => i["id"] === id,
    )!;
    if (req.body["quantity"] === undefined) throw missing("quantity");
    item["quantity"] = Number(req.body["quantity"]);
    fake.emit("platform", "customer.subscription.updated", sub);
    return { body: item };
  });

  fake.route("GET", "/v1/invoices/:id", (req) => {
    billingOnly(req.service);
    return { body: fake.get(req.params["id"]!, null, "invoice") };
  });

  const pay = (id: string, pm: string | null) => {
    const invoice = fake.get(id, null, "invoice");
    if (invoice["status"] === "paid")
      throw new FakeError(
        400,
        "invalid_request_error",
        "invoice_already_paid",
        "Invoice is already paid",
      );
    const sub = fake.get(
      String(
        (invoice["parent"] as { subscription_details: { subscription: string } })
          .subscription_details.subscription,
      ),
      null,
      "subscription",
    );
    const customer = fake.get(String(invoice["customer"]), null, "customer");
    const card = pm ?? pmOf(customer);
    if (pm) customer["invoice_settings"] = { default_payment_method: pm };
    const paid = charge(invoice, card);
    if (!paid)
      throw new FakeError(
        402,
        "card_error",
        "card_declined",
        "Your card was declined.",
        "generic_decline",
      );
    settle(sub, invoice, true);
    return invoice;
  };

  fake.route("POST", "/v1/invoices/:id/pay", (req) => {
    billingOnly(req.service);
    const pm = req.body["payment_method"];
    return { body: pay(req.params["id"]!, typeof pm === "string" ? pm : null) };
  });

  fake.route("POST", "/v1/invoices/create_preview", (req) => {
    billingOnly(req.service);
    const sub = fake.get(String(req.body["subscription"] ?? ""), null, "subscription");
    const next = Number(sub["current_period_end"]);
    return {
      body: {
        object: "invoice",
        id: null,
        status: "draft",
        customer: sub["customer"],
        amount_due: total(sub),
        currency: "usd",
        period_end: next,
        next_payment_attempt: next,
        parent: { type: "subscription_details", subscription_details: { subscription: sub["id"] } },
      },
    };
  });

  fake.route("POST", "/v1/billing_portal/sessions", (req) => {
    billingOnly(req.service);
    const customer = String(req.body["customer"] ?? "");
    fake.get(customer, null, "customer");
    const back = String(req.body["return_url"] ?? "");
    return {
      body: fake.put({
        id: fakeId("bps"),
        object: "billing_portal.session",
        customer,
        return_url: back,
        url: `${fake.publicBase}/fake/billing/${customer}?return_url=${encodeURIComponent(back)}`,
      }),
    };
  });

  // Coupons and Promotion Codes (O-04): the founder's, made in Stripe; tests make theirs here.
  fake.route("POST", "/v1/coupons", (req) => {
    billingOnly(req.service);
    const b = req.body as Record<string, string | undefined>;
    if (!b["duration"]) throw missing("duration");
    return {
      body: fake.put({
        id: fakeId("coupon"),
        object: "coupon",
        percent_off: b["percent_off"] !== undefined ? Number(b["percent_off"]) : null,
        amount_off: b["amount_off"] !== undefined ? Number(b["amount_off"]) : null,
        currency: b["currency"] ?? null,
        duration: b["duration"],
        duration_in_months:
          b["duration_in_months"] !== undefined ? Number(b["duration_in_months"]) : null,
        valid: true,
      }),
    };
  });

  const promoView = (p: Record<string, unknown>) => ({
    ...p,
    promotion: { type: "coupon", coupon: fake.get(String(p["_coupon"]), null, "coupon") },
  });
  const makePromo = (code: string, coupon: string, extra: Record<string, unknown> = {}) =>
    fake.put({
      id: fakeId("promo"),
      object: "promotion_code",
      code,
      active: true,
      expires_at: null,
      max_redemptions: null,
      times_redeemed: 0,
      _coupon: coupon,
      ...extra,
    });

  fake.route("POST", "/v1/promotion_codes", (req) => {
    billingOnly(req.service);
    const b = req.body as {
      code?: string;
      promotion?: { coupon?: string };
      active?: string;
      expires_at?: string;
    };
    const coupon = b.promotion?.coupon;
    if (!coupon) throw missing("promotion[coupon]");
    fake.get(coupon, null, "coupon");
    if (!b.code) throw missing("code");
    return {
      body: promoView(
        makePromo(b.code, coupon, {
          active: b.active !== "false",
          expires_at: b.expires_at ? Number(b.expires_at) : null,
        }),
      ),
    };
  });

  fake.route("GET", "/v1/promotion_codes", (req) => {
    billingOnly(req.service);
    const code = req.query["code"] ? String(req.query["code"]) : null;
    const active = req.query["active"] === undefined ? null : req.query["active"] === "true";
    const data = fake
      .list(
        "promotion_code",
        null,
        (p) =>
          (code === null || String(p["code"]).toLowerCase() === code.toLowerCase()) &&
          (active === null || p["active"] === active),
      )
      .map(promoView);
    return { body: { object: "list", data, has_more: false } };
  });

  // The test-only code: 100% off for one month. It lives in the fake alone, never in our code.
  const seededCoupon = fake.put({
    id: fakeId("coupon"),
    object: "coupon",
    percent_off: 100,
    amount_off: null,
    currency: null,
    duration: "repeating",
    duration_in_months: 1,
    valid: true,
  });
  makePromo(FAKE_PROMO_CODE, String(seededCoupon["id"]));

  // Checkout Sessions in subscription mode (O-04), and the hosted page that finishes one.
  fake.route("POST", "/v1/checkout/sessions", (req) => {
    billingOnly(req.service);
    const b = req.body as {
      mode?: string;
      customer?: string;
      line_items?: unknown;
      discounts?: Record<string, { promotion_code?: string }>;
      success_url?: string;
      cancel_url?: string;
      client_reference_id?: string;
      subscription_data?: { metadata?: unknown };
    };
    if (b.mode !== "subscription")
      throw new FakeError(
        400,
        "invalid_request_error",
        null,
        "The fake makes subscription sessions only.",
      );
    if (!b.customer) throw missing("customer");
    fake.get(b.customer, null, "customer");
    if (!b.success_url) throw missing("success_url");
    const items = Object.values(
      (b.line_items ?? {}) as Record<string, { price?: string; quantity?: string }>,
    );
    if (items.length === 0) throw missing("line_items");
    for (const i of items) {
      if (!i.price) throw missing("line_items[][price]");
      fake.get(i.price, null, "price");
      if (!(Number(i.quantity ?? 1) >= 1))
        throw new FakeError(400, "invalid_request_error", null, "quantity must be at least 1.");
    }
    const promoId = Object.values(b.discounts ?? {})[0]?.promotion_code ?? null;
    if (promoId) {
      const promo = fake.get(promoId, null, "promotion_code");
      if (promo["active"] !== true)
        throw new FakeError(400, "invalid_request_error", null, "This promotion code is inactive.");
    }
    const id = fakeId("cs");
    return {
      body: fake.put({
        id,
        object: "checkout.session",
        mode: "subscription",
        status: "open",
        customer: b.customer,
        subscription: null,
        client_reference_id: b.client_reference_id ?? null,
        success_url: b.success_url,
        cancel_url: b.cancel_url ?? null,
        expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
        url: `${fake.publicBase}/fake/checkout/${id}`,
        _items: items,
        _promo: promoId,
        _metadata: b.subscription_data?.metadata ?? {},
      }),
    };
  });

  fake.route("GET", "/v1/checkout/sessions/:id", (req) => {
    billingOnly(req.service);
    return { body: fake.get(req.params["id"]!, null, "checkout.session") };
  });

  fake.route("POST", "/v1/checkout/sessions/:id/expire", (req) => {
    billingOnly(req.service);
    const cs = fake.get(req.params["id"]!, null, "checkout.session");
    if (cs["status"] !== "open")
      throw new FakeError(400, "invalid_request_error", null, "Only an open session can expire.");
    cs["status"] = "expired";
    cs["url"] = null;
    fake.emit("platform", "checkout.session.expired", cs);
    return { body: cs };
  });

  // Stripe's hosted page: opening it pays with Stripe's test Visa (or ?cancel=1 leaves), then goes back.
  fake.route("GET", "/fake/checkout/:id", (req) => {
    const cs = fake.get(req.params["id"]!, null, "checkout.session");
    if (req.query["cancel"] === "1" || cs["status"] !== "open")
      return {
        status: 302,
        body: "",
        headers: {
          location: String(cs["cancel_url"] ?? cs["success_url"]),
          "content-type": "text/plain",
        },
      };
    const customer = fake.get(String(cs["customer"]), null, "customer");
    customer["invoice_settings"] = { default_payment_method: "pm_card_visa" };
    const promo = cs["_promo"] ? fake.get(String(cs["_promo"]), null, "promotion_code") : null;
    if (promo) promo["times_redeemed"] = Number(promo["times_redeemed"] ?? 0) + 1;
    const coupon = promo ? fake.get(String(promo["_coupon"]), null, "coupon") : null;
    const sub = subscribe(String(cs["customer"]), cs["_items"], cs["_metadata"], coupon);
    cs["status"] = "complete";
    cs["subscription"] = sub["id"];
    cs["url"] = null;
    fake.emit("platform", "checkout.session.completed", cs);
    return {
      status: 302,
      body: "",
      headers: { location: String(cs["success_url"]), "content-type": "text/plain" },
    };
  });

  // A new item on a subscription (the per-room fee, once the first room exists).
  fake.route("POST", "/v1/subscription_items", (req) => {
    billingOnly(req.service);
    const sub = fake.get(String(req.body["subscription"] ?? ""), null, "subscription");
    const price = fake.get(String(req.body["price"] ?? ""), null, "price");
    const item = {
      id: fakeId("si"),
      object: "subscription_item",
      price,
      quantity: Number(req.body["quantity"] ?? 1),
    };
    (sub["items"] as { data: Record<string, unknown>[] }).data.push(item);
    fake.emit("platform", "customer.subscription.updated", sub);
    return { body: item };
  });

  // The hosted pages, as plain text in the fake.
  fake.route("GET", "/fake/billing/:id", (req) => ({
    body: `Billing page for ${req.params["id"]} (fake Stripe) · no real money`,
    headers: { "content-type": "text/plain" },
  }));
  fake.route("GET", "/fake/invoices/:id", (req) => ({
    body: `Invoice ${req.params["id"]} (fake Stripe) · no real money`,
    headers: { "content-type": "text/plain" },
  }));
});
