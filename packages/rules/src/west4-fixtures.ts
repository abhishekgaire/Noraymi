import type { DepositRule, PriceSettings } from "@west4/shared";

/** West 4's price and deposit settings as the spec and the demo seed give them, for the rules' tests. */
export const WEST4_PRICES: PriceSettings = {
  rate: { mode: "perPerson", perPersonCents: 1000 },
  billing: { incrementMin: 1, rounding: "nearest" },
  minGuests: { weeknight: 3, friSat: 4 },
  firstHourMinimum: true,
  bands: [],
  vip: { roomIds: ["room_vip"], hourlyCents: 25000, fromGuests: 20 },
  minSpend: [],
  booking: { minHours: 1, maxHours: 4, maxGuests: 25, startSlots: ["00", "30"] },
  damageFeeCents: 15000,
};

export const WEST4_DEPOSIT: DepositRule = {
  on: true,
  mode: "firstHour",
  value: 0,
  refundHours: 24,
  late: "keep",
  noShow: "firstHour",
  graceMin: 15,
  bigParty: { fromGuests: 20, deposit: { kind: "flat", cents: 25000 }, refundHours: 24 },
};

export const WEST4_TIME = { timeZone: "America/New_York", dayCutover: "06:00" } as const;
