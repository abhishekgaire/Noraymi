import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSeedFile } from "../seed.js";
import { parseCsv } from "./csv.js";
import { consentOutcome, storedKind } from "./consents.js";
import { checkMapping, type Mapping } from "./mapping.js";
import { ImportRefused, prepareImport } from "./prepare.js";
import { buildRehearsalExport } from "./rehearsal.js";
import {
  containsCardNumber,
  parseCents,
  parseInstant,
  parsePhone,
  sensitiveHeader,
} from "./values.js";

const fixtures = join(import.meta.dirname, "../../test-fixtures/import");
const NY = "America/New_York";

function fromDir(dir: string) {
  const mapping = checkMapping(
    JSON.parse(readFileSync(join(fixtures, dir, "mapping.json"), "utf8")),
  );
  return {
    mapping: mapping.mapping!,
    read: (f: string) => readFileSync(join(fixtures, dir, f), "utf8"),
  };
}

describe("reading CSV", () => {
  it("keeps quotes, commas and line breaks inside fields, and each record's first line", () => {
    const t = parseCsv('﻿a,b\r\n1,"x, ""y"""\n2,"two\nlines"\n3,z\n');
    expect(t.header).toEqual(["a", "b"]);
    expect(t.records.map((r) => [r.line, ...r.cells])).toEqual([
      [2, "1", 'x, "y"'],
      [3, "2", "two\nlines"],
      [5, "3", "z"],
    ]);
  });
});

describe("values", () => {
  it("reads money as integer cents, never through a float", () => {
    expect(parseCents("$1,234.50")).toEqual({ ok: true, value: 123450 });
    expect(parseCents("0.1")).toEqual({ ok: true, value: 10 });
    expect(parseCents("19.99")).toEqual({ ok: true, value: 1999 });
    expect(parseCents("(12.00)")).toEqual({ ok: true, value: -1200 });
    expect(parseCents("7500", "cents")).toEqual({ ok: true, value: 7500 });
    expect(parseCents("75.5", "cents").ok).toBe(false);
    expect(parseCents("1.234").ok).toBe(false);
    expect(parseCents("ten").ok).toBe(false);
  });

  it("reads local times in the venue's zone and refuses a time daylight saving makes ambiguous", () => {
    const at = parseInstant("2026-09-25 19:00", NY);
    expect(at.ok && at.value.toString()).toBe("2026-09-25T23:00:00Z");
    const iso = parseInstant("2026-09-25T19:00:00-04:00", NY);
    expect(iso.ok && iso.value.toString()).toBe("2026-09-25T23:00:00Z");
    expect(parseInstant("2026-11-01 01:30", NY).ok).toBe(false); // happens twice
    expect(parseInstant("2026-03-08 02:30", NY).ok).toBe(false); // never happens
  });

  it("normalises US phone numbers to E.164", () => {
    expect(parsePhone("(646) 555-0134")).toEqual({ ok: true, value: "+16465550134" });
    expect(parsePhone("+44 20 7946 0958")).toEqual({ ok: true, value: "+442079460958" });
    expect(parsePhone("555").ok).toBe(false);
  });

  it("spots PIN and card columns by name, and card numbers anywhere in a cell", () => {
    for (const h of ["PIN", "Staff PIN", "pin_code", "StaffPin", "Passcode", "Password"]) {
      expect(sensitiveHeader(h)).toBe("pin");
    }
    for (const h of ["Card Number", "card_no", "CC#", "CVV", "Expiry Date", "PAN"]) {
      expect(sensitiveHeader(h)).toBe("card");
    }
    for (const h of [
      "Pinot Grigio",
      "Shipping",
      "SHIPPING",
      "Spinach",
      "Customer #",
      "Party Size",
      "Mobile",
    ]) {
      expect(sensitiveHeader(h)).toBeUndefined();
    }
    expect(containsCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(containsCardNumber("paid with 4242-4242-4242-4242 ok")).toBe(true);
    expect(containsCardNumber("4242 4242 4242 4241")).toBe(false);
    expect(containsCardNumber("+16465550134")).toBe(false);
    expect(containsCardNumber("2026-09-25 19:00")).toBe(false);
  });
});

describe("the mapping file", () => {
  it("needs version 1, a source, known kinds and every required field", () => {
    expect(checkMapping({ mapping_version: 2, source: "x", files: {} }).problems).toEqual([
      "mapping_version must be 1 (got 2)",
      "files must name at least one kind",
    ]);
    const r = checkMapping({
      mapping_version: 1,
      source: "x",
      files: {
        guests: { file: "g.csv", columns: { name: "Name", pin: "PIN" } },
        tables: { file: "t.csv" },
      },
    });
    expect(r.problems).toEqual([
      "files.guests.columns.pin: not a field of guests",
      "files.guests: legacy_ref needs a column or a default",
      "files.tables: not a kind we import (guests, people, menu, policies, bookings, consents, nightly_totals)",
    ]);
  });
});

describe("preparing an import", () => {
  it("reads the rehearsal export: 11 bookings with $990.00 of deposits, 17 guests, 127 menu lines, 4 people", () => {
    const { mapping, read } = fromDir("rehearsal");
    const p = prepareImport(mapping, read, NY);
    expect(p.problems).toEqual([]);
    expect(p.bookings).toHaveLength(11);
    expect(p.bookings.reduce((a, b) => a + b.depositCents, 0)).toBe(99000);
    expect(p.guests).toHaveLength(17);
    expect(p.menu).toHaveLength(127);
    expect(p.people.map((x) => x.role).sort()).toEqual([
      "bartender",
      "front_desk",
      "manager",
      "owner",
    ]);
    const marcus = p.bookings.find((b) => b.legacyRef === "BK-MARCUS")!;
    expect(marcus).toMatchObject({
      room: "Room 9",
      partySize: 12,
      depositCents: 12000,
      status: "checked_in",
    });
    expect(marcus.startsAt).toBe("2026-09-26T00:00:00Z");
  });

  it("keeps the committed rehearsal files in step with the demo seed", () => {
    const files = buildRehearsalExport(readSeedFile());
    for (const [name, text] of Object.entries(files)) {
      expect(readFileSync(join(fixtures, "rehearsal", name), "utf8"), name).toBe(text);
    }
  });

  it("reads JSON, cents, consents and nightly totals from the sample", () => {
    const { mapping, read } = fromDir("sample");
    const p = prepareImport(mapping, read, NY);
    expect(p.problems).toEqual([]);
    expect(p.guests.map((g) => [g.legacyRef, g.phone, g.locale])).toEqual([
      ["501", "+12125550101", "en"],
      ["502", "+12125550102", "es"],
      ["503", null, "en"],
    ]);
    // Texts go only to +1 numbers: a London number is left out and listed, not a stop.
    expect(p.listed).toEqual([
      {
        file: "guests.json",
        line: 3,
        message: "phone +442079460103 isn't a +1 number: imported without it",
      },
    ]);
    expect(p.bookings.map((b) => b.depositCents)).toEqual([7500, 5000]);
    expect(p.consents.map((c) => [c.kind, c.revokedVia, c.form, c.ip])).toEqual([
      ["texts", null, null, null],
      ["marketing", null, "Old site booking form", "203.0.113.7"],
      ["marketing", "keyword", "Old site booking form", "203.0.113.8"],
      ["marketing", null, null, null],
    ]);
    expect(p.consents[1]!.source).toBe("import:sample-fixture · Old site booking form");
    expect(p.nightlyTotals.map((n) => [n.businessDate, n.netSalesCents])).toEqual([
      ["2026-09-18", 421050],
      ["2026-09-19", 510000],
    ]);
  });

  it("names the file and line of every problem", () => {
    const mapping: Mapping = {
      mapping_version: 1,
      source: "bad",
      files: {
        bookings: {
          file: "b.csv",
          columns: {
            legacy_ref: "id",
            guest_ref: "guest",
            room: "room",
            party_size: "size",
            starts_at: "start",
            ends_at: "end",
            deposit: "deposit",
            status: "status",
          },
          values: { status: { Booked: "confirmed" } },
        },
      },
    };
    const csv = [
      "id,guest,room,size,start,end,deposit,status",
      "B1,G1,Room 1,4,2026-10-02 21:00,2026-10-02 23:00,$40.00,Booked",
      "B2,G1,Room 1,0,2026-10-02 21:00,2026-10-02 20:00,40.123,Booked",
      "B1,G1,Room 1,4,2026-10-02 21:00,2026-10-02 23:00,$40.00,Maybe",
    ].join("\n");
    const p = prepareImport(mapping, () => csv, NY);
    expect(p.bookings.map((b) => b.legacyRef)).toEqual(["B1"]);
    expect(p.problems).toEqual([
      { file: "b.csv", line: 3, message: "ends_at is not after starts_at" },
      { file: "b.csv", line: 3, message: 'deposit "40.123" is not an amount in dollars and cents' },
      { file: "b.csv", line: 3, message: "party_size 0 is outside 1 to 500" },
      { file: "b.csv", line: 4, message: "status \"Maybe\" isn't in the mapping's values" },
      { file: "b.csv", line: 4, message: "repeats the record on line 2" },
    ]);
  });

  it.each([
    ["mapping-pin.json", 'staff-with-pin.csv:1 column "PIN" looks like a PIN'],
    [
      "mapping-card.json",
      'customers-with-card.csv:1 column "Card Number" looks like a card number',
    ],
    [
      "mapping-card-in-notes.json",
      'customers-card-in-notes.csv:2 column "Notes" looks like a card number',
    ],
  ])("refuses %s before reading any row", (file, why) => {
    const mapping = checkMapping(
      JSON.parse(readFileSync(join(fixtures, "refused", file), "utf8")),
    ).mapping!;
    const read = (f: string) => readFileSync(join(fixtures, "refused", f), "utf8");
    expect(() => prepareImport(mapping, read, NY)).toThrow(ImportRefused);
    expect(() => prepareImport(mapping, read, NY)).toThrow(why);
  });
});

describe("the consent proof check (M9-03)", () => {
  const proof = {
    kind: "marketing" as const,
    givenAt: "2026-09-01T22:00:00Z",
    revokedAt: null,
    form: "Old site booking form",
    textVersion: "old-site-2025-03",
    ip: "203.0.113.7",
  };

  it("imports a marketing opt-in only with the form, its wording, the IP address and the time", () => {
    expect(consentOutcome(proof)).toEqual({ outcome: "marketing_with_proof", missing: [] });
    expect(consentOutcome({ ...proof, ip: null })).toEqual({
      outcome: "dropped_no_proof",
      missing: ["the IP address"],
    });
    expect(consentOutcome({ ...proof, form: null, textVersion: null, givenAt: null })).toEqual({
      outcome: "dropped_no_proof",
      missing: ["the form", "its wording", "the time"],
    });
  });

  it("keeps every opt-out, with or without proof, and an SMS one stops every text", () => {
    const out = { ...proof, form: null, ip: null, revokedAt: "2026-09-02T00:00:00Z" };
    expect(consentOutcome(out).outcome).toBe("opt_out");
    expect(storedKind({ channel: "sms", kind: "marketing", revokedAt: out.revokedAt })).toBe(
      "texts",
    );
    expect(storedKind({ channel: "email", kind: "marketing", revokedAt: out.revokedAt })).toBe(
      "marketing",
    );
    expect(storedKind({ channel: "sms", kind: "marketing", revokedAt: null })).toBe("marketing");
  });

  it("needs no proof for an opt-in to service texts", () => {
    expect(consentOutcome({ ...proof, kind: "texts", form: null, ip: null }).outcome).toBe(
      "service",
    );
  });
});
