import { describe, expect, it } from "vitest";
import { requiredSteps, setupChecklist, unusedSteps, type SetupFacts } from "./setup.js";

const nothing: SetupFacts = {
  plan: null,
  venue: { name: true, legalName: true, address: false, guestPhone: false },
  planStarted: false,
  card: { connected: false, cardPaymentsOn: false },
  rooms: { roomWithCapacity: false, roomRate: false },
  hours: { hours: false, agePolicy: false },
  deposits: { rule: false, walkIn: false },
  money: { saved: false },
  menu: { pricedItem: false },
  team: { managerWithPin: false, firstOnCall: false, breachContact: false },
  licenses: { liquor: false },
  texts: { answered: false },
  devices: { reader: false, receiptPrinterWithDrawer: false, merchantCategory: false },
  skipped: [],
};

const everything: SetupFacts = {
  plan: "rooms",
  venue: { name: true, legalName: true, address: true, guestPhone: true },
  planStarted: true,
  card: { connected: true, cardPaymentsOn: true },
  rooms: { roomWithCapacity: true, roomRate: true },
  hours: { hours: true, agePolicy: true },
  deposits: { rule: true, walkIn: true },
  money: { saved: false },
  menu: { pricedItem: true },
  team: { managerWithPin: true, firstOnCall: true, breachContact: true },
  licenses: { liquor: true },
  texts: { answered: false },
  devices: { reader: true, receiptPrinterWithDrawer: true, merchantCategory: true },
  skipped: [],
};

describe("the setup checklist (O-02)", () => {
  it("requires every step but Money at the counter and Texts on the Rooms plans and before a plan", () => {
    const rooms = [
      "venue",
      "plan",
      "card",
      "rooms",
      "hours",
      "deposits",
      "menu",
      "team",
      "licenses",
      "devices",
    ];
    expect(requiredSteps(null)).toEqual(rooms);
    expect(requiredSteps("rooms")).toEqual(rooms);
    expect(requiredSteps("rooms_kitchen")).toEqual(rooms);
  });

  it("the Bar plan doesn't use rooms or deposits: skipped by themselves and not required", () => {
    expect(requiredSteps("bar")).not.toContain("rooms");
    expect(requiredSteps("bar")).not.toContain("deposits");
    expect(unusedSteps("bar")).toEqual(["rooms", "deposits"]);
    const c = setupChecklist({ ...everything, plan: "bar", rooms: nothing.rooms });
    expect(c.steps.find((s) => s.id === "rooms")?.mark).toBe("not_used");
    expect(c.ready).toBe(true);
    expect(c.done).toBe(10);
  });

  it("a new venue: the name and legal name only make Your venue need attention; nothing is ready", () => {
    const c = setupChecklist(nothing);
    expect(c.steps[0]).toMatchObject({
      id: "venue",
      number: 1,
      mark: "attention",
      missing: ["address", "guestPhone"],
    });
    expect(c.steps[1]?.mark).toBe("not_started");
    expect(c.done).toBe(0);
    expect(c.total).toBe(12);
    expect(c.ready).toBe(false);
    expect(c.next).toBe("venue");
  });

  it("a skipped required step stays blocking; the next step skips over it", () => {
    const c = setupChecklist({
      ...nothing,
      venue: everything.venue,
      skipped: ["plan", "card"],
    });
    expect(c.steps.find((s) => s.id === "plan")?.mark).toBe("skipped");
    expect(c.blocking).toContain("plan");
    expect(c.next).toBe("rooms");
  });

  it("Stripe connected without card payments needs attention", () => {
    const c = setupChecklist({ ...nothing, card: { connected: true, cardPaymentsOn: false } });
    expect(c.steps.find((s) => s.id === "card")).toMatchObject({
      mark: "attention",
      missing: ["stripeMore"],
    });
  });

  it("everything required: Ready to open, with the optional steps left", () => {
    const c = setupChecklist(everything);
    expect(c.ready).toBe(true);
    expect(c.blocking).toEqual([]);
    expect(c.done).toBe(10);
    expect(c.next).toBe("money");
    expect(c.steps.find((s) => s.id === "money")?.required).toBe(false);
  });
});
