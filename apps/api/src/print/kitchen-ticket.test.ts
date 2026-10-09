import { describe, expect, it } from "vitest";
import {
  AFTER_OUTAGE,
  isBoldLine,
  ticketEpos,
  ticketEscPos,
  ticketLines,
  ticketMarkup,
  type TicketPayload,
} from "./ticket.js";

/**
 * The kitchen ticket (K-03; Kitchen and food · Kitchen tickets): KITCHEN, the room or tab and the
 * time, who accepted it, each line with its options and its note, an allergy note boxed in bold
 * capitals under its line, no prices and no ID line. The menu is a TEST one, no venue's.
 */
const food: TicketPayload = {
  kitchen: true,
  room: "Room 5",
  accepted_by: "Maya S.",
  accepted_at: "2026-09-26T02:41:00Z",
  lines: [
    {
      qty: 1,
      name: "TEST wings",
      options: ["TEST fries"],
      kitchen_note: "no peanuts, severe",
      allergy: true,
    },
    { qty: 2, name: "TEST side", options: [], kitchen_note: "extra crispy", allergy: false },
  ],
};
const opts = { timeZone: "America/New_York", reprintN: 0 };

describe("the kitchen ticket", () => {
  it("prints KITCHEN, the room and time, who accepted it, the lines and their notes, and no prices", () => {
    const lines = ticketLines(food, opts);
    expect(lines[0]).toBe("KITCHEN");
    expect(lines[1]).toMatch(/^ROOM 5 +10:41 PM$/);
    expect(lines).toContain("Accepted by Maya S.");
    expect(lines).toContain("1 x TEST wings");
    expect(lines).toContain("    TEST fries");
    expect(lines).toContain('    "extra crispy"');
    expect(lines.join("\n")).not.toMatch(/\$|ID (OK|CHECK)/);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(32);
  });

  it("boxes an allergy note in capitals under its line, and prints the box bold", () => {
    const lines = ticketLines(food, opts);
    const at = lines.indexOf("    TEST fries");
    expect(lines.slice(at + 1, at + 4)).toEqual([
      "*".repeat(32),
      "* ALLERGY: NO PEANUTS, SEVERE  *",
      "*".repeat(32),
    ]);
    expect(isBoldLine("* ALLERGY: NO PEANUTS, SEVERE  *")).toBe(true);
    expect(ticketMarkup(food, opts)).toContain("[bold: on]* ALLERGY: NO PEANUTS, SEVERE  *");
    expect(ticketEpos(food, { ...opts, jobId: "j1" })).toContain(
      '<text em="true"/><text>* ALLERGY: NO PEANUTS, SEVERE  *&#10;</text><text em="false"/>',
    );
    const bytes = Buffer.from(ticketEscPos(food, opts)).toString("latin1");
    expect(bytes).toContain("\x1bE\x01* ALLERGY: NO PEANUTS, SEVERE  *\n\x1bE\x00");
  });

  it("wraps a long allergy note inside the box", () => {
    const long = "a".repeat(10) + " " + "b".repeat(30) + " cc";
    const lines = ticketLines(
      {
        ...food,
        lines: [{ qty: 1, name: "TEST wings", options: [], kitchen_note: long, allergy: true }],
      },
      opts,
    );
    const box = lines.filter((l) => l.startsWith("* "));
    expect(box.length).toBeGreaterThan(1);
    for (const l of box) expect(l).toMatch(/^\* .{28} \*$/);
  });

  it("names a bar tab, and stamps REPRINT, AFTER OUTAGE and TRAINING", () => {
    const lines = ticketLines(
      { ...food, room: "Bar · Jess P.", after_outage: true, training: true },
      { ...opts, reprintN: 2 },
    );
    expect(lines.slice(0, 3)).toEqual(["REPRINT 2", "TRAINING - NOT REAL MONEY", "KITCHEN"]);
    expect(lines[3]).toBe(AFTER_OUTAGE);
    expect(lines.join(" ")).toContain("check with the kitchen before making");
    expect(lines.some((l) => l.startsWith("BAR · JESS P."))).toBe(true);
    // Star markup escapes a bracket in a note, so a guest's words can't become a command.
    const bracket = ticketMarkup(
      { ...food, lines: [{ qty: 1, name: "TEST [x]", options: [] }] },
      opts,
    );
    expect(bracket).toContain("1 x TEST [[x]");
  });

  it("leaves the bar ticket as it was: no KITCHEN, the ID line still there", () => {
    const bar = ticketLines(
      {
        room: "Room 5",
        ids: { checked: 4, party: 4 },
        lines: [{ qty: 4, name: "Bud Light", options: [] }],
      },
      opts,
    );
    expect(bar).not.toContain("KITCHEN");
    expect(bar).toContain("ID OK 4 of 4");
  });
});
