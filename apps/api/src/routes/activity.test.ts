import { describe, expect, it } from "vitest";
import { aboutFromEnv, activityRow, HIDDEN, maskValue } from "./activity.js";

const row = (over: Partial<Parameters<typeof activityRow>[0]>) =>
  activityRow({
    id: "7",
    at: new Date("2026-09-26T02:41:00Z"),
    business_date: "2026-09-25",
    actor: null,
    actor_name: null,
    support_grant_id: null,
    emergency: false,
    action: "guests.update",
    target: "guests/g1",
    changed_fields: [],
    old_values: {},
    new_values: {},
    ...over,
  });

describe("the activity log's masking (P-14)", () => {
  it("never shows a secret: PIN verifiers, tokens, keys, hashes, card details, bodies", () => {
    for (const key of [
      "pin_verifier",
      "host_token_hash",
      "manage_token_hash",
      "secret_enc",
      "wrapped_key",
      "card_last4",
      "last4",
      "card_fingerprint",
      "body",
      "accepted_ip",
      "scanned_fields",
      "public_key",
      "credential_id",
    ])
      expect(maskValue("anything", key, "sensitive-value")).toBe(HIDDEN);
  });

  it("masks phones to the last two digits, emails to a letter and the domain, guest names to initials", () => {
    expect(maskValue("guests", "phone_e164", "+12125550123")).toBe("••• ••• 23");
    expect(maskValue("venues", "contact", "mina@example.com")).toBe("m•••@example.com");
    expect(maskValue("guests", "name", "Marcus Thompson")).toBe("M. T.");
    expect(maskValue("tabs", "tab_name", "Jae")).toBe("J.");
    expect(maskValue("singers", "display_name", "Lily K")).toBe("L. K.");
    // Staff and menu names stay: they aren't guests'.
    expect(maskValue("users", "name", "Andy C.")).toBe("Andy C.");
    expect(maskValue("menu_items", "name", "Margarita")).toBe("Margarita");
  });

  it("masks inside settings objects and lists, and an email inside free text", () => {
    expect(
      maskValue("settings", "value", {
        accounting: { emailTo: ["books@example.com"] },
        twilio: { auth_token: "abc" },
        phone: "+12125550188",
        note: "send to owner@west4.nyc please",
        rate: 8875,
      }),
    ).toEqual({
      accounting: { emailTo: ["b•••@example.com"] },
      twilio: { auth_token: HIDDEN },
      phone: "••• ••• 88",
      note: "send to o•••@west4.nyc please",
      rate: 8875,
    });
  });

  it("marks fields written without values (guest contact details) as hidden", () => {
    const r = row({
      changed_fields: ["email", "name", "phone_e164"],
      old_values: { name: "Marcus Thompson" },
      new_values: { name: "Marcus T" },
    });
    expect(r.changes).toEqual([
      { field: "email", hidden: true, old: null, new: null },
      { field: "name", hidden: false, old: "M. T.", new: "M. T." },
      { field: "phone_e164", hidden: true, old: null, new: null },
    ]);
    expect(r.kind).toBe("guests");
    expect(r.op).toBe("update");
    expect(r.record_id).toBe("g1");
  });

  it("names the actor, the system, or our support staff", () => {
    expect(row({ actor: "u1", actor_name: "Jordan" }).actor).toEqual({
      user_id: "u1",
      name: "Jordan",
    });
    expect(row({}).actor).toBeNull();
    expect(row({ support_grant_id: "s1" }).support).toBe(true);
    expect(row({ emergency: true }).support).toBe(true);
  });

  it("reads About from the environment and never invents a contact", () => {
    expect(aboutFromEnv({})).toEqual({ version: "dev", supportEmail: null, supportPhone: null });
    expect(
      aboutFromEnv({ APP_VERSION: "1.4.2", SUPPORT_EMAIL: " help@x.test ", SUPPORT_PHONE: "" }),
    ).toEqual({ version: "1.4.2", supportEmail: "help@x.test", supportPhone: null });
  });
});
