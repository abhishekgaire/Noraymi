import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** Private-party enquiries (M5-04): from the parties page into Messages. */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const enquire = (payload: object) =>
  api.inject({ method: "POST", url: "/v1/public/venues/west4karaoke/enquiries", payload });
const call = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const party = {
  name: "Priya",
  phone: "+16465550142",
  party_size: 22,
  date: "2026-10-10",
  message: "Office party, about 22 of us, from 8 PM.",
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  who = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" } as never],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new FrozenClock(SEED_NOW),
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("party enquiries", () => {
  let conversationId = "";

  it("an enquiry for 22 lands in Messages as an unread thread with its size, date and message", async () => {
    const r = await enquire(party);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    const list = (await call("GET", "/conversations")).json();
    const thread = list.conversations.find(
      (c: { context_kind: string }) => c.context_kind === "enquiry",
    );
    expect(thread).toMatchObject({ guest_name: "Priya", phone_e164: "+16465550142", unread: 1 });
    conversationId = thread.id;
    const detail = (await call("GET", `/conversations/${conversationId}`)).json();
    expect(detail.enquiry).toMatchObject({ party_size: 22, date: "2026-10-10", status: "new" });
    expect(detail.messages.map((m: { body: string; direction: string }) => m)).toEqual([
      expect.objectContaining({ direction: "inbound", body: party.message }),
    ]);
    const events = await owner.query(
      "select 1 from venue_events where type = 'message.received' and entity_id = $1",
      [conversationId],
    );
    expect(events.rowCount).toBe(1);
    const enquiries = (await call("GET", "/enquiries")).json();
    expect(enquiries.items).toEqual([
      expect.objectContaining({ name: "Priya", party_size: 22, date: "2026-10-10" }),
    ]);
  });

  it("won't take an email address in place of a mobile number, or a date gone by", async () => {
    const email = await enquire({ ...party, phone: "priya@example.com" });
    expect(email.statusCode).toBe(400);
    expect(email.json().error.details).toEqual({ reason: "phone" });
    const abroad = await enquire({ ...party, phone: "+447700900123" });
    expect(abroad.json().error.details).toEqual({ reason: "phone" });
    const past = await enquire({ ...party, date: "2026-09-24" });
    expect(past.json().error.details).toEqual({ reason: "date_past" });
  });

  it("a staff reply with a link is refused; a plain reply goes", async () => {
    const link = await call("POST", `/conversations/${conversationId}/messages`, {
      body: "Pay the deposit at west4karaoke.com/pay",
    });
    expect(link.statusCode).toBe(400);
    expect(link.json().error.details).toEqual({ reason: "link" });
    const ok = await call("POST", `/conversations/${conversationId}/messages`, {
      body: "Hi Priya, the VIP room is free on Sat Oct 10. Want us to hold it?",
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("is off with the website module", async () => {
    await owner.query("update venue_modules set state = 'off' where module_id = 'website'");
    expect((await enquire(party)).statusCode).toBe(404);
    await owner.query("update venue_modules set state = 'on' where module_id = 'website'");
  });
});
