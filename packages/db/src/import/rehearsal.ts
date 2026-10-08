import { Temporal } from "@west4/shared";
import type { SeedFile } from "../seed.js";
import { toCsv } from "./csv.js";
import type { Mapping } from "./mapping.js";

/**
 * The rehearsal export (M9-01): the demo seed's 11 bookings, 17 guests,
 * 127-line menu and team, written the way an old booking system's own export
 * tool might write them (its own column names, local times, dollar amounts,
 * its own status words), plus the mapping that reads them. All of it is the
 * seed's made-up demo data; no real guest is in it. The files are kept in
 * packages/db/test-fixtures/import/rehearsal/, and a unit test keeps them in
 * step with this function.
 */
const STATUS_WORD: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  checked_in: "Arrived",
  completed: "Completed",
  no_show: "No Show",
  cancelled: "Cancelled",
};
const ROLE_WORD: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  bartender: "Bartender",
  front_desk: "Front Desk",
  staff: "Staff",
};

const local = (iso: string) =>
  Temporal.Instant.from(iso)
    .toZonedDateTimeISO("America/New_York")
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" })
    .replace("T", " ");

const dollars = (cents: number) =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

const usPhone = (e164: string | null | undefined) => {
  if (!e164 || !/^\+1\d{10}$/.test(e164)) return e164 ?? "";
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
};

export const REHEARSAL_MAPPING: Mapping = {
  mapping_version: 1,
  source: "rehearsal-from-demo-seed",
  description:
    "A rehearsal export made from the demo seed, in an old booking system's style. Fake data only. Replace with West 4's real export's mapping once its files arrive.",
  files: {
    guests: {
      file: "customers.csv",
      columns: { legacy_ref: "Customer #", name: "Customer Name", phone: "Mobile", email: "Email" },
    },
    people: {
      file: "staff.csv",
      columns: { legacy_ref: "Staff #", name: "Name", email: "Email", role: "Position" },
      values: {
        role: {
          Owner: "owner",
          Manager: "manager",
          Bartender: "bartender",
          "Front Desk": "front_desk",
          Staff: "staff",
        },
      },
    },
    menu: {
      file: "menu.csv",
      columns: {
        legacy_ref: "Item Code",
        name: "Item",
        category: "Category",
        price: "Price",
        alcohol: "Alcohol",
      },
      defaults: { tax_category: "drink" },
    },
    bookings: {
      file: "reservations.csv",
      columns: {
        legacy_ref: "Reservation #",
        guest_ref: "Customer #",
        room: "Room",
        party_size: "Party Size",
        starts_at: "Start",
        ends_at: "End",
        deposit: "Deposit Paid",
        status: "Status",
      },
      values: {
        status: {
          Pending: "pending",
          Confirmed: "confirmed",
          Arrived: "checked_in",
          Completed: "completed",
          "No Show": "no_show",
          Cancelled: "cancelled",
        },
      },
    },
  },
};

export function buildRehearsalExport(seed: SeedFile): Record<string, string> {
  const roomName = new Map(seed.rooms.map((r) => [r.id, r.name]));
  const ref = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
  return {
    "mapping.json": JSON.stringify(REHEARSAL_MAPPING, null, 2) + "\n",
    "customers.csv": toCsv([
      ["Customer #", "Customer Name", "Mobile", "Email"],
      ...seed.guests.map((g) => [ref(g.id), g.name, usPhone(g.phone_e164), ""]),
    ]),
    "staff.csv": toCsv([
      ["Staff #", "Name", "Email", "Position"],
      ...seed.team.map((t) => [ref(t.id), t.name, t.demo_email ?? "", ROLE_WORD[t.role] ?? t.role]),
    ]),
    "menu.csv": toCsv([
      ["Item Code", "Item", "Category", "Price", "Alcohol"],
      ...seed.menu.items.map((i) => [
        ref(i.id),
        i.name,
        i.section,
        dollars(i.unit_cents),
        i.alcohol ? "Y" : "N",
      ]),
    ]),
    "reservations.csv": toCsv([
      [
        "Reservation #",
        "Customer #",
        "Room",
        "Party Size",
        "Start",
        "End",
        "Deposit Paid",
        "Status",
      ],
      ...seed.bookings.map((b) => [
        ref(b.id),
        ref(b.guest),
        roomName.get(b.room) ?? b.room,
        String(b.party_size),
        local(b.starts_at),
        local(b.ends_at),
        dollars(b.deposit_cents),
        STATUS_WORD[b.status] ?? b.status,
      ]),
    ]),
  };
}
