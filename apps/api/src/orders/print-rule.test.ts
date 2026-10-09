import { describe, expect, it } from "vitest";
import { printsBarTicket } from "./print-rule.js";

describe("printsBarTicket (M6-29, D99)", () => {
  const cases = [
    // what, source, check kind, setting, prints
    ["a round on Jess P.'s bar tab, setting off", "staff", "bar", false, false],
    ["a round on Jess P.'s bar tab, setting on", "staff", "bar", true, true],
    ["a quick sale, setting off", "staff", "quick", false, false],
    ["a quick sale, setting on", "staff", "quick", true, true],
    ["a gift for Jess P. rung on Tariq A.'s bar tab, setting off", "gift", "bar", false, true],
    ["an offline round on a bar tab synced later, setting off", "offline", "bar", false, false],
    ["drinks staff add to Room 9's tab, setting off", "staff", "room", false, true],
    ["drinks staff add to Room 9's tab, setting on", "staff", "room", true, true],
    ["Room 9's round rung with Open in the bar POS, setting off", "staff", "room", false, true],
    ["a guest's order from Room 9 at Accept, setting off", "room", "room", false, true],
    ["a guest's order from Room 9 at Accept, setting on", "room", "room", true, true],
    ["a bar tab before the setting was ever saved (absent)", "staff", "bar", undefined, false],
  ] as const;
  it.each(cases)("%s", (_what, source, checkKind, printBarDrinkTickets, prints) => {
    expect(printsBarTicket({ source, checkKind, printBarDrinkTickets })).toBe(prints);
  });
});
