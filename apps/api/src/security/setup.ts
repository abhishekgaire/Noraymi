import pg from "pg";
import { badgeUidHash } from "@west4/db";
import { createTestDatabase, seedTwoVenues, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import type { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { headerAuthenticator, type Cast } from "./fixtures.js";
import type { WallFixtures } from "./wall-suite.js";

/**
 * One database for a security suite: two venues, the cast at venue A, and
 * venue B's rows for every venue-owned route parameter. Tests build the app
 * themselves (the planted-leak test adds routes) with `appOptions`.
 */
export interface SuiteWorld {
  readonly db: TestDatabase;
  readonly owner: pg.Pool;
  readonly cast: Cast & { ownerB: string; messageB: string };
  readonly fixtures: WallFixtures;
  readonly clock: SimulatedClock;
  readonly appOptions: Parameters<typeof buildApp>[0];
  readonly close: () => Promise<void>;
}

const KEY = "c".repeat(64);

export async function suiteWorld(): Promise<SuiteWorld> {
  const db = await createTestDatabase({ migrate: true });
  const v = await seedTwoVenues(db.url);
  const owner = new pg.Pool({ connectionString: db.url, max: 2 });
  const clock = new SimulatedClock(SEED_NOW);
  const person = async (
    venueId: string,
    name: string,
    role: string,
    digits: 4 | 6,
  ): Promise<{ userId: string; membershipId: string }> => {
    const u = await owner.query<{ id: string }>(
      "insert into users (name) values ($1) returning id",
      [name],
    );
    const m = await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, $3, 'active', $4) returning id",
      [venueId, u.rows[0]!.id, role, digits],
    );
    return { userId: u.rows[0]!.id, membershipId: m.rows[0]!.id };
  };
  const managerA = await person(v.venueA, "Andy C.", "manager", 6);
  const bartenderA = await person(v.venueA, "Maya S.", "bartender", 4);
  const frontDeskA = await person(v.venueA, "Diego R.", "front_desk", 4);
  // Venue B's rows, one per venue-owned parameter.
  const staffB = await person(v.venueB, "Someone at B", "bartender", 4);
  const deviceB = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name) values ($1, 'front_desk', 'B desk') returning id",
    [v.venueB],
  );
  const readerB = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, stripe_reader_id) values ($1, 'reader', 'B S710', 'tmr_b') returning id",
    [v.venueB],
  );
  const paymentB = await owner.query<{ id: string }>(
    "insert into payments (venue_id, method, status, business_date) values ($1, 'card_present', 'pending', '2026-09-25') returning id",
    [v.venueB],
  );
  const badgeB = await owner.query<{ id: string }>(
    "insert into staff_badges (venue_id, membership_id, uid_hash, label) values ($1, $2, $3, 'B fob') returning id",
    [v.venueB, staffB.membershipId, badgeUidHash(v.venueB, Buffer.from("04B0B0B0B0B0B0", "hex"))],
  );
  const roomB = await owner.query<{ id: string }>(
    "insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max) values ($1, 'B room', 'small', 3, 6) returning id",
    [v.venueB],
  );
  const guestB = await owner.query<{ id: string }>(
    "insert into guests (venue_id, name) values ($1, 'Guest at B') returning id",
    [v.venueB],
  );
  const bookingB = await owner.query<{ id: string }>(
    `insert into bookings (venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at, business_date, status, source)
       values ($1, $2, $3, 'small', 4, '2026-09-26T21:00:00-04:00', '2026-09-26T23:00:00-04:00', '2026-09-26', 'confirmed', 'staff')
       returning id`,
    [v.venueB, guestB.rows[0]!.id, roomB.rows[0]!.id],
  );
  const sessionB = await owner.query<{ id: string }>(
    `insert into room_sessions (venue_id, room_id, party_size, started_at, business_date)
       values ($1, $2, 4, '2026-09-25T21:00:00-04:00', '2026-09-25') returning id`,
    [v.venueB, roomB.rows[0]!.id],
  );
  const checkB = await owner.query<{ id: string }>(
    `insert into checks (venue_id, number, kind, business_date, room_session_id, opened_by)
       values ($1, 1, 'room', '2026-09-25', $2, $3) returning id`,
    [v.venueB, sessionB.rows[0]!.id, v.ownerB],
  );
  const splitB = await owner.query<{ id: string }>(
    "insert into check_splits (venue_id, check_id, share_count, base_cents, created_by, created_at) values ($1, $2, 2, 100, $3, now()) returning id",
    [v.venueB, checkB.rows[0]!.id, v.ownerB],
  );
  const refundB = await owner.query<{ id: string }>(
    `insert into refunds (venue_id, payment_id, check_id, amount_cents, reason, n, requested_by, business_date, requested_at)
       values ($1, $2, $3, 100, 'wall', 1, $4, '2026-09-25', now()) returning id`,
    [v.venueB, paymentB.rows[0]!.id, checkB.rows[0]!.id, v.ownerB],
  );
  const disputeB = await owner.query<{ id: string }>(
    `insert into disputes (venue_id, payment_id, stripe_dispute_id, reason, amount_cents, status, opened_at)
       values ($1, $2, 'dp_wall_b', 'fraudulent', 100, 'needs_response', now()) returning id`,
    [v.venueB, paymentB.rows[0]!.id],
  );
  // A bar tab only venue B has, on its own bar check.
  const barCheckB = await owner.query<{ id: string }>(
    `insert into checks (venue_id, number, kind, business_date, opened_by)
       values ($1, 2, 'bar', '2026-09-25', $2) returning id`,
    [v.venueB, v.ownerB],
  );
  const tabB = await owner.query<{ id: string }>(
    "insert into tabs (venue_id, check_id, name, opened_at) values ($1, $2, 'B tab', now()) returning id",
    [v.venueB, barCheckB.rows[0]!.id],
  );
  // A singer and a queued song only venue B has (M6-18).
  await owner.query(
    "insert into song_nights (venue_id, business_date, started_at) values ($1, '2026-09-25', now())",
    [v.venueB],
  );
  // A night's export at venue B (M7-15: POST /exports/{e}/email).
  const exportB = await owner.query<{ id: string }>(
    "insert into exports (venue_id, kind, business_date, journals, file) values ($1, 'accounting', '2026-09-20', '[]', 'x') returning id",
    [v.venueB],
  );
  // A punch on venue B's time clock (M7-11: PATCH /punches/{p}).
  const punchB = await owner.query<{ id: string }>(
    "insert into time_punches (venue_id, membership_id, kind, duty, at) values ($1, $2, 'clock_in', 'bar', now()) returning id",
    [v.venueB, staffB.membershipId],
  );
  const singerB = await owner.query<{ id: string }>(
    `insert into singers (venue_id, display_name, phone_e164, phone_verified_at, joined_at)
       values ($1, 'B singer', '+12125550100', now(), now()) returning id`,
    [v.venueB],
  );
  const songB = await owner.query<{ id: string }>(
    `insert into song_queue (venue_id, business_date, singer_id, title, round, position, pay_with, queued_at)
       values ($1, '2026-09-25', $2, 'B song', 1, 1, 'credit', now()) returning id`,
    [v.venueB, singerB.rows[0]!.id],
  );
  // Singer B's phone allows alerts (M6-21): a push to it from venue A would be a leak.
  await owner.query(
    `insert into singer_push_subscriptions (venue_id, singer_id, endpoint, keys, created_at)
       values ($1, $2, 'https://push.example.test/singer-b', '{"p256dh":"x","auth":"y"}', now())`,
    [v.venueB, singerB.rows[0]!.id],
  );
  // A tab being opened only venue B has, with its consent line's policy version (M6-06).
  const consentB = await owner.query<{ id: string }>(
    `insert into policy_versions (venue_id, kind, version, text, hash, published_at)
       values ($1, 'tab_consent', 1, 'B words', repeat('b', 64), now()) returning id`,
    [v.venueB],
  );
  const openingB = await owner.query<{ id: string }>(
    `insert into tab_openings (venue_id, payment_id, check_number, consent_text_version, consent_read_by,
       opened_by, created_at)
     values ($1, $2, 3, $3, $4, $4, now()) returning id`,
    [v.venueB, paymentB.rows[0]!.id, consentB.rows[0]!.id, v.ownerB],
  );
  // A draft bar POS layout only venue B has.
  const layoutB = await owner.query<{ id: string }>(
    "insert into pos_layouts (venue_id, station, status, sections) values ($1, 'bar', 'draft', '{}') returning id",
    [v.venueB],
  );
  // A published site version only venue B has: version 777.
  await owner.query(
    `insert into site_versions (venue_id, version, status, content, published_at)
       values ($1, 777, 'published', '{}', now())`,
    [v.venueB],
  );
  const conversationB = await owner.query<{ id: string }>(
    "insert into conversations (venue_id, phone_e164) values ($1, '+12125550100') returning id",
    [v.venueB],
  );
  const messageB = await owner.query<{ id: string }>(
    `insert into messages (venue_id, conversation_id, direction, category, body, status)
       values ($1, $2, 'outbound', 'service', 'B''s text', 'sending') returning id`,
    [v.venueB, conversationB.rows[0]!.id],
  );
  const fileB = await owner.query<{ id: string }>(
    "insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at) values ($1::uuid, 'damage_photo', $1::text || '/b.jpg', 'image/jpeg', 10, now()) returning id",
    [v.venueB],
  );
  const approvalB = await owner.query<{ id: string }>(
    `insert into approvals (venue_id, kind, target_kind, target_id, reason, requested_by, requested_at, routed_to)
       values ($1, 'comp', 'check', $2, 'B''s comp', $3, now(), $4) returning id`,
    [v.venueB, checkB.rows[0]!.id, staffB.userId, v.ownerB],
  );
  const faultB = await owner.query<{ id: string }>(
    "insert into room_faults (venue_id, room_id, text, reported_at) values ($1, $2, 'B''s fault', now()) returning id",
    [v.venueB, roomB.rows[0]!.id],
  );
  const noteB = await owner.query<{ id: string }>(
    "insert into room_notes (venue_id, room_id, text, added_at) values ($1, $2, 'B''s note', now()) returning id",
    [v.venueB, roomB.rows[0]!.id],
  );
  const itemB = await owner.query<{ id: string }>(
    "insert into lost_items (venue_id, description, found_by, found_at, kept_at) values ($1, 'B''s scarf', $2, now(), 'bar') returning id",
    [v.venueB, v.ownerB],
  );
  const callB = await owner.query<{ id: string }>(
    "insert into room_calls (venue_id, session_id, kind, created_at) values ($1, $2, 'tv', now()) returning id",
    [v.venueB, sessionB.rows[0]!.id],
  );
  const waitB = await owner.query<{ id: string }>(
    `insert into waitlist_entries (venue_id, guest_id, party_size, size_tier_needed, joined_at, source)
       values ($1, $2, 4, 'small', now(), 'staff') returning id`,
    [v.venueB, guestB.rows[0]!.id],
  );
  const categoryB = await owner.query<{ id: string }>(
    "insert into menu_categories (venue_id, name) values ($1, 'B drinks') returning id",
    [v.venueB],
  );
  const menuItemB = await owner.query<{ id: string }>(
    "insert into menu_items (venue_id, category_id, name, alcohol) values ($1, $2, 'B beer', true) returning id",
    [v.venueB, categoryB.rows[0]!.id],
  );
  const orderB = await owner.query<{ id: string }>(
    `insert into orders (venue_id, check_id, session_id, source, placed_at, business_date)
       values ($1, $2, $3, 'room', now(), '2026-09-25') returning id`,
    [v.venueB, checkB.rows[0]!.id, sessionB.rows[0]!.id],
  );
  const jobB = await owner.query<{ id: string }>(
    `insert into print_jobs (venue_id, order_id, kind, station, payload) values ($1, $2, 'ticket', 'bar', '{}') returning id`,
    [v.venueB, orderB.rows[0]!.id],
  );
  // A replayed offline order at venue B (M8-05: POST /offline-orders/{replayId}/cash).
  const replayB = await owner.query<{ id: string }>(
    `insert into offline_replays (venue_id, client_order_id, queued_on, replayed_on, queued_at, replayed_at,
       check_id, tab_name, staff_name, lines, total_cents, cash_note, outcome, reason)
     values ($1, 'b-offline-0001', '2026-09-25', '2026-09-25', now(), now(), $2, 'B', 'B', '[]', 0, 'B', 'failed', 'tab_closed')
     returning id`,
    [v.venueB, checkB.rows[0]!.id],
  );
  const lineB = await owner.query<{ id: string }>(
    `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category, business_date)
       values ($1, $2, 'item', 'B''s beer', 1, 800, 800, 'drink', '2026-09-25') returning id::text`,
    [v.venueB, checkB.rows[0]!.id],
  );
  const guestRowB = await owner.query<{ id: string }>(
    `insert into room_guests (venue_id, session_id, room_id, token_hash, token_version, joined_at)
       values ($1, $2, $3, md5(random()::text), 1, now()) returning id`,
    [v.venueB, sessionB.rows[0]!.id, roomB.rows[0]!.id],
  );
  const cast: Cast & {
    ownerB: string;
    messageB: string;
    guestB: string;
    sessionB: string;
    singerB: string;
    songB: string;
  } = {
    venueA: v.venueA,
    venueB: v.venueB,
    ownerA: v.ownerA,
    membershipA: v.membershipA,
    managerA,
    bartenderA,
    frontDeskA,
    ownerB: v.ownerB,
    messageB: messageB.rows[0]!.id,
    guestB: guestB.rows[0]!.id,
    sessionB: sessionB.rows[0]!.id,
    singerB: singerB.rows[0]!.id,
    songB: songB.rows[0]!.id,
  };
  const fixtures: WallFixtures = {
    venueOwned: {
      m: staffB.membershipId,
      d: deviceB.rows[0]!.id,
      b: badgeB.rows[0]!.id,
      r: roomB.rows[0]!.id,
      bookingId: bookingB.rows[0]!.id,
      sessionId: sessionB.rows[0]!.id,
      checkId: checkB.rows[0]!.id,
      fileId: fileB.rows[0]!.id,
      approvalId: approvalB.rows[0]!.id,
      f: faultB.rows[0]!.id,
      noteId: noteB.rows[0]!.id,
      itemId: itemB.rows[0]!.id,
      callId: callB.rows[0]!.id,
      conversationId: conversationB.rows[0]!.id,
      messageId: messageB.rows[0]!.id,
      w: waitB.rows[0]!.id,
      menuRowId: menuItemB.rows[0]!.id,
      menuItemId: menuItemB.rows[0]!.id,
      orderId: orderB.rows[0]!.id,
      draftKey: checkB.rows[0]!.id,
      jobId: jobB.rows[0]!.id,
      lineId: lineB.rows[0]!.id,
      g: guestRowB.rows[0]!.id,
      readerId: readerB.rows[0]!.id,
      paymentId: paymentB.rows[0]!.id,
      splitId: splitB.rows[0]!.id,
      refundId: refundB.rows[0]!.id,
      disputeId: disputeB.rows[0]!.id,
      userId: v.ownerB,
      version: "777",
      l: layoutB.rows[0]!.id,
      t: tabB.rows[0]!.id,
      o: openingB.rows[0]!.id,
      q: songB.rows[0]!.id,
      s: singerB.rows[0]!.id,
      p: punchB.rows[0]!.id,
      e: exportB.rows[0]!.id,
      replayId: replayB.rows[0]!.id,
    },
    bodies: {
      "PATCH /v1/venues/:venueId/team/:m": { locale: "es" },
      "POST /v1/venues/:venueId/drawer-sessions/:s/count": { counted_cents: 0 },
      "POST /v1/venues/:venueId/drawers/:d/swap": { counted_cents: 0 },
      "PATCH /v1/venues/:venueId/punches/:p": { at: "2026-09-25T19:00:00-04:00", reason: "B" },
      "POST /v1/venues/:venueId/payments/:p/match": {
        check_id: "00000000-0000-4000-8000-000000000001",
      },
      "POST /v1/venues/:venueId/drawer-sessions/:s/paid-out": {
        amount_cents: 100,
        reason: "B",
        photo_file_id: "00000000-0000-4000-8000-000000000001",
      },
      "POST /v1/venues/:venueId/drawer-sessions/:s/no-sale": { reason: "B" },
      "POST /v1/venues/:venueId/drawer-sessions/:s/tip-out": {
        paid_to: "00000000-0000-4000-8000-000000000001",
        amount_cents: 100,
      },
      "POST /v1/venues/:venueId/drawers/:d/handover": {
        incoming: "00000000-0000-4000-8000-000000000001",
        counted_cents: 0,
      },
      "POST /v1/venues/:venueId/team/:m/badges/keys": { uid: "04AABBCCDDEEFF" },
      "POST /v1/venues/:venueId/tabs/openings/:o/name": { name: "B", label: null },
      "POST /v1/venues/:venueId/song-queue": { singer_id: singerB.rows[0]!.id, title: "B" },
      "POST /v1/venues/:venueId/song-queue/:q/move": { direction: "down", reason: "B" },
      "POST /v1/venues/:venueId/singers/:s/verify": { code: "123456" },
      "POST /v1/venues/:venueId/singers/:s/credits": { check_id: checkB.rows[0]!.id },
      "POST /v1/venues/:venueId/team/:m/badges": { sun: "https://x.test/?e=00&c=00", label: "x" },
      "PATCH /v1/venues/:venueId/devices/:d": { name: "renamed" },
      "PUT /v1/venues/:venueId/routers/:d/link": {
        maker: null,
        maker_org_id: null,
        maker_device_id: null,
        api_on: false,
        wired_owner: null,
        lte_owner: null,
      },
      "POST /v1/venues/:venueId/routers/:d/failover-tests": { passed: true },
      "POST /v1/venues/:venueId/devices/offline-secret": { fingerprint: null },
      "POST /v1/venues/:venueId/offline-orders/:replayId/cash": { amount_cents: 100 },
      "PATCH /v1/venues/:venueId/modules/:id": { state: "off" },
      "PUT /v1/venues/:venueId/settings/:key": { value: { weekly: [], lastCall: null } },
      "PATCH /v1/venues/:venueId/permissions/:role/:action": { allowed: true },
      "PATCH /v1/venues/:venueId/rooms/:r": { name: "renamed" },
      "PATCH /v1/venues/:venueId/rooms/:r/state": { state: "available" },
      "PATCH /v1/venues/:venueId/bookings/:bookingId": { party_size: 4 },
      "PATCH /v1/venues/:venueId/message-templates/:templateKey": { on: true },
      "POST /v1/venues/:venueId/bookings/:bookingId/check-in": { party_size: 4, ids_checked: 0 },
      "POST /v1/venues/:venueId/rooms/:r/sessions": { party_size: 4, ids_checked: 0, minutes: 60 },
      "POST /v1/venues/:venueId/sessions/:sessionId/id-checks": { method: "visual" },
      "POST /v1/venues/:venueId/approvals/:approvalId/decide": { decision: "approve" },
      "POST /v1/venues/:venueId/rooms/:r/faults": { text: "Mic dead" },
      "PATCH /v1/venues/:venueId/faults/:f": { fixed: true },
      "POST /v1/venues/:venueId/rooms/:r/notes": { text: "x" },
      "PATCH /v1/venues/:venueId/room-notes/:noteId": { cleared: true },
      "POST /v1/venues/:venueId/lost-items": { description: "x", kept_at: "bar" },
      "POST /v1/venues/:venueId/door-counts": { delta: 1 },
      "PATCH /v1/venues/:venueId/waitlist/:w": { quoted_min: 10 },
      "PATCH /v1/venues/:venueId/menu/categories/:menuRowId": { name: "x" },
      "PATCH /v1/venues/:venueId/menu/items/:menuRowId": { name: "x" },
      "PATCH /v1/venues/:venueId/menu/variants/:menuRowId": { name: "x" },
      "PATCH /v1/venues/:venueId/menu/options/:menuRowId": { name: "x" },
      "PATCH /v1/venues/:venueId/menu/modifier-groups/:menuRowId": { name: "x" },
      "PATCH /v1/venues/:venueId/packages/:menuRowId": { name: "x" },
      "PATCH /v1/venues/:venueId/price-rules/:menuRowId": { name: "x" },
      "POST /v1/venues/:venueId/menu/items/:menuItemId/out-tonight": {},
      "POST /v1/venues/:venueId/orders/:orderId/decline": { reason: "x" },
      "PUT /v1/venues/:venueId/drafts/:draftKey": { lines: [], version: 0 },
      "POST /v1/venues/:venueId/sessions/:sessionId/cut-off": { reason: "x" },
      "POST /v1/venues/:venueId/sessions/:sessionId/guests/:g/cut-off": { reason: "x" },
      "POST /v1/venues/:venueId/checks/:checkId/lines/:lineId/comp": { reason: "x", made: true },
      "POST /v1/venues/:venueId/checks/:checkId/lines/:lineId/void": { reason: "x", made: false },
      "POST /v1/venues/:venueId/checks/:checkId/lines/:lineId/move": {
        tab_id: "00000000-0000-4000-8000-000000000045",
      },
      "POST /v1/venues/:venueId/tabs/:t/move-to-room": {
        session_id: "00000000-0000-4000-8000-000000000046",
      },
      "POST /v1/venues/:venueId/checks/:checkId/card-tap": {
        reader_id: "00000000-0000-4000-8000-000000000044",
        consent_text_version: "00000000-0000-4000-8000-000000000047",
      },
      "POST /v1/venues/:venueId/print-host/jobs/:jobId": {
        printer_id: deviceB.rows[0]!.id,
        printed: true,
      },
      "POST /v1/venues/:venueId/checks/:checkId/payments": {
        method: "tap",
        amount_cents: 100,
        reader_id: "00000000-0000-4000-8000-000000000044",
      },
      "POST /v1/venues/:venueId/payments/:paymentId/change": { tendered_cents: 100 },
      "POST /v1/venues/:venueId/payments/:paymentId/approval": { reason: "Guest left" },
      "POST /v1/venues/:venueId/checks/:checkId/receipts": { channel: "print" },
      "POST /v1/venues/:venueId/disputes/:disputeId/evidence": { note: "wall" },
      "POST /v1/venues/:venueId/go-live/people/:userId": { check: "tap_to_pay", confirmed: true },
      "POST /v1/venues/:venueId/checks/:checkId/refunds": {
        parts: [{ payment_id: "00000000-0000-4000-8000-000000000045", amount_cents: 100 }],
        reason: "wall",
      },
      "POST /v1/venues/:venueId/bookings/:bookingId/refunds": {
        parts: [{ payment_id: "00000000-0000-4000-8000-000000000045", amount_cents: 100 }],
        reason: "wall",
      },
      "POST /v1/venues/:venueId/checks/:checkId/splits": { kind: "even", shares: 2 },
      "POST /v1/venues/:venueId/payments/:paymentId/tap": {
        reader_id: "00000000-0000-4000-8000-000000000044",
      },
      "POST /v1/venues/:venueId/checks/:checkId/orders": {
        lines: [{ variant_id: "00000000-0000-4000-8000-000000000001", qty: 1 }],
      },
      "POST /v1/venues/:venueId/orders/:orderId/return": { reason: "no_id" },
      "POST /v1/venues/:venueId/orders/:orderId/resolve": { resolution: "remake" },
      "POST /v1/venues/:venueId/waitlist/:w/seat": { ids_checked: 0, minutes: 60 },
      "POST /v1/venues/:venueId/conversations/:conversationId/messages": { body: "On our way" },
      "POST /v1/venues/:venueId/conversations/:conversationId/running-late": {},
      "POST /v1/venues/:venueId/checks/:checkId/lines": {
        kind: "damage",
        file_id: fileB.rows[0]!.id,
        reason: "x",
      },
      "PATCH /v1/venues/:venueId/lost-items/:itemId": { kept_at: "office" },
      "POST /v1/venues/:venueId/sessions/:sessionId/pause": { reason: "Mic dead" },
      "POST /v1/venues/:venueId/sessions/:sessionId/party-size": { party_size: 5 },
      "POST /v1/venues/:venueId/sessions/:sessionId/move": { room_id: roomB.rows[0]!.id },
      "POST /v1/venues/:venueId/sessions/:sessionId/comp-minutes": { reason: "Mic dead" },
      "POST /v1/venues/:venueId/files": {
        kind: "damage_photo",
        content_type: "image/jpeg",
        bytes: 10,
      },
      "PATCH /v1/venues/:venueId/sessions/:sessionId": {
        booked_end_at: "2026-09-25T23:00:00-04:00",
      },
    },
  };
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: "http://localhost:5173",
  });
  return {
    db,
    owner,
    cast,
    fixtures,
    clock,
    appOptions: {
      config,
      clock,
      authenticators: [headerAuthenticator],
      staffRateLimit: { max: 1_000_000, windowMs: 60_000 },
      moduleCacheMs: 0,
    },
    close: async () => {
      await owner.end();
      await db.drop();
    },
  };
}
