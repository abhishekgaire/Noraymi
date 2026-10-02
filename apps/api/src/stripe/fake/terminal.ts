import { FakeError, fakeId, fakeRouteSets } from "./server.js";

/**
 * The fake's Terminal (M4-02): configurations, locations and readers on a
 * venue's account. A registration code "simulated-s710", "simulated-s700" or
 * "simulated-wpe" registers a simulated reader, as Stripe's sandbox does;
 * "simulated-m2" registers an M2 so the refusal can be tested. A test helper
 * takes a reader offline or back.
 */
// Stripe's sandbox reports a simulated reader's type with "simulated_" in front (West 4's sandbox, Oct 2).
const MODEL_OF_CODE: Record<string, string> = {
  "simulated-s710": "simulated_stripe_s710",
  "simulated-s700": "simulated_stripe_s700",
  "simulated-wpe": "simulated_bbpos_wisepos_e",
  "simulated-m2": "simulated_stripe_m2",
};

const needAccount = (account: string | null): string => {
  if (!account)
    throw new FakeError(
      400,
      "invalid_request_error",
      null,
      "Terminal objects live on the venue's account",
    );
  return account;
};

fakeRouteSets.push((fake) => {
  const configuration = (
    req: { body: Record<string, unknown>; account: string | null },
    id?: string,
  ) => {
    const account = needAccount(req.account);
    const existing = id ? fake.get(id, account, "terminal.configuration") : undefined;
    return fake.put({
      ...(existing ?? { id: fakeId("tmc"), object: "terminal.configuration", _account: account }),
      tipping: req.body["tipping"] ?? existing?.["tipping"],
      cellular: req.body["cellular"] ?? existing?.["cellular"],
    });
  };
  fake.route("POST", "/v1/terminal/configurations", (req) => ({ body: configuration(req) }));
  fake.route("POST", "/v1/terminal/configurations/:id", (req) => ({
    body: configuration(req, req.params["id"]),
  }));
  fake.route("GET", "/v1/terminal/configurations/:id", (req) => ({
    body: fake.get(req.params["id"]!, needAccount(req.account), "terminal.configuration"),
  }));

  fake.route("POST", "/v1/terminal/locations", (req) => {
    const account = needAccount(req.account);
    const config = req.body["configuration_overrides"];
    if (config) fake.get(String(config), account, "terminal.configuration");
    return {
      body: fake.put({
        id: fakeId("tml"),
        object: "terminal.location",
        _account: account,
        display_name: req.body["display_name"],
        address: req.body["address"],
        configuration_overrides: config ?? null,
      }),
    };
  });

  fake.route("POST", "/v1/terminal/readers", (req) => {
    const account = needAccount(req.account);
    const code = String(req.body["registration_code"] ?? "");
    const model = MODEL_OF_CODE[code];
    if (!model)
      throw new FakeError(
        400,
        "invalid_request_error",
        "terminal_reader_invalid_registration_code",
        "That registration code isn't valid.",
      );
    fake.get(String(req.body["location"]), account, "terminal.location");
    return {
      body: fake.put({
        id: fakeId("tmr"),
        object: "terminal.reader",
        _account: account,
        label: req.body["label"] ?? null,
        location: req.body["location"],
        device_type: model,
        serial_number: `FAKE-${Math.floor(Math.random() * 1e8)}`,
        status: "online",
        action: null,
      }),
    };
  });

  fake.route("GET", "/v1/terminal/readers", (req) => ({
    body: {
      object: "list",
      data: fake.list("terminal.reader", needAccount(req.account), (r) =>
        req.query["location"] ? r["location"] === req.query["location"] : true,
      ),
      has_more: false,
    },
  }));
  fake.route("GET", "/v1/terminal/readers/:id", (req) => ({
    body: fake.get(req.params["id"]!, needAccount(req.account), "terminal.reader"),
  }));
  fake.route("DELETE", "/v1/terminal/readers/:id", (req) => {
    const r = fake.get(req.params["id"]!, needAccount(req.account), "terminal.reader");
    fake.objects.delete(String(r["id"]));
    return { body: { id: r["id"], object: "terminal.reader", deleted: true } };
  });

  // Test helper: the reader goes offline, or comes back.
  fake.route("POST", "/fake/readers/:id/status", (req) => {
    const r = fake.get(req.params["id"]!, null, "terminal.reader");
    r["status"] = req.body["status"] === "offline" ? "offline" : "online";
    return { body: { ok: true } };
  });
});
