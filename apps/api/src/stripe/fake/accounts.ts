import { FakeError, fakeId, fakeRouteSets, type FakeStripe } from "./server.js";

/**
 * The fake's accounts (M4-01): Accounts v2 create and read, onboarding links
 * and the page they open, the venue's payouts, and test helpers to say what
 * Stripe still needs.
 */
function accountView(a: Record<string, unknown>, include: unknown): Record<string, unknown> {
  const wanted = Array.isArray(include)
    ? include.map(String)
    : include
      ? Object.values(include as object).map(String)
      : [];
  const { configuration, requirements, ...rest } = a;
  return {
    ...rest,
    ...(wanted.includes("configuration.merchant") ? { configuration } : {}),
    ...(wanted.includes("requirements") ? { requirements } : {}),
  };
}

function setCard(
  fake: FakeStripe,
  a: Record<string, unknown>,
  status: string,
  needs: string[],
): void {
  a["configuration"] = {
    // The fake's onboarded account reports a merchant category (5813, drinking places) for tests;
    // which category fits a karaoke bar is open with Stripe (M4-29).
    merchant: {
      capabilities: { card_payments: { requested: true, status } },
      ...(status === "active" ? { mcc: "5813" } : {}),
    },
  };
  a["requirements"] = {
    entries: needs.map((description) => ({
      description,
      minimum_deadline: { status: "currently_due" },
    })),
  };
  fake.emit("connect", "account.updated", { id: a["id"], object: "account" }, String(a["id"]));
}

fakeRouteSets.push((fake) => {
  fake.route("GET", "/fake/health", () => ({ body: { ok: true } }));

  fake.route("POST", "/v2/core/accounts", (req) => {
    const b = req.body as {
      display_name?: string;
      contact_email?: string;
      defaults?: Record<string, unknown>;
      identity?: Record<string, unknown>;
      dashboard?: string;
    };
    if (!b.display_name)
      throw new FakeError(
        400,
        "invalid_request_error",
        "parameter_missing",
        "display_name is required",
      );
    const a = fake.put({
      id: fakeId("acct"),
      object: "v2.core.account",
      display_name: b.display_name,
      contact_email: b.contact_email,
      dashboard: b.dashboard,
      identity: b.identity,
      defaults: b.defaults,
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true, status: "restricted" } } },
      },
      // As Stripe lists them: field paths, not sentences (West 4's sandbox account had 31).
      requirements: {
        entries: [
          { description: "configuration.merchant.mcc", minimum_deadline: { status: "past_due" } },
          {
            description: "identity.business_details.address",
            minimum_deadline: { status: "past_due" },
          },
        ],
      },
    });
    return { body: accountView(a, ["configuration.merchant", "requirements"]) };
  });

  fake.route("GET", "/v2/core/accounts/:id", (req) => ({
    body: accountView(fake.get(req.params["id"]!, null, "v2.core.account"), req.query["include"]),
  }));

  fake.route("POST", "/v2/core/account_links", (req) => {
    const b = req.body as {
      account?: string;
      use_case?: { account_onboarding?: { return_url?: string; refresh_url?: string } };
    };
    fake.get(String(b.account), null, "v2.core.account");
    const ret = b.use_case?.account_onboarding?.return_url ?? "";
    return {
      body: {
        object: "v2.core.account_link",
        account: b.account,
        url: `${fake.publicBase}/fake/onboarding/${b.account}?return_url=${encodeURIComponent(ret)}`,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    };
  });

  // The hosted onboarding: finishing it turns card payments on and sends account.updated.
  fake.route("GET", "/fake/onboarding/:id", (req) => {
    const a = fake.get(req.params["id"]!, null, "v2.core.account");
    setCard(fake, a, "active", []);
    const back = String(req.query["return_url"] ?? "");
    return back
      ? { status: 302, body: "", headers: { location: back, "content-type": "text/plain" } }
      : { body: "Onboarding complete (fake Stripe)", headers: { "content-type": "text/plain" } };
  });

  fake.route("GET", "/fake/dashboard/:id", (req) => ({
    body: `Stripe Dashboard for ${req.params["id"]} (fake)`,
    headers: { "content-type": "text/plain" },
  }));

  // Test helper: Stripe needs more information (or nothing more).
  fake.route("POST", "/fake/accounts/:id/needs", (req) => {
    const a = fake.get(req.params["id"]!, null, "v2.core.account");
    const needs = Object.values((req.body["needs"] as Record<string, string> | undefined) ?? {});
    setCard(fake, a, needs.length ? "restricted" : "active", needs);
    return { body: { ok: true } };
  });

  // Test helper: a payout on the account.
  fake.route("POST", "/fake/accounts/:id/payouts", (req) => {
    const p = fake.put({
      id: fakeId("po"),
      object: "payout",
      _account: req.params["id"],
      amount: Number(req.body["amount"] ?? 0),
      arrival_date: Number(req.body["arrival_date"] ?? Math.floor(Date.now() / 1000)),
      status: String(req.body["status"] ?? "paid"),
      currency: "usd",
    });
    return { body: p };
  });

  fake.route("GET", "/v1/payouts", (req) => ({
    body: { object: "list", data: fake.list("payout", req.account), has_more: false },
  }));
});
