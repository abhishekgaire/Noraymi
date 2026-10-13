import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker, payTokenHash, withVenue, type PaymentRow } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { settleDeposit } from "./confirm.js";
import {
  BOOKING_GUEST_EMAIL_KIND,
  emailGuestAboutBooking,
  makeBookingGuestEmailHandler,
} from "./guest-email.js";
import { render } from "../email/templates.js";

/**
 * F-06 (D124): every booking is emailed to the guest, confirmed, changed and cancelled, each with
 * a manage link that opens that booking, in the guest's language, and whatever texting says.
 */
let db: TestDatabase;
let v: TwoVenues;
let owner: pg.Pool;
let rw: pg.Pool;
const clock = new FrozenClock(SEED_NOW);
const GUEST_APP = "https://guest.test";

const emails = async (bookingGuest: string) =>
  (
    await owner.query<{ payload: { to: string; locale: string; data: Record<string, unknown> } }>(
      `select payload from jobs where kind = 'email.send' and payload->>'template' = 'booking_guest'
         and payload->>'to' = $1 order by created_at`,
      [bookingGuest],
    )
  ).rows.map((r) => r.payload);

const drain = async () => {
  const w = new Worker(rw, {
    pool: "normal",
    handlers: {
      [BOOKING_GUEST_EMAIL_KIND]: makeBookingGuestEmailHandler({ allowList: null }, GUEST_APP),
    },
    clock,
    random: () => 0.5,
  });
  while ((await w.tick()) > 0) {
    /* drain */
  }
};

const booking = async (email: string | null, locale: "en" | "es" = "en") => {
  const room = await owner.query<{ id: string }>(
    "insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max) values ($1, $2, 'medium', 2, 8) returning id",
    [v.venueA, `Room ${Math.floor(Math.random() * 1e6)}`],
  );
  const guest = await owner.query<{ id: string }>(
    "insert into guests (venue_id, name, email, locale) values ($1, 'Sam O.', $2, $3) returning id",
    [v.venueA, email, locale],
  );
  const b = await owner.query<{ id: string }>(
    `insert into bookings (venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at, business_date, status, source)
       values ($1, $2, $3, 'medium', 6, '2026-09-27T01:30:00Z', '2026-09-27T03:30:00Z', '2026-09-26', 'pending', 'web') returning id`,
    [v.venueA, guest.rows[0]!.id, room.rows[0]!.id],
  );
  return b.rows[0]!.id;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  rw = appPool(db.url);
});

afterAll(async () => {
  await rw.end();
  await owner.end();
  await db.drop();
});

describe("every booking is emailed to the guest (F-06)", () => {
  it("a confirmed online booking emails the guest a manage link that opens it", async () => {
    const id = await booking("sam@example.test");
    const outcome = await withVenue(rw, { venueId: v.venueA }, (c) =>
      settleDeposit(
        c,
        v.venueA,
        {
          id: crypto.randomUUID(),
          booking_id: id,
          method: "card_online",
          training: false,
        } as unknown as PaymentRow,
        clock.now(),
      ),
    );
    expect(outcome).toBe("confirmed");
    // Texting switched off changes nothing for email (emails have no switch).
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on)
         values ($1, 'texting', 1, '{"on":false,"staffCodes":true,"orderWaiting":true,"singerCode":true,"staffReplies":true}', '2026-09-25')`,
      [v.venueA],
    );
    await drain();
    const sent = await emails("sam@example.test");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ event: "confirmed", partySize: 6, minutes: 120 });
    const url = String(sent[0]!.data["manageUrl"]);
    expect(url).toMatch(/^https:\/\/guest\.test\/b\/[A-Za-z0-9_-]{22}$/);
    const token = url.split("/b/")[1]!;
    const link = await owner.query<{ booking_id: string; purpose: string }>(
      "select booking_id, purpose from booking_links where token_hash = $1",
      [payTokenHash(token)],
    );
    expect(link.rows[0]).toEqual({ booking_id: id, purpose: "email" });
    // And it goes once: the same event again sends nothing more.
    await withVenue(rw, { venueId: v.venueA }, (c) =>
      emailGuestAboutBooking(c, {
        venueId: v.venueA,
        event: "confirmed",
        bookingId: id,
        runAt: clock.now(),
      }),
    );
    await drain();
    expect(await emails("sam@example.test")).toHaveLength(1);
  });

  it("a change and a cancellation each send one more, in the guest's language", async () => {
    const id = await booking("ana@example.test", "es");
    for (const event of ["changed", "cancelled"] as const)
      await withVenue(rw, { venueId: v.venueA }, (c) =>
        emailGuestAboutBooking(c, { venueId: v.venueA, event, bookingId: id, runAt: clock.now() }),
      );
    await drain();
    const sent = await emails("ana@example.test");
    expect(sent.map((s) => s.data["event"])).toEqual(["changed", "cancelled"]);
    expect(sent.every((s) => s.locale === "es")).toBe(true);
  });

  it("a booking with no email sends none", async () => {
    const id = await booking(null);
    await withVenue(rw, { venueId: v.venueA }, (c) =>
      emailGuestAboutBooking(c, {
        venueId: v.venueA,
        event: "confirmed",
        bookingId: id,
        runAt: clock.now(),
      }),
    );
    await drain();
    const n = await owner.query<{ n: number }>(
      "select count(*)::int as n from booking_links where booking_id = $1",
      [id],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("renders the guest's copy with no card data, in English and Spanish", () => {
    const data = {
      venueName: "West 4",
      event: "confirmed" as const,
      guestName: "Sam O.",
      partySize: 6,
      when: "Sat, Sep 26, 9:30 PM",
      minutes: 120,
      depositCents: 6000,
      freeCancelUntil: "Fri, Sep 25, 9:30 PM",
      manageUrl: "https://guest.test/b/abc",
      venuePhone: "+1 212 255 0011",
    };
    const en = render("booking_guest", "en", data);
    expect(en.subject).toBe("Booked at West 4 · Sat, Sep 26, 9:30 PM");
    expect(en.text).toContain("Deposit paid: $60.00. It comes off your bill.");
    expect(en.text).toContain("Free to cancel until Fri, Sep 25, 9:30 PM.");
    expect(en.text).toContain("Room time: 2 h");
    expect(en.html).toContain('href="https://guest.test/b/abc"');
    expect(en.text).not.toMatch(/card ending|\*\*\*\*/i);
    const es = render("booking_guest", "es", { ...data, event: "cancelled" });
    expect(es.subject).toBe("Tu reserva en West 4 está cancelada");
    expect(es.text).not.toContain("Depósito pagado");
  });
});
