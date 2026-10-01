import { describe, expect, it } from "vitest";
import { t } from "./i18n/index.js";
import { guestOrderWords, staffOrderWordsKey } from "./orders.js";

describe("order words", () => {
  it("a decline shows the guest the glossary's sentence and the reason", () => {
    const w = guestOrderWords({
      status: "cancelled",
      cancel_reason: "declined",
      decline_reason: "Out of peach",
    });
    expect(t("en", w.key)).toBe("The bar couldn't take this order · nothing charged");
    expect(w.reason).toBe("Out of peach");
    expect(
      t("en", staffOrderWordsKey({ status: "cancelled", cancel_reason: "declined" }), {
        reason: "Out of peach",
      }),
    ).toBe("Declined by the bar · Out of peach");
  });

  it("every status has guest and staff words in both languages", () => {
    for (const status of [
      "ringing",
      "held",
      "accepted",
      "ready",
      "on_the_way",
      "delivered",
      "returned",
    ]) {
      for (const locale of ["en", "es"] as const) {
        expect(
          t(locale, guestOrderWords({ status, cancel_reason: null }).key, { room: "Room 9" }),
        ).not.toMatch(/^orders\./);
        expect(
          t(locale, staffOrderWordsKey({ status, cancel_reason: null }), {
            age: "0:43",
            name: "Andy",
            time: "10:52",
            reason: "No ID",
          }),
        ).not.toMatch(/^orders\./);
      }
    }
    expect(t("en", guestOrderWords({ status: "ringing", cancel_reason: null }).key)).toBe(
      "Sent to the bar · you can still cancel",
    );
    expect(t("en", guestOrderWords({ status: "cancelled", cancel_reason: "guest" }).key)).toBe(
      "Cancelled · nothing charged",
    );
  });
});
